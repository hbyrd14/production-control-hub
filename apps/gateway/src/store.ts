import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';

// Loaded at runtime so bundlers cannot rewrite the "node:" specifier (node:sqlite has no unprefixed form).
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
import {
  CompanionSettingsSchema,
  GatewaySettingsSchema,
  ProfileBodySchema,
  type CompanionSettings,
  type GatewaySettings,
  type Profile,
  type ProfileBody,
  type Role,
} from '@pch/shared';

/** Ordered, append-only schema migrations. Never edit a shipped migration; add a new one. */
const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        ip TEXT,
        user_agent TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('surface','mapped')),
        body TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        sort INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        user_id TEXT,
        username TEXT,
        action TEXT NOT NULL,
        detail TEXT,
        ip TEXT
      );
      CREATE INDEX audit_ts ON audit(ts);
    `,
  },
];

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: string;
  updated_at: string;
}

export type PublicUser = { id: string; username: string; role: Role; disabled: boolean; createdAt: string };

export interface AuditEntry {
  id: number;
  ts: string;
  userId: string | null;
  username: string | null;
  action: string;
  detail: unknown;
  ip: string | null;
}

export class ConflictError extends Error {
  constructor(
    message: string,
    readonly current: unknown,
  ) {
    super(message);
  }
}

export class Store {
  readonly db: DatabaseSyncType;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    const applied = new Set((this.db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version));
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, new Date().toISOString());
      });
    }
  }

  schemaVersion(): number {
    const r = this.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
    return r.v ?? 0;
  }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /* ---------------- settings ---------------- */

  private getSetting(key: string): unknown {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? JSON.parse(r.value) : undefined;
  }

  private setSetting(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), new Date().toISOString());
  }

  getCompanionSettings(): CompanionSettings | null {
    const raw = this.getSetting('companion');
    if (raw === undefined) return null;
    const p = CompanionSettingsSchema.safeParse(raw);
    return p.success ? p.data : null;
  }

  setCompanionSettings(s: CompanionSettings): void {
    this.setSetting('companion', CompanionSettingsSchema.parse(s));
  }

  getGatewaySettings(): GatewaySettings {
    const p = GatewaySettingsSchema.safeParse(this.getSetting('gateway') ?? {});
    return p.success ? p.data : GatewaySettingsSchema.parse({});
  }

  setGatewaySettings(s: GatewaySettings): void {
    this.setSetting('gateway', GatewaySettingsSchema.parse(s));
  }

  /* ---------------- users ---------------- */

  userCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  adminCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
  }

  createUser(username: string, passwordHash: string, role: Role): PublicUser {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO users (id, username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, username, passwordHash, role, now, now);
    return { id, username, role, disabled: false, createdAt: now };
  }

  findUserByName(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  }

  getUser(id: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  }

  listUsers(): PublicUser[] {
    return (this.db.prepare('SELECT * FROM users ORDER BY username').all() as unknown as UserRow[]).map(toPublicUser);
  }

  updateUser(id: string, patch: { role?: Role; disabled?: boolean; passwordHash?: string }): void {
    const u = this.getUser(id);
    if (!u) throw new Error('User not found');
    this.db
      .prepare('UPDATE users SET role = ?, disabled = ?, password_hash = ?, updated_at = ? WHERE id = ?')
      .run(patch.role ?? u.role, patch.disabled === undefined ? u.disabled : patch.disabled ? 1 : 0, patch.passwordHash ?? u.password_hash, new Date().toISOString(), id);
  }

  deleteUser(id: string): void {
    this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }

  /* ---------------- sessions ---------------- */

  createSession(tokenHash: string, userId: string, ttlMs: number, ip: string | null, userAgent: string | null): void {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(tokenHash, userId, now, now + ttlMs, now, ip, userAgent ? userAgent.slice(0, 256) : null);
  }

  /** Returns the session's user if valid; slides the expiry window. */
  touchSession(tokenHash: string, ttlMs: number): UserRow | null {
    const now = Date.now();
    const row = this.db
      .prepare('SELECT u.*, s.expires_at AS s_expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
      .get(tokenHash) as (UserRow & { s_expires: number }) | undefined;
    if (!row) return null;
    if (row.s_expires < now || row.disabled) {
      this.deleteSession(tokenHash);
      return null;
    }
    this.db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?').run(now, now + ttlMs, tokenHash);
    return row;
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  deleteUserSessions(userId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  pruneSessions(): number {
    return Number(this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()).changes);
  }

  /* ---------------- profiles ---------------- */

  listProfiles(): Profile[] {
    const rows = this.db.prepare('SELECT * FROM profiles ORDER BY sort, created_at').all() as {
      id: string;
      body: string;
      revision: number;
      updated_at: string;
    }[];
    const out: Profile[] = [];
    for (const r of rows) {
      const parsed = ProfileBodySchema.safeParse(JSON.parse(r.body));
      if (!parsed.success) {
        console.error(`[store] profile ${r.id} failed schema validation and was skipped:`, parsed.error.issues[0]);
        continue;
      }
      out.push({ ...parsed.data, id: r.id, revision: r.revision, updatedAt: r.updated_at });
    }
    return out;
  }

  getProfile(id: string): Profile | null {
    return this.listProfiles().find((p) => p.id === id) ?? null;
  }

  createProfile(body: ProfileBody, id: string = crypto.randomUUID()): Profile {
    const b = ProfileBodySchema.parse(body);
    const now = new Date().toISOString();
    const sort = (this.db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM profiles').get() as { s: number }).s;
    this.db
      .prepare('INSERT INTO profiles (id, name, kind, body, revision, sort, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
      .run(id, b.name, b.kind, JSON.stringify(b), sort, now, now);
    return { ...b, id, revision: 1, updatedAt: now };
  }

  /** Optimistic-concurrency update: fails with ConflictError if `expectedRevision` is stale. */
  updateProfile(id: string, expectedRevision: number, body: ProfileBody): Profile {
    const b = ProfileBodySchema.parse(body);
    return this.tx(() => {
      const current = this.getProfile(id);
      if (!current) throw new Error('Profile not found');
      if (current.revision !== expectedRevision) {
        throw new ConflictError('Profile was changed by someone else. Reload and re-apply your changes.', current);
      }
      const now = new Date().toISOString();
      this.db.prepare('UPDATE profiles SET name = ?, kind = ?, body = ?, revision = revision + 1, updated_at = ? WHERE id = ?').run(b.name, b.kind, JSON.stringify(b), now, id);
      return { ...b, id, revision: expectedRevision + 1, updatedAt: now };
    });
  }

  deleteProfile(id: string, expectedRevision: number): void {
    this.tx(() => {
      const current = this.getProfile(id);
      if (!current) throw new Error('Profile not found');
      if (current.revision !== expectedRevision) throw new ConflictError('Profile was changed by someone else.', current);
      this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    });
  }

  /* ---------------- audit ---------------- */

  audit(action: string, actor: { id: string; username: string } | null, detail?: unknown, ip?: string | null): void {
    this.db
      .prepare('INSERT INTO audit (ts, user_id, username, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
      .run(new Date().toISOString(), actor?.id ?? null, actor?.username ?? null, action, detail === undefined ? null : JSON.stringify(detail), ip ?? null);
  }

  listAudit(limit = 200, before?: number): AuditEntry[] {
    const rows = (
      before
        ? this.db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, limit)
        : this.db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; ts: string; user_id: string | null; username: string | null; action: string; detail: string | null; ip: string | null }[];
    return rows.map((r) => ({ id: r.id, ts: r.ts, userId: r.user_id, username: r.username, action: r.action, detail: r.detail ? JSON.parse(r.detail) : null, ip: r.ip }));
  }

  pruneAudit(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
    return Number(this.db.prepare('DELETE FROM audit WHERE ts < ?').run(cutoff).changes);
  }
}

function toPublicUser(u: UserRow): PublicUser {
  return { id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.created_at };
}
