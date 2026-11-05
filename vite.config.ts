import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Relative base so the build works under any GitHub Pages sub-path.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spacemouse: resolve(__dirname, 'spacemouse.html'),
        monitor: resolve(__dirname, 'monitor.html'),
      },
      output: {
        manualChunks: { three: ['three'] },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
