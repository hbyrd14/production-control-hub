import { EventEmitter } from 'node:events';
import { CompanionAdapter, CompanionHttpClient, type ConnectionSnapshot, type TransportKind } from '@pch/companion-adapter';
import type { CompanionSettings, CompanionStatus } from '@pch/shared';
import type { Logger } from './logger.js';

export interface DiagnosticLine {
  t: number;
  dir: 'in' | 'out' | 'log';
  text: string;
}

/**
 * Owns the single CompanionAdapter and the optional HTTP fallback client,
 * and turns adapter state into the CompanionStatus shown to browsers.
 */
export class CompanionService extends EventEmitter<{ status: [CompanionStatus] }> {
  readonly adapter: CompanionAdapter;
  private settings: CompanionSettings | null;
  private http: CompanionHttpClient | null = null;
  private readonly lines: DiagnosticLine[] = [];

  constructor(
    settings: CompanionSettings | null,
    private readonly log: Logger,
    transportFactory?: ConstructorParameters<typeof CompanionAdapter>[0]['transportFactory'],
  ) {
    super();
    this.settings = settings;
    this.adapter = new CompanionAdapter({
      host: settings?.host ?? '127.0.0.1',
      port: settings?.port ?? 16622,
      transport: settings?.transport ?? 'tcp',
      transportFactory,
      log: (level, msg) => {
        this.log[level](`[companion] ${msg}`);
        this.pushLine('log', `${level.toUpperCase()} ${msg}`);
      },
    });
    this.applyOptions();
    this.adapter.on('connection', () => this.emit('status', this.status()));
    this.adapter.on('line', (dir, text) => this.pushLine(dir, text));
  }

  start(): void {
    if (this.settings?.enabled) this.adapter.connect();
  }

  stop(): void {
    this.adapter.disconnect();
  }

  getSettings(): CompanionSettings | null {
    return this.settings;
  }

  updateSettings(s: CompanionSettings): void {
    this.settings = s;
    this.applyOptions();
    if (s.enabled) this.adapter.reconnect();
    else this.adapter.disconnect();
    this.emit('status', this.status());
  }

  reconnect(): void {
    if (this.settings?.enabled) this.adapter.reconnect();
  }

  httpFallback(): CompanionHttpClient | null {
    return this.http;
  }

  /** HTTP fallback is only used when subscriptions are unavailable. */
  canUseHttpFallback(): boolean {
    return !!this.http && !!this.settings?.enabled;
  }

  recentLines(): DiagnosticLine[] {
    return [...this.lines];
  }

  status(): CompanionStatus {
    const s: ConnectionSnapshot = this.adapter.getConnectionState();
    if (!this.settings) {
      return { ...base(s), state: 'disabled', host: null, port: null, transport: null, lastError: 'Companion connection not configured' };
    }
    if (!this.settings.enabled) return { ...base(s), state: 'disabled' };
    return base(s);
  }

  private applyOptions(): void {
    const s = this.settings;
    if (!s) return;
    const opts = {
      host: s.host,
      port: s.port,
      transport: s.transport as TransportKind,
      connectTimeoutMs: s.connectTimeoutMs,
      reconnect: s.reconnect,
      bitmapSize: s.bitmapSize,
    };
    // configure() reconnects only if currently enabled; updateSettings handles that explicitly.
    const wasWanted = this.adapter.getConnectionState().state !== 'disconnected';
    if (wasWanted) this.adapter.disconnect();
    this.adapter.configure(opts);
    this.http = s.httpFallbackPort ? CompanionHttpClient.fromHost(s.host, s.httpFallbackPort) : null;
  }

  private pushLine(dir: DiagnosticLine['dir'], text: string): void {
    this.lines.push({ t: Date.now(), dir, text: text.length > 240 ? text.slice(0, 240) + '…' : text.replace(/BITMAP=\S+/, 'BITMAP=…') });
    if (this.lines.length > 200) this.lines.shift();
  }
}

function base(s: ConnectionSnapshot): CompanionStatus {
  return {
    state: s.state,
    host: s.host,
    port: s.port,
    transport: s.transport,
    apiVersion: s.apiVersion,
    companionVersion: s.companionVersion,
    capabilities: s.capabilities,
    supportsSubscriptions: s.supportsSubscriptions,
    supportsPageChange: s.supportsPageChange,
    lastError: s.lastError,
    nextRetryAt: s.nextRetryAt,
    connectedSince: s.connectedSince,
    attempt: s.attempt,
  };
}
