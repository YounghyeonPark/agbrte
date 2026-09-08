/**
 * What became of a workflow, under the document it came from (§4.4).
 *
 * ## Why this belongs beside the document
 *
 * Pressing *Run now* started something and then it vanished. A run is a session
 * (§4.4: "a run is a session and a document is a file"), so it went into the
 * rail with everything else — correct, and it left the document's own page
 * unable to answer the two questions somebody standing there actually has: is
 * this going, and did the last one work.
 *
 * ## It points at runs rather than owning them
 *
 * Each row opens the session, which is where the transcript, the children and
 * the graph of that particular run live. Nothing here is a second place a
 * session can be driven from — §4.4's line holds, and this is a view over the
 * sessions the client already has.
 *
 * That is also why it needs nothing new on the wire: a run carries the
 * document's id (`Session.workflow`), so the runs of a document are a filter
 * over the list the rail is drawn from.
 */

import type { JSX } from 'react';
import type { Session } from '../shared/types/index.js';
import { runProgress } from '../shared/workflow/progress.js';
import { quietTone } from './App.js';

/** The most recent runs first, which is the order somebody reads them in. */
function newestFirst(a: Session, b: Session): number {
  return b.createdAt.localeCompare(a.createdAt);
}

/**
 * How many of a run's nodes are finished, out of how many the document has.
 *
 * The denominator comes from the document rather than from the run, because a
 * run that has spawned two of six children has *not* half finished — the four
 * it has not started are the point of saying `of six`.
 */
function progressOf(run: Session, sessions: readonly Session[], total: number): string {
  const states = runProgress(run, sessions);
  const done = Object.values(states).filter((s) => s === 'done').length;
  return `${done} of ${total}`;
}

export function WorkflowRuns({
  workflowId,
  nodeCount,
  sessions,
  onOpen,
}: {
  workflowId: string;
  /** From the document, for the denominator. See `progressOf`. */
  nodeCount: number;
  /** Every session the client knows about; this filters. */
  sessions: readonly Session[];
  onOpen: (sessionId: string, instanceId: string) => void;
}): JSX.Element | null {
  const runs = sessions.filter((s) => s.workflow === workflowId).sort(newestFirst);
  // Nothing rather than an empty list with a heading: a document nobody has run
  // has no history, and a section saying so is a section about nothing.
  if (runs.length === 0) return null;

  return (
    <div className="grid gap-1" data-testid="workflow-runs">
      <span className="text-muted text-[11px]">runs</span>
      <ul className="grid gap-1">
        {runs.slice(0, 5).map((run) => (
          <li key={run.sessionId}>
            <button
              type="button"
              className="btn flex w-full flex-wrap items-baseline justify-start gap-2 text-left text-[11px]"
              data-testid="workflow-run-row"
              data-session={run.sessionId}
              data-state={run.state}
              onClick={() => onOpen(run.sessionId, run.instanceId)}
            >
              <span className={quietTone(run.state)}>{run.state.replace(/_/g, ' ')}</span>
              <span className="text-muted">{progressOf(run, sessions, nodeCount)}</span>
              <span className="text-muted truncate-line min-w-0">
                {new Date(run.createdAt).toLocaleString()}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {runs.length > 5 ? (
        /* Five, and the count of the rest. A document run nightly has a page of
           these within a fortnight, and the ones worth a glance are the recent
           ones — the rail is where a session is *found*, and it searches. */
        <span className="text-muted text-[11px]" data-testid="workflow-runs-more">
          and {runs.length - 5} older
        </span>
      ) : null}
    </div>
  );
}
