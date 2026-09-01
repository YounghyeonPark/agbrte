/**
 * The e2e suite's own cleanup, tested where it can be (DESIGN.md §14).
 *
 * `reapRecorded` kills two things a run leaves behind — the apps `launch`
 * started, and the **session hosts** those apps started — and neither can be
 * produced on demand from inside the e2e suite. A spec written to time out with
 * an app open does not leak one, checked deliberately; and a stuck host needs a
 * live model to hang mid-turn, which costs three minutes and makes every run
 * red. So the mechanism is exercised here against real processes that are not
 * Electron, and the e2e suite covers the one line neither of these can: that
 * `launch` and a real workspace record the right pids.
 *
 * Two properties are worth the file on their own.
 *
 * **By pid, never by name.** This runs on a developer's machine, where
 * `electron.exe` is a name their own work may also be running under — and,
 * confusingly, the name a *host* runs under too, since one is spawned with
 * `process.execPath`. A teardown matching on it would close somebody's editor.
 *
 * **Only what the suite made.** A host is found through the `host.json` inside a
 * recorded fixture directory, so a real workspace open in the app next door is
 * never even read.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_ENV,
  openLedger,
  recordExit,
  recordFixture,
  recordProcess,
  reapRecorded,
  removeRecorded,
} from './e2e/fixtureDirs.js';

const started: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) child.kill('SIGKILL');
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env[LEDGER_ENV];
});

/** A process that will sit there until something kills it. */
function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  // Killing a process that is already on its way out emits `error` on the
  // handle, and a `ChildProcess` with no listener for it throws — which vitest
  // reports as "1 error was not a part of any test", attached to whatever ran
  // last. This whole file is about killing things, so it is the file most
  // likely to produce one.
  child.on('error', () => undefined);
  started.push(child);
  return child;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ledger(): Promise<string> {
  const path = await openLedger();
  dirs.push(join(path, '..'));
  process.env[LEDGER_ENV] = path;
  return path;
}

describe('apps a run left running', () => {
  it('kills a recorded process that is still alive', async () => {
    const path = await ledger();
    const child = sleeper();
    await recordProcess(child.pid);

    expect(alive(child.pid as number)).toBe(true);
    expect((await reapRecorded(path)).killed).toBe(1);
    // `kill` is asynchronous on both platforms, so this waits rather than
    // asserting on the instant after.
    for (let i = 0; i < 50 && alive(child.pid as number); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(child.pid as number)).toBe(false);
  });

  it('counts nothing when everything closed itself, which is a green run', async () => {
    const path = await ledger();
    const child = sleeper();
    await recordProcess(child.pid);
    child.kill('SIGKILL');
    for (let i = 0; i < 50 && alive(child.pid as number); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }

    // The ordinary path. A report of "killed 3 apps" on every green run would be
    // noise that teaches people to stop reading the line.
    expect((await reapRecorded(path)).killed).toBe(0);
  });

  it('touches nothing that was not recorded', async () => {
    const path = await ledger();
    const recorded = sleeper();
    const bystander = sleeper();
    await recordProcess(recorded.pid);

    await reapRecorded(path);
    for (let i = 0; i < 50 && alive(recorded.pid as number); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    // The whole reason this is a ledger of pids rather than a process-name match.
    expect(alive(bystander.pid as number)).toBe(true);
  });

  it('is silent about a run that recorded nothing', async () => {
    const path = await ledger();
    expect((await reapRecorded(path)).killed).toBe(0);
  });

  it('ignores a line that is not a pid rather than throwing', async () => {
    // Nothing in the teardown may fail the run — a garbled ledger is a worse
    // outcome reported as a test result, which is what this file's neighbour
    // says about directories held open on Windows.
    const path = await ledger();
    await writeFile(join(path, '..', 'processes.txt'), 'not-a-number\n\n-1\n0\n', 'utf8');
    expect((await reapRecorded(path)).killed).toBe(0);
  });

  it('names the test that started a survivor, rather than its position in a list', async () => {
    const path = await ledger();
    const child = sleeper();
    await recordProcess(child.pid, 'app.spec.ts › the shell › opens on the chosen workspace');

    /*
     * The reason the ledger stopped being a list of numbers.
     *
     * Exactly one app survives a full run — reliably one, which is what ruled
     * out a race — and the note in `fixtureDirs.ts` said the launch order meant
     * the survivor's *position* named the spec. True, and a manual count that
     * nobody was going to do at 5am; the label costs nothing and the teardown
     * can print it.
     */
    const reaped = await reapRecorded(path);
    expect(reaped.killed).toBe(1);
    expect(reaped.who).toEqual(['app.spec.ts › the shell › opens on the chosen workspace']);
  });

  it('leaves alone a pid whose app was watched out of existence', async () => {
    const path = await ledger();
    const stranger = sleeper();

    /*
     * The bug this file spent a week describing as an app leak.
     *
     * The suite recorded a pid, the app at it exited, the OS handed the number
     * to something else, and the teardown found it alive and SIGKILLed it —
     * then printed it as "an app the run left running", which is how two green
     * runs produced a paragraph of confident reasoning about a race.
     *
     * Standing in for that here: the same number is recorded as an app and also
     * recorded as having been seen to exit. Whatever holds it now is not ours,
     * and matching a recycled number is no better than matching a process name,
     * which this file already refuses to do.
     */
    await recordProcess(stranger.pid, 'a test whose app exited long ago');
    await recordExit(stranger.pid);

    const reaped = await reapRecorded(path);
    expect(reaped.killed).toBe(0);
    expect(reaped.reused).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(stranger.pid as number)).toBe(true);
  });

  it('still kills one that was never seen to exit', async () => {
    // The other half, so the guard above cannot be satisfied by never killing
    // anything: an app the suite started and never watched go is still reaped.
    const path = await ledger();
    const child = sleeper();
    await recordProcess(child.pid, 'a test that really did leak');

    const reaped = await reapRecorded(path);
    expect(reaped.killed).toBe(1);
    expect(reaped.reused).toBe(0);
  });

  it('still reads a ledger written without labels', async () => {
    // A half-built checkout, or a ledger from before the label existed. A pid is
    // the part that matters and it is still there.
    const path = await ledger();
    const child = sleeper();
    await writeFile(join(path, '..', 'processes.txt'), `${child.pid}\n`, 'utf8');

    const reaped = await reapRecorded(path);
    expect(reaped.killed).toBe(1);
    expect(reaped.who[0]).toContain('unlabelled');
  });
});

describe('session hosts, which are what actually survives', () => {
  /**
   * A host writes its own pid to `<workspace>/.agbrte/host.json`, and the
   * directory ledger already names every workspace the suite made — so the two
   * together find a host without matching command lines, which would be
   * platform-specific and would have to guess at what is ours.
   *
   * Worth its own tests because a host is *meant* to outlive the app (§8) and
   * only goes when idle, and a session left waiting on a permission prompt is
   * not idle. Measured: one from a timed-out live-model test was still running
   * twelve minutes later against a three-second linger.
   */
  const workspaceHolding = async (pid: number): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-ledgerws-'));
    dirs.push(dir);
    await mkdir(join(dir, '.agbrte'), { recursive: true });
    await writeFile(join(dir, '.agbrte', 'host.json'), JSON.stringify({ pid }), 'utf8');
    return dir;
  };

  it('kills a host named by a recorded workspace', async () => {
    const path = await ledger();
    const child = sleeper();
    await recordFixture(await workspaceHolding(child.pid as number));

    expect((await reapRecorded(path)).killed).toBe(1);
    for (let i = 0; i < 50 && alive(child.pid as number); i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(alive(child.pid as number)).toBe(false);
  });

  it('ignores a workspace that never had a host', async () => {
    // The ordinary case: about fifty repos per run and most are never opened.
    const path = await ledger();
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-ledgerws-'));
    dirs.push(dir);
    await recordFixture(dir);
    expect((await reapRecorded(path)).killed).toBe(0);
  });

  it('survives a half-written record without throwing', async () => {
    // A host writing its record while the run ends is a real interleaving, and
    // nothing in the teardown may fail the run.
    const path = await ledger();
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-ledgerws-'));
    dirs.push(dir);
    await mkdir(join(dir, '.agbrte'), { recursive: true });
    await writeFile(join(dir, '.agbrte', 'host.json'), '{"pid":', 'utf8');
    await recordFixture(dir);
    expect((await reapRecorded(path)).killed).toBe(0);
  });

  it('does not read a workspace nobody recorded', async () => {
    /*
     * The property that keeps this away from the developer's own work. A host
     * record is only consulted for a directory this suite created, so a real
     * workspace open in the app next door is never even looked at.
     */
    const path = await ledger();
    const child = sleeper();
    await workspaceHolding(child.pid as number); // made, deliberately not recorded

    expect((await reapRecorded(path)).killed).toBe(0);
    expect(alive(child.pid as number)).toBe(true);
  });
});

describe('the two ledgers are separate on purpose', () => {
  it('keeps directories out of the process list and back again', async () => {
    /*
     * They are cleaned on opposite rules — a failed run keeps its directories
     * and never keeps its processes — so one file with two kinds of line would
     * make the teardown parse its way to a decision it can read directly.
     */
    const path = await ledger();
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-ledgertest-'));
    dirs.push(dir);
    const child = sleeper();
    await recordProcess(child.pid);

    expect(await readFile(path, 'utf8')).toBe('');
    expect(await readFile(join(path, '..', 'processes.txt'), 'utf8')).toContain(String(child.pid));

    // And removing directories says nothing about processes.
    const { removed } = await removeRecorded(path);
    expect(removed).toBe(0);
    expect(alive(child.pid as number)).toBe(true);
  });
});
