import type { ClientMessage, ServerMessage } from '@pch/shared';
import { WS_CLOSE_SESSION_ENDED } from '@pch/shared';
import { api } from './api';
import { loadSavedNav, useApp } from './store';

/**
 * Browser ↔ gateway control channel. Never queues key events while disconnected:
 * a press made while offline is dropped, not delivered later.
 */
class GatewaySocket {
  private ws: WebSocket | null = null;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private wanted = false;
  private lastPong = 0;

  start() {
    this.wanted = true;
    if (!this.ws) this.open();
  }

  stop() {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  isOpen() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): boolean {
    if (!this.isOpen()) return false;
    this.ws!.send(JSON.stringify(msg));
    return true;
  }

  private open() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws = ws;
    useApp.getState().setSocket('connecting');
    ws.onopen = () => {
      this.retry = 0;
      this.lastPong = Date.now();
      useApp.getState().setSocket('open');
      this.send({ type: 'hello', nav: loadSavedNav() });
      this.pingTimer = setInterval(() => {
        // Detect half-open links quickly (Wi-Fi roaming, sleeping iPad).
        if (Date.now() - this.lastPong > 8000) {
          ws.close();
          return;
        }
        this.send({ type: 'ping', t: Date.now() });
      }, 2500);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.lastPong = Date.now();
        return;
      }
      this.lastPong = Date.now();
      useApp.getState().apply(msg);
    };
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws === ws) this.ws = null;
      useApp.getState().setSocket('closed');
      if (!this.wanted) return;
      if (ev.code === WS_CLOSE_SESSION_ENDED) useApp.getState().toast('warn', ev.reason || 'Your session ended');
      void this.checkAuthThenRetry();
    };
  }

  private async checkAuthThenRetry() {
    try {
      const s = await api<{ user: { id: string; username: string; role: 'admin' | 'operator' | 'viewer' } | null; setupRequired: boolean }>('GET', '/api/auth/state');
      if (!s.user) {
        this.wanted = false;
        useApp.getState().setAuth(null, s.setupRequired);
        return;
      }
    } catch {
      /* gateway unreachable: keep retrying */
    }
    const delay = Math.min(10_000, 500 * 2 ** this.retry) * (0.8 + Math.random() * 0.4);
    this.retry++;
    this.timer = setTimeout(() => this.open(), delay);
  }

  reconnectNow() {
    if (this.isOpen() || !this.wanted) return;
    if (this.timer) clearTimeout(this.timer);
    this.retry = 0;
    this.ws?.close();
    this.open();
  }
}

export const gatewaySocket = new GatewaySocket();

// Coming back from the background: reconnect immediately rather than waiting on backoff.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') gatewaySocket.reconnectNow();
});
window.addEventListener('online', () => gatewaySocket.reconnectNow());
