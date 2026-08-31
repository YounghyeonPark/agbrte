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
 * Where the launched apps are listed. Beside the directory ledger, same reason.
 *
 * A separate file rather than a second column, because the two are cleaned on
 * different rules: a directory is kept when the run fails, and a process never
 * is. See `reapRecorded`.
 */
function processLedger(ledger: string): string {
  return join(ledger, '..', 'processes.txt');
}

/**
 * Remember an app the suite started, so the teardown can make sure it is gone.
 *
 * `launch` closes its own app, Playwright closes any it forgot, and between them
 * that is almost always enough. Twice it was not: after two separate full runs,
 * two `electron.exe` processes were still holding their workspaces — measured,
 * and killed by hand.
 *
 * That is not a tidiness problem, because the cost compounds. Both of those runs
 * took about 11.9 minutes against a normal 5.7; on one of them the live-model
 * test blew its 180s timeout and `files.spec.ts` then failed on a picker that
 * could not populate in thirty seconds, and both passed in 8.5s and 20s once the
 * strays were killed. One failure became three because the first left something
 * behind.
 *
 * **The mechanism is not established, and two guesses at it were already wrong.**
 *
 * A single spec that times out with an app open does *not* leak — Playwright
 * closes it, checked deliberately with a throwaway spec that timed out on
 * purpose. So "an aborted test never runs its `finally`" is not the answer,
 * though it was the obvious one.
 *
 * Nor is it about failing runs. The first run this actually caught was **green**:
 * 68 passed, nothing timed out, and one app was still holding its workspace when
 * the teardown ran. That also rules out the second guess, which was a worker torn
 * down hard between the retries of the live-model block.
 *
 * What is left, and it is a better lead than "occasionally": **every green full
 * run measured since has leaked exactly one.** Two in a row, one app each. That
 * is not a race — a race would sometimes leak none — and it is not the failing
 * tests, which had none. Something in a full run reliably starts an app that
 * nothing closes, and the count being one makes it findable: the ledger is
 * written in launch order, so the survivor's position in it names the spec.
 *
 * It is also not a shutdown that had not finished. The two apps found by hand
 * before this existed were still running minutes later, on a machine doing
 * nothing.
 *
 * This does not wait for the reason, because it does not need it: every app the
 * suite starts is recorded here, so a survivor is killed whatever made it one.
 *
 * By pid, and never by process name. `electron.exe` is a name the developer's
 * own work may also be running under, and a teardown that kills by name is one
 * that closes somebody's editor.
 */
export async function recordProcess(pid: number | undefined): Promise<void> {
  const ledger = process.env[LEDGER_ENV];
  if (ledger === undefined || ledger === '' || pid === undefined) return;
  await appendFile(processLedger(ledger), `${pid}\n`, 'utf8').catch(() => undefined);
}

/**
 * Kill anything the run started that is still running.
 *
 * **Always, including when the run failed** — the opposite rule to the
 * directories beside it, and the asymmetry is the point. A kept directory is
 * evidence at rest: it holds the `.agbrte/` a failure happened in and costs
 * disk. A surviving process is not evidence, because Playwright has already
 * captured the trace and the error context; it is a resource that goes on
 * consuming, and on the next run it is a slower machine.
 *
 * `signal 0` first, so the normal case — everything closed itself — reports
 * nothing rather than a list of pids that were already gone. A pid that has
 * been reused by an unrelated process is the one real hazard here, and the
 * window for it is the minutes between a test aborting and the teardown; small
 * enough to accept, and the alternative is matching on a process name, which is
 * worse in a way that cannot be bounded.
 */
export async function reapRecorded(ledger: string): Promise<number> {
  let listed: string[];
  try {
    listed = (await readFile(processLedger(ledger), 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch {
    return 0;
  }
  let killed = 0;
  for (const line of listed) {
    const pid = Number(line);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0);
    } catch {
      continue; // Already gone, which is what a green run looks like.
    }
    try {
      process.kill(pid, 'SIGKILL');
      killed += 1;
    } catch {
      // Not ours to kill, or it exited between the two calls. Either way the
      // teardown has nothing useful to say and must not fail the run.
    }
  }
  return killed;
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
