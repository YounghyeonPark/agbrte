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
import type { Workflow } from '../shared/types/index.js';

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

export function Workflows({
  workspaces,
  onSave,
}: {
  workspaces: WorkspaceWorkflows[];
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
}): JSX.Element {
  const anything = workspaces.some((w) => (w.found?.length ?? 0) > 0);
  /** `instanceId::id` of the document open in the editor, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  return (
    <section className="grid gap-4 p-4" data-testid="workflows">
      <div className="grid gap-1">
        <h2 className="text-ink text-sm font-medium">Workflows</h2>
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
                  className="border-line grid gap-1 rounded-[2px] border p-3"
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
                        <WorkflowGraph workflow={file.workflow} problems={file.problems} />
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
