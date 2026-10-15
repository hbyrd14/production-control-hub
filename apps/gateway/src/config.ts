import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const EnvSchema = z.object({
  PCH_HOST: z.string().default('127.0.0.1'),
  PCH_PORT: z.coerce.number().int().min(0).max(65535).default(8420),
  PCH_DATA_DIR: z.string().default('./data'),
  PCH_WEB_DIST: z.string().optional(),
  PCH_TLS_CERT: z.string().optional(),
  PCH_TLS_KEY: z.string().optional(),
  PCH_ALLOWED_ORIGINS: z.string().default(''),
  PCH_SESSION_TTL_HOURS: z.coerce.number().min(1).max(24 * 30).default(12),
  PCH_ALLOW_NON_PRIVATE_CLIENTS: bool.default('false'),
  PCH_AUDIT_PRESSES: bool.default('true'),
  PCH_AUDIT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  PCH_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Seeds for the initial Companion connection (only used when none is stored yet). */
  PCH_COMPANION_HOST: z.string().optional(),
  PCH_COMPANION_PORT: z.coerce.number().int().optional(),
  PCH_COMPANION_TRANSPORT: z.enum(['tcp', 'websocket']).optional(),
  /** Optional unattended bootstrap of the first admin account. */
  PCH_ADMIN_USERNAME: z.string().optional(),
  PCH_ADMIN_PASSWORD: z.string().optional(),
});

export interface GatewayConfig {
  host: string;
  port: number;
  dataDir: string;
  dbPath: string;
  webDist: string | null;
  tls: { cert: Buffer; key: Buffer } | null;
  allowedOrigins: string[];
  sessionTtlMs: number;
  allowNonPrivateClients: boolean;
  auditPresses: boolean;
  auditRetentionDays: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  companionSeed: { host?: string; port?: number; transport?: 'tcp' | 'websocket' };
  adminBootstrap: { username: string; password: string } | null;
}

/** Load a simple KEY=VALUE .env file (no expansion). Real environment variables win. */
export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function findWebDist(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist'), path.resolve(process.cwd(), 'apps/web/dist')];
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(e.PCH_DATA_DIR);
  let tls: GatewayConfig['tls'] = null;
  if (e.PCH_TLS_CERT || e.PCH_TLS_KEY) {
    if (!e.PCH_TLS_CERT || !e.PCH_TLS_KEY) throw new Error('Both PCH_TLS_CERT and PCH_TLS_KEY must be set to enable HTTPS');
    tls = { cert: fs.readFileSync(path.resolve(e.PCH_TLS_CERT)), key: fs.readFileSync(path.resolve(e.PCH_TLS_KEY)) };
  }
  if (e.PCH_ADMIN_PASSWORD && e.PCH_ADMIN_PASSWORD.length < 10) {
    throw new Error('PCH_ADMIN_PASSWORD must be at least 10 characters');
  }
  return {
    host: e.PCH_HOST,
    port: e.PCH_PORT,
    dataDir,
    dbPath: path.join(dataDir, 'pch.sqlite'),
    webDist: e.PCH_WEB_DIST ? path.resolve(e.PCH_WEB_DIST) : findWebDist(),
    tls,
    allowedOrigins: e.PCH_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlMs: e.PCH_SESSION_TTL_HOURS * 3600_000,
    allowNonPrivateClients: e.PCH_ALLOW_NON_PRIVATE_CLIENTS,
    auditPresses: e.PCH_AUDIT_PRESSES,
    auditRetentionDays: e.PCH_AUDIT_RETENTION_DAYS,
    logLevel: e.PCH_LOG_LEVEL,
    companionSeed: { host: e.PCH_COMPANION_HOST, port: e.PCH_COMPANION_PORT, transport: e.PCH_COMPANION_TRANSPORT },
    adminBootstrap: e.PCH_ADMIN_USERNAME && e.PCH_ADMIN_PASSWORD ? { username: e.PCH_ADMIN_USERNAME, password: e.PCH_ADMIN_PASSWORD } : null,
  };
}
