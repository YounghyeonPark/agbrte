/**
 * Bundle the main process and preload with esbuild.
 *
 * Why bundle at all, rather than emitting plain JS with tsc: the source uses the
 * `@shared/*` and `@main/*` path aliases, and `tsc` rewrites neither — the
 * emitted files would carry unresolvable specifiers. Bundling resolves them once
 * and produces two files Electron can load directly.
 *
 * Two output formats, deliberately:
 *  - main as ESM, matching `"type": "module"`.
 *  - **preload as CommonJS.** A sandboxed preload is not an ES module; loading
 *    one produces an empty `window.gilmok` with no error, which presents as "the
 *    app opened and every button does nothing".
 */

import { build, context } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgVersion = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const watch = process.argv.includes('--watch');

/** Resolves the aliases the TS configs declare. */
const alias = {
  '@shared': resolve(root, 'src/shared'),
  '@main': resolve(root, 'src/main'),
};

const shared = {
  bundle: true,
  platform: 'node',
  // Electron 43 bundles Node 24.18. Kept in step with the installed Electron
  // rather than pinned low: down-levelling costs output size and hides syntax
  // the runtime supports, and a target *above* the runtime fails at load.
  target: 'node24',
  sourcemap: true,
  logLevel: 'info',
  // Electron is provided by the runtime. Bundling it produces a build that
  // fails at import time with a confusing "module not found".
  external: ['electron'],
  alias,
};

const builds = [
  {
    ...shared,
    entryPoints: [resolve(root, 'src/main/main.ts')],
    outfile: resolve(root, 'dist/main/main.js'),
    format: 'esm',
    // `import.meta.url` and __dirname interop: keep ESM semantics but let any
    // CJS-only transitive dependency still resolve.
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  },
  {
    ...shared,
    entryPoints: [resolve(root, 'src/preload/index.ts')],
    outfile: resolve(root, 'dist/main/preload.cjs'),
    format: 'cjs',
  },
];

// The terminal client. A separate bundle rather than part of main's because it
// is the one entry point that runs under plain Node with no Electron anywhere —
// `npm i -g` installs this and nothing else executable.
builds.push({
  ...shared,
  entryPoints: [resolve(root, 'src/cli/gilmok.ts')],
  outfile: resolve(root, 'dist/cli/gilmok.js'),
  format: 'esm',
  // Node, not Electron: this must run on a server that has never seen a GUI.
  target: 'node22',
  define: { __GILMOK_VERSION__: JSON.stringify(pkgVersion) },
  banner: {
    js: [
      // Present so `npm i -g` produces something executable on POSIX. npm writes
      // its own .cmd shim on Windows and ignores this line.
      '#!/usr/bin/env node',
      "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    ].join('\n'),
  },
});

// The browser's `window.gilmok`. Built for the browser, not Node: it is injected
// ahead of the renderer's own bundle and must exist before that bundle boots.
builds.push({
  ...shared,
  entryPoints: [resolve(root, 'src/web/bridge.ts')],
  outfile: resolve(root, 'dist/web/bridge.js'),
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  banner: {},
});

// The session host: a standalone process the app spawns detached (§6.4). It
// outlives the app, so it is built as its own bundle rather than shipped inside
// main's.
builds.push({
  ...shared,
  entryPoints: [resolve(root, 'src/host/hostMain.ts')],
  outfile: resolve(root, 'dist/main/gilmokHost.js'),
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// The agent host is a third entry point: a utilityProcess loaded by main (§8).
// ESM like main, and `electron` stays external — a utilityProcess has a real
// `process.parentPort` from Electron's own runtime.
builds.push({
  ...shared,
  entryPoints: [resolve(root, 'src/host/entry.ts')],
  outfile: resolve(root, 'dist/main/agentHost.js'),
  format: 'esm',
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
});

// The shell smoke check is a separate Electron entry, built only when asked for.
if (process.argv.includes('--smoke')) {
  builds.push({
    ...shared,
    entryPoints: [resolve(root, 'src/smoke/electronSmoke.ts')],
    outfile: resolve(root, 'dist/smoke/electronSmoke.js'),
    format: 'esm',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
}

if (watch) {
  for (const options of builds) {
    const ctx = await context(options);
    await ctx.watch();
  }
  console.log('esbuild watching main + preload');
} else {
  await Promise.all(builds.map((options) => build(options)));
}
