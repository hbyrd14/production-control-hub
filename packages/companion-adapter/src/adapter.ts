import { EventEmitter } from 'node:events';
import { formatCommand, LineBuffer, parseBool, parseLine, versionAtLeast, type ArgValue, type SatelliteMessage } from './protocol.js';
import { createTransport, type Transport, type TransportKind } from './transport.js';
import { bitmapToDataUrl } from './png.js';

/* Satellite API feature thresholds (see https://companion.free/for-developers/Satellite-API) */
export const API_MIN_SUPPORTED = '1.0.0';
export const API_BITMAP_SIZE = '1.5.0';
export const API_COLOR_HEX = '1.6.0';
export const API_TEXT_STYLE = '1.4.0';
export const API_SUBSCRIPTIONS = '1.10.0';
export const API_CHANGE_PAGE = '1.10.0';

export type AdapterState = 'disconnected' | 'connecting' | 'connected' | 'backoff';

export interface ReconnectPolicy {
  initialDelayMs: number;
  maxDelayMs: number;
  factor: number;
}

export interface CompanionAdapterOptions {
  host: string;
  port: number;
  transport: TransportKind;
  connectTimeoutMs?: number;
  reconnect?: Partial<ReconnectPolicy>;
  /** Interval between keepalive PINGs. Companion recommends ~2s. */
  pingIntervalMs?: number;
  /** Declare the link dead if nothing is received for this long. */
  idleTimeoutMs?: number;
  /** Requested square bitmap size for keys and subscriptions. */
  bitmapSize?: number;
  /** For tests: inject a transport factory. */
  transportFactory?: (kind: TransportKind) => Transport;
  random?: () => number;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string) => void;
}

export interface SurfaceDefinition {
  deviceId: string;
  productName: string;
  keysTotal: number;
  keysPerRow: number;
  /** Label for Companion's surface settings checkbox enabling CHANGE-PAGE (API ≥ 1.10). */
  canChangePageLabel?: string;
}

export interface CompanionKeyState {
  type: 'BUTTON' | 'PAGEUP' | 'PAGEDOWN' | 'PAGENUM';
  pressed: boolean;
  image: string | null;
  color: string | null;
  textColor: string | null;
  text: string | null;
  fontSize: number | null;
  location: string | null;
  receivedAt: number;
}

export interface ConnectionSnapshot {
  state: AdapterState;
  host: string;
  port: number;
  transport: TransportKind;
  apiVersion: string | null;
  companionVersion: string | null;
  capabilities: string[];
  supportsSubscriptions: boolean;
  supportsPageChange: boolean;
  lastError: string | null;
  nextRetryAt: number | null;
  connectedSince: number | null;
  attempt: number;
  /** Incremented every time a new Companion session is established. */
  epoch: number;
}

export type CommandResult = { ok: true } | { ok: false; reason: string };

export interface AdapterEvents {
  connection: [snapshot: ConnectionSnapshot];
  keyState: [deviceId: string, index: number, state: CompanionKeyState];
  subState: [subId: string, state: CompanionKeyState];
  keysClear: [deviceId: string];
  surfaceRegistered: [deviceId: string];
  surfaceError: [deviceId: string, message: string];
  subError: [subId: string, message: string];
  locked: [deviceId: string, locked: boolean];
  /** Every raw line, for diagnostics */
  line: [direction: 'in' | 'out', line: string];
}

interface SubscriptionDef {
  subId: string;
  location: string;
}

const NOT_CONNECTED: CommandResult = { ok: false, reason: 'Companion is not connected' };

export class CompanionAdapter extends EventEmitter<AdapterEvents> {
  private opts: Required<Omit<CompanionAdapterOptions, 'transportFactory' | 'log' | 'random' | 'reconnect'>> & {
    reconnect: ReconnectPolicy;
  };
  private readonly transportFactory: (kind: TransportKind) => Transport;
  private readonly random: () => number;
  private readonly log: NonNullable<CompanionAdapterOptions['log']>;

  private transport: Transport | null = null;
  private lines = new LineBuffer();
  private state: AdapterState = 'disconnected';
  private wantConnected = false;
  private attempt = 0;
  private epoch = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private lastRxAt = 0;
  private nextRetryAt: number | null = null;
  private connectedSince: number | null = null;
  private lastError: string | null = null;
  private apiVersion: string | null = null;
  private companionVersion: string | null = null;
  private caps = new Map<string, string>();
  private gotBegin = false;

  private readonly surfaces = new Map<string, SurfaceDefinition>();
  private readonly registeredSurfaces = new Set<string>();
  private readonly subscriptions = new Map<string, SubscriptionDef>();
  private readonly activeSubs = new Set<string>();
  /** Presses sent during the current epoch that have not been released. */
  private readonly held = new Set<string>();

  constructor(options: CompanionAdapterOptions) {
    super();
    this.transportFactory = options.transportFactory ?? createTransport;
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => {});
    this.opts = this.normalize(options);
  }

  private normalize(o: CompanionAdapterOptions) {
    return {
      host: o.host,
      port: o.port,
      transport: o.transport,
      connectTimeoutMs: o.connectTimeoutMs ?? 5000,
      pingIntervalMs: o.pingIntervalMs ?? 2000,
      idleTimeoutMs: o.idleTimeoutMs ?? 7000,
      bitmapSize: o.bitmapSize ?? 144,
      reconnect: {
        initialDelayMs: o.reconnect?.initialDelayMs ?? 1000,
        maxDelayMs: o.reconnect?.maxDelayMs ?? 30000,
        factor: o.reconnect?.factor ?? 2,
      },
    };
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  connect(): void {
    this.wantConnected = true;
    if (this.state === 'connecting' || this.state === 'connected') return;
    this.clearRetry();
    this.openTransport();
  }

  /** Graceful disconnect: releases anything held, removes surfaces, stops reconnecting. */
  disconnect(): void {
    this.wantConnected = false;
    this.clearRetry();
    if (this.transport && this.state === 'connected') {
      this.releaseAllHeld();
      this.sendRaw(formatCommand('QUIT'));
    }
    this.teardown('disconnected by gateway', false);
    this.setState('disconnected');
  }

  /** Drop the current link (if any) and connect again immediately. Never replays commands. */
  reconnect(): void {
    this.wantConnected = true;
    this.clearRetry();
    this.attempt = 0;
    this.teardown('manual reconnect', false);
    this.openTransport();
  }

  /** Apply new connection settings. Reconnects if currently enabled. */
  configure(options: Omit<CompanionAdapterOptions, 'transportFactory' | 'log' | 'random'>): void {
    this.opts = this.normalize(options);
    if (this.wantConnected) this.reconnect();
  }

  getConnectionState(): ConnectionSnapshot {
    return {
      state: this.state,
      host: this.opts.host,
      port: this.opts.port,
      transport: this.opts.transport,
      apiVersion: this.apiVersion,
      companionVersion: this.companionVersion,
      capabilities: [...this.caps.entries()].map(([k, v]) => (v ? `${k}=${v}` : k)),
      supportsSubscriptions: this.supportsSubscriptions(),
      supportsPageChange: this.state === 'connected' && versionAtLeast(this.apiVersion, API_CHANGE_PAGE),
      lastError: this.lastError,
      nextRetryAt: this.nextRetryAt,
      connectedSince: this.connectedSince,
      attempt: this.attempt,
      epoch: this.epoch,
    };
  }

  isConnected(): boolean {
    return this.state === 'connected';
  }

  supportsSubscriptions(): boolean {
    if (this.state !== 'connected') return false;
    if (!versionAtLeast(this.apiVersion, API_SUBSCRIPTIONS)) return false;
    // Servers ≥1.10 advertise SUBSCRIPTIONS in CAPS; absent flags mean disabled.
    return this.caps.has('SUBSCRIPTIONS');
  }

  /* ------------------------------------------------------------------ */
  /* Surfaces                                                            */
  /* ------------------------------------------------------------------ */

  addSurface(def: SurfaceDefinition): void {
    this.surfaces.set(def.deviceId, def);
    if (this.state === 'connected') this.sendAddDevice(def);
  }

  removeSurface(deviceId: string): void {
    if (!this.surfaces.delete(deviceId)) return;
    for (const k of [...this.held]) {
      if (k.startsWith(`key:${deviceId}:`)) {
        const index = Number(k.split(':')[2]);
        this.sendRaw(formatCommand('KEY-PRESS', { DEVICEID: deviceId, KEY: index, PRESSED: false }));
        this.held.delete(k);
      }
    }
    if (this.registeredSurfaces.delete(deviceId) && this.state === 'connected') {
      this.sendRaw(formatCommand('REMOVE-DEVICE', { DEVICEID: deviceId }));
    }
  }

  isSurfaceRegistered(deviceId: string): boolean {
    return this.registeredSurfaces.has(deviceId);
  }

  pressButton(deviceId: string, index: number): CommandResult {
    if (this.state !== 'connected') return NOT_CONNECTED;
    if (!this.registeredSurfaces.has(deviceId)) return { ok: false, reason: 'Surface not registered with Companion' };
    const key = `key:${deviceId}:${index}`;
    if (this.held.has(key)) return { ok: true }; // already down; never double-press
    this.held.add(key);
    this.sendRaw(formatCommand('KEY-PRESS', { DEVICEID: deviceId, KEY: index, PRESSED: true }));
    return { ok: true };
  }

  /** Only releases presses made in the current Companion session; a stale release is dropped. */
  releaseButton(deviceId: string, index: number): CommandResult {
    const key = `key:${deviceId}:${index}`;
    if (!this.held.delete(key)) return { ok: false, reason: 'Key was not pressed in this session' };
    if (this.state !== 'connected') return NOT_CONNECTED;
    this.sendRaw(formatCommand('KEY-PRESS', { DEVICEID: deviceId, KEY: index, PRESSED: false }));
    return { ok: true };
  }

  /** Ask Companion to move a Satellite surface to the next/previous page (API ≥ 1.10, user-enabled). */
  selectPage(deviceId: string, direction: 'next' | 'previous'): CommandResult {
    if (this.state !== 'connected') return NOT_CONNECTED;
    if (!versionAtLeast(this.apiVersion, API_CHANGE_PAGE)) {
      return { ok: false, reason: `Companion Satellite API ${this.apiVersion} does not support CHANGE-PAGE (needs ${API_CHANGE_PAGE})` };
    }
    if (!this.registeredSurfaces.has(deviceId)) return { ok: false, reason: 'Surface not registered with Companion' };
    this.sendRaw(formatCommand('CHANGE-PAGE', { DEVICEID: deviceId, DIRECTION: direction === 'next' ? 1 : 0 }));
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* Location subscriptions (API ≥ 1.10)                                 */
  /* ------------------------------------------------------------------ */

  subscribe(subId: string, location: { page: number; row: number; column: number }): void {
    const def: SubscriptionDef = { subId, location: `${location.page}/${location.row}/${location.column}` };
    const existing = this.subscriptions.get(subId);
    if (existing && existing.location === def.location) return;
    if (existing) this.unsubscribe(subId);
    this.subscriptions.set(subId, def);
    if (this.supportsSubscriptions()) this.sendAddSub(def);
  }

  unsubscribe(subId: string): void {
    if (!this.subscriptions.delete(subId)) return;
    const key = `sub:${subId}`;
    if (this.held.delete(key) && this.state === 'connected') {
      this.sendRaw(formatCommand('SUB-PRESS', { SUBID: subId, PRESSED: false }));
    }
    if (this.activeSubs.delete(subId) && this.state === 'connected') {
      this.sendRaw(formatCommand('REMOVE-SUB', { SUBID: subId }));
    }
  }

  isSubscribed(subId: string): boolean {
    return this.activeSubs.has(subId);
  }

  pressSubscription(subId: string): CommandResult {
    if (this.state !== 'connected') return NOT_CONNECTED;
    if (!this.activeSubs.has(subId)) return { ok: false, reason: 'Subscription not active' };
    const key = `sub:${subId}`;
    if (this.held.has(key)) return { ok: true };
    this.held.add(key);
    this.sendRaw(formatCommand('SUB-PRESS', { SUBID: subId, PRESSED: true }));
    return { ok: true };
  }

  releaseSubscription(subId: string): CommandResult {
    const key = `sub:${subId}`;
    if (!this.held.delete(key)) return { ok: false, reason: 'Subscription was not pressed in this session' };
    if (this.state !== 'connected') return NOT_CONNECTED;
    this.sendRaw(formatCommand('SUB-PRESS', { SUBID: subId, PRESSED: false }));
    return { ok: true };
  }

  heldCount(): number {
    return this.held.size;
  }

  /* ------------------------------------------------------------------ */
  /* Internals                                                           */
  /* ------------------------------------------------------------------ */

  private openTransport(): void {
    this.setState('connecting');
    this.gotBegin = false;
    this.apiVersion = null;
    this.companionVersion = null;
    this.caps.clear();
    this.lines.reset();
    const t = this.transportFactory(this.opts.transport);
    this.transport = t;
    t.on('open', () => {
      if (this.transport !== t) return;
      this.lastRxAt = Date.now();
      this.log('debug', `transport open ${this.opts.host}:${this.opts.port}`);
      // Wait for BEGIN within the connect timeout.
      this.handshakeTimer = setTimeout(() => {
        this.lastError = 'No BEGIN received from Companion (is this the Satellite port?)';
        t.close();
      }, this.opts.connectTimeoutMs);
    });
    t.on('data', (chunk) => {
      if (this.transport !== t) return;
      this.lastRxAt = Date.now();
      let lines: string[];
      try {
        lines = this.lines.push(chunk);
      } catch (err) {
        this.lastError = (err as Error).message;
        t.close();
        return;
      }
      for (const l of lines) this.handleLine(l);
    });
    t.on('error', (err) => {
      if (this.transport !== t) return;
      this.lastError = err.message;
    });
    t.on('close', (reason) => {
      if (this.transport !== t) return;
      if (!this.lastError || this.state === 'connected') this.lastError = reason;
      this.log('warn', `Companion link closed: ${reason}`);
      this.teardown(reason, true);
    });
    t.connect(this.opts.host, this.opts.port, this.opts.connectTimeoutMs);
  }

  /** Drop transport + per-session state. Held presses are forgotten (never replayed). */
  private teardown(reason: string, scheduleRetry: boolean): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const t = this.transport;
    this.transport = null;
    if (t) {
      t.removeAllListeners();
      t.on('error', () => {});
      t.close();
    }
    const wasConnected = this.state === 'connected';
    this.held.clear();
    this.registeredSurfaces.clear();
    this.activeSubs.clear();
    this.connectedSince = null;
    if (wasConnected) this.log('info', `Companion session ended: ${reason}`);
    if (scheduleRetry && this.wantConnected) this.scheduleRetry();
    else if (!this.wantConnected) this.setState('disconnected');
  }

  private scheduleRetry(): void {
    this.attempt++;
    const { initialDelayMs, maxDelayMs, factor } = this.opts.reconnect;
    const base = Math.min(maxDelayMs, initialDelayMs * Math.pow(factor, this.attempt - 1));
    const jitter = base * 0.2 * (this.random() * 2 - 1);
    const delay = Math.max(50, Math.round(base + jitter));
    this.nextRetryAt = Date.now() + delay;
    this.setState('backoff');
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.nextRetryAt = null;
      if (this.wantConnected) this.openTransport();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.nextRetryAt = null;
  }

  private setState(s: AdapterState): void {
    this.state = s;
    this.emit('connection', this.getConnectionState());
  }

  private sendRaw(line: string): boolean {
    if (!this.transport) return false;
    this.emit('line', 'out', line.trimEnd());
    return this.transport.send(line);
  }

  private send(command: string, args: Record<string, ArgValue | undefined>): boolean {
    return this.sendRaw(formatCommand(command, args));
  }

  private onHandshakeComplete(): void {
    if (this.state === 'connected') return;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    this.epoch++;
    this.attempt = 0;
    this.lastError = null;
    this.connectedSince = Date.now();
    this.pingTimer = setInterval(() => this.keepalive(), this.opts.pingIntervalMs);
    this.state = 'connected';
    this.log('info', `Connected to Companion ${this.companionVersion ?? '?'} (Satellite API ${this.apiVersion})`);
    // Re-register desired surfaces and subscriptions. No key presses are ever replayed.
    for (const def of this.surfaces.values()) this.sendAddDevice(def);
    if (this.supportsSubscriptions()) for (const sub of this.subscriptions.values()) this.sendAddSub(sub);
    this.emit('connection', this.getConnectionState());
  }

  private keepalive(): void {
    if (!this.transport) return;
    if (Date.now() - this.lastRxAt > this.opts.idleTimeoutMs) {
      this.lastError = `No data from Companion for ${this.opts.idleTimeoutMs} ms`;
      this.teardown(this.lastError, true);
      return;
    }
    this.sendRaw(`PING ${Date.now()}\n`);
  }

  private sendAddDevice(def: SurfaceDefinition): void {
    const api = this.apiVersion;
    const args: Record<string, ArgValue | undefined> = {
      DEVICEID: def.deviceId,
      PRODUCT_NAME: def.productName,
      KEYS_TOTAL: def.keysTotal,
      KEYS_PER_ROW: def.keysPerRow,
      BITMAPS: versionAtLeast(api, API_BITMAP_SIZE) ? this.opts.bitmapSize : true,
      COLORS: versionAtLeast(api, API_COLOR_HEX) ? 'hex' : true,
      TEXT: true,
      TEXT_STYLE: versionAtLeast(api, API_TEXT_STYLE) ? true : undefined,
      BRIGHTNESS: versionAtLeast(api, '1.7.0') ? false : undefined,
      SERIAL: versionAtLeast(api, '1.10.0') ? def.deviceId : undefined,
      CAN_CHANGE_PAGE: versionAtLeast(api, API_CHANGE_PAGE) && def.canChangePageLabel ? def.canChangePageLabel : undefined,
      BITMAP_FORMAT: this.supportsPng() ? 'png' : undefined,
    };
    this.send('ADD-DEVICE', args);
  }

  private sendAddSub(def: SubscriptionDef): void {
    this.send('ADD-SUB', {
      SUBID: def.subId,
      LOCATION: def.location,
      BITMAP: this.opts.bitmapSize,
      COLORS: 'hex',
      TEXT: true,
      TEXT_STYLE: true,
      BITMAP_FORMAT: this.supportsPng() ? 'png' : undefined,
    });
  }

  private supportsPng(): boolean {
    const formats = this.caps.get('BITMAP_FORMATS');
    return !!formats && formats.split(',').includes('png');
  }

  private releaseAllHeld(): void {
    for (const k of this.held) {
      const parts = k.split(':');
      if (parts[0] === 'key') this.send('KEY-PRESS', { DEVICEID: parts[1], KEY: Number(parts[2]), PRESSED: false });
      else if (parts[0] === 'sub') this.send('SUB-PRESS', { SUBID: parts.slice(1).join(':'), PRESSED: false });
    }
    this.held.clear();
  }

  private handleLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return;
    if (msg.command !== 'PONG' && msg.command !== 'PING') this.emit('line', 'in', msg.raw.length > 300 ? msg.raw.slice(0, 300) + '…' : msg.raw);
    try {
      this.dispatch(msg);
    } catch (err) {
      this.log('warn', `Failed to handle "${msg.command}": ${(err as Error).message}`);
    }
  }

  private dispatch(msg: SatelliteMessage): void {
    switch (msg.command) {
      case 'BEGIN': {
        this.gotBegin = true;
        this.apiVersion = msg.args.ApiVersion ?? null;
        this.companionVersion = msg.args.CompanionVersion ?? null;
        if (!this.apiVersion) {
          this.lastError = 'Companion did not report an ApiVersion';
          this.transport?.close();
          return;
        }
        // Servers ≥1.10 send CAPS right after BEGIN; wait briefly for it.
        if (versionAtLeast(this.apiVersion, '1.10.0')) {
          if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
          this.handshakeTimer = setTimeout(() => this.onHandshakeComplete(), 750);
        } else {
          this.onHandshakeComplete();
        }
        return;
      }
      case 'CAPS': {
        this.caps.clear();
        for (const p of msg.positional) this.caps.set(p, '');
        for (const [k, v] of Object.entries(msg.args)) {
          if (v === '0' || v === 'false') continue;
          this.caps.set(k, v === '1' || v === 'true' ? '' : v);
        }
        if (this.gotBegin) this.onHandshakeComplete();
        return;
      }
      case 'PING':
        this.sendRaw(`PONG ${msg.positional[0] ?? ''}`.trimEnd() + '\n');
        return;
      case 'PONG':
        return;
      case 'ADD-DEVICE': {
        const id = msg.args.DEVICEID;
        if (msg.positional[0] === 'OK') {
          // Older servers may omit DEVICEID on OK; resolve the single pending surface.
          const resolved = id ?? [...this.surfaces.keys()].find((k) => !this.registeredSurfaces.has(k));
          if (resolved) {
            this.registeredSurfaces.add(resolved);
            this.emit('surfaceRegistered', resolved);
          }
        } else {
          const m = msg.args.MESSAGE ?? 'unknown error';
          this.log('error', `ADD-DEVICE failed for ${id ?? '?'}: ${m}`);
          if (id) this.emit('surfaceError', id, m);
        }
        return;
      }
      case 'ADD-SUB': {
        const id = msg.args.SUBID;
        if (!id) return;
        if (msg.positional[0] === 'OK') this.activeSubs.add(id);
        else this.emit('subError', id, msg.args.MESSAGE ?? 'unknown error');
        return;
      }
      case 'KEY-STATE': {
        const deviceId = msg.args.DEVICEID;
        if (!deviceId || msg.args.KEY === undefined) return;
        const index = parseKey(msg.args.KEY, this.surfaces.get(deviceId)?.keysPerRow ?? 8);
        if (index === null) return;
        this.emit('keyState', deviceId, index, toKeyState(msg.args));
        return;
      }
      case 'SUB-STATE': {
        const id = msg.args.SUBID;
        if (!id) return;
        this.activeSubs.add(id);
        this.emit('subState', id, toKeyState(msg.args));
        return;
      }
      case 'KEYS-CLEAR':
        if (msg.args.DEVICEID) this.emit('keysClear', msg.args.DEVICEID);
        return;
      case 'LOCKED-STATE':
        if (msg.args.DEVICEID) this.emit('locked', msg.args.DEVICEID, parseBool(msg.args.LOCKED));
        return;
      case 'ERROR':
        this.log('warn', `Companion error: ${msg.args.MESSAGE ?? msg.raw}`);
        return;
      default:
        // KEY-PRESS OK, REMOVE-DEVICE OK, BRIGHTNESS, DEVICE-CONFIG, etc. — informational.
        if (msg.positional[0] === 'ERROR') this.log('warn', `${msg.command} error: ${msg.args.MESSAGE ?? ''}`);
    }
  }
}

function parseKey(v: string, perRow: number): number | null {
  if (/^\d+$/.test(v)) return Number(v);
  const m = /^(\d+)\/(\d+)$/.exec(v);
  if (m) return Number(m[1]) * perRow + Number(m[2]);
  return null;
}

function decodeText(v: string | undefined): string | null {
  if (v === undefined) return null;
  try {
    return Buffer.from(v, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function normalizeColor(v: string | undefined): string | null {
  if (!v) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  const m = /^rgb\((\d+),(\d+),(\d+)\)$/.exec(v.replace(/\s/g, ''));
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return null;
}

function toKeyState(a: Record<string, string>): CompanionKeyState {
  const type = (['BUTTON', 'PAGEUP', 'PAGEDOWN', 'PAGENUM'] as const).find((t) => t === a.TYPE) ?? 'BUTTON';
  return {
    type,
    pressed: parseBool(a.PRESSED),
    image: a.BITMAP ? bitmapToDataUrl(a.BITMAP) : null,
    color: normalizeColor(a.COLOR),
    textColor: normalizeColor(a.TEXTCOLOR),
    text: decodeText(a.TEXT),
    fontSize: a.FONT_SIZE && /^\d+$/.test(a.FONT_SIZE) ? Number(a.FONT_SIZE) : null,
    location: a.LOCATION ?? null,
    receivedAt: Date.now(),
  };
}
