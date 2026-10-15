import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const gateway = process.env.PCH_GATEWAY_URL ?? 'http://127.0.0.1:8420';

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.PCH_DEV_HOST ?? '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: gateway },
      '/ws': { target: gateway.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2020', sourcemap: true, chunkSizeWarningLimit: 800 },
});
