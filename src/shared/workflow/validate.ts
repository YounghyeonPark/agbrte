/**
 * What is wrong with a workflow document, said before it costs anything (§4.4).
 *
 * ## Why this is a list and not a throw
 *
 * `buildBrief` throws, because it is refusing one seam at the moment somebody
 * asked for it and there is exactly one thing to say. A document is different in
 * both directions: it has many seams, and its reader is either an editor
 * validating on every keystroke or a person who would rather be told all six
 * problems than the first one six times. So every check runs and every finding
 * comes back, each carrying the node it belongs to — which is also what lets the
 * editor mark a node in the graph rather than showing a sentence with a name in
 * it (§4.4).
 *
 * ## Why the budget check is here rather than in the runner
 *
 * §4.3 reserves a child's ceiling at spawn, because checking at spend time makes
 * "a tree cannot outspend what its root was granted" a report rather than a
 * rule. A workflow can do better than either, and this is the one place in the
 * design where it can: **every node ceiling is written in the document, so the
 * total is knowable before anything runs.** A parent proposing one split has no
 * idea what the next child will ask for; a document has already said.
 *
 * What that buys is a refusal that can be acted on. Reserving as it goes stops
 * at the seventh node of twelve, reports one number, and — per §4.3's "a refused
 * split leaves nothing behind" — releases the six reservations it took, leaving
 * nothing on screen to say any of it happened. Checking whole names the total,
 * the shortfall and the nodes that did not fit, because it computed all of them
 * before touching anything. It also means nothing is taken and given back, so
 * leave-nothing-behind holds without an unwind path — and an unwind path is code
 * written once and exercised never.
 *
 * The check is pessimistic on purpose. It sums declared ceilings, and a node
 * finishing under its ceiling releases the remainder (§4.3), so a graph can be
 * refused for a total it would never have spent. That is the right way round:
 * the alternative starts a workflow that dies halfway with six nodes' work done
 * and no budget to finish.
 */

import { availableTokens, seamRefusal } from '../types/index.js';
import type { SessionBudget, Workflow, WorkflowNode } from '../types/index.js';

/**
 * One thing wrong, and where.
 *
 * `node` is absent for a finding about the document as a whole — a duplicate id
 * belongs to no single node, and a budget shortfall belongs to all of them.
 */
export interface WorkflowFinding {
  node?: string;
  message: string;
}

/** Total tokens a run of this document would reserve. */
export function declaredTotal(workflow: Workflow): number {
  return workflow.nodes.reduce((n, node) => n + Math.max(0, node.tokenCeiling), 0);
}

/**
 * Nodes in an order that satisfies every `needs`, or the cycle that prevents one.
 *
 * Kahn's algorithm, and the reason it is here rather than in the runner is that
 * a cycle is a property of the document: a workflow whose order cannot be
 * decided must be refused while somebody is editing it, not discovered by a
 * scheduler that has already spawned half of it.
 *
 * Returns the unorderable node ids on failure rather than a boolean, since
 * "these four are in a cycle" is actionable and "there is a cycle" is not.
 */
export function topoOrder(
  nodes: WorkflowNode[],
): { order: string[]; cycle?: undefined } | { order?: undefined; cycle: string[] } {
  const ids = new Set(nodes.map((n) => n.id));
  // Only edges to nodes that exist: a `needs` naming nothing is reported
  // separately, and counting it here would report a phantom cycle on top of it.
  const pending = new Map(
    nodes.map((n) => [n.id, (n.needs ?? []).filter((d) => ids.has(d) && d !== n.id)] as const),
  );
  const order: string[] = [];
  for (;;) {
    const ready = [...pending].filter(([, deps]) => deps.length === 0).map(([id]) => id);
    if (ready.length === 0) break;
    for (const id of ready) {
      order.push(id);
      pending.delete(id);
    }
    for (const [id, deps] of pending) {
      pending.set(
        id,
        deps.filter((d) => !ready.includes(d)),
      );
    }
  }
  return pending.size === 0 ? { order } : { cycle: [...pending.keys()] };
}

/**
 * Everything wrong with this document, in the order a reader meets it.
 *
 * `against` is the budget a run would draw on — the root's, at the moment the
 * run is proposed. Omitted while editing, where there is no root yet and the
 * shape is the only thing being checked; supplied before a run, where the
 * shortfall is the finding that stops it.
 *
 * The order is deliberate. Structural findings come before seam findings because
 * a `needs` pointing at a node that does not exist makes every other complaint
 * about that region noise, and the budget comes last because it is the only one
 * that is about the run rather than about the document.
 */
export function validateWorkflow(
  workflow: Workflow,
  against?: SessionBudget,
): WorkflowFinding[] {
  const found: WorkflowFinding[] = [];

  if (workflow.goal.trim() === '') {
    // The one field every node inherits (`SessionBrief.parentGoal`), so an empty
    // one is not a missing label — it is every child being told nothing about
    // why it exists.
    found.push({ message: 'the workflow needs a goal; every node inherits it as its parentGoal' });
  }
  if (workflow.nodes.length === 0) {
    found.push({ message: 'a workflow with no nodes decomposes nothing' });
    return found;
  }

  const seen = new Set<string>();
  for (const node of workflow.nodes) {
    if (node.id.trim() === '') {
      found.push({ message: 'a node has an empty id, and `needs` can only refer to it by name' });
      continue;
    }
    if (seen.has(node.id)) {
      found.push({ node: node.id, message: `two nodes share the id "${node.id}"` });
    }
    seen.add(node.id);
  }

  for (const node of workflow.nodes) {
    for (const dep of node.needs ?? []) {
      if (dep === node.id) {
        found.push({ node: node.id, message: `"${node.id}" needs itself` });
      } else if (!seen.has(dep)) {
        found.push({ node: node.id, message: `"${node.id}" needs "${dep}", which is not a node here` });
      }
    }
  }

  const ordered = topoOrder(workflow.nodes);
  if (ordered.cycle !== undefined) {
    found.push({
      message: `these nodes wait on each other and none can start: ${ordered.cycle.join(', ')}`,
    });
  }

  for (const node of workflow.nodes) {
    // The three §4.3 refuses at spawn, refused here in the same words. The
    // fourth — a brief over its own token ceiling — needs the parent's
    // projection and cannot be known from a document; it still fires at spawn.
    const unusable = seamRefusal(node);
    if (unusable !== null) found.push({ node: node.id, message: unusable });
    if (node.tokenCeiling <= 0) {
      found.push({ node: node.id, message: 'a node needs a positive tokenCeiling to be reserved' });
    }
  }

  if (against !== undefined) {
    const need = declaredTotal(workflow);
    const have = availableTokens(against);
    if (need > have) {
      /*
       * Named in the order somebody would act on them: what it costs, what
       * there is, and which nodes are the ones to cut. The nodes are listed
       * largest first because that is the list a person is about to edit, and
       * the biggest ceiling is where the shortfall is cheapest to close.
       */
      const worst = [...workflow.nodes]
        .sort((a, b) => b.tokenCeiling - a.tokenCeiling)
        .slice(0, 3)
        .map((n) => `${n.id} (${n.tokenCeiling.toLocaleString()})`);
      found.push({
        message:
          `"${workflow.name}" needs ${need.toLocaleString()} tokens across ` +
          `${workflow.nodes.length} node${workflow.nodes.length === 1 ? '' : 's'} and ` +
          `${have.toLocaleString()} are unreserved — ${(need - have).toLocaleString()} short. ` +
          `Raise the ceiling this runs under, or lower the largest: ${worst.join(', ')}`,
      });
    }
  }

  return found;
}
