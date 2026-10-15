import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/gateway/src/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
      'tests/integration/**/*.test.ts',
    ],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
    pool: 'forks',
  },
});
