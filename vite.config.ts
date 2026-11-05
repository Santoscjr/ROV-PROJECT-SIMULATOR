import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import type { Plugin } from 'vite';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

/** Build identification: version + commit + build time + where it was built. */
function gitCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'unknown';
  }
}
function gitDirty(): boolean {
  if (process.env.GITHUB_SHA) return false;
  try {
    return execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
  } catch {
    return false;
  }
}
const BUILD = {
  version: pkg.version,
  commit: gitCommit(),
  dirty: gitDirty(),
  builtAt: new Date().toISOString(),
  builder: process.env.GITHUB_ACTIONS ? `github-actions#${process.env.GITHUB_RUN_NUMBER ?? '?'}` : 'local',
  ref: process.env.GITHUB_REF_NAME ?? '',
};

/** Emits dist/version.json so a running page can detect that a newer build was published. */
function versionFile(): Plugin {
  return {
    name: 'rov-version-file',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(BUILD, null, 2) });
    },
  };
}

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version), __BUILD_INFO__: JSON.stringify(BUILD) },
  plugins: [versionFile()],
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
