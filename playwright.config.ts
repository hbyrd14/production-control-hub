import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the production build against the mock Companion.
 * No real switcher or streaming hardware is ever contacted.
 *
 * Browser coverage: Chromium desktop and an iPad-sized touch emulation in Chromium.
 * This is NOT Safari/WebKit; iPadOS Safari must be validated on a real device
 * (see docs/TEST_REPORT.md).
 */
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL: 'http://127.0.0.1:18420',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    {
      name: 'tablet-touch-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec tsx packages/companion-adapter/src/mock-cli.ts --tcp 26622 --ws 26623 --inspect 26680',
      url: 'http://127.0.0.1:26680/state',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: 'node --disable-warning=ExperimentalWarning scripts/e2e-gateway.mjs',
      url: 'http://127.0.0.1:18420/api/health',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
