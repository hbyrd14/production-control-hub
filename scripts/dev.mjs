#!/usr/bin/env node
/**
 * Development launcher: gateway (auto-restart) + Vite dev server, optionally with the mock Companion.
 *   pnpm dev          # uses your Companion settings (set in the UI or .env)
 *   pnpm dev:mock     # also starts a simulated Companion on 127.0.0.1:16622
 */
import { spawn } from 'node:child_process';

const mock = process.argv.includes('--mock');
const procs = [];
const isWin = process.platform === 'win32';

function run(name, cmd, args, env = {}) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env }, shell: isWin });
  const tag = `[${name}]`.padEnd(10);
  const pipe = (stream, out) =>
    stream.on('data', (d) => {
      for (const line of d.toString().split(/\r?\n/)) if (line) out.write(`${tag} ${line}\n`);
    });
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  p.on('exit', (code) => {
    console.log(`${tag} exited with ${code}`);
    shutdown();
  });
  procs.push(p);
}

const env = mock
  ? { PCH_COMPANION_HOST: '127.0.0.1', PCH_COMPANION_PORT: '16622', PCH_COMPANION_TRANSPORT: 'tcp', PCH_DATA_DIR: process.env.PCH_DATA_DIR ?? './data/dev-mock' }
  : {};

if (mock) run('companion', 'pnpm', ['exec', 'tsx', 'packages/companion-adapter/src/mock-cli.ts']);
run('gateway', 'pnpm', ['--filter', '@pch/gateway', 'run', 'dev'], { ...env, PCH_DATA_DIR: env.PCH_DATA_DIR ? `../../${env.PCH_DATA_DIR}` : (process.env.PCH_DATA_DIR ?? '../../data') });
run('web', 'pnpm', ['--filter', '@pch/web', 'run', 'dev']);

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
