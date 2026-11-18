/// <reference types="vite/client" />

/** Application version injected at build time (package.json). */
declare const __APP_VERSION__: string;

/** Build identification injected at build time (vite.config.ts). */
declare const __BUILD_INFO__: { version: string; commit: string; dirty: boolean; builtAt: string; builder: string; ref: string };
