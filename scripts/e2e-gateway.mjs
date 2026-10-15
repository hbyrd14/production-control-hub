// Starts the built gateway against a fresh, throwaway database for end-to-end tests.
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve('test-results/e2e-data');
fs.rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, {
  PCH_HOST: '127.0.0.1',
  PCH_PORT: '18420',
  PCH_DATA_DIR: dataDir,
  PCH_ADMIN_USERNAME: 'admin',
  PCH_ADMIN_PASSWORD: 'e2e-admin-password',
  PCH_COMPANION_HOST: '127.0.0.1',
  PCH_COMPANION_PORT: '26622',
  PCH_COMPANION_TRANSPORT: 'tcp',
  PCH_LOG_LEVEL: 'warn',
});
await import('../apps/gateway/dist/index.js');
