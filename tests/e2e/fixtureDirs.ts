/**
 * The temporary directories this suite makes, and getting rid of them.
 *
 * ## What went wrong without it
 *
 * `launch` removes its Electron profile and `serveWebFixture` removes its repo,
 * but `makeRepo` is called directly from about fifty places across the specs and
 * nothing removed those. A day of running the suite left **1,911** folders and
 * 21 GB under the system temp directory — most of it `node_modules` from
 * install probes, plus one workspace per `makeRepo` call per run, each with its
 * own `.agbrte/` and a session or two inside.
 *
 * Cleaning up at each call site would mean editing fifty tests and would be
 * forgotten by the fifty-first. So the *creators* record what they made, and one
 * teardown removes exactly that.
 *
 * ## A list on disk, not a list in memory
 *
 * Playwright runs `globalTeardown` in a different process from the workers, so a
 * module-level array here would be empty by the time anything read it. A file
 * survives the boundary, and appending to it is safe from parallel workers
 * because each line is written in one `appendFile` call.
 *
 * Deliberately *not* a prefix sweep of the temp directory. Deleting everything
 * matching `agbrte-*` would also delete a second run's fixtures on a machine
 * where somebody has two checkouts going, and a cleanup that can reach into
 * another process's working state is worse than the litter it removes.
 *
 * ## Kept when a run fails, and when asked
 *
 * A failed test is the one case where the folder is worth having: it holds the
 * `.agbrte/` the failure happened in. `globalTeardown` therefore removes nothing
 * unless the run passed, and `AGBRTE_KEEP_FIXTURES=1` keeps them regardless —
 * for the case where a *passing* run left something worth reading.
 */

import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Where the list lives, passed to the workers through the environment.
 *
 * Named by `globalSetup` and read by `globalTeardown`; a worker that finds no
 * variable — somebody running one spec through an IDE, say — records nothing
 * and cleans up nothing, which is the same behaviour the suite had before.
 */
export const LEDGER_ENV = 'AGBRTE_FIXTURE_LEDGER';

/** Remember a directory so the teardown can remove it. */
export async function recordFixture(dir: string): Promise<void> {
  const ledger = process.env[LEDGER_ENV];
  if (ledger === undefined || ledger === '') return;
  // One `appendFile` per path: the call is atomic enough for lines this short,
  // which is what makes this safe from more than one worker at a time.
  await appendFile(ledger, `${dir}\n`, 'utf8').catch(() => undefined);
}

/** `mkdtemp`, remembered. */
export async function tempFixture(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await recordFixture(dir);
  return dir;
}

/** Start a fresh ledger, and hand back the path to put in the environment. */
export async function openLedger(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), 'agbrte-ledger-')), 'fixtures.txt');
  await writeFile(path, '', 'utf8');
  return path;
}

/**
 * Remove every directory the run recorded, and the ledger with it.
 *
 * Failures are swallowed per path. On Windows a directory can be held open by a
 * process that has not finished exiting — a detached host inside its linger
 * window — and one such folder must not stop the other nine hundred being
 * removed. What is left behind is what was left behind before this existed.
 */
export async function removeRecorded(ledger: string): Promise<{ removed: number; left: number }> {
  let listed: string[];
  try {
    listed = (await readFile(ledger, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch {
    return { removed: 0, left: 0 };
  }
  let removed = 0;
  let left = 0;
  for (const dir of listed) {
    try {
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      left += 1;
    }
  }
  await rm(join(ledger, '..'), { recursive: true, force: true }).catch(() => undefined);
  return { removed, left };
}
