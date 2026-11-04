import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  // Relative base so the build works under any GitHub Pages sub-path.
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        spacemouse: resolve(__dirname, 'spacemouse.html'),
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
