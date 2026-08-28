/**
 * Refuse to run the e2e suite against a stale build.
 *
 * The suite launches `dist/main/main.js`, not the TypeScript. `npm run e2e`
 * builds first, and so does CI — but `npx playwright test` does not, and there
 * is nothing about the output that says so. A run against yesterday's `dist`
 * passes, fails, and reports timings exactly like a real one.
 *
 * That is not hypothetical. A change to the harness runtime was measured over
 * twenty live runs, showed no effect, and was nearly reverted as a failed
 * hypothesis — because every one of those runs had executed the previous build.
 * A test that silently checks the wrong code is worse than one that does not
 * run, because it produces numbers.
 *
 * So: compare mtimes and refuse. The cost of being wrong here is one rebuild;
 * the cost of not checking is a conclusion drawn from nothing.
 */

import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LEDGER_ENV, openLedger } from './fixtureDirs.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Newest mtime beneath a directory, or 0 if it does not exist. */
async function newestUnder(dir: string): Promise<number> {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, await newestUnder(path));
    } else if (/\.(ts|tsx|css)$/.test(entry.name)) {
      newest = Math.max(newest, (await stat(path)).mtimeMs);
    }
  }
  return newest;
}

export default async function globalSetup(): Promise<void> {
  /*
   * Opened before the staleness check, so the variable reaches the workers even
   * on a run that is about to be refused — the refusal happens before any
   * fixture is made, but a setup that half-configures the environment depending
   * on where it threw is a thing nobody wants to reason about later.
   *
   * `fixtureDirs.ts` explains what the file is for and what removes it.
   */
  process.env[LEDGER_ENV] = await openLedger();

  const source = await newestUnder(join(ROOT, 'src'));

  /*
   * Every bundle the suite actually launches, and the *oldest* of them.
   * Checking only `main.js` would miss exactly the case that caused this: the
   * runtime lives in the agent-host bundle, so a rebuilt main and a stale host
   * is a real and undetectable state.
   */
  const artefacts = ['main/main.js', 'main/agentHost.js', 'cli/agbrte.js'];
  let built = Infinity;
  for (const rel of artefacts) {
    try {
      built = Math.min(built, (await stat(join(ROOT, 'dist', rel))).mtimeMs);
    } catch {
      throw new Error(
        `dist/${rel} is missing — the e2e suite runs the build, not the source.\n` +
          `Run \`npm run e2e\` (which builds first) instead of \`npx playwright test\`.`,
      );
    }
  }

  if (source > built) {
    const age = Math.round((source - built) / 1000);
    throw new Error(
      `The build is ${age}s older than the newest source file.\n` +
        `These tests launch dist/, so they would be measuring the previous build.\n` +
        `Run \`npm run e2e\`, or \`npm run build\` first if you want to keep using \`npx playwright test\`.`,
    );
  }
}
