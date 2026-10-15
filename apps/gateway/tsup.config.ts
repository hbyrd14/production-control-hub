import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'reset-password': 'src/cli/reset-password.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle workspace packages; keep npm dependencies external.
  noExternal: [/^@pch\//],
  banner: { js: "import { createRequire as __pchCreateRequire } from 'node:module'; const require = __pchCreateRequire(import.meta.url);" },
});
