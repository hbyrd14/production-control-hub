import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { ServerMessage, KeyView } from '../../packages/shared/src/index.js';
import { MockCompanionServer, type MockCompanionOptions } from '../../packages/companion-adapter/src/mock/index.js';
import { loadConfig } from '../../apps/gateway/src/config.js';
import { silentLogger } from '../../apps/gateway/src/logger.js';
import { createGateway, type Gateway } from '../../apps/gateway/src/server.js';

export const ADMIN = { username: 'admin', password: 'correct-horse-battery' };

export interface Stack {
  mock: MockCompanionServer;
  gw: Gateway;
  base: string;
  port: number;
  dataDir: string;
  stop(opts?: { keepData?: boolean }): Promise<void>;
}

export async function startStack(opts: { mock?: MockCompanionOptions; dataDir?: string; env?: Record<string, string>; noMock?: boolean } = {}): Promise<Stack> {
  const mock = new MockCompanionServer({ wsPort: null, ...opts.mock });
  await mock.start();
  const dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'pch-it-'));
  const config = loadConfig({
    PCH_HOST: '127.0.0.1',
    PCH_PORT: '0',
    PCH_DATA_DIR: dataDir,
    PCH_WEB_DIST: path.join(dataDir, 'no-web'),
    PCH_ADMIN_USERNAME: ADMIN.username,
    PCH_ADMIN_PASSWORD: ADMIN.password,
    PCH_COMPANION_HOST: '127.0.0.1',
    PCH_COMPANION_PORT: String(mock.tcpPort),
    PCH_COMPANION_TRANSPORT: 'tcp',
    ...opts.env,
  });
  const gw = await createGateway(config, silentLogger);
  // Fast reconnects for tests
  const s = gw.store.getCompanionSettings()!;
  const fast = { ...s, port: mock.tcpPort, reconnect: { initialDelayMs: 100, maxDelayMs: 500, factor: 2 } };
  gw.store.setCompanionSettings(fast);
  gw.companion.updateSettings(fast);
  const { port } = await gw.listen();
  const base = `http://127.0.0.1:${port}`;
  return {
    mock,
    gw,
    base,
    port,
    dataDir,
    async stop({ keepData } = {}) {
      await gw.close();
      await mock.stop();
      if (!keepData) fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function api(base: string, method: string, url: string, body?: unknown, cookie?: string) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-pch-request': '1' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as Record<string, unknown> & unknown[], headers: res.headers };
}

export async function login(base: string, username = ADMIN.username, password = ADMIN.password): Promise<string> {
  const res = await api(base, 'POST', '/api/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.json)}`);
  const sc = res.headers.get('set-cookie')!;
  return sc.split(';')[0]!;
}

export async function createUser(base: string, adminCookie: string, username: string, role: 'operator' | 'viewer' | 'admin', password = 'operator-password-1') {
  const r = await api(base, 'POST', '/api/users', { username, password, role }, adminCookie);
  if (r.status !== 200) throw new Error(`create user failed: ${JSON.stringify(r.json)}`);
  return login(base, username, password);
}

export class TestClient {
  readonly messages: ServerMessage[] = [];
  keys: KeyView[] = [];
  view: Extract<ServerMessage, { type: 'view' }>['view'] | null = null;
  status: Extract<ServerMessage, { type: 'status' }>['companion'] | null = null;
  closed: { code: number; reason: string } | null = null;
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.messages.push(m);
      if (m.type === 'keys') this.keys = m.keys;
      if (m.type === 'key') this.keys[m.key.index] = m.key;
      if (m.type === 'view') this.view = m.view;
      if (m.type === 'status') this.status = m.companion;
    });
    ws.on('close', (code, reason) => (this.closed = { code, reason: reason.toString() }));
  }

  static connect(port: number, cookie: string | null, origin = `http://127.0.0.1:${port}`): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: cookie ? { cookie } : {}, origin });
      const c = new TestClient(ws);
      ws.once('open', () => resolve(c));
      ws.once('unexpected-response', (_req, res) => reject(new Error(`ws rejected ${res.statusCode}`)));
      ws.once('error', reject);
    });
  }

  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }

  hello(nav: unknown = null) {
    this.send({ type: 'hello', nav });
  }

  down(index: number) {
    this.send({ type: 'key', action: 'down', index });
  }

  up(index: number) {
    this.send({ type: 'key', action: 'up', index });
  }

  close() {
    this.ws.close();
  }

  feedback(index: number) {
    return this.messages.filter((m): m is Extract<ServerMessage, { type: 'feedback' }> => m.type === 'feedback' && m.index === index);
  }
}

export function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, label = 'condition'): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let v: T | undefined | null | false;
      try {
        v = fn();
      } catch {
        v = undefined;
      }
      if (v) return resolve(v as T);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 20);
    };
    tick();
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
