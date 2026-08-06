/**
 * Build a single self-contained installer.
 *
 * `dist/install-loom.sh` carries the three bundles that *are* Loom on a machine
 * with no display — the CLI, the session host, and the agent host — so installing
 * needs no git, no npm, no registry, no checkout and no build on the target. One
 * file goes over, one command runs it.
 *
 * That is possible because those three are already standalone: esbuild inlines
 * every dependency, so they run against a bare Node with no `node_modules`
 * anywhere. Established by running them that way on a real server before this
 * script existed, not assumed from the bundler's settings.
 *
 * The payload is gzipped and base64'd into a shell variable rather than appended
 * after a marker, because a marker has to be read back out of `"$0"` and a script
 * arriving through `curl … | sh` has no `"$0"` to read.
 */

import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What a headless machine needs, and nothing else. The app's own files stay out. */
const PAYLOAD = {
  'cli/loom.js': 'dist/cli/loom.js',
  'main/loomHost.js': 'dist/main/loomHost.js',
  'main/agentHost.js': 'dist/main/agentHost.js',
};

if (!process.argv.includes('--no-build')) {
  execFileSync(process.execPath, [resolve(root, 'scripts/build.mjs')], { stdio: 'inherit' });
}

const files = {};
for (const [name, from] of Object.entries(PAYLOAD)) {
  const path = resolve(root, from);
  // Checked explicitly: a missing bundle would otherwise become a truncated
  // payload that installs cleanly and fails at first use, somewhere else.
  if (!statSync(path, { throwIfNoEntry: false })) {
    throw new Error(`missing ${from} — run the build first`);
  }
  files[name] = readFileSync(path, 'utf8');
}

const payload = gzipSync(Buffer.from(JSON.stringify(files)), { level: 9 }).toString('base64');

const template = readFileSync(resolve(root, 'scripts/installer.template.sh'), 'utf8');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

// Assigned before `set -eu` would matter and before anything reads it. Single
// quotes are safe without escaping because base64's alphabet cannot contain one.
const script = template.replace(
  '\nset -eu\n',
  `\nset -eu\n\nLOOM_PACKAGED_VERSION=${version}\nPAYLOAD='${payload}'\n`,
);
if (script === template) throw new Error('could not find the anchor to insert the payload after');

mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = resolve(root, 'dist/install-loom.sh');
// LF regardless of platform. Authored on Windows, run on a server: a CRLF here
// makes `sh` report `set: Illegal option -`, which names neither the file's
// problem nor the line with it.
writeFileSync(out, script.replace(/\r\n/g, '\n'), 'utf8');
chmodSync(out, 0o755);

const kb = (n) => `${Math.round(n / 1024)} KB`;
process.stdout.write(
  `\n  dist/install-loom.sh  ${kb(script.length)}  (${Object.keys(files).length} bundles, ${kb(
    Object.values(files).reduce((n, f) => n + f.length, 0),
  )} uncompressed)\n\n` +
    `  scp dist/install-loom.sh <server>:\n` +
    `  ssh <server> 'sh install-loom.sh'\n\n`,
);
