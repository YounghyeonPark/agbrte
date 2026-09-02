/**
 * Editing a workflow document (DESIGN.md §4.4).
 *
 * ## The split is along the grain of the data, not down the middle of the screen
 *
 * **Structure is geometry and prose is not.** Which nodes exist and what waits
 * on what is what a graph is good at; `scope`, `outOfScope` and `acceptance` are
 * the writing that decides whether a child works — §4.3 refuses an empty
 * `outOfScope` outright, because without exclusions a child reads widely to
 * re-derive context it was never given. A node canvas optimises the easy half
 * and puts the hard half in a small box. So: the graph selects, the form writes.
 *
 * ## Live validation is why this exists at all
 *
 * `validateWorkflow`'s refusals are already written and already correct, and
 * they are the same ones `buildBrief` raises at spawn — one function, two
 * callers, so a seam refused in a file is refused for the reasons §4.3 gives.
 * Running them as the document is edited, and marking the node in the graph,
 * turns a run-time refusal into a design aid. It is the one thing a text file
 * cannot do, and it is the whole argument for an editor over an editor window.
 *
 * ## What it does not do
 *
 * It does not run anything, and it does not review. The review of a workflow
 * happens in a **diff** — that is §4.4's approval argument and the reason an
 * agent proposes one by writing a file rather than by starting a run — so this
 * is for the person writing it, before it is worth reading.
 *
 * Saving goes through the host, which serialises. A client that wrote its own
 * text would make §4.4's canonical form a property of the app version rather
 * than of the file, and two apps could then produce two spellings of one
 * workflow — which is exactly the diff noise the canonical form exists to stop.
 */

import { useMemo, useState, type JSX } from 'react';
import type { Workflow, WorkflowNode } from '../shared/types/index.js';
import { validateWorkflow } from '../shared/workflow/validate.js';
import { WorkflowGraph } from './WorkflowGraph.js';

const FIELD = 'field w-full text-[12px]';
const LABEL = 'text-muted text-[11px]';

/** One line per entry, which is how a list of sentences is actually typed. */
function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** A node with everything the validator insists on, so a new one is legal. */
function blankNode(id: string): WorkflowNode {
  return {
    id,
    title: id,
    scope: '',
    // Not pre-filled with a placeholder. §4.3 refuses an empty `outOfScope`
    // *because only the parent knows what it is keeping*, and a default would be
    // this editor answering that on the author's behalf — which is the one thing
    // the refusal exists to prevent.
    outOfScope: [],
    acceptance: [],
    contract: { summaryMaxTokens: 800, artifacts: [] },
    tokenCeiling: 10_000,
  };
}

export function WorkflowEditor({
  initial,
  onSave,
  onCancel,
  saving,
  saveError,
}: {
  initial: Workflow;
  onSave: (workflow: Workflow) => void;
  onCancel: () => void;
  saving: boolean;
  /** What the host said, when it refused a save this editor thought was fine. */
  saveError?: string | null;
}): JSX.Element {
  const [draft, setDraft] = useState<Workflow>(initial);
  const [selected, setSelected] = useState<string | null>(initial.nodes[0]?.id ?? null);

  // Recomputed on every keystroke, which is the point. The refusals are cheap —
  // they look at the document and nothing else — so there is no reason to make
  // somebody press a button to find out what the file already knows.
  const problems = useMemo(() => validateWorkflow(draft), [draft]);
  const node = draft.nodes.find((n) => n.id === selected) ?? null;
  const forNode = problems.filter((p) => p.node === selected);
  const forDocument = problems.filter((p) => p.node === undefined);

  const editNode = (id: string, patch: Partial<WorkflowNode>): void => {
    setDraft((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  };

  /**
   * Set or remove `needs`, which cannot be a patch.
   *
   * Empty means the **key is absent**, not present and empty, matching what the
   * serializer writes: a `needs: []` on disk reads as a dependency somebody
   * removed rather than one that was never there, and the two would round-trip
   * to the same object anyway. `exactOptionalPropertyTypes` makes that a rebuild
   * rather than an assignment, which is the type system insisting on the
   * distinction the file format already makes.
   */
  const setNeeds = (id: string, needs: string[]): void => {
    setDraft((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== id) return n;
        const { needs: _dropped, ...rest } = n;
        return needs.length === 0 ? rest : { ...rest, needs };
      }),
    }));
  };

  const addNode = (): void => {
    // Numbered rather than named, because a name is the author's to choose and a
    // guessed one is a name they have to notice and undo.
    let n = draft.nodes.length + 1;
    while (draft.nodes.some((x) => x.id === `node${n}`)) n += 1;
    const fresh = blankNode(`node${n}`);
    setDraft((d) => ({ ...d, nodes: [...d.nodes, fresh] }));
    setSelected(fresh.id);
  };

  const removeNode = (id: string): void => {
    setDraft((d) => ({
      ...d,
      nodes: d.nodes
        .filter((n) => n.id !== id)
        // The edges go with it. A `needs` naming a node that is gone is its own
        // finding, and leaving one behind would report a deletion as a mistake.
        .map((n) => ({ ...n, ...(n.needs !== undefined ? { needs: n.needs.filter((d2) => d2 !== id) } : {}) })),
    }));
    setSelected(null);
  };

  return (
    <section className="grid gap-3" data-testid="workflow-editor">
      <div className="grid gap-1">
        <label className={LABEL} htmlFor="wf-goal">
          Goal — every node inherits this as its parentGoal
        </label>
        <input
          id="wf-goal"
          className={FIELD}
          data-testid="wf-goal"
          value={draft.goal}
          onChange={(e) => setDraft((d) => ({ ...d, goal: e.target.value }))}
        />
      </div>

      <WorkflowGraph workflow={draft} problems={problems} />

      <div className="flex flex-wrap items-center gap-2">
        {draft.nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            className="btn text-[11px]"
            data-testid="wf-select-node"
            data-id={n.id}
            aria-pressed={selected === n.id}
            onClick={() => setSelected(n.id)}
          >
            {n.id}
          </button>
        ))}
        <button type="button" className="btn text-[11px]" data-testid="wf-add-node" onClick={addNode}>
          + node
        </button>
      </div>

      {node !== null ? (
        <div className="border-line grid gap-2 rounded-surface border p-3" data-testid="wf-node-form">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-ink text-[13px]">{node.id}</span>
            <button
              type="button"
              className="btn text-[11px]"
              data-testid="wf-remove-node"
              onClick={() => removeNode(node.id)}
            >
              remove
            </button>
          </div>

          <div className="grid gap-1">
            <label className={LABEL}>Scope — this node&apos;s narrow goal</label>
            <textarea
              className={FIELD}
              data-testid="wf-scope"
              rows={2}
              value={node.scope}
              onChange={(e) => editNode(node.id, { scope: e.target.value })}
            />
          </div>

          <div className="grid gap-1">
            {/* Named as the refusal names it, so the field and the finding are
                recognisably about one thing. */}
            <label className={LABEL}>Out of scope — one per line, and required</label>
            <textarea
              className={FIELD}
              data-testid="wf-outofscope"
              rows={2}
              value={node.outOfScope.join('\n')}
              onChange={(e) => editNode(node.id, { outOfScope: linesToList(e.target.value) })}
            />
          </div>

          <div className="grid gap-1">
            <label className={LABEL}>Acceptance — how this node knows it is done</label>
            <textarea
              className={FIELD}
              data-testid="wf-acceptance"
              rows={2}
              value={node.acceptance.join('\n')}
              onChange={(e) => editNode(node.id, { acceptance: linesToList(e.target.value) })}
            />
          </div>

          <div className="grid gap-1">
            <label className={LABEL}>Needs — node ids, one per line</label>
            <textarea
              className={FIELD}
              data-testid="wf-needs"
              rows={2}
              value={(node.needs ?? []).join('\n')}
              onChange={(e) => setNeeds(node.id, linesToList(e.target.value))}
            />
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="grid gap-1">
              <label className={LABEL}>Summary ceiling</label>
              <input
                type="number"
                className={`${FIELD} w-28`}
                data-testid="wf-summary-max"
                value={node.contract.summaryMaxTokens}
                onChange={(e) =>
                  editNode(node.id, {
                    contract: { ...node.contract, summaryMaxTokens: Number(e.target.value) },
                  })
                }
              />
            </div>
            <div className="grid gap-1">
              <label className={LABEL}>Token ceiling</label>
              <input
                type="number"
                className={`${FIELD} w-32`}
                data-testid="wf-token-ceiling"
                value={node.tokenCeiling}
                onChange={(e) => editNode(node.id, { tokenCeiling: Number(e.target.value) })}
              />
            </div>
          </div>

          {forNode.length > 0 ? (
            <ul className="grid gap-1" data-testid="wf-node-problems">
              {forNode.map((p, i) => (
                <li key={i} className="text-state-fail text-[11px]">
                  {p.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {forDocument.length > 0 ? (
        <ul className="grid gap-1" data-testid="wf-doc-problems">
          {forDocument.map((p, i) => (
            <li key={i} className="text-state-fail text-[12px]">
              {p.message}
            </li>
          ))}
        </ul>
      ) : null}

      {saveError !== null && saveError !== undefined ? (
        <p className="text-state-fail text-[12px]" data-testid="wf-save-error">
          {saveError}
        </p>
      ) : null}

      <div className="flex gap-2">
        {/*
          Disabled while anything is wrong, and that is not politeness. The host
          refuses an invalid document anyway (`saveWorkflow`), so a save button
          that stayed live would offer a round trip whose only outcome is the
          list already on screen. The refusals are visible above it.
        */}
        <button
          type="button"
          className="btn text-accent text-[12px]"
          data-testid="wf-save"
          disabled={saving || problems.length > 0}
          onClick={() => onSave(draft)}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="btn text-[12px]" data-testid="wf-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
