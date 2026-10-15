import net from 'node:net';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export type TransportKind = 'tcp' | 'websocket';

export interface TransportEvents {
  open: [];
  data: [chunk: string];
  close: [reason: string];
  error: [err: Error];
}

/** A line-oriented byte pipe to Companion. Emits `close` exactly once. */
export interface Transport extends EventEmitter<TransportEvents> {
  readonly kind: TransportKind;
  connect(host: string, port: number, timeoutMs: number): void;
  send(data: string): boolean;
  close(): void;
}

export class TcpTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'tcp' as const;
  private socket: net.Socket | null = null;
  private closed = false;

  connect(host: string, port: number, timeoutMs: number): void {
    const socket = net.createConnection({ host, port });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 5000);
    const timer = setTimeout(() => {
      this.fail(new Error(`Connection to ${host}:${port} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      this.emit('open');
    });
    socket.on('data', (d: string) => this.emit('data', d));
    socket.on('error', (err) => {
      clearTimeout(timer);
      this.fail(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      this.finish('socket closed');
    });
  }

  send(data: string): boolean {
    if (!this.socket || this.closed || !this.socket.writable) return false;
    this.socket.write(data);
    return true;
  }

  close(): void {
    this.socket?.destroy();
    this.finish('closed by client');
  }

  private fail(err: Error): void {
    if (this.closed) return;
    this.emit('error', err);
    this.socket?.destroy();
    this.finish(err.message);
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

export class WebSocketTransport extends EventEmitter<TransportEvents> implements Transport {
  readonly kind = 'websocket' as const;
  private ws: WebSocket | null = null;
  private closed = false;

  connect(host: string, port: number, timeoutMs: number): void {
    const h = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const ws = new WebSocket(`ws://${h}:${port}`, { handshakeTimeout: timeoutMs });
    this.ws = ws;
    ws.on('open', () => this.emit('open'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      // A WebSocket frame carries one or more complete lines; ensure termination.
      const text = data.toString();
      this.emit('data', text.endsWith('\n') ? text : text + '\n');
    });
    ws.on('error', (err) => {
      if (this.closed) return;
      this.emit('error', err);
      this.finish(err.message);
      ws.terminate();
    });
    ws.on('close', (code) => this.finish(`websocket closed (${code})`));
  }

  send(data: string): boolean {
    if (!this.ws || this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    // Satellite over WS: one message per frame, newline not required but harmless.
    this.ws.send(data.replace(/\n$/, ''));
    return true;
  }

  close(): void {
    this.ws?.terminate();
    this.finish('closed by client');
  }

  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', reason);
  }
}

export function createTransport(kind: TransportKind): Transport {
  return kind === 'tcp' ? new TcpTransport() : new WebSocketTransport();
}
