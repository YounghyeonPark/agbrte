/**
 * A workflow run, drawn while it runs (DESIGN.md §4.4, §4.3).
 *
 * ## Why this is a panel and not the session's whole view
 *
 * A run *is* a session — it has a log, a transcript, children reporting back —
 * and §4.4's line is that "a run is a session and a document is a file". So it
 * opens like every other session, and this sits beside the transcript the way
 * the group and MCP panels do: another way of reading what is already there.
 *
 * The graph answers a question the transcript cannot. A tree of five children
 * in a rail says which exist; a picture says which are *waiting on which*, and
 * a join — two predecessors meeting at one node — is the thing a session tree
 * cannot express at all. That is why `needs` exists and why the edges are the
 * content.
 *
 * ## The document is fetched, and its absence is a sentence
 *
 * A run carries only the workflow's **id** (§4.4: the document is a file, and
 * files live in a workspace). So the picture needs a read, and the document may
 * genuinely be gone — edited, renamed, or deleted since the run started, which
 * `git pull` can do to somebody mid-run. That is said rather than drawn as an
 * empty panel: a run whose document has moved is still a run, and its children
 * are still in the rail.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import type { Session, Workflow } from '../shared/types/index.js';
import { runProgress } from '../shared/workflow/progress.js';
import { WorkflowGraph } from './WorkflowGraph.js';

export function RunGraph({
  run,
  sessions,
  documents,
}: {
  /** The open session, which must be a run — the caller checks `workflow`. */
  run: Session;
  /** Everything the client knows, for the live half of `runProgress`. */
  sessions: readonly Session[];
  /** Asks that workspace what documents it holds. One call, on open. */
  documents: (instanceId: string) => Promise<Array<{ id: string; workflow?: Workflow }> | null>;
}): JSX.Element | null {
  const [found, setFound] = useState<Workflow | null | 'looking'>('looking');

  /*
   * The fetcher in a ref, and out of the effect's dependencies.
   *
   * A caller writing `documents={(id) => window.agbrte.workflows.list(id)}` —
   * which is the natural way to write it — hands a new function on every
   * render. With that in the dependency list the effect re-ran on every push
   * from the open session, each time setting the state back to `looking`, so
   * the panel never appeared at all: not a slow fetch, a fetch that started
   * again before it could finish.
   *
   * Held here rather than fixed at the call site, because a prop that has to be
   * memoised to work is a trap for the next caller, and nothing in the type
   * says so.
   */
  const fetcher = useRef(documents);
  fetcher.current = documents;

  useEffect(() => {
    let live = true;
    setFound('looking');
    void fetcher.current(run.instanceId)
      .then((all) => {
        if (!live) return;
        const doc = all?.find((f) => f.id === run.workflow)?.workflow;
        setFound(doc ?? null);
      })
      .catch(() => {
        if (live) setFound(null);
      });
    return () => {
      live = false;
    };
    // `run.workflow` rather than `run`: the session object changes on every
    // push, and refetching the document on each one would be a read per token.
  }, [run.instanceId, run.workflow]);

  if (found === 'looking') return null;

  return (
    <details className="border-line rounded-surface border" data-testid="run-graph" open>
      <summary className="text-muted cursor-pointer px-2 py-1.5 text-[11px]">
        {run.workflow} — {run.children.length} of {found?.nodes.length ?? '?'} started
      </summary>
      <div className="px-2 pt-1 pb-2">
        {found === null ? (
          /* Not an empty picture. A run whose document is gone is still a run,
             and drawing nothing would read as a graph with no nodes in it. */
          <p className="text-muted m-0 text-[11px]" data-testid="run-graph-missing">
            This workspace no longer holds a workflow called {run.workflow}, so there is nothing
            to draw. Its children are still in the list.
          </p>
        ) : (
          <WorkflowGraph workflow={found} states={runProgress(run, sessions)} />
        )}
      </div>
    </details>
  );
}
