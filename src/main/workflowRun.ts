/**
 * Running a workflow (DESIGN.md §4.4, §4.3).
 *
 * A run is **an ordinary session tree**. There is no second execution model
 * here: the root is a session, each node is a child session, and every invariant
 * §4.3 states — brief, result contract, budget reserved at spawn, failure
 * isolation, orphan-on-cancel, attention bubbling — holds because this spawns
 * children the same way an approved split does.
 *
 * What is new is only *who decides*. A split is proposed by an agent and
 * approved by a person, one seam at a time; a run reads a document somebody
 * already wrote and approved, and spawns what `nextStep` says is ready.
 *
 * ## Nothing here remembers what has run
 *
 * §5.1 refuses a second source of truth. Progress is derived from the children's
 * own states every time it is needed — `nodeStates` below is the whole of it —
 * so there is no bookkeeping that can disagree with the log, and a run advanced
 * twice for the same event does the same thing twice, which is nothing.
 *
 * ## The one durable gap, named rather than hidden
 *
 * Which *document* a root is running is held in memory for the life of the host.
 * A host restarted mid-run therefore has the children, their states, and the
 * tree — all durable — and no longer knows which workflow they came from, so it
 * will not spawn the nodes that had not started yet. The root sits in
 * `awaiting_children` with what it has.
 *
 * That is a real hole and it is one field wide: `session.created` carries `goal`
 * and `title` and would need the workflow id beside them, folded by the
 * projection and versioned in the checkpoint the way every other durable fact
 * is. Deliberately not bolted on somewhere cheaper — a run identity kept
 * anywhere but the log is the second store this file's first paragraph refuses.
 */

import { nextStep, runSucceeded, type NodeState, type RunState } from '@shared/workflow/schedule.js';
import type { SessionId, Workflow, WorkflowNode } from '@shared/types/index.js';
import type { SessionManager } from './sessionManager.js';

/** What a live run needs, which is the document and nothing else. */
interface Running {
  workflow: Workflow;
}

/**
 * Every node's state, read from the root's children.
 *
 * The mapping from child to node is the child's **title**, which is the node id
 * — durable, on both logs, and already what `ChildRef` carries for rendering. A
 * side table would have been a second store for a fact the tree already holds.
 *
 * `lastKnown` is a cache and §4.3 says so, but it is the right cache here: it is
 * updated by `rollUp` on every state change of every descendant, which is
 * exactly the moment a run wants to look.
 */
function nodeStates(manager: SessionManager, rootId: SessionId): RunState {
  const root = manager.get(rootId);
  const nodes: Record<string, NodeState> = {};
  for (const child of root.children) {
    const state = child.lastKnown.state;
    nodes[child.title] =
      state === 'done'
        ? 'done'
        : state === 'failed' || state === 'cancelled'
          ? 'failed'
          : 'running';
  }
  return { nodes };
}

/** A node, as `prepareChild` wants it. */
function spawnFor(node: WorkflowNode): Parameters<SessionManager['prepareChild']>[1] {
  return {
    // The node id, because it is the run's only durable link back to the
    // document — see `nodeStates`. Its `title` field is the human label and
    // rides in the brief's scope where a person actually reads it.
    title: node.id,
    scope: node.scope,
    outOfScope: node.outOfScope,
    contract: node.contract,
    acceptance: node.acceptance,
    tokenCeiling: node.tokenCeiling,
    ...(node.target !== undefined ? { target: node.target } : {}),
  };
}

export class WorkflowRuns {
  private readonly live = new Map<SessionId, Running>();

  constructor(private readonly manager: SessionManager) {}

  /** Whether this session is a workflow root this host is driving. */
  isRun(sessionId: SessionId): boolean {
    return this.live.has(sessionId);
  }

  /**
   * Begin a run: remember the document, then spawn whatever is ready.
   *
   * The root session is the caller's to create, because creating one is already
   * a decision with a workspace, a target and a budget attached — and a runner
   * that made its own would be a second way to start a session.
   */
  async start(rootId: SessionId, workflow: Workflow): Promise<void> {
    this.live.set(rootId, { workflow });
    await this.advance(rootId);
  }

  /**
   * Spawn everything the document says is now ready.
   *
   * Safe to call at any time and as often as anything likes: it reads the
   * children's states, spawns what is ready, and does nothing when nothing is.
   * That is what lets `rollUp` drive it without knowing whether this run has
   * already been advanced for the same change.
   */
  async advance(rootId: SessionId): Promise<void> {
    const run = this.live.get(rootId);
    if (run === undefined) return;

    const step = nextStep(run.workflow, nodeStates(this.manager, rootId));
    for (const node of step.ready) {
      /*
       * Spawned one at a time and sequentially, because `prepareChild` reserves
       * from the parent's remaining budget: two spawns racing would both read
       * the same remainder and could between them reserve more than the root
       * was granted, which is the one thing §4.3's reservation-at-spawn exists
       * to make impossible.
       */
      const prepared = await this.manager.prepareChild(rootId, spawnFor(node), {
        // §4.4's narrow exemption: the readability limit does not bind a run's
        // root, because that review already happened in the file. It covers the
        // nodes the document declares and nothing else — a node calling
        // `propose_split` mid-run is an ordinary split meeting the ordinary
        // limit.
        declaredByWorkflow: true,
      });
      const child = await this.manager.createSession(prepared.create);
      await this.manager.recordChild(rootId, child, prepared.parentBudget, node.contract);
    }

    if (step.finished) {
      this.live.delete(rootId);
    }
  }

  /** Whether every node of a finished run succeeded. */
  succeeded(rootId: SessionId, workflow: Workflow): boolean {
    return runSucceeded(workflow, nodeStates(this.manager, rootId));
  }
}
