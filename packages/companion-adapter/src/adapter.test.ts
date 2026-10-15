import { afterEach, describe, expect, it } from 'vitest';
import { CompanionAdapter, type CompanionAdapterOptions, type ConnectionSnapshot } from './adapter.js';
import { MockCompanionServer } from './mock/server.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(serverOpts: ConstructorParameters<typeof MockCompanionServer>[0] = {}, adapterOpts: Partial<CompanionAdapterOptions> = {}) {
  const server = new MockCompanionServer(serverOpts);
  await server.start();
  cleanup.push(() => server.stop());
  const transport = adapterOpts.transport ?? 'tcp';
  const adapter = new CompanionAdapter({
    host: '127.0.0.1',
    port: transport === 'tcp' ? server.tcpPort : server.wsPort,
    transport,
    bitmapSize: 72,
    reconnect: { initialDelayMs: 100, maxDelayMs: 400, factor: 2 },
    random: () => 0.5,
    ...adapterOpts,
  });
  cleanup.push(() => adapter.disconnect());
  return { server, adapter };
}

function waitFor<T>(fn: () => T | undefined | false | null, timeoutMs = 4000, label = 'condition'): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v as T);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

const SURFACE = { deviceId: 'pch-test', productName: 'Production Control Hub', keysTotal: 32, keysPerRow: 8, canChangePageLabel: 'Allow PCH page buttons' };

describe.each(['tcp', 'websocket'] as const)('CompanionAdapter over %s', (transport) => {
  it('performs the BEGIN/CAPS handshake and reports capabilities', async () => {
    const { adapter } = await setup({}, { transport });
    adapter.connect();
    await waitFor(() => adapter.isConnected(), 4000, 'connected');
    const s = adapter.getConnectionState();
    expect(s.apiVersion).toBe('1.14.0');
    expect(s.companionVersion).toBe('mock-4.x');
    expect(s.supportsSubscriptions).toBe(true);
    expect(s.capabilities).toContain('BITMAP_FORMATS=rgb,png');
  });

  it('registers a 32-key surface and receives key images', async () => {
    const { server, adapter } = await setup({}, { transport });
    const states = new Map<number, string | null>();
    adapter.on('keyState', (_d, i, st) => states.set(i, st.image));
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => states.size === 32, 4000, '32 key states');
    expect(server.deviceIds()).toEqual(['pch-test']);
    expect(states.get(0)).toMatch(/^data:image\/png;base64,/);
    const add = server.received.find((l) => l.startsWith('ADD-DEVICE'))!;
    expect(add).toContain('KEYS_TOTAL=32');
    expect(add).toContain('KEYS_PER_ROW=8');
    expect(add).toContain('BITMAPS=72');
    expect(add).toContain('BITMAP_FORMAT=png');
  });

  it('sends exact press/release events', async () => {
    const { server, adapter } = await setup({}, { transport });
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    expect(adapter.pressButton('pch-test', 9)).toEqual({ ok: true });
    expect(adapter.pressButton('pch-test', 9)).toEqual({ ok: true }); // idempotent, no second down
    expect(adapter.releaseButton('pch-test', 9)).toEqual({ ok: true });
    await waitFor(() => server.events.length === 2);
    expect(server.received.filter((l) => l.startsWith('KEY-PRESS'))).toEqual([
      'KEY-PRESS DEVICEID=pch-test KEY=9 PRESSED=true',
      'KEY-PRESS DEVICEID=pch-test KEY=9 PRESSED=false',
    ]);
    expect(server.events.map((e) => [e.location, e.pressed])).toEqual([
      ['1/1/1', true],
      ['1/1/1', false],
    ]);
  });
});

describe('CompanionAdapter safety', () => {
  it('never sends a release for a key it did not press', async () => {
    const { server, adapter } = await setup();
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    expect(adapter.releaseButton('pch-test', 3).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received.some((l) => l.startsWith('KEY-PRESS'))).toBe(false);
  });

  it('rejects commands while disconnected instead of queuing them', async () => {
    const { server, adapter } = await setup();
    expect(adapter.pressButton('pch-test', 0)).toEqual({ ok: false, reason: 'Companion is not connected' });
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    await new Promise((r) => setTimeout(r, 100));
    expect(server.received.some((l) => l.startsWith('KEY-PRESS'))).toBe(false);
  });

  it('reconnects with backoff after a drop and does not replay or release held keys', async () => {
    const { server, adapter } = await setup();
    const snapshots: ConnectionSnapshot[] = [];
    adapter.on('connection', (s) => snapshots.push(s));
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    const epoch = adapter.getConnectionState().epoch;
    adapter.pressButton('pch-test', 5);
    await waitFor(() => server.events.length === 1);

    server.dropAll();
    await waitFor(() => adapter.getConnectionState().state === 'backoff', 4000, 'backoff');
    expect(adapter.heldCount()).toBe(0);
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'), 4000, 're-registration');
    expect(adapter.getConnectionState().epoch).toBe(epoch + 1);

    // The pre-drop press must not be released or re-pressed in the new session.
    expect(adapter.releaseButton('pch-test', 5).ok).toBe(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(server.events).toHaveLength(1);
    expect(server.received.filter((l) => l.startsWith('KEY-PRESS'))).toEqual(['KEY-PRESS DEVICEID=pch-test KEY=5 PRESSED=true']);
    expect(server.received.filter((l) => l.startsWith('ADD-DEVICE'))).toHaveLength(2);
    expect(snapshots.some((s) => s.state === 'backoff' && s.nextRetryAt !== null)).toBe(true);
  });

  it('grows the retry delay exponentially up to the cap', async () => {
    const adapter = new CompanionAdapter({
      host: '127.0.0.1',
      port: 1, // nothing listens here
      transport: 'tcp',
      connectTimeoutMs: 500,
      reconnect: { initialDelayMs: 50, maxDelayMs: 200, factor: 2 },
      random: () => 0.5,
    });
    cleanup.push(() => adapter.disconnect());
    const delays: number[] = [];
    adapter.on('connection', (s) => {
      if (s.state === 'backoff' && s.nextRetryAt) delays.push(s.nextRetryAt - Date.now());
    });
    adapter.connect();
    await waitFor(() => delays.length >= 4, 5000, '4 retries');
    expect(delays[0]).toBeLessThanOrEqual(55);
    expect(delays[1]!).toBeGreaterThan(80);
    expect(delays[3]!).toBeLessThanOrEqual(205);
    expect(adapter.getConnectionState().lastError).toBeTruthy();
  });

  it('detects a hung Companion via keepalive timeout', async () => {
    const { server, adapter } = await setup({}, { pingIntervalMs: 50, idleTimeoutMs: 300 });
    adapter.connect();
    await waitFor(() => adapter.isConnected());
    server.silent = true;
    await waitFor(() => adapter.getConnectionState().state === 'backoff', 3000, 'idle detection');
    expect(adapter.getConnectionState().lastError).toMatch(/No data from Companion/);
    server.silent = false;
    await waitFor(() => adapter.isConnected(), 3000, 'recovery');
  });

  it('graceful disconnect releases held keys then quits', async () => {
    const { server, adapter } = await setup();
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    adapter.pressButton('pch-test', 2);
    adapter.disconnect();
    await waitFor(() => server.received.includes('QUIT'));
    expect(server.received.slice(-2)).toEqual(['KEY-PRESS DEVICEID=pch-test KEY=2 PRESSED=false', 'QUIT']);
    expect(adapter.getConnectionState().state).toBe('disconnected');
  });
});

describe('Location subscriptions', () => {
  it('subscribes to a location, receives state, and presses via SUB-PRESS', async () => {
    const { server, adapter } = await setup();
    const states: string[] = [];
    adapter.on('subState', (id, st) => states.push(`${id}:${st.text}:${st.color}`));
    adapter.subscribe('k0', { page: 1, row: 0, column: 0 });
    adapter.connect();
    await waitFor(() => adapter.isSubscribed('k0'));
    await waitFor(() => states.length > 0);
    expect(states[0]).toBe('k0:PGM\n1:#cc0000'); // input 1 is on program in the mock
    expect(adapter.pressSubscription('k0').ok).toBe(true);
    expect(adapter.releaseSubscription('k0').ok).toBe(true);
    await waitFor(() => server.events.length === 2);
    expect(server.events[0]).toMatchObject({ via: 'sub', location: '1/0/0', pressed: true });
    expect(server.received).toContain('SUB-PRESS SUBID=k0 PRESSED=true');
  });

  it('receives tally feedback changes caused elsewhere', async () => {
    const { adapter } = await setup();
    const colors: string[] = [];
    adapter.on('subState', (_id, st) => colors.push(st.color ?? ''));
    adapter.subscribe('pvw3', { page: 1, row: 1, column: 2 });
    adapter.subscribe('pvw3-btn', { page: 1, row: 1, column: 2 });
    adapter.connect();
    await waitFor(() => adapter.isSubscribed('pvw3'));
    adapter.pressSubscription('pvw3');
    adapter.releaseSubscription('pvw3');
    await waitFor(() => colors.includes('#008a2e'), 3000, 'preview tally');
  });

  it('re-subscribes after reconnect', async () => {
    const { server, adapter } = await setup();
    adapter.subscribe('k1', { page: 2, row: 0, column: 0 });
    adapter.connect();
    await waitFor(() => adapter.isSubscribed('k1'));
    server.dropAll();
    await waitFor(() => !adapter.isSubscribed('k1'));
    await waitFor(() => adapter.isSubscribed('k1'), 4000, 'resubscribe');
    expect(server.received.filter((l) => l.startsWith('ADD-SUB'))).toHaveLength(2);
  });
});

describe('Older Companion (Satellite API 1.7)', () => {
  it('falls back to raw RGB, disables subscriptions and page changes', async () => {
    const { server, adapter } = await setup({ apiVersion: '1.7.0' });
    const images: string[] = [];
    adapter.on('keyState', (_d, _i, st) => st.image && images.push(st.image));
    adapter.addSurface(SURFACE);
    adapter.subscribe('x', { page: 1, row: 0, column: 0 });
    adapter.connect();
    await waitFor(() => images.length === 32);
    expect(images[0]).toMatch(/^data:image\/png;base64,/); // converted from raw RGB by the gateway
    const s = adapter.getConnectionState();
    expect(s.supportsSubscriptions).toBe(false);
    expect(s.supportsPageChange).toBe(false);
    expect(adapter.selectPage('pch-test', 'next').ok).toBe(false);
    expect(server.received.some((l) => l.startsWith('ADD-SUB'))).toBe(false);
    const add = server.received.find((l) => l.startsWith('ADD-DEVICE'))!;
    expect(add).not.toContain('BITMAP_FORMAT');
    expect(add).not.toContain('CAN_CHANGE_PAGE');
  });
});

describe('CHANGE-PAGE', () => {
  it('moves the surface to the next page when allowed', async () => {
    const { server, adapter } = await setup();
    adapter.addSurface(SURFACE);
    adapter.connect();
    await waitFor(() => adapter.isSurfaceRegistered('pch-test'));
    expect(adapter.selectPage('pch-test', 'next').ok).toBe(true);
    await waitFor(() => server.devicePage('pch-test') === 2);
  });
});
