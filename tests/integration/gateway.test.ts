import { afterEach, describe, expect, it } from 'vitest';
import { keyIndex } from '../../packages/shared/src/index.js';
import { ADMIN, api, createUser, login, sleep, startStack, TestClient, waitFor, type Stack } from './helpers.js';

let stack: Stack | null = null;
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  await stack?.stop();
  stack = null;
});

async function client(cookie: string, nav: unknown = null) {
  const c = await TestClient.connect(stack!.port, cookie);
  clients.push(c);
  c.hello(nav);
  await waitFor(() => c.keys.length === 32 && c.view, 5000, 'initial view');
  return c;
}

async function ready(c: TestClient) {
  // Wait until Companion is connected and the key at index 0 has live state.
  await waitFor(() => c.status?.state === 'connected' && c.keys[0]?.source === 'companion' && !c.keys[0].disabledReason, 5000, 'live key 0');
}

describe('authentication & access control', () => {
  it('rejects unauthenticated API and WebSocket access', async () => {
    stack = await startStack();
    expect((await api(stack.base, 'GET', '/api/profiles')).status).toBe(401);
    await expect(TestClient.connect(stack.port, null)).rejects.toThrow(/401/);
  });

  it('rejects WebSocket connections from a foreign origin', async () => {
    stack = await startStack();
    const cookie = await login(stack.base);
    await expect(TestClient.connect(stack.port, cookie, 'http://evil.example')).rejects.toThrow(/403/);
  });

  it('requires the CSRF header on state-changing requests', async () => {
    stack = await startStack();
    const res = await fetch(stack.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ADMIN) });
    expect(res.status).toBe(403);
  });

  it('rate-limits repeated failed logins', async () => {
    stack = await startStack();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await api(stack.base, 'POST', '/api/auth/login', { username: 'admin', password: 'wrong-password' })).status);
    expect(statuses.slice(0, 8).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(8)).toEqual([429, 429]);
  });

  it('prevents viewers from pressing keys or editing profiles', async () => {
    stack = await startStack();
    const admin = await login(stack.base);
    const viewer = await createUser(stack.base, admin, 'viewer1', 'viewer');
    const c = await client(viewer);
    await ready(c);
    c.down(0);
    c.up(0);
    await waitFor(() => c.feedback(0).some((f) => f.state === 'rejected'));
    expect(stack.mock.events).toHaveLength(0);
    const profiles = (await api(stack.base, 'GET', '/api/profiles', undefined, viewer)).json as unknown as { id: string; revision: number }[];
    const res = await api(stack.base, 'PUT', `/api/profiles/${profiles[0]!.id}`, { revision: profiles[0]!.revision, profile: profiles[0] }, viewer);
    expect(res.status).toBe(403);
  });

  it('ends WebSocket sessions when the account is disabled', async () => {
    stack = await startStack();
    const admin = await login(stack.base);
    const opCookie = await createUser(stack.base, admin, 'op1', 'operator');
    const c = await client(opCookie);
    const users = (await api(stack.base, 'GET', '/api/users', undefined, admin)).json as unknown as { id: string; username: string }[];
    const op = users.find((u) => u.username === 'op1')!;
    await api(stack.base, 'PATCH', `/api/users/${op.id}`, { disabled: true }, admin);
    await waitFor(() => c.closed, 3000, 'socket closed');
    expect(c.closed!.code).toBe(4410);
    expect((await api(stack.base, 'GET', '/api/profiles', undefined, opCookie)).status).toBe(401);
  });

  it('first-run setup requires the one-time code', async () => {
    stack = await startStack({ env: { PCH_ADMIN_USERNAME: '', PCH_ADMIN_PASSWORD: '' } });
    expect((await api(stack.base, 'GET', '/api/auth/state')).json.setupRequired).toBe(true);
    const bad = await api(stack.base, 'POST', '/api/auth/setup', { username: 'boss', password: 'long-enough-pass', setupCode: '00000000x' });
    expect(bad.status).toBe(403);
    const good = await api(stack.base, 'POST', '/api/auth/setup', { username: 'boss', password: 'long-enough-pass', setupCode: stack.gw.setupCode });
    expect(good.status).toBe(200);
    const again = await api(stack.base, 'POST', '/api/auth/setup', { username: 'boss2', password: 'long-enough-pass', setupCode: 'x' });
    expect(again.status).toBe(409);
  });
});

describe('mapped profile control', () => {
  it('shows 32 keys with live Companion imagery and routes press/release to the mapped location', async () => {
    stack = await startStack();
    const c = await client(await login(stack.base));
    await ready(c);
    expect(c.keys).toHaveLength(32);
    expect(c.keys[0]!.image).toMatch(/^data:image\/png;base64,/);
    expect(c.view!.page!.name).toBe('ATEM');

    const pvw3 = keyIndex(1, 2);
    c.down(pvw3);
    await waitFor(() => stack!.mock.events.length === 1);
    c.up(pvw3);
    await waitFor(() => stack!.mock.events.length === 2);
    expect(stack.mock.events.map((e) => [e.location, e.pressed, e.via])).toEqual([
      ['1/1/2', true, 'sub'],
      ['1/1/2', false, 'sub'],
    ]);
    // Tally feedback arrives without a refresh
    await waitFor(() => c.keys[pvw3]!.background === '#008a2e', 3000, 'preview tally');
  });

  it('synchronises feedback across multiple clients', async () => {
    stack = await startStack();
    const admin = await login(stack.base);
    const a = await client(admin);
    const b = await client(await createUser(stack.base, admin, 'op2', 'operator'));
    await ready(a);
    await ready(b);
    const pgm4 = keyIndex(0, 3);
    a.down(pgm4);
    a.up(pgm4);
    await waitFor(() => b.keys[pgm4]!.background === '#cc0000', 3000, 'program tally on client B');
    expect(b.keys[0]!.background).not.toBe('#cc0000');
  });

  it('two operators holding the same key produce one press and one release', async () => {
    stack = await startStack();
    const admin = await login(stack.base);
    const a = await client(admin);
    const b = await client(await createUser(stack.base, admin, 'op3', 'operator'));
    await ready(a);
    await ready(b);
    a.down(20);
    b.down(20);
    await sleep(100);
    a.up(20);
    await sleep(100);
    expect(stack.mock.events.map((e) => e.pressed)).toEqual([true]);
    b.up(20);
    await waitFor(() => stack!.mock.events.length === 2);
    expect(stack.mock.events.map((e) => e.pressed)).toEqual([true, false]);
  });

  it('releases a held key when the browser disconnects', async () => {
    stack = await startStack();
    const c = await client(await login(stack.base));
    await ready(c);
    c.down(5);
    await waitFor(() => stack!.mock.events.length === 1);
    c.close();
    await waitFor(() => stack!.mock.events.length === 2, 3000, 'release on disconnect');
    expect(stack.mock.events[1]).toMatchObject({ location: '1/0/5', pressed: false });
  });

  it('navigates pages and folders, persisting nothing unintended', async () => {
    stack = await startStack();
    const c = await client(await login(stack.base));
    await ready(c);
    c.down(keyIndex(3, 7)); // Next
    c.up(keyIndex(3, 7));
    await waitFor(() => c.view?.page?.name === 'vMix');
    c.down(keyIndex(3, 5)); // Safety folder
    c.up(keyIndex(3, 5));
    await waitFor(() => c.view?.page?.name === 'Safety Controls');
    expect(c.view!.nav!.folderStack).toEqual(['vmix']);
    c.down(keyIndex(3, 0)); // Back
    c.up(keyIndex(3, 0));
    await waitFor(() => c.view?.page?.name === 'vMix');
    expect(stack.mock.events).toHaveLength(0); // navigation never touches Companion
  });

  it('hold-to-fire keys send nothing when released early and fire when held', async () => {
    stack = await startStack();
    const c = await client(await login(stack.base));
    await ready(c);
    c.send({ type: 'nav', action: 'folder', target: 'safety' });
    await waitFor(() => c.view?.page?.id === 'safety');
    await waitFor(() => c.keys[0]?.source === 'companion' && !c.keys[0].disabledReason);
    c.down(0); // STREAM, hold 1200ms
    await sleep(300);
    c.up(0);
    await sleep(1200);
    expect(stack.mock.events).toHaveLength(0);
    c.down(0);
    await waitFor(() => stack!.mock.events.length === 1, 3000, 'hold fire');
    c.up(0);
    await waitFor(() => stack!.mock.events.length === 2);
    expect(stack.mock.events[0]).toMatchObject({ location: '2/2/7', pressed: true });
  });
});

describe('network interruption safety', () => {
  it('marks imagery stale, refuses presses while offline, and never replays after reconnect', async () => {
    stack = await startStack();
    const c = await client(await login(stack.base));
    await ready(c);
    c.down(1); // held through the outage
    await waitFor(() => stack!.mock.events.length === 1);

    stack.mock.dropAll();
    await waitFor(() => c.status?.state !== 'connected', 3000, 'offline status');
    await waitFor(() => c.keys[2]?.stale && c.keys[2].disabledReason === 'Companion offline', 3000, 'stale keys');

    c.down(3); // attempted while offline
    c.up(3);
    await waitFor(() => c.feedback(3).some((f) => f.state === 'rejected'));
    c.up(1); // releasing the pre-outage press must not send anything later

    await ready(c);
    await sleep(300);
    // Only the original press exists: no release of key 1, no replay of key 3.
    expect(stack.mock.events.map((e) => [e.location, e.pressed])).toEqual([['1/0/1', true]]);
    expect(c.keys[2]!.stale).toBe(false);

    // Normal operation resumes
    c.down(4);
    c.up(4);
    await waitFor(() => stack!.mock.events.length === 3);
  });

  it('reports mapped keys as unavailable on Companion without subscriptions', async () => {
    stack = await startStack({ mock: { apiVersion: '1.7.0' } });
    const c = await client(await login(stack.base));
    await waitFor(() => c.status?.state === 'connected');
    await waitFor(() => c.keys[0]?.source === 'unavailable');
    expect(c.keys[0]!.disabledReason).toMatch(/1\.10/);
    c.down(0);
    await waitFor(() => c.feedback(0).some((f) => f.state === 'rejected'));
    expect(stack.mock.events).toHaveLength(0);
  });

  it('explains when Companion has button subscriptions turned off', async () => {
    stack = await startStack();
    stack.mock.subscriptionsEnabled = false;
    stack.mock.dropAll(); // Companion closes connections when the setting changes
    const c = await client(await login(stack.base));
    await waitFor(() => c.status?.state === 'connected' && c.keys[0]?.source === 'unavailable', 5000, 'unavailable mapped key');
    expect(c.keys[0]!.disabledReason).toMatch(/Turn on button subscriptions/);
    c.down(0);
    await waitFor(() => c.feedback(0).some((f) => f.state === 'rejected' && /subscriptions/.test(f.message ?? '')));
    expect(stack.mock.events).toHaveLength(0);
  });
});

describe('surface profile', () => {
  it('registers a Satellite surface, shows Companion page, presses keys and changes page', async () => {
    stack = await startStack();
    const cookie = await login(stack.base);
    const profiles = (await api(stack.base, 'GET', '/api/profiles', undefined, cookie)).json as unknown as { id: string; kind: string }[];
    const surface = profiles.find((p) => p.kind === 'surface')!;
    const c = await client(cookie, { profileId: surface.id, pageId: null, folderStack: [] });
    await waitFor(() => c.view?.profile?.kind === 'surface' && c.keys[0]?.source === 'companion' && !c.keys[0].disabledReason, 5000, 'surface keys');
    expect(stack.mock.deviceIds()).toContain('pch-main');
    expect(c.view!.companionPage).toBe(1);
    c.down(9);
    c.up(9);
    await waitFor(() => stack!.mock.events.length === 2);
    expect(stack.mock.events[0]).toMatchObject({ via: 'key', deviceId: 'pch-main', location: '1/1/1' });
    c.send({ type: 'nav', action: 'companion-next' });
    await waitFor(() => c.view?.companionPage === 2, 3000, 'companion page 2');
  });
});

describe('profiles API & persistence', () => {
  it('detects conflicting edits and persists across restarts', async () => {
    stack = await startStack();
    const cookie = await login(stack.base);
    const [p] = (await api(stack.base, 'GET', '/api/profiles', undefined, cookie)).json as unknown as { id: string; revision: number; name: string }[];
    const { id, revision, updatedAt: _u, ...body } = p as unknown as Record<string, unknown> & { id: string; revision: number };
    const first = await api(stack.base, 'PUT', `/api/profiles/${id}`, { revision, profile: { ...body, name: 'Edited A' } }, cookie);
    expect(first.status).toBe(200);
    const second = await api(stack.base, 'PUT', `/api/profiles/${id}`, { revision, profile: { ...body, name: 'Edited B' } }, cookie);
    expect(second.status).toBe(409);

    const dataDir = stack.dataDir;
    await stack.stop({ keepData: true });
    stack = await startStack({ dataDir });
    const cookie2 = await login(stack.base);
    const after = (await api(stack.base, 'GET', `/api/profiles/${id}`, undefined, cookie2)).json as unknown as { name: string; revision: number };
    expect(after.name).toBe('Edited A');
    expect(after.revision).toBe(revision + 1);
  });

  it('round-trips export/import and validates input', async () => {
    stack = await startStack();
    const cookie = await login(stack.base);
    const [p] = (await api(stack.base, 'GET', '/api/profiles', undefined, cookie)).json as unknown as { id: string }[];
    const exported = await api(stack.base, 'GET', `/api/profiles/${p!.id}/export`, undefined, cookie);
    expect(exported.json.format).toBe('pch-profile');
    const imported = await api(stack.base, 'POST', '/api/profiles/import', exported.json, cookie);
    expect(imported.status).toBe(200);
    const bad = await api(stack.base, 'POST', '/api/profiles/import', { format: 'pch-profile', version: 1, exportedAt: 'x', profile: { name: 'x', kind: 'mapped', pages: [{ id: 'a', name: 'a', slots: [] }] } }, cookie);
    expect(bad.status).toBe(400);
    const dup = await api(stack.base, 'POST', `/api/profiles/${p!.id}/duplicate`, {}, cookie);
    expect(dup.status).toBe(200);
    const audit = (await api(stack.base, 'GET', '/api/audit', undefined, cookie)).json as unknown as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['profile.imported', 'profile.duplicated', 'auth.login']));
  });
});
