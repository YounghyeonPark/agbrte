/**
 * The pass that actually fires a routine (DESIGN.md §4.4, §6.4).
 *
 * `schedules.test.ts` covers the arithmetic; this covers the half with a disk
 * and a clock in it, which is where the expensive mistakes are. A schedule that
 * starts a run twice spends twice, and one that records nothing starts again on
 * every tick for as long as whatever went wrong keeps going.
 *
 * Driven with an injected clock and a counter rather than by waiting, because a
 * test that sleeps for a minute to watch a minute-long interval is a test
 * nobody runs.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ScheduleRunner } from '@main/schedules/runner.js';
import { readSchedules, writeSchedules, type WorkflowSchedule } from '@main/store/schedules.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  dirs.length = 0;
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-sched-run-'));
  dirs.push(dir);
  return dir;
}

const BUDGET = { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 };

const daily = (minute: number, over: Partial<WorkflowSchedule> = {}): WorkflowSchedule => ({
  workflowId: 'nightly',
  every: { kind: 'daily', minute },
  budget: BUDGET,
  enabled: true,
  ...over,
});

const at = (day: number, hour: number, minute = 0): Date =>
  new Date(2026, 0, day, hour, minute, 0, 0);

/** A runner over one workspace, with everything it reaches for recorded. */
function rig(root: string, opts: { running?: boolean; fail?: string } = {}) {
  const started: string[] = [];
  const said: string[] = [];
  let now = at(1, 8);
  const runner = new ScheduleRunner({
    workspaces: () => [root],
    running: () => opts.running === true,
    run: (_root, schedule) => {
      if (opts.fail !== undefined) return Promise.reject(new Error(opts.fail));
      started.push(schedule.workflowId);
      return Promise.resolve();
    },
    report: (line) => said.push(line),
    now: () => now,
  });
  return {
    started,
    said,
    runner,
    clock: (to: Date) => {
      now = to;
    },
  };
}

describe('a pass over the workspaces this host holds', () => {
  it('starts a run when the hour arrives, and not before', async () => {
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const r = rig(root);

    r.clock(at(2, 8));
    await r.runner.tick();
    expect(r.started).toEqual([]);

    r.clock(at(2, 9));
    await r.runner.tick();
    expect(r.started).toEqual(['nightly']);
  });

  it('records the run before starting it, so a crash costs one rather than a loop', async () => {
    /*
     * The order matters more than it looks. Recording after would mean a crash
     * between the two leaves the schedule due, and the next tick starts it
     * again — each one spending a budget, forever, for as long as whatever
     * crashed keeps crashing. Recording first costs one skipped run.
     */
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const r = rig(root, { fail: 'the document is gone' });

    r.clock(at(2, 9));
    await r.runner.tick();

    expect((await readSchedules(root))[0]?.lastRunAt).toBe(at(2, 9).toISOString());
    // And the failure is said rather than swallowed: there is no caller to
    // raise it to, and a routine that quietly does nothing looks like one that
    // works.
    expect(r.said.join(' ')).toContain('would not start');
  });

  it('does not fire the same schedule twice in one day', async () => {
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const r = rig(root);

    r.clock(at(2, 9));
    await r.runner.tick();
    r.clock(at(2, 9, 1));
    await r.runner.tick();
    r.clock(at(2, 14));
    await r.runner.tick();

    expect(r.started).toEqual(['nightly']);
  });

  it('runs once for the days the machine was off, not once per day', async () => {
    // The mornings those runs were for have been and gone. Three at once is a
    // bill nobody asked for — and never running at all is the failure this
    // whole feature exists to avoid, so it is one, late.
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const r = rig(root);

    r.clock(at(5, 10));
    await r.runner.tick();
    await r.runner.tick();

    expect(r.started).toEqual(['nightly']);
  });

  it('skips one whose previous run is still going, and says so', async () => {
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const r = rig(root, { running: true });

    r.clock(at(2, 9));
    await r.runner.tick();

    expect(r.started).toEqual([]);
    expect(r.said.join(' ')).toContain('has not finished');
    // And the clock did not move, so it is still due when the run finishes.
    expect((await readSchedules(root))[0]?.lastRunAt).toBe(at(1, 9).toISOString());
  });

  it('carries on past a workspace it cannot read', async () => {
    /*
     * A background job has no caller to hand a failure to, so one broken
     * workspace must not take the others down with it. Asserted through a
     * directory that is not a workspace at all, which is what a folder deleted
     * under a running host looks like.
     */
    const root = await workspace();
    await writeSchedules(root, [daily(9 * 60, { lastRunAt: at(1, 9).toISOString() })]);
    const started: string[] = [];
    const runner = new ScheduleRunner({
      workspaces: () => [join(root, 'not-a-workspace'), root],
      running: () => false,
      run: (_r, s) => {
        started.push(s.workflowId);
        return Promise.resolve();
      },
      report: () => undefined,
      now: () => at(2, 9),
    });

    await runner.tick();
    expect(started).toEqual(['nightly']);
  });

  it('does nothing at all for a workspace with no schedules', async () => {
    const root = await workspace();
    const r = rig(root);
    r.clock(at(2, 9));
    await r.runner.tick();
    expect(r.started).toEqual([]);
    expect(r.said).toEqual([]);
  });
});
