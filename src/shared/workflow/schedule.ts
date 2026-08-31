/**
 * What a workflow run should do next (DESIGN.md §4.4, §4.3).
 *
 * Pure, and that is the whole design of the runner rather than a preference
 * about testability. §5.1 refuses a second source of truth — `events.jsonl` is
 * the record and everything else is derived — so a scheduler holding its own
 * idea of which nodes have run would be exactly the durable state that section
 * exists to not have, and the two would disagree the first time a host
 * restarted mid-run.
 *
 * So this holds nothing. It is handed the document and **what the children are
 * doing right now**, and answers with what to spawn. Resume is then not a
 * feature: a host that comes back reads its children's states out of the log,
 * asks this, and carries on from wherever it actually is.
 */

import type { Workflow, WorkflowNode } from '../types/index.js';

/**
 * A node's state, as far as a scheduler cares.
 *
 * Narrower than `SessionState` on purpose. The twelve session states describe
 * what one session is *doing*; a scheduler only needs to know whether a
 * dependency is satisfied, still going, or never will be — and collapsing them
 * here means the rule below cannot accidentally start depending on the
 * difference between `awaiting_permission` and `working`.
 */
export type NodeState = 'unstarted' | 'running' | 'done' | 'failed';

export interface RunState {
  /** Every node that has been spawned, by node id. */
  nodes: Readonly<Record<string, NodeState>>;
}

/**
 * What the run should do next.
 *
 * `blocked` is separate from `unstarted` because they are different sentences
 * for a person: one is waiting its turn, and the other is never going to
 * happen. Reporting a stranded node as merely pending would leave somebody
 * watching a graph that has quietly stopped.
 */
export interface NextStep {
  /** Nodes whose predecessors have all finished. Spawn these. */
  ready: WorkflowNode[];
  /** Nodes that can never start, because something they need failed. */
  blocked: WorkflowNode[];
  /** True when nothing is running and nothing more can start. */
  finished: boolean;
}

/** `unstarted` for anything the run has not recorded, which is where it begins. */
function stateOf(run: RunState, id: string): NodeState {
  return run.nodes[id] ?? 'unstarted';
}

/**
 * Whether a failure upstream has stranded this node, following `needs` back.
 *
 * Transitive, because the alternative is a node whose immediate predecessor is
 * itself blocked sitting in `unstarted` forever — pending in the UI, waiting on
 * something that will never run. A person watching that sees a graph that
 * stopped for no stated reason, which is the worst of the three outcomes.
 */
function strandedBy(node: WorkflowNode, byId: Map<string, WorkflowNode>, run: RunState): boolean {
  const seen = new Set<string>();
  const queue = [...(node.needs ?? [])];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (stateOf(run, id) === 'failed') return true;
    const dep = byId.get(id);
    if (dep !== undefined) queue.push(...(dep.needs ?? []));
  }
  return false;
}

/**
 * The next step, from the document and what the children are doing.
 *
 * **A failed node stops what depended on it and nothing else**, which is the
 * question §4.4 left open and the third answer rather than either of the two it
 * named as wrong. Stopping the whole graph throws away branches that have
 * nothing to do with the failure and may already be finished; carrying on
 * regardless starts a node whose predecessor produced nothing for it to read,
 * which is a turn spent to arrive at the same failure one step later. Following
 * the edges is neither, and it needs no new field — the dependency the author
 * already wrote down is exactly the statement of what this node cannot do
 * without.
 *
 * A `needs` naming a node that is not in the document is ignored here, as it is
 * everywhere else: it is `validateWorkflow`'s finding, and a document carrying
 * one never reaches a run.
 */
export function nextStep(workflow: Workflow, run: RunState): NextStep {
  const byId = new Map(workflow.nodes.map((n) => [n.id, n]));
  const ready: WorkflowNode[] = [];
  const blocked: WorkflowNode[] = [];
  let running = 0;

  for (const node of workflow.nodes) {
    const state = stateOf(run, node.id);
    if (state === 'running') running += 1;
    if (state !== 'unstarted') continue;

    if (strandedBy(node, byId, run)) {
      blocked.push(node);
      continue;
    }
    const deps = (node.needs ?? []).filter((d) => byId.has(d) && d !== node.id);
    if (deps.every((d) => stateOf(run, d) === 'done')) ready.push(node);
  }

  return { ready, blocked, finished: running === 0 && ready.length === 0 };
}

/**
 * Whether the run as a whole succeeded, once it has finished.
 *
 * A run with a blocked or failed node is a failed run even though other
 * branches finished, because the workflow is the unit somebody asked for. §4.3's
 * rule that a failed child does not fail its parent is about a *parent choosing*
 * — retry, re-scope, abandon — and a scheduler is not choosing anything; saying
 * the run succeeded because three of four nodes did would be the report making a
 * decision the person never made.
 */
export function runSucceeded(workflow: Workflow, run: RunState): boolean {
  return workflow.nodes.every((n) => stateOf(run, n.id) === 'done');
}
