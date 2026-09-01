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

/** What a live run needs: the document, and one advance at a time. */
interface Running {
  workflow: Workflow;
  /**
   * The advance currently in flight, so a second one queues behind it.
   *
   * Not an optimisation. `advance` reads what the children are doing and spawns
   * what is ready, and those are two steps: two callers that read before either
   * writes both see the same nodes unstarted and both spawn them. The roll-up
   * hook makes that reachable in ordinary use — a child finishing calls
   * `advance` while an earlier one is still creating sessions — and it produced
   * a run with `tests` and `lint` twice, each with its own log and its own
   * reservation out of the root.
   *
   * Found by a test that called `advance` explicitly after settling a node, next
   * to a roll-up that had already called it. Serialising is the whole fix: the
   * second read then happens after the first write, sees the children, and does
   * nothing.
   */
  advancing?: Promise<void>;
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
    /*
     * The child's own state when it is loaded, and the parent's cache only when
     * it is not — in that order, because they disagree and one of them is not
     * evidence.
     *
     * §4.3 says `lastKnown` is "a cache for rendering a tree whose children may
     * be unreachable, never authoritative", and it is refreshed by `rollUp`
     * while both ends are in memory. After a host restart the parent comes back
     * from its log with the cache as it was at spawn, so every finished node
     * reads as still running — which is a run that resumes and then does
     * nothing, the exact failure the durable id was added to fix. Found by the
     * resume test, not by reading.
     */
    let state = child.lastKnown.state;
    try {
      state = manager.get(child.sessionId).state;
    } catch {
      // Not loaded here — another workspace, or simply not opened. The cache is
      // what §4.3 keeps it for.
    }
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
   * Pick a run back up after a restart, from the log and the file.
   *
   * `session.created` carries which document a root is a run of, so this needs
   * nothing the host did not already have: the children and their states came
   * back with the session, and the document is re-read from the workspace. Then
   * `advance` asks the same question it asks at any other moment — the scheduler
   * holds no progress, so "resume" and "carry on" are the same call.
   *
   * A document that has since been **edited** is used as it now is, deliberately
   * and not by oversight. The alternative is a snapshot taken at start, which
   * would be a second copy of a tracked file living in a log — and the file is
   * the thing under review, so a run that quietly followed an older version
   * would be running something nobody is looking at. Nodes already finished are
   * read from the children by id; ones the edit removed simply never start, and
   * ones it added start when their dependencies allow.
   *
   * Silent when there is no document, and that covers three real cases: an
   * ordinary session, a log written before this field existed, and a workflow
   * whose file has been deleted since. None of them is a run this host can
   * drive, and none is an error — the tree is on screen either way.
   */
  async resume(rootId: SessionId, workflowId: string, workspaceRoot: string): Promise<void> {
    if (this.live.has(rootId)) return;
    const { readWorkflow } = await import('./store/workflows.js');
    const file = await readWorkflow(workspaceRoot, workflowId);
    if (file.workflow === undefined || file.problems.length > 0) return;

    /*
     * Every node this run already made is loaded before anything is decided.
     *
     * A child's state is durable in the child's *own* log, and the copy on the
     * parent is a cache §4.3 keeps for rendering an unreachable child — after a
     * restart it says what was true at spawn. Deciding from it would read every
     * finished node as still running and spawn nothing, so the run would come
     * back and stall, which is not better than not coming back.
     *
     * `resumeSession` is idempotent, so this costs one open per node once. A
     * child that cannot be opened — deleted, or in a workspace this host does
     * not hold — falls through to the cache, which is what that cache is for.
     */
    for (const child of this.manager.get(rootId).children) {
      await this.manager.resumeSession(child.sessionId).catch(() => undefined);
    }

    await this.start(rootId, file.workflow);
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

    // Queued behind whatever is already spawning for this run — see `advancing`.
    // The `catch` keeps a failed advance from poisoning every later one, which
    // would turn one refused spawn into a run that never moves again.
    const mine = (run.advancing ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.spawnReady(rootId));
    run.advancing = mine.catch(() => undefined);
    return mine;
  }

  private async spawnReady(rootId: SessionId): Promise<void> {
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
