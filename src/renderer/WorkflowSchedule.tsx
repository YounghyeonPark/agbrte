/**
 * Running a workflow now, and arranging for it to run again (DESIGN.md §4.4, §4.3).
 *
 * ## Two controls, and the second is the reason for the first
 *
 * Until v31 nothing could start a run at all: the pane could list, validate,
 * draw and edit a document, and the only thing that could *run* one was a test
 * holding the manager. So `Run now` is not a convenience next to the schedule —
 * it is the same command, pressed by a person instead of by a clock, and having
 * both here is what makes the schedule checkable before it is trusted.
 *
 * ## The host keeps the routine, not this
 *
 * §6.4: the host is what does things and the app is a client. A timer in this
 * window would fire only while somebody had the window open, which is the one
 * thing a routine cannot depend on. So everything here is a read or a write of
 * something the host owns, and closing the app changes nothing about what
 * happens at nine tomorrow.
 *
 * ## A ceiling is required, and typed in tokens
 *
 * §4.3's argument is at its sharpest for a schedule: a run fans out into
 * children and nobody is watching when it starts. A ceiling refused up front is
 * a conversation; one refused at three in the morning is a bill. So the field
 * has a default rather than being optional, and the default is small enough to
 * be worth changing on purpose.
 */

import { useState, type JSX } from 'react';
import type { WorkflowSchedule } from '../shared/types/index.js';
import { LABEL } from './App.js';

/** What the form holds, before it becomes a schedule. */
interface Draft {
  kind: 'daily' | 'interval';
  /** `HH:MM`, for the daily one. The field is `type="time"`, so it is valid. */
  time: string;
  /** Hours, for the interval one. Kept as text so a half-typed number is not 0. */
  hours: string;
  ceiling: string;
}

const START: Draft = { kind: 'daily', time: '09:00', hours: '6', ceiling: '200000' };

/** Minutes past local midnight, from the `HH:MM` a time input produces. */
function minuteOf(time: string): number {
  const [h, m] = time.split(':');
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

/** `HH:MM` again, for showing a schedule that already exists. */
function timeOf(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** What a person reads on the row: when, and when it last went off. */
export function describeSchedule(schedule: WorkflowSchedule): string {
  const when =
    schedule.every.kind === 'daily'
      ? `every day at ${timeOf(schedule.every.minute)}`
      : `every ${Math.round(schedule.every.ms / 3_600_000)}h`;
  const last =
    schedule.lastRunAt === undefined
      ? 'not yet run'
      : `last ran ${new Date(schedule.lastRunAt).toLocaleString()}`;
  return `${when} · ${last}`;
}

export function WorkflowSchedulePanel({
  workflowId,
  schedule,
  canRun,
  onRun,
  onSet,
  onClear,
}: {
  workflowId: string;
  /** What the host has for this document, if anything. */
  schedule: WorkflowSchedule | undefined;
  /**
   * Absent where this client may not start work — a read-only role, a public
   * host, a host too old for the command. Absent rather than a dark button:
   * §3.12's rule about a control that teaches people the feature does nothing.
   */
  canRun: boolean;
  onRun: (ceiling: number) => Promise<void>;
  onSet: (schedule: WorkflowSchedule) => Promise<void>;
  onClear: () => Promise<void>;
}): JSX.Element | null {
  const [draft, setDraft] = useState<Draft>(START);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!canRun) return null;

  /** One place for the three calls, so a refusal reads the same whichever it was. */
  const attempt = (what: () => Promise<void>): void => {
    setBusy(true);
    setNote(null);
    void what()
      .then(() => setOpen(false))
      .catch((err: unknown) => setNote(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const ceiling = Number(draft.ceiling);
  const ceilingOk = Number.isInteger(ceiling) && ceiling > 0;

  return (
    <div className="grid gap-1" data-testid="workflow-schedule">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn text-[11px]"
          data-testid="workflow-run"
          disabled={busy || !ceilingOk}
          onClick={() => attempt(() => onRun(ceiling))}
        >
          {busy ? 'Working…' : 'Run now'}
        </button>

        {schedule === undefined ? (
          <button
            type="button"
            className="btn text-[11px]"
            data-testid="workflow-schedule-open"
            onClick={() => setOpen((was) => !was)}
          >
            Schedule…
          </button>
        ) : (
          <>
            {/* What is set, in words, because a routine nobody can read is one
                nobody can tell is wrong. */}
            <span className="control-note" data-testid="workflow-schedule-summary">
              {describeSchedule(schedule)}
            </span>
            <button
              type="button"
              className="btn-quiet text-[11px] hover:border-state-fail hover:text-state-fail"
              data-testid="workflow-unschedule"
              disabled={busy}
              onClick={() => attempt(onClear)}
            >
              Unschedule
            </button>
          </>
        )}
      </div>

      {open && schedule === undefined ? (
        <form
          className="border-line grid gap-2 rounded-surface border p-2"
          data-testid="workflow-schedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!ceilingOk) return;
            attempt(() =>
              onSet({
                workflowId,
                every:
                  draft.kind === 'daily'
                    ? { kind: 'daily', minute: minuteOf(draft.time) }
                    : { kind: 'interval', ms: Math.round(Number(draft.hours) * 3_600_000) },
                budget: { tokenCeiling: ceiling, spent: 0, reservedForChildren: 0 },
                enabled: true,
              }),
            );
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="field w-auto text-[11px]"
              data-testid="workflow-schedule-kind"
              value={draft.kind}
              onChange={(e) => setDraft((d) => ({ ...d, kind: e.target.value as Draft['kind'] }))}
            >
              <option value="daily">every day at</option>
              <option value="interval">every</option>
            </select>

            {draft.kind === 'daily' ? (
              /* A time input, so the hour is the machine's own idea of a time
                 rather than a string this has to parse — and `daily` is local,
                 because "nine in the morning" means the morning of whoever
                 typed it. */
              <input
                className="field w-auto text-[11px]"
                type="time"
                data-testid="workflow-schedule-time"
                value={draft.time}
                onChange={(e) => setDraft((d) => ({ ...d, time: e.target.value }))}
              />
            ) : (
              <span className="flex items-center gap-1">
                <input
                  className="field w-16 text-[11px]"
                  data-testid="workflow-schedule-hours"
                  inputMode="numeric"
                  value={draft.hours}
                  onChange={(e) => setDraft((d) => ({ ...d, hours: e.target.value }))}
                />
                <span className={LABEL}>hours</span>
              </span>
            )}
          </div>

          <label className="text-muted grid gap-1 text-[11px]">
            Token ceiling for each run
            <input
              className="field text-[11px]"
              data-testid="workflow-schedule-ceiling"
              inputMode="numeric"
              value={draft.ceiling}
              onChange={(e) => setDraft((d) => ({ ...d, ceiling: e.target.value }))}
            />
            {/* Said where the number is typed, not in a document nobody opens.
                This is the one control here that spends money on its own. */}
            <span className="opacity-70">
              A run fans out into children and starts with nobody watching, so this is the
              only thing bounding what one costs.
            </span>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="btn text-accent text-[11px]"
              data-testid="workflow-schedule-save"
              disabled={busy || !ceilingOk}
            >
              {busy ? 'Saving…' : 'Schedule'}
            </button>
            <button type="button" className="btn-quiet text-[11px]" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {note !== null ? (
        /* Verbatim. These come from the host — a document that will not run, a
           client that may not start work, an interval short enough to be a loop
           — and every one of them already names its own way round. */
        <p className="text-state-fail m-0 text-[11px]" data-testid="workflow-schedule-error">
          {note}
        </p>
      ) : null}
    </div>
  );
}
