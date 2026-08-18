/**
 * Launch Electron with a corrected environment.
 *
 * `ELECTRON_RUN_AS_NODE=1` makes the `electron` binary behave as plain Node:
 * it runs the entry file, `app` is undefined, no window is ever created, and
 * nothing reports an error — the process just exits. Any parent that is itself
 * an Electron app (VS Code's terminal, Claude Code) exports it into every child
 * shell, so a developer hits this without doing anything unusual.
 *
 * Deleting the key from the child's env is the fix, and it lives here rather
 * than in an npm script because `unset` / `env -u` differ across cmd.exe,
 * PowerShell, and sh, and a script that only works in one is worse than none.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import electron from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The version this checkout ships, handed to the app explicitly.
 *
 * Electron is started as `electron dist/main/main.js`, which makes the app path
 * `dist/main` — and there is no `package.json` there, so `app.getVersion()`
 * answers with *Electron's* version rather than this project's. Everything that
 * compares the two then disagrees forever: §6.3's outdated-host badge is
 * `hostBundleVersion !== shippingVersion`, so in development it was true on
 * every host, the Update button never went away, and pressing it could not
 * help. A packaged build has a `package.json` beside its entry and never had
 * the problem, which is why the tests did not either.
 */
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

/**
 * @param {Record<string, string | undefined>} extra
 * @returns {import('node:child_process').ChildProcess}
 */
export function launchElectron(extra = {}) {
  // `extra` wins: a caller deliberately naming a version is answering the same
  // question, and the fallback exists because the app path cannot.
  const env = { AGBRTE_VERSION: version, ...process.env, ...extra };
  delete env['ELECTRON_RUN_AS_NODE'];

  const child = spawn(String(electron), [resolve(root, 'dist/main/main.js')], {
    stdio: 'inherit',
    env,
    // Never a shell: the entry path can contain spaces, and quoting it through
    // three different shells correctly is not worth the exposure.
    shell: false,
  });

  child.on('close', (code) => process.exit(code ?? 0));
  return child;
}

// Direct invocation (`npm start`) launches immediately; `dev.mjs` imports it.
if (process.argv[1] !== undefined && import.meta.url.endsWith('launch.mjs')) {
  const invoked = resolve(process.argv[1]);
  if (invoked === resolve(root, 'scripts/launch.mjs')) launchElectron();
}
