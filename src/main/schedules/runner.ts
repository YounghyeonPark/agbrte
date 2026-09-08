/**
 * The thing that actually fires a routine (DESIGN.md §4.4, §6.4).
 *
 * ## Why this lives in the host
 *
 * Everything that *does* something belongs to the host; the app is a client.
 * Preview servers settle it by precedent — started by the host "so a preview
 * survives the turn that motivated it, the app closing, and the lid" (§6.8),
 * and stopped when the host stops. A schedule kept in the window would fire
 * only while somebody was watching, which is the one thing a routine cannot
 * depend on.
 *
 * It stops with the host for the same reason a preview does: a timer outliving
 * the process that owns the workspace would be work starting with nothing left
 * that knows how to stop it.
 *
 * ## Why it polls rather than arming a timer per schedule
 *
 * A `setTimeout` for "nine tomorrow" is fifteen hours of trusting a clock that
 * a sleeping laptop stops advancing — the lid closes at eleven, the machine
 * suspends, and the timer comes back late by however long it slept, or not at
 * all. A poll asks the same question the pure `dueNow` answers, from whatever
 * the wall clock says *now*, so a suspend is indistinguishable from a host that
 * was busy. That is also what makes the missed-window rule expressible at all.
 *
 * The interval is a minute, which bounds how late a `daily` can be by a minute
 * and costs one file read per workspace per minute.
 */

import { dueNow, readSchedules, writeSchedules, type WorkflowSchedule } from '../store/schedules.js';

/** How often the question is asked. See the module note on why it is a poll. */
export const TICK_MS = 60_000;

export interface ScheduleRunnerDeps {
  /** The workspaces this host holds, asked afresh each tick — they come and go. */
  workspaces: () => string[];
  /**
   * Start a run, exactly as `workflow.run` does.
   *
   * Injected rather than reached for, so this module knows nothing about the
   * session server or the manager and can be driven by a test with a clock and
   * a counter.
   */
  run: (workspaceRoot: string, schedule: WorkflowSchedule) => Promise<void>;
  /**
   * Whether a run of this workflow is still going in that workspace.
   *
   * Asked rather than remembered: a host restart forgets what it started, and
   * the runs themselves are on the log where the answer actually is.
   */
  running: (workspaceRoot: string, workflowId: string) => boolean;
  /** Said out loud, because a routine that quietly does nothing looks like one that works. */
  report: (line: string) => void;
  now?: () => Date;
}

export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * The pass in flight, if there is one.
   *
   * A promise rather than a boolean, and not for style: a flag is read before
   * the awaits and cleared after them, which is `lint:race`'s shape exactly —
   * the guard happens to be safe because its write is adjacent to its read, and
   * "safe because of an adjacency nothing checks" is how the append counter
   * that lint exists for was safe too. Holding the pass itself removes the
   * question: a tick arriving during one joins it instead of starting a second.
   */
  private pass: Promise<void> | null = null;

  constructor(private readonly deps: ScheduleRunnerDeps) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Not `unref`'d: this is one of the reasons the host process stays up, the
    // same as a preview server or a session waiting on a turn.
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass over every workspace this host holds.
   *
   * Public so a test can advance it without a clock, and so the host can ask
   * for one at startup — a machine that was off through its schedule's hour
   * should not wait another minute to find that out.
   *
   * Never throws. A workspace whose file cannot be read, or whose run refuses,
   * must not stop the workspaces after it: this is a background job with no
   * caller to hand a failure to, so the failure is reported and the pass
   * continues.
   */
  async tick(): Promise<void> {
    this.pass ??= this.sweep().finally(() => {
      this.pass = null;
    });
    await this.pass;
  }

  /** One pass. Never called directly — `tick` is what keeps it to one. */
  private async sweep(): Promise<void> {
    const now = this.deps.now?.() ?? new Date();
      for (const root of this.deps.workspaces()) {
        let schedules: WorkflowSchedule[];
        try {
          schedules = await readSchedules(root);
        } catch {
          continue;
        }
        if (schedules.length === 0) continue;

        let changed = false;
        for (const schedule of schedules) {
          const verdict = dueNow(schedule, now, {
            running: this.deps.running(root, schedule.workflowId),
          });
          if (verdict.skipped !== undefined) {
            this.deps.report(`skipped ${schedule.workflowId}: ${verdict.skipped}`);
          }
          if (!verdict.run) continue;

          /*
           * The clock moves before the run starts, not after.
           *
           * A crash between the two costs one skipped run; the other order
           * costs a run started again on every tick for as long as the crash
           * keeps happening, each one spending a budget. Recording first is the
           * cheaper mistake, and it is the same reasoning `agent.created`
           * follows in writing what it is about to do.
           */
          schedule.lastRunAt = now.toISOString();
          changed = true;
          try {
            await this.deps.run(root, schedule);
            this.deps.report(`started ${schedule.workflowId}`);
          } catch (err) {
            // Reported and stepped over. There is no caller to raise this to,
            // and a routine that stops the whole pass because one document is
            // broken takes the others down with it.
            this.deps.report(
              `${schedule.workflowId} would not start: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (changed) {
          try {
            await writeSchedules(root, schedules);
          } catch (err) {
            /*
             * The one failure worth shouting about.
             *
             * If the clock could not be written, the next tick sees the same
             * schedule due and starts it again — the loop this whole design is
             * arranged to avoid.
             */
            this.deps.report(
              `could not record the run in ${root}, so it may start again: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
      }
    }
  }
}
