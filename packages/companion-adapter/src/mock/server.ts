import net from 'node:net';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { formatCommand, LineBuffer, parseBool, parseLine, versionAtLeast, type ArgValue } from '../protocol.js';
import { encodePng } from '../png.js';
import { defaultMockPages, type MockButton, type MockPage } from './fixtures.js';
import { renderKey } from './render.js';

/**
 * A mock Companion Satellite server implementing the documented server side of the protocol
 * (BEGIN, CAPS, ADD-DEVICE, KEY-PRESS, KEY-STATE, ADD-SUB/SUB-STATE/SUB-PRESS, CHANGE-PAGE, PING/PONG).
 * It never touches real hardware: "ATEM" and "vMix" behaviour is simulated tally state.
 */

export interface MockCompanionOptions {
  host?: string;
  tcpPort?: number;
  wsPort?: number | null;
  apiVersion?: string;
  companionVersion?: string;
  /** Advertise PNG bitmap support (API ≥ 1.12) */
  png?: boolean;
  pages?: Map<number, MockPage>;
}

export interface MockPressEvent {
  t: number;
  pressed: boolean;
  via: 'key' | 'sub';
  location: string;
  deviceId?: string;
  subId?: string;
}

interface Conn {
  id: number;
  send(line: string): void;
  close(): void;
  devices: Map<string, DeviceInfo>;
  subs: Map<string, SubInfo>;
}

interface DeviceInfo {
  deviceId: string;
  keysTotal: number;
  keysPerRow: number;
  bitmapSize: number;
  colors: boolean;
  text: boolean;
  png: boolean;
  canChangePage: boolean;
  page: number;
  sent: Map<number, string>;
}

interface SubInfo {
  subId: string;
  location: string;
  bitmapSize: number;
  colors: boolean;
  text: boolean;
  png: boolean;
  sent: string | null;
}

export class MockCompanionServer extends EventEmitter<{ press: [MockPressEvent]; line: [number, string] }> {
  readonly apiVersion: string;
  readonly companionVersion: string;
  readonly png: boolean;
  readonly pages: Map<number, MockPage>;
  readonly events: MockPressEvent[] = [];
  readonly received: string[] = [];
  /** When true, the server stops answering PINGs (simulates a hung peer). */
  silent = false;

  private tcp: net.Server | null = null;
  private wss: WebSocketServer | null = null;
  private conns = new Set<Conn>();
  private nextConnId = 1;
  private pressedLocations = new Set<string>();
  private latched = new Set<string>();
  private groups = new Map<string, { program: number; preview: number; transitioning: boolean }>();
  tcpPort = 0;
  wsPort = 0;

  constructor(private readonly options: MockCompanionOptions = {}) {
    super();
    this.apiVersion = options.apiVersion ?? '1.14.0';
    this.companionVersion = options.companionVersion ?? 'mock-4.x';
    this.png = options.png ?? true;
    this.pages = options.pages ?? defaultMockPages();
    this.resetState();
  }

  resetState(): void {
    this.events.length = 0;
    this.received.length = 0;
    this.pressedLocations.clear();
    this.latched.clear();
    this.groups.clear();
    for (const page of this.pages.values()) {
      for (const b of Object.values(page.buttons)) {
        const g = 'group' in b.behavior ? b.behavior.group : null;
        if (g && !this.groups.has(g)) this.groups.set(g, { program: 1, preview: 2, transitioning: false });
      }
    }
    this.refresh();
  }

  async start(): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    this.tcp = net.createServer((socket) => this.acceptTcp(socket));
    await new Promise<void>((resolve, reject) => {
      this.tcp!.once('error', reject);
      this.tcp!.listen(this.options.tcpPort ?? 0, host, () => resolve());
    });
    this.tcpPort = (this.tcp.address() as net.AddressInfo).port;
    if (this.options.wsPort !== null) {
      this.wss = new WebSocketServer({ host, port: this.options.wsPort ?? 0 });
      await new Promise<void>((resolve, reject) => {
        this.wss!.once('listening', () => resolve());
        this.wss!.once('error', reject);
      });
      this.wsPort = (this.wss.address() as net.AddressInfo).port;
      this.wss.on('connection', (ws) => this.acceptWs(ws));
    }
  }

  async stop(): Promise<void> {
    this.dropAll();
    await Promise.all([
      new Promise<void>((r) => (this.tcp ? this.tcp.close(() => r()) : r())),
      new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r())),
    ]);
  }

  /** Abruptly close every client connection (simulates network loss / Companion restart). */
  dropAll(): void {
    for (const c of [...this.conns]) c.close();
    this.conns.clear();
  }

  connectionCount(): number {
    return this.conns.size;
  }

  deviceIds(): string[] {
    return [...this.conns].flatMap((c) => [...c.devices.keys()]);
  }

  devicePage(deviceId: string): number | null {
    for (const c of this.conns) {
      const d = c.devices.get(deviceId);
      if (d) return d.page;
    }
    return null;
  }

  activeSubscriptionCount(): number {
    let n = 0;
    for (const c of this.conns) n += c.subs.size;
    return n;
  }

  /* ------------------------------------------------------------------ */

  private acceptTcp(socket: net.Socket): void {
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    const lb = new LineBuffer();
    const conn: Conn = {
      id: this.nextConnId++,
      send: (l) => {
        if (!socket.destroyed) socket.write(l);
      },
      close: () => socket.destroy(),
      devices: new Map(),
      subs: new Map(),
    };
    this.conns.add(conn);
    socket.on('data', (d: string) => {
      for (const l of lb.push(d)) this.handle(conn, l);
    });
    socket.on('error', () => {});
    socket.on('close', () => this.conns.delete(conn));
    this.greet(conn);
  }

  private acceptWs(ws: WebSocket): void {
    const conn: Conn = {
      id: this.nextConnId++,
      send: (l) => {
        if (ws.readyState === ws.OPEN) ws.send(l.replace(/\n$/, ''));
      },
      close: () => ws.terminate(),
      devices: new Map(),
      subs: new Map(),
    };
    this.conns.add(conn);
    ws.on('message', (data) => {
      for (const l of data.toString().split('\n')) this.handle(conn, l);
    });
    ws.on('error', () => {});
    ws.on('close', () => this.conns.delete(conn));
    this.greet(conn);
  }

  private greet(conn: Conn): void {
    conn.send(formatCommand('BEGIN', { CompanionVersion: this.companionVersion, ApiVersion: this.apiVersion }));
    if (versionAtLeast(this.apiVersion, '1.10.0')) {
      const caps: Record<string, ArgValue> = { SUBSCRIPTIONS: true, NONSQUARE: true };
      if (versionAtLeast(this.apiVersion, '1.12.0')) caps.BITMAP_FORMATS = this.png ? 'rgb,png' : 'rgb';
      conn.send(formatCommand('CAPS', caps));
    }
  }

  private reply(conn: Conn, cmd: string, ok: boolean, args: Record<string, ArgValue | undefined> = {}): void {
    conn.send(formatCommand(cmd, args, [ok ? 'OK' : 'ERROR']));
  }

  private handle(conn: Conn, raw: string): void {
    const msg = parseLine(raw);
    if (!msg) return;
    if (msg.command !== 'PING') {
      this.received.push(msg.raw);
      this.emit('line', conn.id, msg.raw);
    }
    const a = msg.args;
    const supportsSubs = versionAtLeast(this.apiVersion, '1.10.0');
    switch (msg.command) {
      case 'PING':
        if (!this.silent) conn.send(`PONG ${msg.positional[0] ?? ''}`.trimEnd() + '\n');
        return;
      case 'PONG':
        return;
      case 'QUIT':
        conn.close();
        return;
      case 'ADD-DEVICE': {
        const id = a.DEVICEID;
        if (!id || !a.PRODUCT_NAME) return this.reply(conn, 'ADD-DEVICE', false, { DEVICEID: id, MESSAGE: 'Missing DEVICEID or PRODUCT_NAME' });
        for (const c of this.conns) {
          if (c !== conn && c.devices.has(id)) return this.reply(conn, 'ADD-DEVICE', false, { DEVICEID: id, MESSAGE: 'Device exists elsewhere' });
        }
        const bitmaps = a.BITMAPS;
        const size = bitmaps === undefined ? 72 : bitmaps === 'true' ? 72 : bitmaps === 'false' ? 0 : Number(bitmaps) || 0;
        const dev: DeviceInfo = {
          deviceId: id,
          keysTotal: Number(a.KEYS_TOTAL ?? 32),
          keysPerRow: Number(a.KEYS_PER_ROW ?? 8),
          bitmapSize: size,
          colors: a.COLORS !== undefined && a.COLORS !== 'false' && a.COLORS !== '0',
          text: parseBool(a.TEXT),
          png: a.BITMAP_FORMAT === 'png' && this.png && versionAtLeast(this.apiVersion, '1.12.0'),
          canChangePage: !!a.CAN_CHANGE_PAGE,
          page: 1,
          sent: new Map(),
        };
        conn.devices.set(id, dev);
        this.reply(conn, 'ADD-DEVICE', true, { DEVICEID: id });
        this.refresh();
        return;
      }
      case 'REMOVE-DEVICE':
        if (a.DEVICEID) conn.devices.delete(a.DEVICEID);
        this.reply(conn, 'REMOVE-DEVICE', true, { DEVICEID: a.DEVICEID });
        return;
      case 'KEY-PRESS': {
        const dev = a.DEVICEID ? conn.devices.get(a.DEVICEID) : undefined;
        if (!dev || a.KEY === undefined) return this.reply(conn, 'KEY-PRESS', false, { DEVICEID: a.DEVICEID, MESSAGE: 'Unknown device' });
        const index = /^\d+$/.test(a.KEY) ? Number(a.KEY) : (() => {
          const [r, c] = a.KEY!.split('/').map(Number);
          return (r ?? 0) * dev.keysPerRow + (c ?? 0);
        })();
        const loc = `${dev.page}/${Math.floor(index / dev.keysPerRow)}/${index % dev.keysPerRow}`;
        this.press(loc, parseBool(a.PRESSED), { via: 'key', deviceId: dev.deviceId }, dev);
        return;
      }
      case 'CHANGE-PAGE': {
        if (!supportsSubs) return conn.send(formatCommand('ERROR', { MESSAGE: 'Unknown command: CHANGE-PAGE' }));
        const dev = a.DEVICEID ? conn.devices.get(a.DEVICEID) : undefined;
        if (dev && dev.canChangePage) this.changeDevicePage(dev, a.DIRECTION === '1' ? 1 : -1);
        this.reply(conn, 'CHANGE-PAGE', true, { DEVICEID: a.DEVICEID });
        return;
      }
      case 'ADD-SUB': {
        if (!supportsSubs) return conn.send(formatCommand('ERROR', { MESSAGE: 'Unknown command: ADD-SUB' }));
        if (!a.SUBID) return this.reply(conn, 'ADD-SUB', false, { MESSAGE: 'Missing SUBID' });
        const sub: SubInfo = {
          subId: a.SUBID,
          location: a.LOCATION ?? '',
          bitmapSize: Number(a.BITMAP ?? 0) || 0,
          colors: a.COLORS !== undefined && a.COLORS !== 'false',
          text: parseBool(a.TEXT),
          png: a.BITMAP_FORMAT === 'png' && this.png,
          sent: null,
        };
        conn.subs.set(sub.subId, sub);
        this.reply(conn, 'ADD-SUB', true, { SUBID: sub.subId });
        this.refresh();
        return;
      }
      case 'REMOVE-SUB':
        if (a.SUBID) conn.subs.delete(a.SUBID);
        this.reply(conn, 'REMOVE-SUB', true, { SUBID: a.SUBID });
        return;
      case 'SUB-PRESS': {
        const sub = a.SUBID ? conn.subs.get(a.SUBID) : undefined;
        if (!sub) return this.reply(conn, 'SUB-PRESS', false, { SUBID: a.SUBID, MESSAGE: 'Unknown subscription' });
        this.press(sub.location, parseBool(a.PRESSED), { via: 'sub', subId: sub.subId });
        return;
      }
      default:
        conn.send(formatCommand('ERROR', { MESSAGE: `Unknown command: ${msg.command}` }));
    }
  }

  private changeDevicePage(dev: DeviceInfo, delta: number): void {
    const pages = [...this.pages.keys()].sort((x, y) => x - y);
    const max = Math.max(...pages, 1);
    dev.page = ((dev.page - 1 + delta + max) % max) + 1;
    this.refresh();
  }

  private press(location: string, pressed: boolean, meta: { via: 'key' | 'sub'; deviceId?: string; subId?: string }, dev?: DeviceInfo): void {
    const ev: MockPressEvent = { t: Date.now(), pressed, location, ...meta };
    this.events.push(ev);
    if (this.events.length > 5000) this.events.shift();
    this.emit('press', ev);
    if (pressed) this.pressedLocations.add(location);
    else this.pressedLocations.delete(location);
    const button = this.buttonAt(location);
    if (pressed && button) this.applyBehavior(location, button, dev);
    this.refresh();
  }

  private applyBehavior(location: string, b: MockButton, dev?: DeviceInfo): void {
    const bh = b.behavior;
    switch (bh.type) {
      case 'program': {
        const g = this.groups.get(bh.group)!;
        g.program = bh.input;
        break;
      }
      case 'preview': {
        const g = this.groups.get(bh.group)!;
        g.preview = bh.input;
        break;
      }
      case 'cut': {
        const g = this.groups.get(bh.group)!;
        [g.program, g.preview] = [g.preview, g.program];
        break;
      }
      case 'auto': {
        const g = this.groups.get(bh.group)!;
        if (g.transitioning) break;
        g.transitioning = true;
        setTimeout(() => {
          [g.program, g.preview] = [g.preview, g.program];
          g.transitioning = false;
          this.refresh();
        }, bh.durationMs).unref?.();
        break;
      }
      case 'latch':
        if (this.latched.has(location)) this.latched.delete(location);
        else this.latched.add(location);
        break;
      case 'pageup':
        if (dev) this.changeDevicePage(dev, -1);
        break;
      case 'pagedown':
        if (dev) this.changeDevicePage(dev, 1);
        break;
      case 'momentary':
        break;
    }
  }

  private buttonAt(location: string): MockButton | null {
    const [p, r, c] = location.split('/');
    return this.pages.get(Number(p))?.buttons[`${r}/${c}`] ?? null;
  }

  private visual(location: string) {
    const b = this.buttonAt(location);
    const pressed = this.pressedLocations.has(location);
    if (!b) return { type: 'BUTTON', text: '', background: '#000000', textColor: '#ffffff', pressed, tally: null as string | null };
    let background = b.background;
    let tally: string | null = null;
    const bh = b.behavior;
    if (bh.type === 'program' && this.groups.get(bh.group)?.program === bh.input) {
      background = '#cc0000';
      tally = '#ff4040';
    } else if (bh.type === 'preview' && this.groups.get(bh.group)?.preview === bh.input) {
      background = '#008a2e';
      tally = '#30d060';
    } else if (bh.type === 'latch' && this.latched.has(location)) {
      background = bh.onColor;
    } else if (bh.type === 'auto' && this.groups.get(bh.group)?.transitioning) {
      background = '#b45309';
    }
    const type = bh.type === 'pageup' ? 'PAGEUP' : bh.type === 'pagedown' ? 'PAGEDOWN' : 'BUTTON';
    return { type, text: b.text, background, textColor: b.textColor, pressed, tally };
  }

  private stateArgs(location: string, size: number, colors: boolean, text: boolean, png: boolean): Record<string, ArgValue | undefined> {
    const v = this.visual(location);
    const args: Record<string, ArgValue | undefined> = { TYPE: v.type, PRESSED: v.pressed ? 1 : 0 };
    if (size > 0) {
      const rgb = renderKey({ size, text: v.text, background: v.background, textColor: v.textColor, pressed: v.pressed, tally: v.tally });
      args.BITMAP = png ? `data:image/png;base64,${encodePng(rgb, size, size, 3).toString('base64')}` : rgb.toString('base64');
    }
    if (colors) {
      args.COLOR = v.background;
      args.TEXTCOLOR = v.textColor;
    }
    if (text) {
      args.TEXT = Buffer.from(v.text, 'utf8').toString('base64');
      args.FONT_SIZE = 14;
    }
    return args;
  }

  /** Send any key/sub state that differs from what each client last received. */
  refresh(): void {
    for (const conn of this.conns) {
      for (const dev of conn.devices.values()) {
        for (let i = 0; i < dev.keysTotal; i++) {
          const loc = `${dev.page}/${Math.floor(i / dev.keysPerRow)}/${i % dev.keysPerRow}`;
          const sig = JSON.stringify(this.visual(loc));
          if (dev.sent.get(i) === sig) continue;
          dev.sent.set(i, sig);
          const args = this.stateArgs(loc, dev.bitmapSize, dev.colors, dev.text, dev.png);
          conn.send(formatCommand('KEY-STATE', { DEVICEID: dev.deviceId, KEY: i, ...args, LOCATION: versionAtLeast(this.apiVersion, '1.10.0') ? loc : undefined }));
        }
      }
      for (const sub of conn.subs.values()) {
        const sig = JSON.stringify(this.visual(sub.location));
        if (sub.sent === sig) continue;
        sub.sent = sig;
        conn.send(formatCommand('SUB-STATE', { SUBID: sub.subId, ...this.stateArgs(sub.location, sub.bitmapSize, sub.colors, sub.text, sub.png) }));
      }
    }
  }
}
