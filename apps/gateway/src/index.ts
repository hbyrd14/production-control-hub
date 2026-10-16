import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, loadDotEnv } from './config.js';
import { createLogger } from './logger.js';
import { createGateway } from './server.js';

// .env in the working directory, then the repository root (same depth from src/ and dist/).
loadDotEnv(path.resolve(process.cwd(), '.env'));
loadDotEnv(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../.env'));

const config = loadConfig();
const log = createLogger(config.logLevel);

const gateway = await createGateway(config, log);
const { url } = await gateway.listen();

log.info(`Production Control Hub gateway listening on ${url}`);
log.info(`Data directory: ${config.dataDir}`);
if (!config.webDist) log.warn('Web UI build not found — run "pnpm build" (or use "pnpm dev" for development).');
if (gateway.setupCode) {
  const bar = '='.repeat(64);
  console.log(`\n${bar}\n  FIRST-RUN SETUP\n  Open ${url} and create the admin account.\n  One-time setup code: ${gateway.setupCode}\n${bar}\n`);
}

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${signal} received — releasing held keys and shutting down`);
  await gateway.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
// Windows: closing the console window raises SIGHUP; Ctrl+Break raises SIGBREAK.
process.on('SIGHUP', () => void shutdown('SIGHUP'));
if (process.platform === 'win32') process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
