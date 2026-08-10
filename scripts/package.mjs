/**
 * Build a single self-contained installer.
 *
 * `dist/install-agbrte.sh` carries the three bundles that *are* Agbrte on a machine
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
import { mkdirSync, readFileSync, readdirSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, relative, resolve, sep } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** What a headless machine needs, and nothing else. Electron's own files stay out. */
const PAYLOAD = {
  'cli/agbrte.js': 'dist/cli/agbrte.js',
  'main/agbrteHost.js': 'dist/main/agbrteHost.js',
  'main/agentHost.js': 'dist/main/agentHost.js',
  'web/bridge.js': 'dist/web/bridge.js',
};

/**
 * Directories carried whole, because their contents are hashed at build time.
 *
 * The renderer's bundle is `index-C-IOJcA3.js` today and something else after the
 * next edit, so it cannot be listed by name. Included at all because `agbrte web`
 * serves it, and a server install that could not serve the UI would make the one
 * command a phone needs the one command that does not work there.
 */
const PAYLOAD_DIRS = { renderer: 'dist/renderer' };

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

// ---------------------------------------------------------------- licence gate
// This script produces the thing that gets *distributed*, so it is where a
// licence violation would actually happen — not at build, not at install.
//
// The dependency this was written for — `@anthropic-ai/claude-agent-sdk`,
// "© Anthropic PBC. All rights reserved" — is gone, and the gate stays.
//
// It never fired: the adapter that imported it was not registered in any
// headless entry point, so the proprietary code reached no bundle by accident
// rather than by construction. That is exactly why the check should outlive the
// thing it was checking for. The next proprietary SDK will arrive as a
// convenience in one adapter, and this script is where redistribution would
// actually happen — not at build, not at install.
//
// Refusing here rather than warning: a warning in build output is read once.
const PROPRIETARY = ['@anthropic-ai/', 'claude-agent-sdk', 'Anthropic PBC'];
for (const [name, contents] of Object.entries(files)) {
  const found = PROPRIETARY.find((marker) => contents.includes(marker));
  if (found !== undefined) {
    throw new Error(
      `refusing to package: ${name} contains "${found}".
` +
        `That dependency is not open source (see NOTICE), so it must not be redistributed.
` +
        `Keep proprietary adapters out of the headless entry points, or load them dynamically.`,
    );
  }
}

for (const [prefix, from] of Object.entries(PAYLOAD_DIRS)) {
  const base = resolve(root, from);
  if (!statSync(base, { throwIfNoEntry: false })) throw new Error(`missing ${from} — run the build first`);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      // Source maps are for debugging here, not on someone else's server, and
      // they are four times the size of the code they describe.
      else if (!entry.name.endsWith('.map')) {
        files[`${prefix}/${relative(base, full).split(sep).join('/')}`] = readFileSync(full, 'utf8');
      }
    }
  };
  walk(base);
}

const payload = gzipSync(Buffer.from(JSON.stringify(files)), { level: 9 }).toString('base64');

// Normalized before anything looks at it, not just before it is written out.
// `.gitattributes` keeps the committed file LF, but an editor on Windows can
// still leave CRLF in the working tree — and then the anchor below matches
// nothing and the build fails with "could not find the anchor", which points at
// this line rather than at the invisible thing that actually changed.
const template = readFileSync(resolve(root, 'scripts/installer.template.sh'), 'utf8').replace(
  /\r\n/g,
  '\n',
);
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

// Assigned before `set -eu` would matter and before anything reads it. Single
// quotes are safe without escaping because base64's alphabet cannot contain one.
const script = template.replace(
  '\nset -eu\n',
  `\nset -eu\n\nAGBRTE_PACKAGED_VERSION=${version}\nPAYLOAD='${payload}'\n`,
);
if (script === template) throw new Error('could not find the anchor to insert the payload after');

mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = resolve(root, 'dist/install-agbrte.sh');
// LF regardless of platform. Authored on Windows, run on a server: a CRLF here
// makes `sh` report `set: Illegal option -`, which names neither the file's
// problem nor the line with it.
writeFileSync(out, script.replace(/\r\n/g, '\n'), 'utf8');
chmodSync(out, 0o755);

const kb = (n) => `${Math.round(n / 1024)} KB`;
process.stdout.write(
  `\n  dist/install-agbrte.sh  ${kb(script.length)}  (${Object.keys(files).length} bundles, ${kb(
    Object.values(files).reduce((n, f) => n + f.length, 0),
  )} uncompressed)\n\n` +
    `  scp dist/install-agbrte.sh <server>:\n` +
    `  ssh <server> 'sh install-agbrte.sh'\n\n`,
);
