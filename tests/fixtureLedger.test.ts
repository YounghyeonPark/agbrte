/**
 * The e2e suite's own cleanup, tested where it can be (DESIGN.md §14).
 *
 * `reapRecorded` kills apps a run left running, and the failure it exists for
 * cannot be reproduced from inside the e2e suite: it needs a test to *time out*,
 * which aborts before its `finally` and leaves an Electron behind. A spec that
 * deliberately times out costs three minutes and makes every run red.
 *
 * So the mechanism is checked here against real processes that are not Electron.
 * What is being asserted is the part that was written new — that a recorded pid
 * is killed, that one which already exited is not counted, and that nothing
 * outside the ledger is touched. Whether `launch` records the right pid is the
 * one line the e2e suite covers by using it.
 *
 * Kills by **pid and never by name**, which is the property worth pinning: this
 * runs on a developer's machine, `electron.exe` is a name their own work may
 * also be running under, and a teardown that matched on it would close somebody's
 * editor.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_ENV,
  openLedger,
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
    expect(await reapRecorded(path)).toBe(1);
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
    expect(await reapRecorded(path)).toBe(0);
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
    expect(await reapRecorded(path)).toBe(0);
  });

  it('ignores a line that is not a pid rather than throwing', async () => {
    // Nothing in the teardown may fail the run — a garbled ledger is a worse
    // outcome reported as a test result, which is what this file's neighbour
    // says about directories held open on Windows.
    const path = await ledger();
    await writeFile(join(path, '..', 'processes.txt'), 'not-a-number\n\n-1\n0\n', 'utf8');
    expect(await reapRecorded(path)).toBe(0);
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
