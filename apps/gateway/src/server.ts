import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import {
  CompanionSettingsSchema,
  GatewaySettingsSchema,
  PCH_VERSION,
  ProfileBodySchema,
  ProfileExportSchema,
  RoleSchema,
  roleCan,
  validateProfileBody,
  WS_CLOSE_SESSION_ENDED,
  type ProfileBody,
  type ServerMessage,
  type SessionUser,
} from '@pch/shared';
import type { Transport, TransportKind } from '@pch/companion-adapter';
import type { GatewayConfig } from './config.js';
import { DUMMY_HASH, hashPassword, hashToken, newToken, RateLimiter, validatePassword, verifyPassword } from './auth.js';
import { CompanionService } from './companion-service.js';
import { defaultProfiles } from './defaults.js';
import { Hub } from './hub.js';
import type { Logger } from './logger.js';
import { describeBind, isPrivateAddress } from './netguard.js';
import { ConflictError, Store, type UserRow } from './store.js';

export const SESSION_COOKIE = 'pch_session';
export const CSRF_HEADER = 'x-pch-request';

export interface Gateway {
  app: FastifyInstance;
  hub: Hub;
  store: Store;
  companion: CompanionService;
  setupCode: string | null;
  listen(): Promise<{ url: string; port: number }>;
  close(): Promise<void>;
}

interface AuthedRequest extends FastifyRequest {
  pchUser?: UserRow;
  pchSessionHash?: string;
}

export async function createGateway(
  config: GatewayConfig,
  log: Logger,
  opts: { transportFactory?: (kind: TransportKind) => Transport } = {},
): Promise<Gateway> {
  const store = new Store(config.dbPath);
  store.pruneSessions();
  const pruned = store.pruneAudit(config.auditRetentionDays);
  if (pruned) log.info(`Pruned ${pruned} audit records older than ${config.auditRetentionDays} days`);

  // First-run seeding
  if (!store.getCompanionSettings() && config.companionSeed.host) {
    store.setCompanionSettings(
      CompanionSettingsSchema.parse({
        host: config.companionSeed.host,
        port: config.companionSeed.port ?? (config.companionSeed.transport === 'websocket' ? 16623 : 16622),
        transport: config.companionSeed.transport ?? 'tcp',
      }),
    );
  }
  if (store.listProfiles().length === 0) for (const p of defaultProfiles()) store.createProfile(p);

  let setupCode: string | null = null;
  if (store.userCount() === 0) {
    if (config.adminBootstrap) {
      store.createUser(config.adminBootstrap.username, hashPassword(config.adminBootstrap.password), 'admin');
      store.audit('user.bootstrap', null, { username: config.adminBootstrap.username });
      log.info(`Created admin account "${config.adminBootstrap.username}" from environment`);
    } else {
      setupCode = crypto.randomInt(0, 1e8).toString().padStart(8, '0');
    }
  }

  const companion = new CompanionService(store.getCompanionSettings(), log, opts.transportFactory);
  const hub = new Hub(store, companion, log, { auditPresses: config.auditPresses });

  const app = Fastify({
    logger: false,
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
    ...(config.tls ? { https: { cert: config.tls.cert, key: config.tls.key } } : {}),
  }) as unknown as FastifyInstance;
  await app.register(fastifyCookie);

  const loginLimiter = new RateLimiter(8, 5 * 60_000);
  const ipLimiter = new RateLimiter(30, 5 * 60_000);
  const apiLimiter = new RateLimiter(300, 60_000);

  /* -------------------- origin / network guards -------------------- */

  const originAllowed = (origin: string | undefined, host: string | undefined): boolean => {
    if (!origin) return false;
    if (config.allowedOrigins.includes(origin)) return true;
    try {
      return !!host && new URL(origin).host === host;
    } catch {
      return false;
    }
  };

  const remoteAllowed = (addr: string | undefined) => config.allowNonPrivateClients || isPrivateAddress(addr);

  app.addHook('onRequest', async (req, reply) => {
    if (!remoteAllowed(req.socket.remoteAddress)) {
      log.warn(`Refused request from non-private address ${req.socket.remoteAddress}`);
      return reply.code(403).send({ error: 'Production Control Hub only serves private network clients' });
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (req.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      if (!apiLimiter.take(req.socket.remoteAddress ?? '?')) return reply.code(429).send({ error: 'Too many requests' });
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // CSRF defence: custom header forces a CORS preflight that we never approve; Origin must match when present.
        if (req.headers[CSRF_HEADER] !== '1') return reply.code(403).send({ error: 'Missing request header' });
        if (req.headers.origin && !originAllowed(req.headers.origin, req.headers.host)) return reply.code(403).send({ error: 'Origin not allowed' });
      }
    }
  });

  /* -------------------- auth helpers -------------------- */

  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: !!config.tls, maxAge: Math.floor(config.sessionTtlMs / 1000) };

  const resolveSession = (cookieHeader: string | undefined): { user: UserRow; hash: string } | null => {
    if (!cookieHeader) return null;
    const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(cookieHeader);
    if (!m) return null;
    const hash = hashToken(decodeURIComponent(m[1]!));
    const user = store.touchSession(hash, config.sessionTtlMs);
    return user ? { user, hash } : null;
  };

  const requireRole = (check: (r: UserRow['role']) => boolean) => async (req: FastifyRequest, reply: FastifyReply) => {
    const s = resolveSession(req.headers.cookie);
    if (!s) return reply.code(401).send({ error: 'Not signed in' });
    if (!check(s.user.role)) return reply.code(403).send({ error: 'Insufficient permissions' });
    (req as AuthedRequest).pchUser = s.user;
    (req as AuthedRequest).pchSessionHash = s.hash;
  };
  const anyUser = requireRole(() => true);
  const adminOnly = requireRole(roleCan.admin);
  const actor = (req: FastifyRequest) => {
    const u = (req as AuthedRequest).pchUser!;
    return { id: u.id, username: u.username };
  };
  const ip = (req: FastifyRequest) => req.socket.remoteAddress ?? null;

  const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown, reply: FastifyReply): z.output<S> | null => {
    const r = schema.safeParse(data);
    if (!r.success) {
      void reply.code(400).send({ error: 'Validation failed', issues: r.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`) });
      return null;
    }
    return r.data;
  };

  const issueSession = (reply: FastifyReply, user: UserRow | { id: string }, req: FastifyRequest) => {
    const token = newToken();
    store.createSession(hashToken(token), user.id, config.sessionTtlMs, ip(req), req.headers['user-agent'] ?? null);
    void reply.setCookie(SESSION_COOKIE, token, cookieOpts);
  };

  /* -------------------- auth routes -------------------- */

  app.get('/api/health', async () => ({ ok: true, version: PCH_VERSION }));

  app.get('/api/auth/state', async (req) => {
    const s = resolveSession(req.headers.cookie);
    return {
      setupRequired: store.userCount() === 0,
      user: s ? { id: s.user.id, username: s.user.username, role: s.user.role } : null,
      version: PCH_VERSION,
    };
  });

  const Credentials = z.object({ username: z.string().trim().min(2).max(64).regex(/^[a-zA-Z0-9._@-]+$/, 'Letters, digits and . _ @ - only'), password: z.string().min(1).max(256) });

  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(Credentials.extend({ setupCode: z.string().max(32) }), req.body, reply);
    if (!body) return;
    if (!loginLimiter.take(`setup:${ip(req)}`)) return reply.code(429).send({ error: 'Too many attempts. Wait a few minutes.' });
    if (store.userCount() > 0 || !setupCode) return reply.code(409).send({ error: 'Setup has already been completed' });
    const a = Buffer.from(body.setupCode.padEnd(32));
    const b = Buffer.from(setupCode.padEnd(32));
    if (!crypto.timingSafeEqual(a, b)) {
      store.audit('auth.setup_failed', null, null, ip(req));
      return reply.code(403).send({ error: 'Incorrect setup code (shown in the gateway console)' });
    }
    const pwErr = validatePassword(body.password);
    if (pwErr) return reply.code(400).send({ error: pwErr });
    const u = store.createUser(body.username, hashPassword(body.password), 'admin');
    setupCode = null;
    gateway.setupCode = null;
    store.audit('user.setup_admin', { id: u.id, username: u.username }, null, ip(req));
    issueSession(reply, u, req);
    return { user: { id: u.id, username: u.username, role: u.role } };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(Credentials, req.body, reply);
    if (!body) return;
    // Only failed attempts count toward the limits (per user+address, and per address).
    const key = `${ip(req)}:${body.username.toLowerCase()}`;
    const ipKey = `ip:${ip(req)}`;
    if (!loginLimiter.allowed(key) || !ipLimiter.allowed(ipKey)) {
      store.audit('auth.rate_limited', null, { username: body.username }, ip(req));
      return reply.code(429).send({ error: 'Too many sign-in attempts. Wait a few minutes.' });
    }
    const user = store.findUserByName(body.username);
    const ok = verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH) && !!user && !user.disabled;
    if (!ok || !user) {
      loginLimiter.take(key);
      ipLimiter.take(ipKey);
      store.audit('auth.login_failed', null, { username: body.username }, ip(req));
      return reply.code(401).send({ error: 'Incorrect username or password' });
    }
    loginLimiter.reset(key);
    issueSession(reply, user, req);
    store.audit('auth.login', { id: user.id, username: user.username }, null, ip(req));
    return { user: { id: user.id, username: user.username, role: user.role } };
  });

  app.post('/api/auth/logout', { preHandler: anyUser }, async (req, reply) => {
    const r = req as AuthedRequest;
    store.deleteSession(r.pchSessionHash!);
    hub.disconnectSession(r.pchSessionHash!, WS_CLOSE_SESSION_ENDED, 'Signed out');
    store.audit('auth.logout', actor(req), null, ip(req));
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/me/password', { preHandler: anyUser }, async (req, reply) => {
    const body = parse(z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }), req.body, reply);
    if (!body) return;
    const u = (req as AuthedRequest).pchUser!;
    if (!verifyPassword(body.currentPassword, u.password_hash)) return reply.code(403).send({ error: 'Current password is incorrect' });
    const err = validatePassword(body.newPassword);
    if (err) return reply.code(400).send({ error: err });
    store.updateUser(u.id, { passwordHash: hashPassword(body.newPassword) });
    store.deleteUserSessions(u.id);
    hub.disconnectUser(u.id, WS_CLOSE_SESSION_ENDED, 'Password changed');
    issueSession(reply, u, req);
    store.audit('user.password_changed', actor(req), null, ip(req));
    return { ok: true };
  });

  /* -------------------- users (admin) -------------------- */

  app.get('/api/users', { preHandler: adminOnly }, async () => store.listUsers());

  app.post('/api/users', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(Credentials.extend({ role: RoleSchema }), req.body, reply);
    if (!body) return;
    const err = validatePassword(body.password);
    if (err) return reply.code(400).send({ error: err });
    if (store.findUserByName(body.username)) return reply.code(409).send({ error: 'Username already exists' });
    const u = store.createUser(body.username, hashPassword(body.password), body.role);
    store.audit('user.created', actor(req), { username: u.username, role: u.role }, ip(req));
    return u;
  });

  app.patch('/api/users/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ role: RoleSchema.optional(), disabled: z.boolean().optional(), password: z.string().max(256).optional() }), req.body, reply);
    if (!body) return;
    const target = store.getUser(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    const demotingAdmin = target.role === 'admin' && !target.disabled && ((body.role && body.role !== 'admin') || body.disabled === true);
    if (demotingAdmin && store.adminCount() <= 1) return reply.code(409).send({ error: 'At least one active admin is required' });
    if (body.password) {
      const err = validatePassword(body.password);
      if (err) return reply.code(400).send({ error: err });
    }
    store.updateUser(id, { role: body.role, disabled: body.disabled, passwordHash: body.password ? hashPassword(body.password) : undefined });
    // Any change to role, status or credentials invalidates existing sessions.
    store.deleteUserSessions(id);
    hub.disconnectUser(id, WS_CLOSE_SESSION_ENDED, 'Account changed by administrator');
    store.audit('user.updated', actor(req), { username: target.username, role: body.role, disabled: body.disabled, passwordReset: !!body.password }, ip(req));
    return { ok: true };
  });

  app.delete('/api/users/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = store.getUser(id);
    if (!target) return reply.code(404).send({ error: 'User not found' });
    if (id === (req as AuthedRequest).pchUser!.id) return reply.code(409).send({ error: 'You cannot delete your own account' });
    if (target.role === 'admin' && !target.disabled && store.adminCount() <= 1) return reply.code(409).send({ error: 'At least one active admin is required' });
    hub.disconnectUser(id, WS_CLOSE_SESSION_ENDED, 'Account removed');
    store.deleteUser(id);
    store.audit('user.deleted', actor(req), { username: target.username }, ip(req));
    return { ok: true };
  });

  /* -------------------- profiles -------------------- */

  const checkProfile = (body: ProfileBody, reply: FastifyReply, excludeId?: string): boolean => {
    const errors = validateProfileBody(body);
    if (body.kind === 'surface' && body.surfaceId) {
      const clash = store.listProfiles().find((p) => p.id !== excludeId && p.kind === 'surface' && p.surfaceId === body.surfaceId);
      if (clash) errors.push(`Surface id "${body.surfaceId}" is already used by profile "${clash.name}"`);
    }
    if (errors.length) {
      void reply.code(400).send({ error: 'Profile is not valid', issues: errors });
      return false;
    }
    return true;
  };

  app.get('/api/profiles', { preHandler: anyUser }, async () => store.listProfiles());

  app.get('/api/profiles/:id', { preHandler: anyUser }, async (req, reply) => {
    const p = store.getProfile((req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'Profile not found' });
  });

  app.post('/api/profiles', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(ProfileBodySchema, req.body, reply);
    if (!body || !checkProfile(body, reply)) return;
    const p = store.createProfile(body);
    store.audit('profile.created', actor(req), { id: p.id, name: p.name }, ip(req));
    hub.onProfilesChanged();
    return p;
  });

  app.put('/api/profiles/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ revision: z.number().int(), profile: ProfileBodySchema }), req.body, reply);
    if (!body || !checkProfile(body.profile, reply, id)) return;
    try {
      const p = store.updateProfile(id, body.revision, body.profile);
      store.audit('profile.updated', actor(req), { id, name: p.name, revision: p.revision }, ip(req));
      hub.onProfilesChanged();
      return p;
    } catch (err) {
      if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, current: err.current });
      if ((err as Error).message === 'Profile not found') return reply.code(404).send({ error: 'Profile not found' });
      throw err;
    }
  });

  app.post('/api/profiles/:id/duplicate', { preHandler: adminOnly }, async (req, reply) => {
    const src = store.getProfile((req.params as { id: string }).id);
    if (!src) return reply.code(404).send({ error: 'Profile not found' });
    const body = parse(z.object({ name: z.string().min(1).max(64).optional() }).default({}), req.body ?? {}, reply);
    if (!body) return;
    const { id: _id, revision: _r, updatedAt: _u, ...rest } = src;
    const copy: ProfileBody = { ...rest, name: body.name ?? `${src.name} copy`.slice(0, 64), surfaceId: src.kind === 'surface' ? uniqueSurfaceId(store, src.surfaceId ?? 'main') : null };
    const p = store.createProfile(copy);
    store.audit('profile.duplicated', actor(req), { from: src.id, id: p.id }, ip(req));
    hub.onProfilesChanged();
    return p;
  });

  app.delete('/api/profiles/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const revision = Number((req.query as { revision?: string }).revision);
    if (!Number.isInteger(revision)) return reply.code(400).send({ error: 'revision query parameter required' });
    if (store.listProfiles().length <= 1) return reply.code(409).send({ error: 'At least one profile is required' });
    try {
      store.deleteProfile(id, revision);
    } catch (err) {
      if (err instanceof ConflictError) return reply.code(409).send({ error: err.message, current: err.current });
      return reply.code(404).send({ error: 'Profile not found' });
    }
    const gs = store.getGatewaySettings();
    if (gs.defaultProfileId === id) store.setGatewaySettings({ ...gs, defaultProfileId: null });
    store.audit('profile.deleted', actor(req), { id }, ip(req));
    hub.onProfilesChanged();
    return { ok: true };
  });

  app.get('/api/profiles/:id/export', { preHandler: anyUser }, async (req, reply) => {
    const p = store.getProfile((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: 'Profile not found' });
    const { id: _id, revision: _r, updatedAt: _u, ...body } = p;
    const doc = { format: 'pch-profile', version: 1, exportedAt: new Date().toISOString(), profile: body };
    const safeName = p.name.replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 40) || 'profile';
    void reply.header('Content-Disposition', `attachment; filename="${safeName}.pch-profile.json"`);
    return doc;
  });

  app.post('/api/profiles/import', { preHandler: adminOnly }, async (req, reply) => {
    const doc = parse(ProfileExportSchema, req.body, reply);
    if (!doc) return;
    const body: ProfileBody = { ...doc.profile, surfaceId: doc.profile.kind === 'surface' ? uniqueSurfaceId(store, doc.profile.surfaceId ?? 'main') : null };
    if (!checkProfile(body, reply)) return;
    const p = store.createProfile(body);
    store.audit('profile.imported', actor(req), { id: p.id, name: p.name }, ip(req));
    hub.onProfilesChanged();
    return p;
  });

  /* -------------------- settings -------------------- */

  app.get('/api/settings/companion', { preHandler: anyUser }, async () => ({ settings: store.getCompanionSettings(), status: companion.status() }));

  app.put('/api/settings/companion', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(CompanionSettingsSchema, req.body, reply);
    if (!body) return;
    store.setCompanionSettings(body);
    companion.updateSettings(body);
    store.audit('settings.companion', actor(req), { host: body.host, port: body.port, transport: body.transport, enabled: body.enabled }, ip(req));
    return { settings: body, status: companion.status() };
  });

  app.post('/api/companion/reconnect', { preHandler: requireRole(roleCan.press) }, async (req) => {
    companion.reconnect();
    store.audit('companion.reconnect', actor(req), null, ip(req));
    return { status: companion.status() };
  });

  app.get('/api/settings/gateway', { preHandler: anyUser }, async () => store.getGatewaySettings());

  app.put('/api/settings/gateway', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(GatewaySettingsSchema, req.body, reply);
    if (!body) return;
    if (body.defaultProfileId && !store.getProfile(body.defaultProfileId)) return reply.code(400).send({ error: 'Default profile not found' });
    store.setGatewaySettings(body);
    store.audit('settings.gateway', actor(req), body, ip(req));
    hub.onGatewaySettingsChanged();
    return body;
  });

  /* -------------------- diagnostics & audit -------------------- */

  const startedAt = Date.now();
  app.get('/api/diagnostics', { preHandler: anyUser }, async (req) => {
    const u = (req as AuthedRequest).pchUser!;
    const base = {
      version: PCH_VERSION,
      node: process.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      companion: companion.status(),
      clients: hub.clientCount(),
      tls: !!config.tls,
    };
    if (!roleCan.admin(u.role)) return base;
    return {
      ...base,
      bind: { host: config.host, port: config.port, ...describeBind(config.host) },
      allowNonPrivateClients: config.allowNonPrivateClients,
      database: { path: config.dbPath, schemaVersion: store.schemaVersion() },
      clientList: hub.clientSummaries(),
      protocolLog: companion.recentLines(),
    };
  });

  app.get('/api/audit', { preHandler: adminOnly }, async (req) => {
    const q = req.query as { limit?: string; before?: string };
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    return store.listAudit(limit, q.before ? Number(q.before) : undefined);
  });

  /* -------------------- static web app -------------------- */

  if (config.webDist && fs.existsSync(path.join(config.webDist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders: (res, filePath) => {
        const base = path.basename(filePath);
        if (base === 'index.html' || base === 'sw.js' || base.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    app.get('/*', async (req, reply) => {
      const rel = decodeURIComponent((req.params as { '*': string })['*'] ?? '');
      const target = path.resolve(config.webDist!, rel);
      if (rel && target.startsWith(config.webDist! + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) return reply.sendFile(rel);
      if (rel.startsWith('api/')) return reply.code(404).send({ error: 'Not found' });
      reply.header('Cache-Control', 'no-cache');
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({ name: 'Production Control Hub gateway', version: PCH_VERSION, note: 'Web UI not built. Run "pnpm build" or use "pnpm dev".' }));
  }

  app.setErrorHandler((err, _req, reply) => {
    const e = err as { statusCode?: number; message: string; stack?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    log.error(`Unhandled error: ${e.stack ?? e.message}`);
    return reply.code(500).send({ error: 'Internal error' });
  });

  /* -------------------- WebSocket -------------------- */

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const rejectUpgrade = (socket: Duplex, code: number, text: string) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  app.server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '';
    if (!url.startsWith('/ws')) return rejectUpgrade(socket, 404, 'Not Found');
    if (!remoteAllowed(req.socket.remoteAddress)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (!originAllowed(req.headers.origin, req.headers.host)) {
      log.warn(`Rejected WebSocket from origin ${req.headers.origin ?? '(none)'}`);
      return rejectUpgrade(socket, 403, 'Forbidden');
    }
    const s = resolveSession(req.headers.cookie);
    if (!s) return rejectUpgrade(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, s.user, s.hash, req.socket.remoteAddress ?? null));
  });

  const sockets = new Set<WebSocket>();
  const onSocket = (ws: WebSocket, user: UserRow, sessionHash: string, addr: string | null) => {
    sockets.add(ws);
    const id = crypto.randomUUID();
    const sessionUser: SessionUser = { id: user.id, username: user.username, role: user.role };
    let alive = true;
    ws.on('pong', () => (alive = true));
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
      // Re-validate the session periodically (expiry, revocation, disabled account).
      if (!store.touchSession(sessionHash, config.sessionTtlMs)) ws.close(WS_CLOSE_SESSION_ENDED, 'Session ended');
    }, 15_000);
    hub.attach({
      id,
      user: sessionUser,
      sessionHash,
      ip: addr,
      send: (msg: ServerMessage) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close: (code, reason) => ws.close(code, reason),
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      hub.handleMessage(id, data.toString());
    });
    ws.on('close', () => {
      clearInterval(heartbeat);
      sockets.delete(ws);
      hub.detach(id);
    });
    ws.on('error', () => ws.terminate());
  };

  const pruneTimer = setInterval(() => store.pruneSessions(), 3600_000);
  pruneTimer.unref();

  const gateway: Gateway = {
    app,
    hub,
    store,
    companion,
    setupCode,
    async listen() {
      const bind = describeBind(config.host);
      if (bind.exposure !== 'loopback') log.warn(bind.message);
      await app.listen({ host: config.host, port: config.port });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      companion.start();
      const proto = config.tls ? 'https' : 'http';
      return { url: `${proto}://${config.host}:${port}`, port };
    },
    async close() {
      clearInterval(pruneTimer);
      for (const ws of sockets) ws.terminate();
      companion.stop();
      await app.close();
      store.close();
    },
  };
  return gateway;
}

function uniqueSurfaceId(store: Store, base: string): string {
  const used = new Set(store.listProfiles().map((p) => p.surfaceId).filter(Boolean));
  const stem = base.replace(/-\d+$/, '').slice(0, 28) || 'surface';
  if (!used.has(stem)) return stem;
  for (let i = 2; i < 1000; i++) if (!used.has(`${stem}-${i}`)) return `${stem}-${i}`;
  return `${stem}-${crypto.randomBytes(2).toString('hex')}`;
}
