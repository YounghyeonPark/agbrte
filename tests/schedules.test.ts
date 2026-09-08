/**
 * When a routine fires, and when it deliberately does not (DESIGN.md §4.4, §4.3).
 *
 * The arithmetic is separated from the clock and the disk because this is the
 * half that is easy to get quietly wrong and impossible to *see* wrong: a
 * schedule that fires twice, or never, looks exactly like one nothing has
 * reached yet. Every case below is a way it could be confidently wrong.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dueNow,
  nextDue,
  readSchedules,
  validateSchedule,
  writeSchedules,
  MIN_INTERVAL_MS,
  type WorkflowSchedule,
} from '@main/store/schedules.js';

const BUDGET = { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 };

const every = (ms: number, over: Partial<WorkflowSchedule> = {}): WorkflowSchedule => ({
  workflowId: 'nightly',
  every: { kind: 'interval', ms },
  budget: BUDGET,
  enabled: true,
  ...over,
});

const daily = (minute: number, over: Partial<WorkflowSchedule> = {}): WorkflowSchedule => ({
  workflowId: 'nightly',
  every: { kind: 'daily', minute },
  budget: BUDGET,
  enabled: true,
  ...over,
});

/** A local time, since `daily` is local — see the module's own reasoning. */
const at = (day: number, hour: number, minute = 0): Date =>
  new Date(2026, 0, day, hour, minute, 0, 0);

describe('when an interval is next due', () => {
  it('is due immediately when it has never run', () => {
    // "Every six hours" with no history has no anchor but the present. The
    // alternative — waiting six hours before the first one — makes saving a
    // schedule feel like nothing happened.
    expect(nextDue(every(6 * 3_600_000), at(1, 16)).getTime()).toBe(at(1, 16).getTime());
  });

  it('measures from the last run, not from the wall clock', () => {
    const s = every(6 * 3_600_000, { lastRunAt: at(1, 9).toISOString() });
    expect(nextDue(s, at(1, 12)).getTime()).toBe(at(1, 15).getTime());
  });

  it('treats an unreadable timestamp as never having run', () => {
    // A hand-edited file, or one from a build that wrote it differently. The
    // honest reading of a date nobody can parse is that there is none.
    const s = every(3_600_000, { lastRunAt: 'the other day' });
    expect(nextDue(s, at(1, 16)).getTime()).toBe(at(1, 16).getTime());
  });
});

describe('when a daily is next due', () => {
  it('waits for its hour rather than firing when it was saved', () => {
    /*
     * The difference from an interval, and it is deliberate. "At nine" has an
     * anchor of its own, so a schedule typed at four in the afternoon must not
     * run at four in the afternoon — which is what treating it like an interval
     * with no history would do.
     */
    expect(nextDue(daily(9 * 60), at(1, 16)).getTime()).toBe(at(2, 9).getTime());
    expect(nextDue(daily(9 * 60), at(1, 7)).getTime()).toBe(at(1, 9).getTime());
  });

  it('does not arm a second run in the same day', () => {
    // A run at 09:01 must not make 09:02 due again. Comparing by day rather
    // than by distance is what stops that, and a minute is all the room a tick
    // needs to get it wrong.
    const s = daily(9 * 60, { lastRunAt: at(1, 9, 1).toISOString() });
    expect(nextDue(s, at(1, 9, 2)).getTime()).toBe(at(2, 9).getTime());
  });

  it('is due again the next day, once', () => {
    const s = daily(9 * 60, { lastRunAt: at(1, 9).toISOString() });
    expect(nextDue(s, at(2, 8)).getTime()).toBe(at(2, 9).getTime());
  });
});

describe('what stops a run', () => {
  it('does not catch up on the mornings the machine was off', () => {
    /*
     * A host that was off for three days comes back to one run, not three. The
     * mornings those runs were for have been and gone, and three at once is a
     * bill nobody asked for — which is the same reasoning §4.3 uses to refuse a
     * limit imposed by a mechanism rather than by anybody's intent.
     */
    const s = daily(9 * 60, { lastRunAt: at(1, 9).toISOString() });
    expect(dueNow(s, at(4, 10), { running: false }).run).toBe(true);
    // And the next one is tomorrow, not the two that were missed.
    const after = { ...s, lastRunAt: at(4, 10).toISOString() };
    expect(dueNow(after, at(4, 11), { running: false }).run).toBe(false);
  });

  it('does not start a second run over one still going, and says why', () => {
    // A run fans out into children, so two at once spend twice and write into
    // one workspace together — §4.2's reasoning for capping a session at one
    // agent, one level up.
    const s = every(MIN_INTERVAL_MS, { lastRunAt: at(1, 1).toISOString() });
    const verdict = dueNow(s, at(2, 1), { running: true });
    expect(verdict.run).toBe(false);
    // Recorded, not passed over: a schedule that has quietly done nothing for a
    // week looks exactly like one that is working.
    expect(verdict.skipped).toMatch(/has not finished/);
  });

  it('says nothing when a disabled one is simply not due', () => {
    // Off is not a skip. A skip is something that would have run; reporting one
    // every tick for a schedule somebody turned off is noise that buries the
    // ones that mean something.
    expect(dueNow(every(3_600_000, { enabled: false }), at(9, 9), { running: false })).toEqual({
      run: false,
    });
  });
});

describe('what is refused', () => {
  it('refuses an interval short enough to be a loop', () => {
    expect(() => validateSchedule(every(1_000))).toThrow(/refused/);
    expect(() => validateSchedule(every(MIN_INTERVAL_MS))).not.toThrow();
  });

  it('refuses a daily time that is not a time', () => {
    expect(() => validateSchedule(daily(-1))).toThrow(/minutes past midnight/);
    expect(() => validateSchedule(daily(1_440))).toThrow(/minutes past midnight/);
    expect(() => validateSchedule(daily(0))).not.toThrow();
    expect(() => validateSchedule(daily(1_439))).not.toThrow();
  });
});

describe('the file', () => {
  const scratch = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-sched-'));
    return dir;
  };

  it('is absent until something is written, which is not a failure', async () => {
    const root = await scratch();
    try {
      expect(await readSchedules(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('round-trips, and lands under run/ where git does not follow', async () => {
    const root = await scratch();
    try {
      await writeSchedules(root, [daily(9 * 60)]);
      expect(await readSchedules(root)).toEqual([daily(9 * 60)]);
      /*
       * `run/` and not beside `templates/`, which is the whole of the sharing
       * question: templates are tracked, so a schedule written there would
       * start running on a colleague's machine the moment they pulled.
       */
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(join(root, '.agbrte', 'run', 'schedules.json'), 'utf8')).toContain(
        'nightly',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a corrupt file as no schedules rather than refusing to start', async () => {
    const root = await scratch();
    try {
      await mkdir(join(root, '.agbrte', 'run'), { recursive: true });
      await writeFile(join(root, '.agbrte', 'run', 'schedules.json'), '{ not json', 'utf8');
      /*
       * The opposite of `endpoints.json`, and for the opposite reason: there, a
       * file that cannot be read means turns would go somewhere nobody chose,
       * so it refuses. Here it means nothing runs, which is the safe direction —
       * and a host that will not start because of a stray comma in a routine is
       * worse than a routine that does not fire.
       */
      expect(await readSchedules(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses the whole write when one entry is unusable', async () => {
    const root = await scratch();
    try {
      await writeSchedules(root, [daily(9 * 60)]);
      await expect(writeSchedules(root, [daily(9 * 60), every(1_000)])).rejects.toThrow(/refused/);
      // The good one that was already there survives, because nothing was
      // written — a half-applied list is the state nobody can reason about.
      expect(await readSchedules(root)).toEqual([daily(9 * 60)]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
