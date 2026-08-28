/**
 * Removes the temporary directories the run made — when the run passed.
 *
 * `launch` and `serveWebFixture` already clean up after themselves; `makeRepo`
 * never did, and it is called from about fifty places. A day of running this
 * suite left **1,911** folders and 21 GB under the system temp directory. See
 * `fixtureDirs.ts` for why the list is a file rather than an array.
 *
 * ## Where the pass/fail answer comes from, after two wrong guesses
 *
 * `globalTeardown`'s second parameter is typed as the run's result and arrives
 * `undefined` — measured, after a deliberately failing spec was cleaned up
 * anyway. So the logic moved to a reporter, whose `onEnd` genuinely is handed
 * the status. That was worse: `--reporter=line` on the command line *replaces*
 * the configured reporters, so the cleanup silently stopped happening for
 * anyone who picked a reporter, which is most runs.
 *
 * Playwright writes `test-results/.last-run.json` on every run, under every
 * reporter, before this hook is called. Reading it is neither of the clever
 * answers and is the one that is always there.
 *
 * ## Kept when a run fails, and when asked
 *
 * A failed test is the one case where its workspace is worth having: it holds
 * the `.agbrte/` the failure happened in, with the event log that explains it.
 * `AGBRTE_KEEP_FIXTURES=1` keeps them from a green run too.
 *
 * Nothing here may fail the run. A directory a departing host still holds open
 * on Windows is a normal outcome rather than a test result, so the count is
 * printed and never thrown.
 */

import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LEDGER_ENV, removeRecorded } from './fixtureDirs.js';

/**
 * Whether anything failed, read from what Playwright has already written.
 *
 * A failing test gets a directory under `test-results/` holding its trace and
 * error context, and it is written *as the test fails* — so by the time this
 * runs, one such directory means one such failure. `.last-run.json` would be the
 * obvious file to read and is written *after* this hook, which is the third
 * thing that looked like the answer and was not.
 *
 * Only directories count: `.last-run.json` itself sits in the same folder, left
 * over from the previous run, and counting files would report every run as a
 * failure from the second one onward.
 */
async function somethingFailed(): Promise<boolean> {
  try {
    const entries = await readdir(resolve(import.meta.dirname, '..', '..', 'test-results'), {
      withFileTypes: true,
    });
    return entries.some((e) => e.isDirectory());
  } catch {
    // No folder at all is what a run with no failures looks like on a clean
    // checkout, and is the one state that is unambiguously green.
    return false;
  }
}

export default async function globalTeardown(): Promise<void> {
  const ledger = process.env[LEDGER_ENV];
  if (ledger === undefined || ledger === '') return;

  if (process.env['AGBRTE_KEEP_FIXTURES'] === '1') {
    process.stdout.write(`\n  fixtures kept, as asked — the list is ${ledger}\n`);
    return;
  }

  /*
   * The two ways to be wrong are not symmetric, which is why an unreadable
   * answer keeps rather than removes: keeping too much costs disk on a machine
   * somebody can clear, and removing too much costs the evidence for a failure
   * that has already happened.
   */
  if (await somethingFailed()) {
    process.stdout.write(`\n  fixtures kept for the failure — the list is ${ledger}\n`);
    return;
  }

  const { removed, left } = await removeRecorded(ledger);
  if (removed + left > 0) {
    process.stdout.write(
      `\n  removed ${removed} fixture director${removed === 1 ? 'y' : 'ies'}` +
        `${left > 0 ? `, ${left} still held open` : ''}\n`,
    );
  }
}
