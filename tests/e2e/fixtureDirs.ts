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
 * **Two things survive a run, and for most of a day only one of them was
 * suspected.** The corrections are kept because each was believed on evidence.
 *
 * *Apps.* Two green full runs each left one behind — not a race, which would
 * sometimes leave none. Why is still unknown, and two guesses are ruled out: a
 * spec written to time out with an app open does not leak, Playwright closes it;
 * and the runs it was caught on were green, so it is not a worker torn down
 * between the live-model block's retries. The ledger is in launch order, so the
 * survivor's position names the spec, which is where to look next.
 *
 * *Hosts, which were the ones actually costing anything.* Every `electron.exe`
 * counted by hand was very likely one of these rather than an app: a host is
 * spawned with `process.execPath`, which inside Electron *is* `electron.exe`.
 * See `hostPids` for what keeps one alive and how it is found. That is also why
 * "the two apps found by hand were still running minutes later" — an earlier
 * version of this paragraph — was true about the processes and wrong about what
 * they were.
 *
 * None of this waits for a full explanation, because it does not need one:
 * every app the suite starts is recorded here, every workspace it makes records
 * its own host, and a survivor of either kind is killed whatever made it one.
 *
 * By pid, and never by process name. `electron.exe` is a name the developer's
 * own work may also be running under, and a teardown that kills by name is one
 * that closes somebody's editor.
 */
export async function recordProcess(pid: number | undefined, who?: string): Promise<void> {
  const ledger = process.env[LEDGER_ENV];
  if (ledger === undefined || ledger === '' || pid === undefined) return;
  // Tab-separated, and the label may be absent: a line is still a pid to
  // anything that only wants pids, which is what this file was before.
  const line = who === undefined || who === '' ? `${pid}` : `${pid}\t${who.replace(/\s+/g, ' ')}`;
  await appendFile(processLedger(ledger), `${line}\n`, 'utf8').catch(() => undefined);
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
export async function reapRecorded(ledger: string): Promise<{ killed: number; who: string[] }> {
  const apps = await recordedApps(ledger);
  const entries = [
    ...apps,
    ...(await hostPids(ledger)).map((pid) => ({ pid, who: 'a session host' })),
  ];
  let killed = 0;
  const who: string[] = [];
  for (const entry of entries) {
    try {
      process.kill(entry.pid, 0);
    } catch {
      continue; // Already gone, which is what a green run mostly looks like.
    }
    try {
      process.kill(entry.pid, 'SIGKILL');
      killed += 1;
      who.push(entry.who);
    } catch {
      // Not ours to kill, or it exited between the two calls. Either way the
      // teardown has nothing useful to say and must not fail the run.
    }
  }
  return { killed, who };
}

/**
 * The apps `launch` started, each with the test that started it.
 *
 * The label is why this stopped being a list of numbers. Exactly one app
 * survives a full run — reliably one, which is what rules out a race — and the
 * note above says the ledger is in launch order so the survivor's *position*
 * names the spec. That is true and it is a manual step nobody performs at the
 * moment the information is free: the teardown can simply say which test, and
 * then the next green run that leaks reports its own suspect instead of leaving
 * somebody to count lines.
 *
 * Old lines with no label still parse, because a ledger written by a half-built
 * checkout is not worth an exception.
 */
async function recordedApps(ledger: string): Promise<Array<{ pid: number; who: string }>> {
  try {
    return (await readFile(processLedger(ledger), 'utf8'))
      .split('\n')
      .map((line) => {
        const [rawPid, label] = line.split('\t');
        return { pid: Number((rawPid ?? '').trim()), who: label?.trim() ?? 'an app (unlabelled)' };
      })
      .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
  } catch {
    return [];
  }
}

/**
 * The **session hosts** those apps started, read from each fixture's own record.
 *
 * This is the half that was actually keeping the machine busy, and finding it
 * corrected two things at once.
 *
 * A host is spawned with `process.execPath`, which inside Electron is
 * `electron.exe` — so every "leaked Electron" counted by hand was very likely a
 * host and its forked agent host, not an app. And a host is *meant* to outlive
 * the app (§8); the tests set `AGBRTE_HOST_LINGER_MS=3000` so it goes shortly
 * after. It only goes when **idle**, and a session left waiting on a permission
 * prompt is not idle. Measured: a host from a timed-out live-model test was
 * still running twelve minutes later, its last event an `agent.tool_use` four
 * seconds in, holding a workspace and an agent host with it.
 *
 * That behaviour is right for a person — a pending decision is state worth
 * coming back to — and wrong for a suite that makes fifty throwaway workspaces.
 *
 * Found through `host.json` rather than by matching command lines, which would
 * be platform-specific and would have to guess at what is ours. §6.4 says a
 * record is a hint and only a socket answering is a fact; that is the rule for
 * *deciding a host is alive*, and this is asking the opposite question of a
 * directory the suite created itself. `process.kill(pid, 0)` supplies the
 * missing half, and a stale record simply names a pid that is already gone.
 */
async function hostPids(ledger: string): Promise<number[]> {
  let dirs: string[];
  try {
    dirs = (await readFile(ledger, 'utf8')).split('\n').filter((l) => l.trim() !== '');
  } catch {
    return [];
  }
  const found: number[] = [];
  for (const dir of dirs) {
    try {
      const record = JSON.parse(await readFile(join(dir, '.agbrte', 'host.json'), 'utf8')) as {
        pid?: unknown;
      };
      if (typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0) {
        found.push(record.pid);
      }
    } catch {
      // No workspace, no record, or a half-written one. All three mean there is
      // no host to reap here, which is the ordinary case for a fixture that was
      // never opened.
    }
  }
  return found;
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
