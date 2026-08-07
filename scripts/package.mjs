/**
 * Build a single self-contained installer.
 *
 * `dist/install-gilmok.sh` carries the three bundles that *are* Gilmok on a machine
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
  'cli/gilmok.js': 'dist/cli/gilmok.js',
  'main/gilmokHost.js': 'dist/main/gilmokHost.js',
  'main/agentHost.js': 'dist/main/agentHost.js',
  'web/bridge.js': 'dist/web/bridge.js',
};

/**
 * Directories carried whole, because their contents are hashed at build time.
 *
 * The renderer's bundle is `index-C-IOJcA3.js` today and something else after the
 * next edit, so it cannot be listed by name. Included at all because `gilmok web`
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
// `@anthropic-ai/claude-agent-sdk` is "© Anthropic PBC. All rights reserved". It
// reaches no bundle today, but only because the adapter that imports it is not
// registered in any headless entry point. Wire that adapter into the agent host
// and this installer silently starts redistributing proprietary code, which no
// licence of ours can authorise. An accident that holds is not a guarantee.
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
        `Keep the claude-agent-sdk adapter out of the headless entry points, or load it dynamically.`,
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

const template = readFileSync(resolve(root, 'scripts/installer.template.sh'), 'utf8');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;

// Assigned before `set -eu` would matter and before anything reads it. Single
// quotes are safe without escaping because base64's alphabet cannot contain one.
const script = template.replace(
  '\nset -eu\n',
  `\nset -eu\n\nGILMOK_PACKAGED_VERSION=${version}\nPAYLOAD='${payload}'\n`,
);
if (script === template) throw new Error('could not find the anchor to insert the payload after');

mkdirSync(resolve(root, 'dist'), { recursive: true });
const out = resolve(root, 'dist/install-gilmok.sh');
// LF regardless of platform. Authored on Windows, run on a server: a CRLF here
// makes `sh` report `set: Illegal option -`, which names neither the file's
// problem nor the line with it.
writeFileSync(out, script.replace(/\r\n/g, '\n'), 'utf8');
chmodSync(out, 0o755);

const kb = (n) => `${Math.round(n / 1024)} KB`;
process.stdout.write(
  `\n  dist/install-gilmok.sh  ${kb(script.length)}  (${Object.keys(files).length} bundles, ${kb(
    Object.values(files).reduce((n, f) => n + f.length, 0),
  )} uncompressed)\n\n` +
    `  scp dist/install-gilmok.sh <server>:\n` +
    `  ssh <server> 'sh install-gilmok.sh'\n\n`,
);
