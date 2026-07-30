import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Renderer build only. Main and preload are bundled by `scripts/build.mjs` with
 * esbuild, because they are Node/CommonJS targets with a different external set
 * and running them through Vite's web-oriented defaults invites accidentally
 * bundling `electron` itself.
 */
export default defineConfig({
  root: resolve(here, 'src/renderer'),
  // Relative so the built index.html works from `file://` — an absolute /assets
  // path resolves to the filesystem root and silently loads nothing.
  base: './',
  build: {
    outDir: resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130', // Electron 33's Chromium; no point down-levelling
    sourcemap: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': resolve(here, 'src/shared') },
  },
  server: { port: 5273, strictPort: true },
});
