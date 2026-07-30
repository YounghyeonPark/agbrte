/**
 * Development launcher: Vite dev server + esbuild watch + Electron.
 *
 * One process rather than three concurrent npm scripts, so the ordering is
 * explicit. Electron must start *after* main.js exists on disk and after the
 * dev server is listening — start it first and it either fails to find its
 * entry or loads a URL that is not up yet, and both look like an app bug.
 */

import { context } from 'esbuild';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { launchElectron } from './launch.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
};

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  logLevel: 'warning',
  external: ['electron'],
  alias,
};

// 1. Build main + preload, and keep watching. `rebuild` on the context is what
//    makes an edit to main visible after a manual restart.
const contexts = await Promise.all([
  context({
    ...shared,
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.js'),
    format: 'esm',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  }),
  context({
    ...shared,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(root, 'dist/main/preload.cjs'),
    format: 'cjs',
  }),
]);

for (const ctx of contexts) {
  await ctx.rebuild(); // once, synchronously, before Electron looks for the file
  await ctx.watch();
}

// 2. Renderer dev server, for hot reload of the UI.
const server = await createServer({ configFile: resolve(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (url === undefined) throw new Error('vite did not report a local URL');
console.log(`renderer on ${url}`);

// 3. Electron, told where the dev server is.
const child = launchElectron({ LOOM_DEV_SERVER: url });

const shutdown = async () => {
  await server.close();
  await Promise.all(contexts.map((c) => c.dispose()));
};

child.on('close', () => void shutdown());
process.on('SIGINT', () => {
  child.kill();
  void shutdown();
});
