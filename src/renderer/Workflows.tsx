/**
 * The workflow documents in each attached workspace (DESIGN.md §4.4).
 *
 * ## Why documents get a place and runs do not
 *
 * §4.4 keeps these apart deliberately. A workflow *run* is an ordinary session
 * tree and belongs in the session list, badged rather than moved — the sidebar
 * groups by host because §8's caps are per host and §10 wants "what is running
 * this, and where" answerable without a click, and `needsAttention` bubbling
 * works because the fleet re-sorts every session globally. A run outside that
 * list is a run whose blocked node stops surfacing.
 *
 * A *document* is none of those things. It is not running, has no attention, and
 * costs nothing. It had no home at all: session templates are reachable today
 * only as apply-buttons inside the new-session panel, so neither kind could be
 * browsed or read. This is that home, and both kinds will share it.
 *
 * ## What it shows, and what it deliberately does not
 *
 * The review of a workflow happens in a **diff**, not here — that is the whole
 * of §4.4's approval argument, and it is why an agent proposes one by writing a
 * file rather than by starting a run. So this pane answers *what is here, what
 * shape is it, and is it usable*, and stops there: it does not edit or run
 * anything. The refusals are content rather than an error state, because the
 * document that will be refused is the one somebody is looking for.
 */

import { useState, type JSX } from 'react';
import type { HostInfo } from '../shared/ipc/contract.js';
import type { WorkflowSummary } from '../shared/host/sessionProtocol.js';
import { WorkflowGraph } from './WorkflowGraph.js';
import { WorkflowEditor } from './WorkflowEditor.js';
import { runProgress } from '../shared/workflow/progress.js';
import { WorkflowRuns } from './WorkflowRuns.js';
import { WorkflowSchedulePanel } from './WorkflowSchedule.js';
import type { Session, Workflow, WorkflowSchedule } from '../shared/types/index.js';

/**
 * One workspace's answer.
 *
 * `null` is a host too old to be asked, and it is kept apart from `[]` all the
 * way to the screen for the reason §3.3 spends four capability states on: an
 * empty list is a finished answer — nobody has written a workflow — while a host
 * that predates them has a remedy, and rendering the second as the first tells
 * somebody they have none when the truth is that nothing could say.
 */
export interface WorkspaceWorkflows {
  host: HostInfo;
  found: WorkflowSummary[] | null;
}

/** `2 nodes`, `1 node` — a count that reads rather than one that is parsed. */
function nodeCount(n: number): string {
  return `${n} node${n === 1 ? '' : 's'}`;
}

/**
 * The name a document will actually land under.
 *
 * `saveWorkflow` replaces anything outside `[a-zA-Z0-9._-]` with a dash, so a
 * name typed with a space in it becomes a file nobody named. Shown before the
 * file exists rather than discovered afterwards — the attach form makes the
 * same promise about a folder, for the same reason.
 */
function safeId(typed: string): string {
  return typed.trim().replace(/[^a-zA-Z0-9._-]/g, '-');
}

/**
 * What a new document starts as: one node, filled in enough to be legal.
 *
 * Not empty. `validateWorkflow` refuses a workflow with no nodes and a node
 * with no `outOfScope` — §4.3's rule, because a child without exclusions reads
 * widely to re-derive context it was never given — so an empty start would open
 * the editor onto a list of findings. A skeleton opens onto something to change.
 */
function skeleton(id: string): Workflow {
  return {
    id,
    name: id,
    goal: 'what this whole workflow is for',
    nodes: [
      {
        id: 'first',
        title: 'first',
        scope: 'the one thing this part does',
        outOfScope: ['everything the other parts do'],
        acceptance: ['how anybody can tell it is done'],
        contract: { summaryMaxTokens: 800, artifacts: [] },
        tokenCeiling: 20_000,
      },
    ],
  };
}

/**
 * The run of this document that is still going, if one is.
 *
 * `working` and the paused states both count as going — a run waiting on a
 * quota window has not finished, and drawing it as though it had would say the
 * work is done. Only a `done`, `failed` or `cancelled` run is over.
 *
 * The newest, because two can overlap: the schedule refuses to start one over
 * another, but `Run now` does not — pressing it twice is a person's decision to
 * make and not something to refuse on their behalf.
 */
function going(workflowId: string, sessions: readonly Session[]): Session | undefined {
  return sessions
    .filter(
      (s) =>
        s.workflow === workflowId &&
        s.state !== 'done' &&
        s.state !== 'failed' &&
        s.state !== 'cancelled',
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

export function Workflows({
  workspaces,
  sessions,
  onClose,
  onOpenRun,
  schedules,
  onSave,
  onRun,
  onSchedule,
}: {
  workspaces: WorkspaceWorkflows[];
  /**
   * Every session the client knows about, so a document can show its own runs.
   *
   * A filter rather than a fetch: a run carries the document's id
   * (`Session.workflow`), so the runs of a workflow are already in the list the
   * rail is drawn from. Nothing new crosses the wire for this.
   */
  sessions: readonly Session[];
  /** Leave the pane. See the control that calls it. */
  onClose: () => void;
  /** Open one, which is the rail's own action — this pane points, never drives. */
  onOpenRun: (sessionId: string, instanceId: string) => void;
  /**
   * What each workspace runs on a routine, keyed by `instanceId` (§4.4).
   *
   * The host keeps these; this is a read of them. Absent for a workspace whose
   * host is too old to keep one, which reads the same as having none — because
   * on that host, nothing is scheduled.
   */
  schedules?: Record<string, WorkflowSchedule[]>;
  /**
   * Write one back. Resolves with the host's findings, empty when it was saved.
   *
   * Absent where saving is not available — a public host declines the channel
   * outright (`publicChannels.ts` is an allowlist), and a read-only client is
   * refused by the host. Absent rather than a button that fails: §3.12's rule
   * about a dark control teaching people the feature does nothing.
   */
  onSave?: (
    instanceId: string,
    workflowId: string,
    workflow: Workflow,
  ) => Promise<Array<{ node?: string; message: string }>>;
  /**
   * Start a run now — the same command a schedule calls, pressed by a person.
   *
   * Absent where this client may not start work, and its absence is what hides
   * the schedule controls too: arranging for something to run is the same
   * permission as running it.
   */
  onRun?: (instanceId: string, workflowId: string, ceiling: number) => Promise<void>;
  /** Replace one workspace's routines, whole. See `setSchedules` on the wire. */
  onSchedule?: (instanceId: string, schedules: WorkflowSchedule[]) => Promise<void>;
}): JSX.Element {
  const anything = workspaces.some((w) => (w.found?.length ?? 0) > 0);
  /** `instanceId::id` of the document open in the editor, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The workspace whose `New workflow…` form is open, if any. */
  const [making, setMaking] = useState<string | null>(null);
  const [draftId, setDraftId] = useState('');
  /** A document being written that is not on disk yet — id and where it will go. */
  const [started, setStarted] = useState<{ instanceId: string; id: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  return (
    <section className="grid gap-4 p-4" data-testid="workflows">
      <div className="grid gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-ink text-sm font-medium">Workflows</h2>
          {/*
            The way out, which used to be the button that opened it.

            That button toggled, so closing was pressing it again; with it gone
            from the rail this pane would have been one somebody could enter and
            not leave. A view with no exit is worse than one with no entrance —
            the entrance was at least missed on the way in.
          */}
          <button
            type="button"
            className="btn-quiet text-[11px]"
            data-testid="close-workflows"
            onClick={onClose}
          >
            Done
          </button>
        </div>
        <p className="text-muted max-w-prose text-[13px]">
          A workflow is a decomposition written down before it runs: what the parts are, what each
          one may not touch, and what it owes back. They live beside session templates in the
          workspace, are tracked by git, and are reviewed the way code is — in a diff.
        </p>
      </div>

      {workspaces.length === 0 ? (
        <p className="text-muted text-[13px]" data-testid="workflows-no-hosts">
          Attach a folder and its workflows will be listed here.
        </p>
      ) : null}

      {workspaces.map(({ host, found }) => (
        <div key={host.instanceId} className="grid gap-2" data-testid="workflows-workspace">
          <div className="text-muted flex items-baseline gap-2 text-[11px]">
            <span className="text-ink text-[13px]">{host.label}</span>
            <span className="truncate-line">{host.root}</span>
          </div>

          {found === null ? (
            /* Not "no workflows". The remedy is different and so is the fact:
               this host predates the command, and updating it is one click
               elsewhere. Saying "none" here would be a claim nothing made. */
            <p className="text-muted text-[13px]" data-testid="workflows-unsupported">
              This host is too old to list workflows — update it to see them.
            </p>
          ) : found.length === 0 ? (
            <p className="text-muted text-[13px]" data-testid="workflows-empty">
              None here yet.
            </p>
          ) : (
            <ul className="grid gap-2">
              {found.map((file) => (
                <li
                  key={file.id}
                  className="border-line grid gap-1 rounded-surface border p-3"
                  data-testid="workflow-row"
                  data-id={file.id}
                  data-ok={file.problems.length === 0 ? 'yes' : 'no'}
                >
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-ink text-[13px]">{file.workflow?.name ?? file.id}</span>
                    <span className="text-muted text-[11px]">{file.id}</span>
                    {file.workflow !== undefined ? (
                      <span className="text-muted text-[11px]">
                        {nodeCount(file.workflow.nodes.length)}
                      </span>
                    ) : null}
                  </div>
                  {file.workflow?.goal !== undefined && file.workflow.goal !== '' ? (
                    <p className="text-muted text-[12px]">{file.workflow.goal}</p>
                  ) : null}
                  {/*
                    Drawn under the row that names it, and only when asked.
                    Every graph open at once would make a pane of four workflows
                    a page of pictures nobody is looking at; none of them open
                    would make the button the feature. So a row is a disclosure,
                    and the picture is the thing it discloses.
                  */}
                  {file.workflow !== undefined && editing === `${host.instanceId}::${file.id}` ? (
                    <WorkflowEditor
                      initial={file.workflow}
                      saving={saving}
                      saveError={saveError}
                      onCancel={() => {
                        setEditing(null);
                        setSaveError(null);
                      }}
                      onSave={(draft) => {
                        if (onSave === undefined) return;
                        setSaving(true);
                        setSaveError(null);
                        void onSave(host.instanceId, file.id, draft)
                          .then((problems) => {
                            // Empty means it is on disk. Anything else is the
                            // host's own list, which is the same list the editor
                            // computes — so a disagreement is worth seeing
                            // rather than smoothing over.
                            if (problems.length === 0) setEditing(null);
                            else setSaveError(problems.map((p) => p.message).join('; '));
                          })
                          .catch((err: unknown) => {
                            setSaveError(err instanceof Error ? err.message : String(err));
                          })
                          .finally(() => setSaving(false));
                      }}
                    />
                  ) : file.workflow !== undefined ? (
                    <details data-testid="workflow-shape">
                      <summary className="text-muted cursor-pointer text-[11px]">shape</summary>
                      <div className="grid gap-2 pt-2">
                        {/*
                          The document's shape, carrying a live run's state when
                          one is going.

                          One picture rather than two. The same graph was drawn
                          here for the document and again in the session for the
                          run, and somebody comparing "what this does" with
                          "where it has got to" had to hold them apart in their
                          head. `WorkflowGraph`'s header always said the boxes
                          would carry a run's state; this is the other caller it
                          meant.

                          The *newest* run, and only while one is working: an
                          old run's states over a document somebody is reading
                          would be a picture of history presented as now.
                        */}
                        <WorkflowGraph
                          workflow={file.workflow}
                          problems={file.problems}
                          {...(going(file.id, sessions) === undefined
                            ? {}
                            : { states: runProgress(going(file.id, sessions)!, sessions) })}
                        />
                        {onSave !== undefined ? (
                          <div>
                            <button
                              type="button"
                              className="btn text-[11px]"
                              data-testid="workflow-edit"
                              onClick={() => setEditing(`${host.instanceId}::${file.id}`)}
                            >
                              Edit
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ) : null}
                  {onRun !== undefined && onSchedule !== undefined && file.workflow !== undefined ? (
                    <WorkflowSchedulePanel
                      workflowId={file.id}
                      schedule={(schedules?.[host.instanceId] ?? []).find(
                        (s) => s.workflowId === file.id,
                      )}
                      canRun={file.problems.length === 0}
                      onRun={(ceiling) => onRun(host.instanceId, file.id, ceiling)}
                      onSet={(made) =>
                        onSchedule(host.instanceId, [
                          // Whole-list replacement, so this rebuilds the others
                          // around the one being set — the wire takes the list
                          // and two clients cannot interleave into a third.
                          ...(schedules?.[host.instanceId] ?? []).filter(
                            (s) => s.workflowId !== file.id,
                          ),
                          made,
                        ])
                      }
                      onClear={() =>
                        onSchedule(
                          host.instanceId,
                          (schedules?.[host.instanceId] ?? []).filter(
                            (s) => s.workflowId !== file.id,
                          ),
                        )
                      }
                    />
                  ) : null}
                  {file.workflow !== undefined ? (
                    <WorkflowRuns
                      workflowId={file.id}
                      nodeCount={file.workflow.nodes.length}
                      sessions={sessions}
                      onOpen={onOpenRun}
                    />
                  ) : null}
                  {file.problems.length > 0 ? (
                    /* Every finding, not the first. A document has many seams and
                       one reader, and being told one problem six times is the
                       reason `validateWorkflow` returns a list. */
                    <ul className="grid gap-1" data-testid="workflow-problems">
                      {file.problems.map((p, i) => (
                        <li key={i} className="text-state-fail text-[12px]">
                          {p.node === undefined ? '' : `${p.node}: `}
                          {p.message}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
      {onSave !== undefined ? (
        <div className="grid gap-2" data-testid="workflow-new">
          {making === host.instanceId ? (
            <form
              className="border-line grid gap-2 rounded-surface border p-3"
              onSubmit={(e) => {
                e.preventDefault();
                const id = safeId(draftId);
                if (id === '') return;
                setMaking(null);
                setDraftId('');
                setStarted({ instanceId: host.instanceId, id });
                setEditing(`${host.instanceId}::${id}`);
              }}
            >
              <label className="text-muted grid gap-1 text-[11px]">
                A name for it
                <input
                  className="field text-[12px]"
                  data-testid="workflow-new-id"
                  autoFocus
                  value={draftId}
                  onChange={(e) => setDraftId(e.target.value)}
                  placeholder="nightly-sweep"
                />
                {/*
                  The filename, before the file exists.

                  `saveWorkflow` replaces anything outside `[a-zA-Z0-9._-]` with
                  a dash, so a name with a space in it lands under a name nobody
                  typed. The attach form makes the same promise about a folder
                  for the same reason: a thing appearing on disk under a name
                  you did not choose is a thing you go looking for later.
                */}
                <span className="opacity-70" data-testid="workflow-new-file">
                  {draftId.trim() === ''
                    ? 'templates/….workflow.json'
                    : `templates/${safeId(draftId)}.workflow.json`}
                </span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="btn text-accent text-[11px]"
                  data-testid="workflow-new-start"
                  disabled={safeId(draftId) === ''}
                >
                  Start it
                </button>
                <button
                  type="button"
                  className="btn-quiet text-[11px]"
                  onClick={() => {
                    setMaking(null);
                    setDraftId('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : (
            <div>
              <button
                type="button"
                className="btn text-[11px]"
                data-testid="workflow-new-open"
                onClick={() => setMaking(host.instanceId)}
              >
                New workflow…
              </button>
            </div>
          )}

          {/*
            The editor, over a document that is not on disk yet.

            Nothing is written until Save, which is what makes an abandoned one
            cost nothing — and `workflow.save` refuses a document with findings,
            so a skeleton that cannot run cannot land in the repo either.
          */}
          {started?.instanceId === host.instanceId &&
          editing === `${host.instanceId}::${started.id}` ? (
            <WorkflowEditor
              initial={skeleton(started.id)}
              saving={saving}
              saveError={saveError}
              onCancel={() => {
                setEditing(null);
                setStarted(null);
                setSaveError(null);
              }}
              onSave={(made) => {
                setSaving(true);
                setSaveError(null);
                void onSave(host.instanceId, started.id, made)
                  .then((problems) => {
                    if (problems.length === 0) {
                      setEditing(null);
                      setStarted(null);
                    } else setSaveError(problems.map((p) => p.message).join('; '));
                  })
                  .catch((err: unknown) => {
                    setSaveError(err instanceof Error ? err.message : String(err));
                  })
                  .finally(() => setSaving(false));
              }}
            />
          ) : null}
        </div>
      ) : null}
        </div>
      ))}

      {!anything && workspaces.length > 0 ? (
        <p className="text-muted max-w-prose text-[12px]" data-testid="workflows-howto">
          Write one as <code>.agbrte/templates/&lt;name&gt;.workflow.json</code>, then run{' '}
          <code>agbrte workflows</code> to check it before it costs anything.
        </p>
      ) : null}
    </section>
  );
}
