/**
 * A decomposition written down before the run (DESIGN.md §4.4).
 *
 * §4.3 builds a session tree one node at a time — an agent proposes a split, a
 * person approves it, a child is spawned with a brief and a contract. A workflow
 * is that same decomposition, authored in advance and reviewed as a file. It is
 * **not a second execution model**: a workflow run is an ordinary session tree,
 * and every invariant §4.3 states holds unchanged.
 *
 * Which is why almost everything here is a field that already exists somewhere
 * else. A node is a `SessionBrief` minus the parts only a running parent can
 * supply, plus the one thing a document adds: an edge.
 */

import type { ExecutionTarget } from './target.js';
import type { ResultContract, SessionBrief, SessionBudget } from './session.js';

/**
 * One node: a child session that starts when its predecessors have finished.
 *
 * **`needs` is dependency and never lineage**, and keeping those apart is the
 * decision that makes a graph expressible at all (§4.4). A session has exactly
 * one `parentSessionId` and that is load-bearing — the parent reserves the
 * budget, receives the result, and adopts the child as a root on cancel — so a
 * join cannot be expressed by giving a node two parents. Every node of a run is
 * a child of the run's root, and `needs` names siblings.
 *
 * It also stops `maxDepth: 3` from capping pipeline length by accident: a
 * six-stage pipeline is six siblings at depth 1, not a chain at depth 6.
 * Execution order and lineage were always different things.
 */
export interface WorkflowNode {
  /**
   * A name, unique within the workflow — not a generated id.
   *
   * People write these files and read them in diffs, and `needs: ['a7f3e1']`
   * is a line nobody can review. The cost is that renaming a node is a rename
   * everywhere it is named, which a validator can at least catch.
   */
  id: string;
  /** Nodes that must finish first. Absent or empty means it can start at once. */
  needs?: string[];
  title: string;
  /** → `SessionBrief.scope`. */
  scope: string;
  /** → `SessionBrief.outOfScope`. Refused when empty, exactly as at spawn. */
  outOfScope: string[];
  /** → `SessionBrief.acceptance`. */
  acceptance: string[];
  /** → what this node owes. `summaryMaxTokens` bounds node-to-node flow. */
  contract: ResultContract;
  /** → `SessionBrief.pointers`, for context the author already knows about. */
  pointers?: SessionBrief['pointers'];
  /**
   * The ceiling reserved for this node.
   *
   * Named per node rather than divided from a total, because the author knows
   * which node is the expensive one and an even split would be a guess wearing
   * a number. The sum is what §4.4's whole-graph check tests.
   */
  tokenCeiling: number;
  /** A node may name another machine, as a child already may (§4.3, §17.5). */
  target?: ExecutionTarget;
}

/**
 * The document.
 *
 * There is no `run` field, no condition and no loop, and that is a refusal
 * rather than an omission (§4.4): the moment this can branch and repeat it is a
 * programming language, which needs an execution log of its own — the second
 * durable store §5.1 exists to not have. Dynamism arrives through
 * `propose_split` mid-run, reviewed the way every split is.
 */
export interface Workflow {
  id: string;
  name: string;
  /** → `SessionBrief.parentGoal` for every node: why this work exists at all. */
  goal: string;
  nodes: WorkflowNode[];
  /**
   * What the whole graph may spend, if the author pinned it.
   *
   * Absent means the run's root supplies it, the way a session is unbudgeted
   * rather than zero-budgeted when nobody chose a number (§4.3).
   */
  budget?: SessionBudget;
}
