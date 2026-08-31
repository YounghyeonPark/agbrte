/**
 * The one way a workflow document is written (DESIGN.md §4.4, §13).
 *
 * ## Round-trip fidelity is a requirement, not a nicety
 *
 * These files are **tracked**, and the diff is the whole of §4.4's approval
 * argument: an agent proposes a workflow by writing one, a person reviews it the
 * way they review code, and that is what makes an authored decomposition safe
 * where an autonomous one is not. An editor that reordered keys or re-indented
 * would make every edit a wall of noise, and a review nobody can read is not a
 * review. So the property this file exists to hold is narrow and exact:
 *
 * > changing one field changes one line.
 *
 * Which needs a **canonical form** rather than merely stable behaviour. Key
 * order is fixed here and not taken from the object, because object key order is
 * insertion order — so a document that went through an editor would come out
 * ordered by whatever the form happened to touch first, and two people editing
 * different fields would produce unrelated diffs of the same file.
 *
 * ## Absent rather than empty
 *
 * An optional field that is not set is left out, never written as `[]` or `""`.
 * A file full of empty arrays reads as a document that was configured and is
 * not; and on the next read those two states are the same object, so writing
 * them differently would make the form a fixed point of nothing.
 *
 * ## §13 needs no scan here, and that is by construction
 *
 * A `Workflow` has no field a credential fits in — no `env`, no headers, no
 * command. The rule that a workflow may *name* a credential and never carry one
 * is kept by the type rather than by a filter over it, which is the only way it
 * stays kept when somebody adds a field: adding one that could hold a secret
 * would be the decision, visible in a diff, rather than an oversight.
 */

import type { Workflow, WorkflowNode } from '../types/index.js';

/**
 * Node fields, in the order a reader wants them.
 *
 * Identity, then position in the graph, then the seam — scope before what is
 * excluded from it, because that is the order the two are decided in — then the
 * contract, then the cost. `title` sits with `id` because together they are the
 * label; `tokenCeiling` is last because it is the only number and the only thing
 * a reviewer checks against a total.
 */
const NODE_KEYS: ReadonlyArray<keyof WorkflowNode> = [
  'id',
  'title',
  'needs',
  'scope',
  'outOfScope',
  'acceptance',
  'contract',
  'pointers',
  'tokenCeiling',
  'target',
];

const WORKFLOW_KEYS: ReadonlyArray<keyof Workflow> = ['id', 'name', 'goal', 'budget', 'nodes'];

/** Whether a value is worth a line. `0` and `false` are, emptiness is not. */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value !== '';
  return true;
}

/** One object, rebuilt with its keys in the fixed order and nothing else added. */
function ordered<T extends object>(value: T, keys: ReadonlyArray<keyof T>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (present(value[key])) out[key as string] = value[key];
  }
  /*
   * Anything the type does not know about is dropped, deliberately.
   *
   * A field somebody hand-wrote that this version has no meaning for would
   * otherwise survive a round trip and look supported. It is not, and a document
   * that quietly carries an ignored key is one whose author believes something
   * false about what will run. The loss is visible in the diff the same edit
   * produces, which is where a person can act on it.
   */
  return out;
}

/**
 * A workflow as it belongs on disk: canonical, two-space, newline-terminated.
 *
 * The trailing newline is not decoration — a file without one makes the next
 * line added to it show as a change to the line before, which is exactly the
 * diff noise everything above is about.
 */
export function serializeWorkflow(workflow: Workflow): string {
  const body = {
    ...ordered(workflow, WORKFLOW_KEYS),
    nodes: workflow.nodes.map((node) => ordered(node, NODE_KEYS)),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}
