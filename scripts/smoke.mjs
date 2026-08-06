/**
 * Build and run the Electron shell smoke check.
 *
 * Separate from `npm test` because it needs a real Electron process and a real
 * window, which Vitest's node environment cannot provide.
 */

import { spawn } from 'node:child_process';
import electron from 'electron';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The child reports here rather than to a stream. On Windows the electron
// binary is GUI-subsystem, so nothing its JS writes to fd 1 or fd 2 reaches this
// process — a file is the only channel that works on every platform.
const resultsPath = join(tmpdir(), `gilmok-smoke-${process.pid}.txt`);

const env = { ...process.env, GILMOK_SMOKE_OUT: resultsPath };
// See scripts/launch.mjs — inherited from any Electron-based parent terminal,
// and it would silently turn this into a plain Node run with no `app`.
delete env['ELECTRON_RUN_AS_NODE'];

const child = spawn(String(electron), [resolve(root, 'dist/smoke/electronSmoke.js')], {
  stdio: 'inherit',
  env,
  shell: false,
  cwd: root,
});

child.on('close', (code) => {
  try {
    process.stdout.write(readFileSync(resultsPath, 'utf8'));
    rmSync(resultsPath, { force: true });
  } catch {
    process.stdout.write('smoke produced no results file — the process died early\n');
  }
  process.exit(code ?? 1);
});
