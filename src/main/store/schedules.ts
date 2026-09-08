/**
 * Workflows this workspace runs on a routine (DESIGN.md §4.4, §6.4, §5.1).
 *
 * ## Why the host owns this, and not the app
 *
 * Everything that *does* something belongs to the host; the app is a client
 * (§6.4). Preview servers set the precedent and settle it: they are started by
 * the host rather than by an agent or by the window, "so a preview survives the
 * turn that motivated it, the app closing, and the lid", and they stop when the
 * host stops. A schedule that lived in the window would fire only while
 * somebody was looking at it, which is the one thing a routine must not depend
 * on — "every morning" that skips the mornings you had the laptop shut is not a
 * routine, it is a coincidence.
 *
 * ## Why it lives in the workspace, under `run/`
 *
 * A schedule is a fact about *this workspace's* workflows, and §5.1 keeps the
 * two directories apart by what is in them: `~/.agbrte` is the machine's
 * install area — the private Node, the host bundles, `endpoints.json` — and
 * `<workspace>/.agbrte` holds one workspace's identity, memory, templates and
 * sessions. Putting a schedule in the machine's directory would leave it behind
 * when the folder moves (§5.3) or is deleted.
 *
 * `run/` rather than beside `templates/`, and that is the whole of the sharing
 * question: `templates/` is tracked, so a schedule written there would start
 * running on a colleague's machine the moment they pulled. `run/` is in the
 * nested `.gitignore` already, next to `sessions/` and `index/`.
 *
 * ## Two shapes, and no cron
 *
 * `daily` and `every`, which are the two things people actually ask for, and
 * neither needs a parser. This project has eight runtime dependencies and a
 * cron grammar would be a ninth to express something a dozen lines of
 * arithmetic already say. A schedule that cannot be written here is one nobody
 * has asked for yet.
 *
 * `daily` is in **local** time, because "nine in the morning" means the
 * morning of whoever typed it, on the machine that will run it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { workspaceLayout } from './layout.js';
import type { WorkflowSchedule } from '@shared/types/index.js';
export type { ScheduleEvery, WorkflowSchedule } from '@shared/types/index.js';

/** The file, which is a map so a workflow has at most one schedule. */
export interface ScheduleFile {
  schedules: WorkflowSchedule[];
}

const MINUTES_A_DAY = 24 * 60;

/** The lowest interval this will accept, so a typo cannot become a loop. */
export const MIN_INTERVAL_MS = 5 * 60 * 1000;

export class ScheduleRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ScheduleRejected';
  }
}

function schedulesPath(workspaceRoot: string): string {
  return `${workspaceLayout(workspaceRoot).runDir}/schedules.json`;
}

/**
 * Refused where it cannot be honoured, at the moment somebody can still fix it.
 *
 * The interval floor is the one that matters: `every: 0` is a run that starts
 * as soon as the last one is recorded, forever, spending a budget each time.
 * A number nobody can act on is worse than a refusal they can.
 */
export function validateSchedule(schedule: WorkflowSchedule): void {
  if (schedule.workflowId.trim() === '') throw new ScheduleRejected('name the workflow to run');
  if (schedule.every.kind === 'interval' && schedule.every.ms < MIN_INTERVAL_MS) {
    throw new ScheduleRejected(
      `an interval under ${MIN_INTERVAL_MS / 60_000} minutes is refused — a workflow run ` +
        'fans out into children, and one that restarts before it finishes is a bill rather ' +
        'than a routine',
    );
  }
  if (
    schedule.every.kind === 'daily' &&
    (!Number.isInteger(schedule.every.minute) ||
      schedule.every.minute < 0 ||
      schedule.every.minute >= MINUTES_A_DAY)
  ) {
    throw new ScheduleRejected('a daily time is minutes past midnight, from 0 to 1439');
  }
}

/**
 * When this schedule is next due, given when it last ran.
 *
 * Pure, and separated from everything that reads a clock or a disk, because
 * this is the half that is easy to get quietly wrong and impossible to see
 * wrong: a schedule that fires twice, or never, looks the same as one nobody
 * has reached yet.
 *
 * A schedule that has never run is due **now** for an interval, and at its next
 * occurrence for a daily one — see the daily branch for why those differ, and
 * for what an established schedule does when its hour has already gone by.
 */
export function nextDue(schedule: WorkflowSchedule, now: Date): Date {
  const last = schedule.lastRunAt === undefined ? null : new Date(schedule.lastRunAt);

  if (schedule.every.kind === 'interval') {
    if (last === null || Number.isNaN(last.getTime())) return now;
    return new Date(last.getTime() + schedule.every.ms);
  }

  const at = new Date(now);
  at.setHours(0, schedule.every.minute, 0, 0);
  const tomorrow = new Date(at);
  tomorrow.setDate(tomorrow.getDate() + 1);

  /*
   * A schedule that has never run waits for its next real occurrence; one that
   * has runs late rather than not at all.
   *
   * The first half is why a daily differs from an interval at all: "at nine"
   * has an anchor of its own, so one typed at four in the afternoon must not go
   * off at four in the afternoon.
   *
   * The second half is the one worth stating. Strictly honouring the window
   * would mean a machine that is off at nine every morning runs this *never* —
   * a routine that silently does nothing, which is the failure this whole
   * feature exists to avoid. So an established schedule whose hour has passed
   * is overdue rather than missed, and fires once. The days it was off for are
   * still not caught up: `lastRunAt` moves to now, and the next occurrence is
   * tomorrow's.
   */
  if (last === null || Number.isNaN(last.getTime())) {
    return now.getTime() < at.getTime() ? at : tomorrow;
  }
  // Comparing against `last` by the day's slot rather than by distance is what
  // stops a run at 09:01 from arming another at 09:02.
  return last.getTime() >= at.getTime() ? tomorrow : at;
}

/**
 * Whether this schedule should start a run now, and why not when it should not.
 *
 * The two refusals are the ones settled before any of this was written:
 *
 * **A missed window is not caught up.** A host that was off for three days does
 * not start three runs when it comes back — the mornings those runs were for
 * have been and gone, and three at once is a bill nobody asked for. It is
 * *recorded* rather than passed over silently, because a schedule that has
 * quietly done nothing for a week looks exactly like one that is working.
 *
 * **A run that is still going is not joined by another.** A workflow run fans
 * out into children, so two overlapping runs spend twice and write into one
 * workspace at once. The same reasoning §4.2 uses to cap a session at one
 * agent.
 */
export function dueNow(
  schedule: WorkflowSchedule,
  now: Date,
  opts: { running: boolean },
): { run: boolean; skipped?: string } {
  if (!schedule.enabled) return { run: false };
  if (opts.running) {
    return { run: false, skipped: 'the previous run has not finished' };
  }
  const due = nextDue(schedule, now);
  if (now.getTime() < due.getTime()) return { run: false };
  return { run: true };
}

/** What this workspace has, or nothing — an absent file is not a failure. */
export async function readSchedules(workspaceRoot: string): Promise<WorkflowSchedule[]> {
  let text: string;
  try {
    text = await readFile(schedulesPath(workspaceRoot), 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(text) as ScheduleFile;
    return Array.isArray(parsed.schedules) ? parsed.schedules : [];
  } catch {
    /*
     * An unreadable file is no schedules, not a broken host.
     *
     * The opposite of what `endpoints.json` does, and for the opposite reason:
     * there, a file that cannot be read means turns would go somewhere nobody
     * chose, so it refuses. Here it means nothing runs — which is the safe
     * direction, and a host that will not start because of a stray comma in a
     * routine is worse than a routine that does not fire.
     */
    return [];
  }
}

/** Replace the whole list, which is how one is added, edited or removed. */
export async function writeSchedules(
  workspaceRoot: string,
  schedules: WorkflowSchedule[],
): Promise<void> {
  for (const schedule of schedules) validateSchedule(schedule);
  const path = schedulesPath(workspaceRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ schedules }, null, 2)}\n`, 'utf8');
}
