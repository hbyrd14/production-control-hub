/**
 * Standalone mock Companion for development, demos and end-to-end tests.
 *
 *   pnpm mock:companion [--tcp 16622] [--ws 16623] [--api 1.14.0] [--inspect 16680] [--no-png]
 *
 * The inspector HTTP port (loopback only) exposes:
 *   GET  /events        press/release log (JSON)
 *   GET  /state         connections, devices, subscriptions
 *   POST /drop          drop every Satellite connection
 *   POST /stop-pong     stop answering PINGs (simulate hung Companion)
 *   POST /resume-pong
 *   POST /down          refuse connections and drop existing ones (Companion unreachable)
 *   POST /up            accept connections again
 *   POST /reset         clear log and simulated tally state
 */
import http from 'node:http';
import { MockCompanionServer } from './mock/server.js';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const host = arg('host', '127.0.0.1');
const server = new MockCompanionServer({
  host,
  tcpPort: Number(arg('tcp', '16622')),
  wsPort: Number(arg('ws', '16623')),
  apiVersion: arg('api', '1.14.0'),
  png: !process.argv.includes('--no-png'),
});

await server.start();
console.log(`[mock-companion] Satellite API ${server.apiVersion} — TCP ${host}:${server.tcpPort}, WS ${host}:${server.wsPort}`);
console.log('[mock-companion] Simulated pages: 1 = ATEM, 2 = vMix. No real hardware is controlled.');

const inspectPort = Number(arg('inspect', '16680'));
http
  .createServer((req, res) => {
    const json = (o: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.method === 'GET' && req.url === '/events') return json(server.events);
    if (req.method === 'GET' && req.url === '/state')
      return json({ connections: server.connectionCount(), devices: server.deviceIds(), subscriptions: server.activeSubscriptionCount() });
    if (req.method === 'POST' && req.url === '/drop') {
      server.dropAll();
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/stop-pong') {
      server.silent = true;
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/resume-pong') {
      server.silent = false;
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/down') {
      server.refuseConnections = true;
      server.dropAll();
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/up') {
      server.refuseConnections = false;
      return json({ ok: true });
    }
    if (req.method === 'POST' && req.url === '/reset') {
      server.resetState();
      return json({ ok: true });
    }
    res.writeHead(404).end();
  })
  .listen(inspectPort, '127.0.0.1', () => console.log(`[mock-companion] inspector on http://127.0.0.1:${inspectPort}`));

server.on('press', (e) => console.log(`[mock-companion] ${e.pressed ? 'DOWN' : 'UP  '} ${e.location} via ${e.via}`));

const shutdown = () => {
  void server.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
