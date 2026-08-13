/**
 * SessionManager (DESIGN.md §4, §8, §13).
 *
 * The headless core of the app: it owns session lifecycle, agent admission, the
 * permission gate, and the mapping from a turn's outcome to a session state. The
 * Electron layer is a client of this — nothing here imports Electron, which is
 * both why it is testable and why the same code can run inside a remote agent
 * host later (§6.4).
 *
 * The rule this class exists to protect: **a pause is not a failure** (§4.1). A
 * pending permission, a dead egress tunnel, and a spent quota window all hold
 * state and resume.
 */

import { EventEmitter } from 'node:events';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  byAttentionThenRecency,
  TREE_LIMITS,
  isPaused,
  newAgentId,
  newSessionId,
  uuidv7,
  type OutboundMessage,
  type PermissionAsk,
  type PolicyRule,
  type ResultContract,
  type AgentHandle,
  type AgentMessage,
  type AgentRecord,
  type AgentRole,
  type AgentRuntime,
  type AgentSpec,
  type AttentionReason,
  type ChildRef,
  type CompactedHistory,
  type ReasoningRequest,
  type Annotation,
  type ImageBlock,
  type EventOrigin,
  type ExecutionTarget,
  type InboxEntry,
  type InstanceId,
  type AgbrteEvent,
  type PermissionDecision,
  type PermissionRequest,
  type RuntimeContext,
  type Session,
  type SessionBudget,
  type SessionState,
  type Sha256,
  type SplitProposal,
  type ToolPolicy,
  type UserTurn,
  type AgentId,
  type SessionId,
  type Actor,
  describeTarget,
  sameTarget,
} from '@shared/types/index.js';
import { SessionStore, type SessionMeta } from './store/sessionStore.js';
import { workspaceLayout } from './store/layout.js';
import { addCost } from '@shared/cost.js';
import { ensureBlob } from './store/blobTransfer.js';
import { compactionSizes, rehydrate } from './store/rehydrate.js';
import { pumpAgent, stopReasonSummary } from './runtime/supervisor.js';
import { groupFor, QuotaScheduler } from './quota.js';
import { TurnSlots } from './concurrency.js';
import { entriesFrom, merge, ReadMarker } from './inbox.js';
import { fitContent } from './content/fit.js';
import { flattenAnnotations, scaleToFit, sizeOf } from './content/pixels.js';
import { captureUrl } from './capture/headless.js';
import { buildBrief, checkResult, reserveForChild } from './store/brief.js';
import {
  createWorktree,
  hasCommits,
  removeWorktree,
  worktreeSupport,
  type Worktree,
} from './worktree.js';
import type { Isolation, RoleRequirements, RuntimeRegistry } from './runtime/registry.js';
import { defaultPolicyForTarget, evaluatePolicy } from './policy/evaluate.js';

export interface CreateSessionInput {
  title: string;
  goal: string;
  target?: ExecutionTarget;
  policy?: ToolPolicy;
  /**
   * What this session is allowed to spend (§4.3).
   *
   * Absent by default, and absent means unbudgeted rather than zero — most
   * sessions are a person working, and imposing a ceiling nobody chose would
   * stop turns for a reason the user never set. A tree, though, cannot be
   * carved out of nothing: `spawnChild` refuses on a parent with no budget,
   * because inventing one would put a number nobody agreed to at the root of a
   * subtree.
   */
  budget?: SessionBudget;
  /**
   * Splits this session may make without asking (§17 Q8).
   *
   * Set when the run is created, which is when the person is present. Absent
   * means every split asks, which is §4.3's rule and stays the default.
   */
  splitGrant?: { count: number; maxDepth: number };
}

export interface NewAgentInput {
  role: AgentRole;
  runtimeId: string;
  model?: AgentSpec['model'];
  auth?: AgentSpec['auth'];
  systemPrompt?: string;
  policy?: ToolPolicy;
  isolation?: Isolation;
  limits?: AgentSpec['limits'];
  requirements?: RoleRequirements;
}

/** What a split needs beyond the brief itself (§4.3). */
export interface SpawnChildInput {
  title: string;
  /** The child's narrow goal. Becomes its `goal`, and the brief's `scope`. */
  scope: string;
  /** Required: without it the child reads widely to re-derive context (§4.3). */
  outOfScope: string[];
  contract: ResultContract;
  acceptance?: string[];
  /** Carved out of the parent's remainder at spawn, never at spend time. */
  tokenCeiling: number;
  memoryRefs?: string[];
  verbatimTurns?: number;
  /** A child may run somewhere else entirely — that is half the point (§4.3). */
  target?: ExecutionTarget;
}

export class SplitRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SplitRefused';
  }
}

export class AdmissionRefused extends Error {
  constructor(readonly failures: ReadonlyArray<{ code: string; detail: string }>) {
    super(`agent refused: ${failures.map((f) => f.detail).join('; ')}`);
    this.name = 'AdmissionRefused';
  }
}

interface QueuedTurn {
  turn: UserTurn;
  resolve: () => void;
  reject: (err: Error) => void;
  /**
   * Captured when the turn is queued, not when it runs.
   *
   * A queued turn can start long after the client that sent it disconnected, so
   * asking "who is attached now" at execution time would attribute it to
   * whoever happens to be watching — or to nobody. The sender is a property of
   * the turn.
   */
  actor?: Actor;
}

export interface PendingPermission extends PermissionRequest {
  resolve: (d: PermissionDecision) => void;
  askedAt: string;
}

/** States that mean nothing more will happen without someone acting. */
function isSettled(state: SessionState): boolean {
  return state === 'done' || state === 'failed' || state === 'awaiting_input';
}

/** What a session has cost so far, summed across its agents. */
function totalCost(session: Session): number | 'unknown' {
  let total = 0;
  for (const agent of session.agents) {
    if (agent.usage.cost === 'unknown') return 'unknown';
    total += agent.usage.cost;
  }
  return total;
}

/** Grants apply to the asking agent, so its siblings are never widened. */
function clonePolicy(policy: ToolPolicy): ToolPolicy {
  return { defaultAction: policy.defaultAction, rules: policy.rules.map((r) => ({ ...r })) };
}

interface LiveSession {
  session: Session;
  store: SessionStore;
  policy: ToolPolicy;
  handles: Map<AgentId, AgentHandle>;
  specs: Map<AgentId, AgentSpec>;
  /** Real controllers, so `ctx.abortSignal` can actually fire. */
  aborts: Map<AgentId, AbortController>;
  /** Whether this session has already recorded the move. */
  notedRelocation?: boolean;
  /**
   * When this session last appended anything.
   *
   * Not `updatedAt`, which moves only when an agent is added or the state
   * changes — a session mid-turn can go quiet for an hour without either. Every
   * append is the honest signal that something is still happening.
   */
  lastEventAt: number;
  /**
   * The turn to run again once the quota window resets.
   *
   * Held rather than reconstructed from the log: the turn is what the person
   * asked for and it did not complete, so resuming means running *that*, not
   * something inferred later from a transcript.
   */
  parked?: { resetsAt: number; agentId: AgentId; turn: UserTurn; actor?: Actor };
  /**
   * Agents queued behind a shared credential rather than doing anything (§8).
   *
   * Held because a session waiting for a quota slot is indistinguishable from a
   * hung one — both sit in `working` emitting nothing — and the stall detector
   * would flag it. A warning that fires on something working exactly as designed
   * is how a warning stops being read (§10).
   */
  waitingOnQuota: Set<AgentId>;
  /**
   * How deep the current exchange is, per agent (§4.2).
   *
   * A lead asks a worker, the worker asks back, and without a ceiling that is a
   * conversation with a bill attached and nobody watching. Held per agent
   * because the depth belongs to the turn being run, and cleared whenever a
   * *person* sends a turn — a human in the loop is exactly the thing the ceiling
   * exists to wait for.
   */
  hops: Map<AgentId, number>;
  /** Per-agent checkouts under `worktree` isolation (§9). */
  worktrees: Map<AgentId, Worktree>;
  /**
   * Splits an agent has asked for and nobody has answered (§4.3).
   *
   * Held rather than derived from state, because a pending proposal outlives
   * every state transition underneath it: the session goes on being
   * `awaiting_input` between turns, and an attention computed from state alone
   * would drop the question the moment anything else happened.
   */
  pendingSplits: Map<string, SplitProposal>;
  /** What this session owes its parent, from the brief it was spawned with. */
  contract?: ResultContract;
}

export interface SessionManagerDeps {
  registry: RuntimeRegistry;
  workspaceRoot: string;
  instanceId: InstanceId;
  /**
   * How long a working session may go silent before it is called stalled.
   *
   * A judgement call, and deliberately generous. A model can legitimately take
   * minutes on a long generation and a tool can be slow; calling those stuck
   * would train the user to ignore the signal, which is the only failure mode
   * that matters for a warning. Five minutes of complete silence from something
   * that normally emits text as it goes is genuinely unusual.
   */
  stallAfterMs?: number;
  /**
   * Shared-credential scheduling (§8).
   *
   * Here rather than in main because this is where turns start: a scheduler
   * above the host could not gate a turn sent by the CLI, by a second client, or
   * by this manager's own parked-session sweeper waking at reset. §13's rule
   * that a bypassable gate is not a gate applies to this one too.
   */
  quota?: QuotaScheduler;
  /** Turns run at once on this host. Defaults to §8's `min(8, cores − 2)`. */
  maxConcurrentTurns?: number;
  /**
   * Set when this workspace was opened somewhere other than where it last was.
   *
   * A native resume token was minted by a vendor against the *old* location, so
   * the honest assumption is that it no longer describes anything — see
   * `openHandle`. Absent means "not known to have moved", which is also what an
   * `instance.json` written before relocation was tracked reports.
   */
  relocatedFrom?: string;
  now?: () => Date;
}

/** Five minutes of complete silence from something that streams as it goes. */
const DEFAULT_STALL_AFTER_MS = 5 * 60 * 1_000;

/**
 * How much of each log the inbox folds.
 *
 * Bounded so opening it costs the same on a workspace used for a month as on one
 * opened yesterday, and generous enough that a session which finished overnight
 * is still in range — that being the case the inbox exists for.
 */
const INBOX_EVENT_WINDOW = 500;

/**
 * How many agent-to-agent hops may pass without a person.
 *
 * Generous enough for a real exchange — a lead briefing two workers, each
 * reporting back, a reviewer commenting — and small enough that a pair talking
 * in circles stops before it becomes expensive. The refusal is recorded, so a
 * roster that keeps hitting it is visible rather than merely slow.
 */
/**
 * What a seat thinks at when it says nothing and the model takes an effort.
 *
 * `max` because the targets this is aimed at are local: the cost of thinking
 * longer is electricity and latency rather than a bill, and a workbench for
 * unattended runs would rather wait than be asked twice.
 */
const DEFAULT_REASONING = 'max' as const;

const MAX_MESSAGE_HOPS = 8;

/**
 * Who the log says approved an automatic split.
 *
 * `via: 'asserted'` and an id that is plainly not a person: §5.1's rule is that
 * an actor says what established it and therefore what it is worth, and "the
 * grant you set earlier" is worth exactly as much as the grant. Attributing it
 * to the user who created the session would be true in spirit and would make
 * the transcript unable to answer "did I approve this one".
 */
const AUTO_ACTOR: Actor = { id: 'agbrte:split-grant', via: 'asserted', label: 'split grant' };

/**
 * One turn's concurrency slot, mutable so it can be given back and retaken.
 *
 * A plain `() => void` would be enough if a slot were held for the whole turn.
 * It is not: a turn parked on a permission prompt returns its slot and takes a
 * fresh one when answered, so what `send`'s `finally` must release is whichever
 * one is current rather than the one it started with.
 */
interface SlotHolder {
  release: () => void;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, LiveSession>();
  /** The slot each running turn currently holds, so a prompt can hand it back. */
  private readonly turnSlots = new Map<AgentId, SlotHolder>();
  private readonly pending = new Map<string, PendingPermission>();
  /**
   * Request ids already answered in this process.
   *
   * Kept so a second client answering the same prompt gets `already-answered`
   * rather than `unknown` — the difference between "someone else got there
   * first" and "that prompt was never real", which the UI should not conflate.
   */
  private readonly answered = new Set<string>();
  /** Turns waiting to run, per agent. See `send`. */
  private readonly queues = new Map<AgentId, QueuedTurn[]>();
  /** Agents with a runner already draining, so a turn is never started twice. */
  private readonly draining = new Set<AgentId>();
  private readonly now: () => Date;

  private readonly sweeper: NodeJS.Timeout;

  /**
   * The runtimes this manager can admit.
   *
   * Exposed because the host answers "what can this adapter do here" without a
   * session existing to ask it through, and reaching into `deps` from the server
   * would make the registry a shared mutable it does not own.
   */
  get registry(): RuntimeRegistry {
    return this.deps.registry;
  }

  /** Shared with nothing by default: one host, its own view of each credential. */
  private readonly quota: QuotaScheduler;
  /** How many turns this host runs at once (§8). */
  private readonly slots: TurnSlots;

  constructor(private readonly deps: SessionManagerDeps) {
    super();
    this.now = deps.now ?? (() => new Date());

    // One timer for every session and both jobs, rather than one each: each
    // check is a comparison against a number, and N timers would be N wakeups
    // to do what a single pass does. Swept at a fraction of the stall threshold
    // so a reported `since` is not off by a whole interval.
    //
    // Started regardless of `stallAfterMs`. Gating it on that was a bug: waking
    // a parked session and noticing silence are unrelated jobs that happened to
    // share a timer, so turning stall detection off also stopped every quota
    // window from ever resuming. `sweepStalled` disables itself instead.
    this.quota = deps.quota ?? new QuotaScheduler();
    // Injectable so a test is not at the mercy of the core count of whatever
    // machine it runs on — the cap is a property of the host, and a test about
    // queueing needs to be able to make one.
    this.slots = new TurnSlots(deps.maxConcurrentTurns);
    const after = deps.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    this.sweeper = setInterval(
      () => {
        this.sweepStalled();
        this.sweepParked();
      },
      Math.max(1_000, (after > 0 ? after : DEFAULT_STALL_AFTER_MS) / 5),
    );
    // Never hold the process open just to notice silence.
    this.sweeper.unref?.();
  }

  /** Stop the stall sweeper. Sessions are unaffected; they live in the log. */
  dispose(): void {
    clearInterval(this.sweeper);
  }

  /**
   * Remove the checkouts this manager cut, keeping their branches (§9).
   *
   * Separate from `dispose` because it touches the filesystem and can fail,
   * and because the two answer different questions: `dispose` stops timers so a
   * process can exit, while this tidies up disk. A caller that wants a clean
   * shutdown asks for both; a test that only wants its timers back does not have
   * to wait on git.
   *
   * The **branches survive**. Removing a checkout is housekeeping; removing a
   * branch would delete work nobody accepted, and a session ending is not the
   * same as its output being merged.
   */
  async releaseWorktrees(): Promise<void> {
    for (const live of this.sessions.values()) {
      for (const [agentId, worktree] of live.worktrees) {
        await removeWorktree(this.deps.workspaceRoot, worktree);
        live.worktrees.delete(agentId);
      }
    }
  }

  async createSession(input: CreateSessionInput, actor?: Actor): Promise<Session> {
    const sessionId = newSessionId();
    const createdAt = this.now().toISOString();

    const store = await SessionStore.create(this.deps.workspaceRoot, {
      sessionId,
      instanceId: this.deps.instanceId,
      title: input.title,
      goal: input.goal,
      createdAt,
    }, { ...(actor !== undefined ? { actor } : {}) });

    const session: Session = {
      sessionId,
      instanceId: this.deps.instanceId,
      target: input.target ?? { kind: 'local' },
      title: input.title,
      goal: input.goal,
      state: 'planning',
      agents: [],
      createdAt,
      updatedAt: createdAt,
      checklist: [],
      artifacts: [],
      needsAttention: null,
      ...(input.budget !== undefined ? { budget: input.budget } : {}),
      ...(input.splitGrant !== undefined && input.splitGrant.count > 0
        ? {
            splitGrant: {
              remaining: input.splitGrant.count,
              granted: input.splitGrant.count,
              maxDepth: input.splitGrant.maxDepth,
            },
          }
        : {}),
      // A session created directly is a root of its own tree (§4.3).
      tree: { rootSessionId: sessionId, depth: 0, ancestry: [] },
      children: [],
      peerSessionIds: [],
      pendingSplits: [],
    };

    // Live forwarding for the UI (§7). Wired here rather than from the IPC
    // layer so exactly one place knows which session a store belongs to, and
    // the renderer never receives an event it cannot attribute.
    store.onAppend = (event) => {
      this.spoke(sessionId);
      this.emit('event', sessionId, event);
    };

    this.sessions.set(sessionId, {
      session,
      store,
      // The §13 defaults are selected from the target, not left to the caller.
      // An empty default policy meant every call fell through to `ask`, which is
      // safe but means the documented local/remote distinction never applied.
      policy: input.policy ?? defaultPolicyForTarget(session.target.kind),
      handles: new Map(),
      specs: new Map(),
      aborts: new Map(),
      lastEventAt: this.now().getTime(),
      waitingOnQuota: new Set<AgentId>(),
      hops: new Map<AgentId, number>(),
      worktrees: new Map<AgentId, Worktree>(),
      pendingSplits: new Map<string, SplitProposal>(),
    });

    this.emit('session', session);
    return session;
  }

  get(sessionId: SessionId): Session {
    return this.live(sessionId).session;
  }

  list(): Session[] {
    return [...this.sessions.values()].map((l) => l.session).sort(byAttentionThenRecency);
  }

  /**
   * Add an agent, refusing configurations that cannot run safely.
   *
   * Admission happens here rather than at the first tool call, so an
   * `all-or-nothing` runtime never reaches a shared workspace and a role's
   * capability floor is enforced before any work starts (§3.10, §4.2, §9).
   */
  async addAgent(sessionId: SessionId, input: NewAgentInput, actor?: Actor): Promise<AgentRecord> {
    const live = this.live(sessionId);
    const requested = input.isolation ?? 'shared';

    const spec: AgentSpec = {
      agentId: newAgentId(),
      role: input.role,
      runtimeId: input.runtimeId,
      auth: input.auth ?? { kind: 'none' },
      // A *copy*, not the session's object. Sharing the reference meant a
      // pattern grant approved for a trusted agent silently widened every other
      // agent in the session — including one on a coarse-gated runtime (§13).
      toolPolicy: input.policy ?? clonePolicy(live.policy),
      limits: input.limits ?? {},
      workspacePath: this.deps.workspaceRoot,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    };

    /**
     * What isolation this agent will actually get (§9).
     *
     * > Non-git workspaces fall back to `shared` with leases (and therefore
     * > cannot host an `all-or-nothing` agent at all).
     *
     * Resolved *before* admission, and that ordering is the whole point. The
     * fallback is not a quiet downgrade: admission then runs against what the
     * agent really gets, so §3.10's rule refuses an `all-or-nothing` runtime
     * here — with the missing capability named — rather than admitting it as
     * "contained" and handing it the workspace root. Deciding after admission
     * would produce exactly that: a decision that said isolated and a filesystem
     * that was not.
     */
    let isolation = requested;
    let downgraded: string | null = null;
    if (requested === 'worktree') {
      const support = await worktreeSupport(this.deps.workspaceRoot);
      if (!support.ok) {
        isolation = 'shared';
        downgraded = support.reason;
      }
    }

    const admission = await this.deps.registry.admit(spec, isolation, input.requirements ?? {});
    if (!admission.ok) throw new AdmissionRefused(admission.failures);

    // Cut after admission, so a configuration that was going to be refused
    // anyway does not leave a branch behind.
    if (isolation === 'worktree') {
      const worktree = await createWorktree(this.deps.workspaceRoot, spec.agentId);
      live.worktrees.set(spec.agentId, worktree);
      spec.workspacePath = worktree.path;
    }

    /*
     * The default effort is chosen here and nowhere earlier, because here is the
     * first point anything knows whether the model takes one (§3.3).
     *
     * A seat that asked for nothing gets `max` on a target that can think, and
     * nothing at all on one that cannot — the adapter rejects an effort a model
     * does not support outright, so a blanket default would break every plain
     * model rather than degrade on it.
     */
    if (spec.reasoning === undefined && admission.capabilities.reasoningControl === 'effort') {
      spec.reasoning = { mode: DEFAULT_REASONING };
    }

    const record: AgentRecord = {
      agentId: spec.agentId,
      role: spec.role,
      spec: stripWorkspacePath(spec),
      resolvedCapabilities: admission.capabilities,
      status: 'idle',
      isolation,
      resumeToken: null,
      lastEventSeq: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    };

    live.session.agents.push(record);
    live.specs.set(spec.agentId, spec);

    // Said out loud. An agent that asked for its own checkout and did not get
    // one is working under different rules than its configuration reads, and a
    // downgrade nobody was told about is how that becomes a surprise later.
    if (downgraded !== null) {
      this.emit('progress', live.session.sessionId, {
        kind: 'phase',
        detail: `${spec.agentId} asked for worktree isolation and is running shared: ${downgraded}`,
        at: this.now().toISOString(),
      });
    }

    // Durable, so a reloaded log can resolve this agentId to its runtime, model,
    // isolation, and gate strength — which every logged decision references.
    await live.store.append(
      {
        type: 'agent.created',
        role: spec.role,
        runtimeId: spec.runtimeId,
        isolation,
        permissionFidelity: admission.capabilities.permissionFidelity,
        capabilities: admission.capabilities,
        ...(spec.model !== undefined ? { model: spec.model } : {}),
        // Persisted so `resumeSession` rebuilds this exact spec rather than a
        // default-shaped lookalike.
        ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
        ...(Object.keys(spec.limits).length > 0 ? { limits: spec.limits } : {}),
        ...(spec.reasoning !== undefined ? { reasoning: spec.reasoning } : {}),
      },
      {
        agentId: spec.agentId,
        origin: this.originFor(spec),
        ...(actor !== undefined ? { actor } : {}),
      },
    );

    this.touch(live);
    return record;
  }

  /** Send a turn and run it to completion, applying the resulting state. */
  /**
   * Queue a turn for an agent and resolve when *this* turn completes.
   *
   * Several clients may hold read-write access at once (§17 Q14), so two people
   * can send to the same agent. Turns are queued in arrival order at the owner
   * rather than raced: arrival here is the only ordering that exists, since
   * client clocks disagree and neither client can see the other's send.
   *
   * The queue is **per agent**, not per session. Agents in one session are meant
   * to run in parallel (§4.2), so a session-wide queue would serialize work that
   * is supposed to be concurrent. With one agent the two are identical, which is
   * why this costs nothing today and is correct later.
   *
   * A turn survives the client that sent it. Queued work belongs to the session
   * owner, so closing the app — or the phone going to sleep — does not cancel
   * what was already asked for.
   *
   * **Not durable across an owner crash.** A queued turn has not happened yet, so
   * writing it to the log would put something in the transcript that never ran.
   * The alternative, a separate durable queue, buys little: depth is normally
   * zero or one, and a crash already costs the running turn.
   */
  async send(sessionId: SessionId, agentId: AgentId, turn: UserTurn, actor?: Actor): Promise<void> {
    // A person in the loop is what the hop ceiling is waiting for, so their turn
    // clears it for the whole session rather than only for the agent they
    // addressed — the exchange they interrupted is over.
    if (actor !== undefined) this.live(sessionId).hops.clear();

    // Validate before queueing, so a bad target fails at the call rather than
    // silently much later when the queue drains to it.
    const live = this.live(sessionId);
    this.agent(live, agentId);

    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(agentId) ?? [];
      queue.push({ turn, resolve, reject, ...(actor !== undefined ? { actor } : {}) });
      this.queues.set(agentId, queue);
      this.emit('queue', sessionId, agentId, queue.length);
      void this.drain(sessionId, agentId);
    });
  }

  /** Turns waiting behind the one running, for a client to display. */
  queueDepth(agentId: AgentId): number {
    return this.queues.get(agentId)?.length ?? 0;
  }

  /**
   * Run queued turns for one agent, one at a time.
   *
   * Guarded by `draining` rather than by queue length: two concurrent sends would
   * otherwise each see a non-empty queue and start a runner, and the same turn
   * would be delivered twice.
   */
  private async drain(sessionId: SessionId, agentId: AgentId): Promise<void> {
    if (this.draining.has(agentId)) return;
    this.draining.add(agentId);
    try {
      for (;;) {
        const queue = this.queues.get(agentId);
        const next = queue?.shift();
        if (!next) return;
        this.emit('queue', sessionId, agentId, queue?.length ?? 0);
        try {
          await this.runTurn(sessionId, agentId, next.turn, next.actor);
          next.resolve();
        } catch (err) {
          // One failed turn must not strand the turns behind it.
          next.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    } finally {
      this.draining.delete(agentId);
    }
  }

  private async runTurn(
    sessionId: SessionId,
    agentId: AgentId,
    turn: UserTurn,
    actor?: Actor,
  ): Promise<void> {
    const live = this.live(sessionId);
    const record = this.agent(live, agentId);
    const spec = live.specs.get(agentId);
    if (!spec) throw new Error(`agent ${agentId} has no spec`);

    const runtime = this.deps.registry.get(spec.runtimeId);

    // The handle is opened *before* this turn is logged. A rehydrated seed is
    // built from the log, so appending first would put the incoming turn into
    // the seed and then send it again — the agent would see it twice.
    let handle = live.handles.get(agentId);
    if (!handle) {
      handle = await this.openHandle(live, record, spec, runtime);
    }

    /**
     * Fitted to what this agent declared it can take (§12.2).
     *
     * Here rather than in the harness, and that placement is the point: this is
     * the only process holding both the blob store and the agent's capabilities.
     * A resizer inside the adapter could decide an image was too large and had
     * no way to reach the bytes to do anything about it.
     *
     * Per agent, not per session: one session can hold a frontier lead and a
     * local worker with different limits, and the answer belongs to whoever is
     * receiving this turn.
     */
    const fitted = await fitContent(
      turn.content,
      record.resolvedCapabilities,
      (image, max) => this.rescale(live, image, max),
      // §12.3's flattening, here for the same reason as the resizer: this is the
      // only process holding both the blob store and the agent's capabilities.
      (image, annotations) => this.burnAnnotations(live, image, annotations),
    );
    for (const note of fitted.downgrades) {
      // Reported, never silent. §3.5: "this model keeps ignoring my screenshots"
      // should have a visible cause rather than becoming folklore.
      this.emit('progress', live.session.sessionId, {
        kind: 'phase',
        detail: note.detail,
        at: this.now().toISOString(),
      });
    }

    await live.store.append(
      { type: 'user.turn', content: fitted.content },
      { agentId, ...(actor !== undefined ? { actor } : {}) },
    );
    await this.setState(live, 'working');

    record.status = 'running';

    /**
     * Queue behind whatever else shares this credential (§8).
     *
     * After the turn is logged and the session is `working`, so the transcript
     * shows what was asked and the UI shows something happening — a wait that
     * looked like nothing at all would be worse than the wait.
     *
     * Immediate for a local model, and for any credential nothing has complained
     * about yet, which is every credential until a provider says otherwise.
     */
    const group = groupFor(spec.auth);
    live.waitingOnQuota.add(agentId);
    try {
      await this.quota.acquire(group, (ms) =>
        this.contextFor(live, spec).reportProgress({
          kind: 'phase',
          detail: `waiting ${Math.round(ms / 1000)}s for the shared credential`,
          at: this.now().toISOString(),
        }),
      );
    } finally {
      live.waitingOnQuota.delete(agentId);
    }

    /**
     * A slot on this machine, taken **after** the credential wait (§8).
     *
     * The order is the decision. Waiting on a shared allowance costs this host
     * nothing, so holding one of its scarce slots through that wait would starve
     * agents on a *different* credential that could have run. §8 keeps these as
     * "three independent limits" and this is what that separation buys.
     *
     * Held for as long as the turn runs, **except while a human is being waited
     * for** — see `decide`. That exception was not here, and the reasoning
     * against it ("the worker is resident and costing memory whether or not
     * anyone has answered") is true and is outweighed: a permission prompt can
     * go unanswered for hours, which is the entire premise of §11's inbox, and a
     * quota wait is already outside this slot for exactly the same reason one
     * line up.
     *
     * A parent waiting on children holds nothing: `propose_split` returns inside
     * the turn, so the parent's turn ends and its slot goes back before any child
     * asks for one. Without that a tree deeper than the cap would deadlock.
     */
    const holder: SlotHolder = { release: await this.acquireSlot(live, spec) };
    // Mutable and keyed by agent, because `decide` has to be able to hand this
    // slot back mid-turn and take a fresh one afterwards.
    this.turnSlots.set(agentId, holder);

    let outcome;
    try {
      const pumped = pumpAgent(handle, live.store, { origin: this.originFor(spec), agentId });
      await handle.send({ content: fitted.content });
      outcome = await pumped;
    } finally {
      // Whatever happened, and whichever slot is current. A slot leaked by a
      // thrown turn is a host that runs one fewer agent for the rest of its
      // life, and nothing would report it. `release` is idempotent, so a turn
      // that threw while parked on a prompt gives back nothing twice.
      holder.release();
      this.turnSlots.delete(agentId);
    }

    // What one agent learned about the credential, before the others send. This
    // is the entire reason a group exists: eight agents on one allowance should
    // not each spend a request discovering the same spent window.
    this.quota.observe(group, outcome.stop);

    record.resumeToken = outcome.resumeToken;
    record.lastEventSeq = live.store.nextSeq - 1;
    record.usage = mergeUsage(record.usage, outcome.usage);
    record.status = outcome.disposition === 'fail' ? 'stopped' : 'idle';

    // A finished turn releases the handle so the next send resumes cleanly;
    // parked agents are what make many concurrent sessions affordable (§8).
    live.handles.delete(agentId);
    live.aborts.delete(agentId);

    // Parked with everything needed to pick it up again. A window that reports
    // no `resetsAt` is not parked: waking at a time nobody named would be a
    // guess, and this waits for a person instead.
    if (outcome.stop.kind === 'quota_exhausted' && outcome.stop.resetsAt !== undefined) {
      const resetsAt = Date.parse(outcome.stop.resetsAt);
      if (Number.isFinite(resetsAt)) {
        live.parked = { resetsAt, agentId, turn, ...(actor !== undefined ? { actor } : {}) };
      }
    }

    await this.surfaceMerge(live, agentId);

    await this.setState(live, outcome.nextState, stopReasonSummary(outcome.stop));
    await live.store.maybeCheckpoint();
  }

  /**
   * Two-tier resume (§5.4). The native token is a cache; the log is truth.
   *
   * Gated on the *capability*, not on whether a token happens to exist. Gating
   * on token presence meant every `nativeResume: false` runtime silently started
   * fresh each turn while logging `resumeMode: 'fresh'` as though intentional —
   * so the session's memory reset and nothing said so.
   */
  private async openHandle(
    live: LiveSession,
    record: AgentRecord,
    spec: AgentSpec,
    runtime: AgentRuntime,
  ): Promise<AgentHandle> {
    const caps = record.resolvedCapabilities;
    const ctx = this.contextFor(live, spec);

    // Skipped outright after a move, rather than attempted and allowed to fail.
    // A vendor's resume token was minted against the old path, and the two ways
    // it can behave are both bad: reject — which costs a round trip to learn
    // what we already know — or *succeed* against state that describes a
    // directory the code is no longer in. §15's criterion for this phase is
    // explicitly "verified with the native resume token deliberately
    // invalidated", because the durable path is the one that has to carry it.
    const trustToken = this.deps.relocatedFrom === undefined;

    // Recorded whether or not there was a token to discard. The move is a fact
    // about the workspace, not about one runtime's resume support — putting it
    // inside the token branch meant a runtime that mints no token left no trace
    // of having moved at all. Once per session, not once per agent, or the log
    // fills with the same sentence.
    if (!trustToken && !live.notedRelocation) {
      live.notedRelocation = true;
      await live.store.append({
        type: 'workspace.relocated',
        from: this.deps.relocatedFrom as string,
        to: this.deps.workspaceRoot,
      });
    }

    if (!trustToken && record.resumeToken !== null) {
      this.emit(
        'resume-rejected',
        live.session.sessionId,
        spec.agentId,
        new Error(`workspace moved from ${this.deps.relocatedFrom}; native resume token discarded`),
      );
    }

    if (trustToken && caps.nativeResume && record.resumeToken !== null) {
      try {
        const handle = await runtime.resume(spec, record.resumeToken, ctx);
        live.handles.set(spec.agentId, handle);
        await live.store.append(
          { type: 'agent.started', resumeMode: 'native' },
          { agentId: spec.agentId, origin: this.originFor(spec) },
        );
        return handle;
      } catch (err) {
        // Rejection is expected and ordinary — a moved workspace, an upgraded
        // runtime, an expired token. Fall through to the durable path.
        this.emit('resume-rejected', live.session.sessionId, spec.agentId, err);
      }
    }

    const seed = await rehydrate(live.store, {
      budgetTokens: Math.floor(caps.contextWindow * 0.5),
    });

    const handle = await runtime.start(spec, {
      ...ctx,
      ...(seed.isEmpty ? {} : { seedHistory: seed.seed }),
    });
    live.handles.set(spec.agentId, handle);

    await live.store.append(
      {
        type: 'agent.started',
        resumeMode: seed.isEmpty ? 'fresh' : 'rehydrated',
        ...(seed.isEmpty ? {} : { seededThroughSeq: seed.seededThroughSeq }),
      },
      { agentId: spec.agentId, origin: this.originFor(spec) },
    );

    return handle;
  }

  /**
   * Interrupt one agent or all of them.
   *
   * Capability-gated: a runtime that declares `interruptible: false` is not
   * asked, and the refusal is reported rather than silently doing nothing.
   * §3.3 says capabilities are enforced, not assumed — this was the call site
   * that assumed. The abort signal fires either way, so an adapter that honors
   * only `ctx.abortSignal` is still cancellable.
   */
  async interrupt(sessionId: SessionId, agentId?: AgentId, actor?: Actor): Promise<void> {
    const live = this.live(sessionId);
    const targets = agentId ? [agentId] : [...live.handles.keys()];

    for (const id of targets) {
      const record = live.session.agents.find((a) => a.agentId === id);
      live.aborts.get(id)?.abort(new Error('interrupted'));

      const interruptible = record?.resolvedCapabilities.interruptible !== false;
      if (!interruptible) {
        this.emit('degraded', live.session.sessionId, id, 'runtime is not interruptible');
      } else {
        await live.handles.get(id)?.interrupt();
      }

      // Logged either way, and *after* the attempt so `delivered` reports what
      // happened rather than what was intended. A stop that the runtime could
      // not honour is the case a transcript most needs to explain: without this
      // the turn simply carries on and the log offers no reason why.
      await live.store.append(
        {
          type: 'agent.interrupted',
          delivered: interruptible,
          ...(interruptible ? {} : { note: 'this runtime cannot be interrupted mid-turn' }),
        },
        { agentId: id, ...(actor !== undefined ? { actor } : {}) },
      );
    }

    /**
     * A session that is `working` with nothing running is stuck, and this is the
     * only thing that can say so.
     *
     * The manager owns the turn loop, so a handle is registered before the state
     * becomes `working` and removed when the turn ends. `working` with an empty
     * handle map therefore means the agent went away mid-turn — the host died,
     * the adapter crashed — and nothing else will ever move it: §10 will not let
     * stall detection change the state, because a stall is a suspicion and an
     * agent may simply be slow.
     *
     * Left alone, that session holds the host busy forever: `shutdown` refuses
     * while anything is `working`, so the host cannot be asked to exit and
     * upgrading it means killing the process. Found in the field, doing exactly
     * that.
     *
     * Only on an *explicit* interrupt. A person typed this; inferring it from a
     * timer would be stall detection issuing the verdict §10 denies it.
     *
     * `awaiting_input` rather than `failed`, per §4.1: nothing is broken, the
     * work simply stopped and is waiting for whoever stopped it.
     */
    if (live.session.state === 'working' && live.handles.size === 0) {
      await this.setState(live, 'awaiting_input', 'interrupted; no turn was running');
    }
  }

  // ---------------------------------------------------------------- permissions

  /** Requests currently awaiting a decision, newest last. */
  pendingPermissions(): PermissionRequest[] {
    return [...this.pending.values()].map(({ resolve: _resolve, askedAt: _askedAt, ...req }) => req);
  }

  /**
   * Resolve a pending request. The denial reason is fed back to the agent so it
   * can adapt rather than retrying blindly (§13).
   */
  /**
   * Answer a pending request. **First answer wins.**
   *
   * With several clients attached to one host, two devices can show the same
   * prompt and both be clicked. Throwing on the second would surface an error on
   * a device that did nothing wrong, so a late answer returns
   * `already-answered` and the caller withdraws its prompt instead.
   *
   * `unknown` covers a request this process never had — answered before a
   * restart, or withdrawn. Also not an error: a client that raced a withdrawal
   * should not see a failure for a prompt that simply no longer exists.
   */
  async respondPermission(
    requestId: string,
    decision: PermissionDecision,
    actor?: Actor,
  ): Promise<'answered' | 'already-answered' | 'unknown'> {
    const entry = this.pending.get(requestId);
    if (!entry) {
      // Distinguishable so a UI can say "someone else answered this" rather than
      // "that prompt was never real".
      return this.answered.has(requestId) ? 'already-answered' : 'unknown';
    }
    this.pending.delete(requestId);
    this.answered.add(requestId);

    const live = this.live(entry.sessionId);
    const spec = live.specs.get(entry.agentId);

    await this.logDecision(live, entry, decision, 'user', undefined, actor);
    this.applyGrant(spec, entry, decision);

    entry.resolve(decision);

    // Announced, because the prompt is on more than one screen. A request
    // reaches every attached client, so an answer has to as well — otherwise the
    // device that did not answer keeps showing a question that has already been
    // settled, and only finds out by pressing a button and being told it was too
    // late. §15 names this the criterion that proves the topology, and it is the
    // half that was missing: the ask was broadcast and the answer was not.
    this.emit('permission-resolved', {
      requestId,
      sessionId: entry.sessionId,
      outcome: 'answered' as const,
      decision,
      ...(actor !== undefined ? { actor } : {}),
    });

    // Per session: another session's open prompt must not keep this one parked,
    // and this one's must not be cleared by a sibling being answered.
    if (!this.hasPendingFor(entry.sessionId)) await this.setState(live, 'working');
    return 'answered';
  }

  /**
   * Withdraw every request this session still shows as pending.
   *
   * Called when a session is loaded from disk: the promises those requests were
   * waiting on died with the process that made them, so the agent is not
   * waiting any more. Leaving them in the folded pending set would offer a
   * prompt that does nothing when answered, which is worse than offering none.
   */
  private async withdrawStale(live: LiveSession, outstanding: ReadonlyArray<{ requestId: string; agentId: AgentId }>): Promise<void> {
    for (const request of outstanding) {
      await live.store.append(
        {
          type: 'permission.withdrawn',
          requestId: request.requestId,
          reason: 'the agent that asked is no longer running',
        },
        { agentId: request.agentId },
      );
      // Same reason as an answer: a prompt nobody can answer any more must
      // disappear from every screen showing it, not just from the one that
      // happened to reload.
      this.emit('permission-resolved', {
        requestId: request.requestId,
        sessionId: live.session.sessionId,
        outcome: 'withdrawn' as const,
        reason: 'the agent that asked is no longer running',
      });
    }
  }

  /**
   * Move a seat to a different reasoning effort (§3.4).
   *
   * Refused **by name** on a target that cannot take one, rather than accepted
   * and dropped. `reasoning_effort` is not a field a model without the
   * capability ignores — it is a 400 — so silently storing an effort here would
   * turn every later turn into a failed request, and the person who set it
   * would have no reason to connect the two.
   *
   * Written to the log rather than only to the live object: the projected seat
   * is what a rebuilt spec is made from, and a change that lived in memory
   * would vanish at the next restart while the transcript looked complete.
   */
  async setReasoning(sessionId: SessionId, agentId: AgentId, to: ReasoningRequest): Promise<void> {
    const live = this.live(sessionId);
    const record = live.session.agents.find((a) => a.agentId === agentId);
    if (record === undefined) throw new Error(`no agent ${agentId} in this session`);

    if (record.resolvedCapabilities.reasoningControl !== 'effort') {
      throw new Error(
        `${record.spec.model?.modelId ?? record.spec.runtimeId} does not take a reasoning effort`,
      );
    }

    const from = record.spec.reasoning;
    if (from?.mode === to.mode) return;

    record.spec.reasoning = to;
    const spec = live.specs.get(agentId);
    if (spec !== undefined) spec.reasoning = to;

    await live.store.append(
      { type: 'agent.reasoning_changed', ...(from !== undefined ? { from } : {}), to },
      { agentId },
    );
    this.touch(live);
  }

  private contextFor(live: LiveSession, spec: AgentSpec): RuntimeContext {
    // Held, not discarded: the previous version created a controller inline, so
    // the documented cancellation channel could never fire and `wallClockMs` had
    // no mechanism behind it.
    const controller = new AbortController();
    live.aborts.set(spec.agentId, controller);

    return {
      abortSignal: controller.signal,
      reportProgress: (p) => this.emit('progress', live.session.sessionId, p),
      requestPermission: (ask) => this.decide(live, spec, ask),
      sendMessage: (message) => void this.deliver(live, spec.agentId, message),
      peers: live.session.agents.map((a) => a.agentId),
      capture: (o) => this.captureUrl(live, o),
      proposeSplit: (proposal) => void this.proposeSplit(live.session.sessionId, proposal, spec.agentId),
      compact: (budgetTokens) => this.compact(live, spec, budgetTokens),
    };
  }

  /**
   * Compact one agent's history, on that agent's own initiative (§3.7).
   *
   * The **same `rehydrate()`** the resume path uses, which was the point of the
   * design: the function that reconstructs context after a workspace moves is
   * the function that compacts a running session, so the durable path is
   * exercised every day rather than only in a rare recovery.
   *
   * `null` for an empty result rather than an empty history. A session whose log
   * holds nothing worth carrying is ordinary, and handing back zero turns would
   * erase a conversation to save a window that was not full.
   *
   * The event is written here, not by the caller, for the reason every other
   * event is: the store is the owner's. A transcript that shows a context
   * shrinking with no line saying so reads as a model that forgot things.
   */
  private async compact(
    live: LiveSession,
    spec: AgentSpec,
    budgetTokens: number,
  ): Promise<CompactedHistory | null> {
    const result = await rehydrate(live.store, { budgetTokens });
    if (result.isEmpty) return null;

    const { beforeTokens, afterTokens } = await compactionSizes(live.store, result);
    await live.store.append(
      { type: 'agent.compacted', beforeTokens, afterTokens },
      { agentId: spec.agentId, origin: this.originFor(spec) },
    );
    live.lastEventAt = this.now().getTime();

    return { turns: result.seed, beforeTokens, afterTokens };
  }

  /**
   * Record one agent addressing another, and wake the recipient (§4.2).
   *
   * The log entry is written **whatever happens next** — including when the
   * message is refused for depth, and including a broadcast that wakes nobody.
   * Recording only the delivered ones would make the transcript a record of
   * successful coordination rather than of coordination, and the interesting
   * question when a roster misbehaves is usually what it *tried* to say.
   */
  private async deliver(live: LiveSession, from: AgentId, message: OutboundMessage): Promise<void> {
    const hops = (live.hops.get(from) ?? 0) + 1;
    const stamped: AgentMessage = { ...message, from, hops };

    await live.store.append({ type: 'agent.message', message: stamped }, { agentId: from });
    live.lastEventAt = this.now().getTime();

    if (hops > MAX_MESSAGE_HOPS) {
      await live.store.append(
        {
          type: 'session.state',
          from: live.session.state,
          to: live.session.state,
          reason: `message from ${from} not delivered: ${MAX_MESSAGE_HOPS} hops without a person`,
        },
        { agentId: from },
      );
      return;
    }

    // A broadcast is readable by anyone and wakes no one. Delivering it as a
    // turn would mean one message starting a turn per agent in the roster,
    // which is how a roster of six becomes a fork bomb.
    if (stamped.to === 'session') return;

    const recipient = live.session.agents.find((a) => a.agentId === stamped.to);
    if (recipient === undefined) return;

    live.hops.set(stamped.to, hops);
    // No actor: nobody pressed anything. §5.1 treats an absent actor as "no
    // person acted", and attributing this to whoever happens to be attached
    // would put a name on a turn they never sent.
    void this.send(live.session.sessionId, stamped.to, { content: stamped.content }).catch(
      () => undefined,
    );
  }

  /**
   * Put an unmerged branch on the checklist (§9).
   *
   * Never merged automatically. A worktree is a branch and the merge is the
   * user's call: an automatic `git merge` either conflicts at an inconvenient
   * moment or, worse, does not — and lands work nobody reviewed. A visible
   * unfinished item is the honest shape for "this agent produced something you
   * have not accepted yet".
   *
   * Idempotent by item id, so a five-turn agent contributes one line rather than
   * five. Re-appended each turn on purpose: the text carries the commit state,
   * and an item that stopped being true after the first turn would be worse than
   * no item at all.
   */
  private async surfaceMerge(live: LiveSession, agentId: AgentId): Promise<void> {
    const worktree = live.worktrees.get(agentId);
    if (worktree === undefined) return;
    if (!(await hasCommits(this.deps.workspaceRoot, worktree))) return;

    await live.store.append(
      {
        type: 'checklist.updated',
        itemId: `merge:${worktree.branch}`,
        state: 'todo',
        text: `merge ${worktree.branch} into ${worktree.base}`,
      },
      { agentId },
    );
  }

/**
   * Scale a stored image down for an agent that cannot take it whole (§12.2).
   *
   * Reads the blob, scales, and stores the result as a *new* blob — the original
   * is never replaced. §12.3 makes that rule explicit for annotations and the
   * same reasoning applies here: what was attached has to stay recoverable, and
   * a second agent with a larger limit should get the full-size image rather
   * than whatever the first agent's ceiling left behind.
   *
   * `null` on anything at all — an unreadable blob, a format this cannot decode.
   * `fitContent` turns that into a named downgrade, which is the honest outcome:
   * the image is not sent, and the model is told why.
   */
  private async rescale(
    live: LiveSession,
    image: { sha256: string; mime: string },
    maxLongEdge: number,
  ): Promise<{ sha256: Sha256; width: number; height: number } | null> {
    try {
      const original = await live.store.blobs.get(image.sha256 as Sha256, image.mime);
      const scaled = await scaleToFit(original, maxLongEdge);
      const { width, height } = sizeOf(scaled);
      const stored = await live.store.attach(scaled, image.mime);
      return { sha256: stored.sha256 as Sha256, width, height };
    } catch {
      return null;
    }
  }

/**
   * Draw a turn's annotations onto its image and store the result (§12.3).
   *
   * A *new* blob every time, never a replacement. §12.3: annotations "stay
   * editable and the original is never destroyed" — and the original is what
   * `annotatedFrom` points back at, so overwriting it would break the link and
   * the promise in one move.
   *
   * Blackouts never reach here. They went through `redactAndStore` before the
   * frame was written, because deferring one would leave the secret sitting in a
   * content-addressed store that §6.7 will push on request — §12.1's guarantee,
   * which §12.3 explicitly must not undo.
   *
   * `null` rather than a throw when there is no decoder: a missing painter costs
   * the marks, not the message. The description travels either way, and §12.3
   * says that is often the only part a weaker model reads.
   */
  private async burnAnnotations(
    live: LiveSession,
    image: { sha256: string; mime: string },
    annotations: readonly Annotation[],
  ): Promise<{ sha256: Sha256 } | null> {
    try {
      const original = await live.store.blobs.get(image.sha256 as Sha256, image.mime);
      const painted = await flattenAnnotations(original, annotations);
      const stored = await live.store.attach(painted, image.mime);
      return { sha256: stored.sha256 as Sha256 };
    } catch {
      return null;
    }
  }

  /**
   * Screenshot a URL and store it in this session's blobs (§12.1).
   *
   * Here rather than in the adapter for the same reason fitting is: the blob
   * store belongs to the owner of the log. An adapter handed raw bytes would
   * either have to write them somewhere it does not own or hold a screenshot in
   * memory for the rest of the turn.
   *
   * Provenance is recorded in full — url, viewport, which browser — because §12.1
   * asks for it and because a rendering difference between two captures is
   * unattributable without it.
   */
  private async captureUrl(
    live: LiveSession,
    o: { url: string; viewport?: { width: number; height: number; dpr: number } },
  ): Promise<ImageBlock> {
    const shot = await captureUrl(o.url, { ...(o.viewport !== undefined ? { viewport: o.viewport } : {}) });
    const { width, height } = sizeOf(shot.png);
    const stored = await live.store.attach(shot.png, 'image/png');

    return {
      type: 'image',
      sha256: stored.sha256 as Sha256,
      mime: 'image/png',
      width,
      height,
      provenance: {
        kind: 'headless_browser',
        // §12.1: both remote sources are tagged this way. The pixels were
        // produced by the machine running the work, not by the person watching.
        origin: 'remote',
        capturedAt: this.now().toISOString(),
        url: shot.url,
        viewport: { w: shot.viewport.width, h: shot.viewport.height, dpr: shot.viewport.dpr },
      },
    };
  }

  /** Provenance for events attributable to an agent (§5.1). */
  private originFor(spec: AgentSpec | Omit<AgentSpec, 'workspacePath'>): EventOrigin {
    const runtime = this.deps.registry.has(spec.runtimeId)
      ? this.deps.registry.get(spec.runtimeId)
      : null;
    return {
      runtimeId: spec.runtimeId,
      adapterVersion: runtime?.version ?? 'unknown',
      ...(runtime?.toolVersion !== undefined ? { cliVersion: runtime.toolVersion } : {}),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
    };
  }

  /**
   * The gate. Policy is consulted first; only an `ask` outcome reaches the user.
   * An unresolvable request parks the session in `awaiting_permission` — paused,
   * holding state, never failed.
   *
   * Every outcome is logged, including the ones policy settles without a prompt.
   */
  private async decide(
    live: LiveSession,
    spec: AgentSpec,
    ask: PermissionAsk,
  ): Promise<PermissionDecision> {
    // The workspace root is what makes §13's inside/outside rows evaluable.
    const evaluation = evaluatePolicy(spec.toolPolicy, ask.tool, ask.args, {
      workspaceRoot: this.deps.workspaceRoot,
    });

    const request: PermissionRequest = {
      ...ask,
      sessionId: live.session.sessionId,
      // Host-minted. An adapter-minted id collided across parallel calls, so a
      // decision could be applied to a different call than the one displayed.
      requestId: `${ask.agentId}:${ask.toolUseId ?? uuidv7()}`,
    };

    if (evaluation.outcome !== 'ask') {
      const decision: PermissionDecision =
        evaluation.outcome === 'allow'
          ? { result: 'allow', scope: 'once' }
          : {
              result: 'deny',
              reason:
                evaluation.reason ??
                (evaluation.rule?.match
                  ? `denied by policy: ${evaluation.rule.tool}(${evaluation.rule.match})`
                  : `denied by policy: ${ask.tool}`),
            };

      await this.logDecision(
        live,
        request,
        decision,
        evaluation.nonOverridable ? 'escalation-guard' : 'policy',
        evaluation,
      );
      return decision;
    }

    if (this.pending.has(request.requestId)) {
      // Overwriting would drop the first promise and wedge that turn forever.
      throw new Error(`duplicate permission request id ${request.requestId}`);
    }

    // Durable *before* the prompt exists. The waiting promise lives in this
    // process, but the record of what is being asked does not — that is what
    // lets any attached client see the request and answer it, and what lets a
    // reloaded session know a request was outstanding at all (§7, §16).
    await live.store.append(
      {
        type: 'permission.requested',
        requestId: request.requestId,
        tool: request.tool,
        args: request.args,
        ...(request.toolUseId !== undefined ? { toolUseId: request.toolUseId } : {}),
      },
      { agentId: request.agentId, origin: this.originFor(spec) },
    );

    await this.setState(live, 'awaiting_permission');

    /**
     * Hand the concurrency slot back while a person is being waited for (§8).
     *
     * Found by CI on a small runner, not by reading: `defaultTurnCap()` is
     * `min(8, cores − 2)`, which is **1** on any machine with three cores or
     * fewer — a modest VM, a CI runner, a Raspberry Pi. Holding the slot across
     * a prompt meant one unanswered question stopped every agent on the host,
     * on every session, until a human came back. Every development machine here
     * has four cores or more, so it passed everywhere it was ever run.
     *
     * The argument for holding it was that the worker is resident and costs
     * memory whether or not anyone has answered. True, and outweighed twice
     * over: a prompt can go unanswered for hours — that is the whole premise of
     * §11's inbox — and the design already makes this exact call one line above
     * the acquisition, where a quota wait sits *outside* the slot because
     * "waiting on a shared allowance costs this host nothing". Waiting on a
     * person costs it nothing either.
     *
     * The cost is that resuming queues again rather than continuing instantly.
     * That is the correct price: a turn that has been idle for an hour has no
     * claim on the machine ahead of one that has been waiting to start.
     */
    const holder = this.turnSlots.get(request.agentId);
    holder?.release();

    try {
      return await new Promise<PermissionDecision>((resolve) => {
        this.pending.set(request.requestId, {
          ...request,
          askedAt: this.now().toISOString(),
          resolve,
        });
        this.emit('permission', request);
      });
    } finally {
      // Retaken before the tool runs, so the work that follows an answer is
      // still bounded by the cap. Reassigned rather than returned, so the
      // `finally` in `send` releases whichever slot is current.
      if (holder !== undefined) {
        holder.release = await this.acquireSlot(live, spec);
      }
    }
  }

  /** Take a slot, explaining the wait if there is one. */
  private async acquireSlot(live: LiveSession, spec: AgentSpec): Promise<() => void> {
    return this.slots.acquire((position) =>
      this.contextFor(live, spec).reportProgress({
        kind: 'phase',
        detail: `queued behind ${position} turn${position === 1 ? '' : 's'} on this machine`,
        at: this.now().toISOString(),
      }),
    );
  }

  private async logDecision(
    live: LiveSession,
    request: PermissionRequest,
    decision: PermissionDecision,
    via: 'policy' | 'user' | 'escalation-guard',
    evaluation?: { rule: PolicyRule | null; subject: string | null },
    /** Only ever set when `via` is `'user'` — policy is not a person. */
    actor?: Actor,
  ): Promise<void> {
    const spec = live.specs.get(request.agentId);
    await live.store.append(
      {
        type: 'permission.decided',
        requestId: request.requestId,
        tool: request.tool,
        args: request.args,
        decision,
        via,
        ...(evaluation?.rule ? { rule: evaluation.rule } : {}),
        ...(evaluation ? { subject: evaluation.subject } : {}),
        ...(request.toolUseId !== undefined ? { toolUseId: request.toolUseId } : {}),
      },
      {
        agentId: request.agentId,
        // "Which agent tried that" needs the runtime and model, not just an id.
        ...(spec ? { origin: this.originFor(spec) } : {}),
        // The question this whole field exists to answer: with several people
        // attached to one host, "the gate said yes" is not an answer to "who
        // let it run that".
        ...(actor !== undefined ? { actor } : {}),
      },
    );
  }

  /**
   * Apply a durable grant to the *asking agent* only. A session-wide grant would
   * widen siblings that may be on a less trusted runtime (§13).
   */
  private applyGrant(
    spec: AgentSpec | undefined,
    request: PermissionRequest,
    decision: PermissionDecision,
  ): void {
    if (!spec || decision.result !== 'allow') return;
    if (decision.scope === 'once') return;

    spec.toolPolicy.rules.push(
      decision.scope === 'pattern'
        ? { tool: request.tool, match: decision.match, action: 'allow' }
        : { tool: request.tool, action: 'allow' },
    );
  }

  private hasPendingFor(sessionId: SessionId): boolean {
    for (const entry of this.pending.values()) {
      if (entry.sessionId === sessionId) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ internals

  private async setState(live: LiveSession, to: SessionState, reason?: string): Promise<void> {
    if (live.session.state === to) return;
    const from = live.session.state;

    /**
     * A parent cannot finish while a descendant is still working (§4.3).
     *
     * `awaiting_children` is one of the `awaiting_*` family: paused, holding all
     * state, will resume. Letting a parent reach `done` with live children would
     * mark the work finished while some of it is still running, and a dashboard
     * that says done is the one thing nobody looks at again.
     */
    const settled = to === 'done' || to === 'awaiting_input';
    live.session.state = settled && this.hasActiveChildren(live) ? 'awaiting_children' : to;
    // Through `ownAttention`, not `attentionFor` directly: a pending split
    // proposal has to survive the states underneath it. Deriving from state
    // alone dropped the question the moment the next turn ended.
    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    this.rollUp(live);

    await live.store.append({
      type: 'session.state',
      from,
      to,
      ...(reason !== undefined ? { reason } : {}),
    });
    this.emit('state', live.session.sessionId, to, from);
  }

  /**
   * A session said something, so it is not stuck.
   *
   * Clearing on the *first* event rather than on a turn ending is what makes
   * `stalled` reversible. A long turn that goes quiet and then resumes was never
   * stuck, and a warning that stays up after the thing it warned about resolved
   * is how a signal stops being read.
   */
  private spoke(sessionId: SessionId): void {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return;
    live.lastEventAt = this.now().getTime();
    if (live.session.needsAttention?.reason === 'stalled') {
      live.session.needsAttention = null;
      this.emit('session', live.session);
      // And up, so a warning that resolved stops showing at the root too. A
      // summons left standing after the thing it pointed at cleared is how the
      // rail stops being read.
      this.rollUp(live);
    }
  }

  /**
   * Mark sessions that have gone silent mid-turn.
   *
   * A **suspicion, not a verdict**: the state stays `working`, because that is
   * what it is — an agent may legitimately be slow, and moving it to a paused or
   * failed state would claim something untrue about work still in flight and
   * would have to be undone the moment it spoke again. `needsAttention` exists
   * precisely to say "a person should look" without asserting what happened.
   *
   * Only sessions that are `working`. A paused one is waiting for a human by
   * design, which is a different thing with its own reason, and calling that
   * stalled would flag every session anybody ever left overnight.
   */
  /**
   * Put parked sessions back to work once their window has reset.
   *
   * The turn is re-sent rather than the session merely being unpaused. §15's
   * criterion is that a quota-exhausted agent "parks and resumes on its own at
   * reset", and returning it to `awaiting_input` would mean the work only
   * continues if a human happens to notice and retype it — which is the thing
   * parking exists to avoid.
   *
   * Re-running a turn can repeat side effects it already had. That is the same
   * bargain the supervisor already makes for `rate_limited`, on a longer clock,
   * and the alternative is worse: work abandoned in the middle because nobody
   * was watching at 4am. The repeat is announced in the log so a transcript
   * showing the same turn twice explains itself.
   */
  private sweepParked(): void {
    const now = this.now().getTime();

    for (const live of this.sessions.values()) {
      const parked = live.parked;
      if (parked === undefined || now < parked.resetsAt) continue;

      // Cleared first: `send` runs the turn, and a park still set would be
      // waiting to fire again on the very next sweep.
      delete live.parked;

      void (async () => {
        try {
          await live.store.append({
            type: 'session.unparked',
            reason: 'quota-window-reset',
            parkedFor: new Date(parked.resetsAt).toISOString(),
          });
          await this.send(live.session.sessionId, parked.agentId, parked.turn, parked.actor);
        } catch {
          // A failed resume leaves the session where the failure put it. Parking
          // again on a window that has already reset would spin.
        }
      })();
    }
  }

  private sweepStalled(): void {
    const after = this.deps.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
    if (after <= 0) return;
    const now = this.now().getTime();

    for (const live of this.sessions.values()) {
      if (live.session.state !== 'working') continue;
      if (live.session.needsAttention !== null) continue;
      // Queued behind a shared credential is not stuck. It is the scheduler
      // doing exactly what it exists to do, and flagging it would teach the user
      // to ignore the one signal that means something.
      if (live.waitingOnQuota.size > 0) continue;
      if (now - live.lastEventAt < after) continue;

      live.session.needsAttention = {
        reason: 'stalled',
        since: new Date(live.lastEventAt).toISOString(),
      };
      this.emit('session', live.session);
      // Bubbled like any other blockage. A stalled grandchild that only showed
      // on its own card is exactly the thing §4.3 says nobody will ever find.
      this.rollUp(live);
    }
  }

  private touch(live: LiveSession): void {
    live.session.updatedAt = this.now().toISOString();
    this.emit('session', live.session);
  }

  private live(sessionId: SessionId): LiveSession {
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`unknown session ${sessionId}`);
    return live;
  }

  private agent(live: LiveSession, agentId: AgentId): AgentRecord {
    const record = live.session.agents.find((a) => a.agentId === agentId);
    if (!record) throw new Error(`unknown agent ${agentId}`);
    return record;
  }

  /**
   * Whether a session can already resolve a hash, sourcing it from a sibling
   * session on this host if one can (§6.7).
   *
   * The transfer is driven from the client side — the client is what holds the
   * bytes and therefore what has to decide whether to send them — but the answer
   * belongs here, because the store does.
   */
  async hasBlob(sessionId: SessionId, sha256: Sha256, mime: string): Promise<boolean> {
    // Throws on an unknown session rather than answering `false`, which would
    // read as "send it to me" and then fail on the write.
    this.live(sessionId);
    return ensureBlob(this.deps.workspaceRoot, sessionId, sha256, mime);
  }

  /**
   * Store verified bytes against a session (§6.7).
   *
   * `attach` rather than `put`, and the difference is the log: the bytes land in
   * the store *and* a `capture.attached` event lands in the transcript. A blob
   * that arrived without a trace would be unattributable the moment anybody
   * asked where a screenshot came from — which for a screenshot is the question
   * that gets asked.
   */
  async attachBlob(sessionId: SessionId, data: Buffer, mime: string): Promise<Sha256> {
    const { sha256 } = await this.live(sessionId).store.attach(data, mime);
    return sha256 as Sha256;
  }

  /** Tail the durable log for a session — the renderer's subscription source. */
  async events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
    return this.live(sessionId).store.readEvents(fromSeq);
  }

/**
   * Split a session's scope into a child that owns its own log (§4.3).
   *
   * The expensive form of decomposition, and deliberately so: a new log, its own
   * plan, its own agents, its own budget. §4.3's decision rule is that this is
   * for when *the task* does not fit — where compacting would discard specifics
   * the remaining work still needs — not for when the transcript is merely long.
   *
   * ## Everything here is a refusal before it is an action
   *
   * §4.3 keeps splits user-approved because "a decomposition mistake made
   * autonomously produces a tree of subtly mis-scoped children that is harder to
   * salvage than a single overlong session". The same reasoning applies to every
   * check below: a child spawned past a limit, or on a budget its parent cannot
   * cover, is worse than a spawn that did not happen — the first costs money and
   * attention before anyone notices, the second says why immediately.
   *
   * `buildBrief` supplies its own refusals (empty scope, empty `outOfScope`, no
   * summary ceiling, a brief over its own ceiling). This adds the ones that are
   * about the *tree* rather than the brief.
   *
   * ## The edge is written on both ends
   *
   * The parent records `session.spawned_child`, the child records
   * `session.brief_received`. Either log alone can reconstruct the relationship,
   * which is what makes a child in another workspace — the case §4.3 is built
   * for — self-contained rather than a dangling reference.
   */
  async spawnChild(
    parentSessionId: SessionId,
    input: SpawnChildInput,
    actor?: Actor,
  ): Promise<Session> {
    const parent = this.live(parentSessionId);

    // Depth first, because it is the cheapest thing to be wrong about and the
    // one that says the decomposition itself is off (§4.3: "deeper trees are
    // unmanageable and almost always signal bad decomposition, not deep work").
    const depth = parent.session.tree.depth + 1;
    if (depth > TREE_LIMITS.maxDepth) {
      throw new SplitRefused(
        `maxDepth is ${TREE_LIMITS.maxDepth} and this child would sit at ${depth}; ` +
          `a tree this deep is usually a sign the split is wrong rather than deep work`,
      );
    }
    if (parent.session.children.length >= TREE_LIMITS.maxChildrenPerSession) {
      throw new SplitRefused(
        `this session already has ${parent.session.children.length} children, ` +
          `which is the limit that keeps a tree node reviewable by a human`,
      );
    }

    /**
     * A child runs on the host that spawned it, and saying otherwise is a lie
     * in the record (§4.3, §15 Phase 6).
     *
     * `spawnChild` creates the child through `this.createSession` — *this*
     * manager, which owns one workspace on one host. A `target` naming another
     * machine set the child's `target` field and changed nothing about where it
     * ran, so the log said `ssh` while the agent worked locally. That is worse
     * than the feature being missing: an absent feature is noticed, and this one
     * was only noticed by whoever later trusted the field — roll-up asking a
     * machine that never had the session, or a person reading a transcript.
     *
     * §4.3 already says the cross-host consequences are open ("tree budget has
     * no single owner", `needsAttention` bubbling across hosts). §15 marked the
     * phase done anyway. Refusing is what makes the two agree until the fleet
     * can own a spawn.
     */
    if (input.target !== undefined && !sameTarget(input.target, parent.session.target)) {
      throw new SplitRefused(
        `a child on a different machine is not built: this session runs on ` +
          `${describeTarget(parent.session.target)} and the child would be created here anyway. ` +
          `Attach that machine and start the work there, or spawn on the same host.`,
      );
    }

    const budget = parent.session.budget;
    if (budget === undefined) {
      // A parent with no ceiling cannot carve one out, and inventing one would
      // put a number nobody agreed to at the root of a subtree.
      throw new SplitRefused('this session has no budget, so nothing can be reserved for a child');
    }

    // Taken *before* the child exists. §4.3's claim that "a tree cannot outspend
    // what its root was granted" only holds if the reservation happens at spawn
    // rather than being checked when the child spends — by then the money is
    // gone and the check is a report.
    const reserved = reserveForChild(budget, input.tokenCeiling);

    const built = await buildBrief(parent.store, {
      scope: input.scope,
      outOfScope: input.outOfScope,
      contract: input.contract,
      acceptance: input.acceptance ?? [],
      budget: reserved.child,
      ...(input.memoryRefs !== undefined ? { memoryRefs: input.memoryRefs } : {}),
      ...(input.verbatimTurns !== undefined ? { verbatimTurns: input.verbatimTurns } : {}),
    });

    const child = await this.createSession(
      {
        title: input.title,
        goal: input.scope,
        /**
         * The parent's policy, copied (§13).
         *
         * > A child **never inherits more permission than its parent held** …
         * > so "decompose the work" can never be a route to escalating
         * > privilege.
         *
         * Without this the child took `defaultPolicyForTarget`, so a parent
         * that had been *narrowed* — bash denied, say — produced a child with
         * the permissions back. Splitting was a way to undo a restriction, which
         * is the one thing this section says it must never be.
         *
         * A copy rather than the object, for the reason `addAgent` copies: a
         * grant made in the child would otherwise widen the parent, and every
         * sibling with it.
         */
        policy: clonePolicy(parent.policy),
        ...(input.target !== undefined ? { target: input.target } : {}),
      },
      actor,
    );

    const live = this.live(child.sessionId);
    live.session.tree = {
      rootSessionId: parent.session.tree.rootSessionId,
      parentSessionId,
      depth,
      // Root-first, and carrying the parent: this is what a breadcrumb renders
      // from and what stops a cycle being createable at all.
      ancestry: [...parent.session.tree.ancestry, parentSessionId],
    };
    live.session.budget = reserved.child;
    // Kept so the child can be held to it when it reports back, without having
    // to re-read a brief to find out what shape its own answer must take.
    live.contract = input.contract;

    // Durable on the child, so a session resumed in three weeks still knows why
    // it exists (§4.3: "the brief is durable, not an opening prompt").
    await live.store.append(
      { type: 'session.brief_received', brief: built.brief, parentSessionId },
      { ...(actor !== undefined ? { actor } : {}) },
    );

    const ref: ChildRef = {
      sessionId: child.sessionId,
      instanceId: child.instanceId,
      target: child.target,
      title: child.title,
      contract: input.contract,
      lastKnown: {
        state: live.session.state,
        checklistDone: 0,
        checklistTotal: 0,
        updatedAt: live.session.updatedAt,
        cost: 0,
      },
    };

    parent.session.budget = reserved.parent;
    parent.session.children.push(ref);
    await parent.store.append(
      { type: 'session.spawned_child', child: ref },
      { ...(actor !== undefined ? { actor } : {}) },
    );

    this.emit('session', parent.session);
    this.emit('session', live.session);
    return live.session;
  }

/**
   * Push this session's state up to its parent, and bubble what is blocked.
   *
   * Two things travel up and they are different in kind. `lastKnown` is a
   * **cache** for rendering a tree whose children may be unreachable — §4.3 is
   * explicit that it is "never authoritative". `needsAttention` is a **summons**:
   * §4.3 calls bubbling "the single most important tree behavior in the UI",
   * because a child three levels down waiting on a permission prompt is the
   * easiest thing in the system to lose. A parent sitting in `awaiting_children`
   * looks patient; the question underneath it goes unanswered forever.
   *
   * Walks to the root rather than one level, since the rail is at the top and a
   * blockage that stopped at the parent would still be two expansions away.
   *
   * **Within this host only.** A tree spanning two workspaces has an edge no
   * `SessionManager` can see across, and §4.3 already names this as open: the
   * fleet, or the host owning the root, has to carry it. Bubbling as far as one
   * manager reaches is honest; pretending otherwise would put a rail on screen
   * that silently omits half a tree.
   */
  private rollUp(live: LiveSession): void {
    const parentId = live.session.tree.parentSessionId;
    if (parentId === undefined) return;
    const parent = this.sessions.get(parentId as SessionId);
    if (parent === undefined) return;

    const ref = parent.session.children.find((c) => c.sessionId === live.session.sessionId);
    if (ref !== undefined) {
      ref.lastKnown = {
        state: live.session.state,
        checklistDone: live.session.checklist.filter((i) => i.state === 'done').length,
        checklistTotal: live.session.checklist.length,
        updatedAt: live.session.updatedAt,
        cost: totalCost(live.session),
      };
    }

    // Recomputed from scratch rather than patched. A parent whose own state also
    // changed, or whose child just cleared, has to be able to *lose* a bubbled
    // attention — and an incremental update that only ever adds is how a stale
    // summons stays on screen after the thing it pointed at was answered.
    this.recomputeAttention(parent);
    this.rollUp(parent);
  }

  /** Whether anything below this session is still working. */
  private hasActiveChildren(live: LiveSession): boolean {
    return live.session.children.some((c) => !isSettled(c.lastKnown.state));
  }

  /**
   * A session's own blockage, or the nearest one beneath it.
   *
   * Its own wins. A parent that is itself waiting on a permission prompt is not
   * helped by being told a grandchild is too — the thing in front of you is the
   * thing you can answer.
   */
  private recomputeAttention(parent: LiveSession): void {
    const own = this.ownAttention(parent);
    if (own !== null) {
      parent.session.needsAttention = own;
      this.touch(parent);
      return;
    }

    const found = this.findBlockedDescendant(parent, []);
    parent.session.needsAttention =
      found === null
        ? null
        : {
            reason: found.attention.reason,
            since: found.attention.since,
            // The breadcrumb travels with it, because "something below this
            // needs you" is not actionable — you have to be able to get there.
            from: { sessionId: found.sessionId, title: found.title, path: found.path },
          };
    this.touch(parent);
  }

  /** Depth-first, nearest first: the closest blockage is the one to name. */
  private findBlockedDescendant(
    live: LiveSession,
    path: string[],
  ): { sessionId: SessionId; title: string; path: string[]; attention: NonNullable<Session['needsAttention']> } | null {
    for (const ref of live.session.children) {
      const child = this.sessions.get(ref.sessionId as SessionId);
      if (child === undefined) continue;
      const here = [...path, child.session.title];

      const attention = child.session.needsAttention;
      /**
       * `needs_input` does not travel.
       *
       * Every turn ends there, so a tree of any size would permanently show a
       * summons from some child or other — and a rail that is always lit is a
       * rail nobody reads, which is the one failure mode that matters for a
       * warning. The same reason it is silent in the notifier and absent from
       * the inbox. It stays on the child's own card, where it is true and where
       * looking at it is a choice.
       */
      if (attention !== null && attention.reason !== 'needs_input') {
        // A blockage already bubbled from further down keeps its own origin,
        // rather than being re-attributed to the child that relayed it.
        return attention.from !== undefined
          ? { sessionId: attention.from.sessionId, title: attention.from.title, path: [...here, ...attention.from.path], attention }
          : { sessionId: child.session.sessionId, title: child.session.title, path: here, attention };
      }

      const deeper = this.findBlockedDescendant(child, here);
      if (deeper !== null) return deeper;
    }
    return null;
  }

  /**
   * Cancel a session, turning its children into roots (§4.3).
   *
   * > Cancelling a parent orphans its children into roots rather than destroying
   * > them.
   *
   * Each child is self-contained and independently valuable — its own log, its
   * own workspace, its own budget — so adopting it as a root is the safe default
   * and cascading cancellation is the thing that needs asking about. A child
   * destroyed with its parent takes a transcript worth reading with it.
   */
  async cancelSession(sessionId: SessionId, actor?: Actor): Promise<void> {
    const live = this.live(sessionId);

    for (const ref of live.session.children) {
      const child = this.sessions.get(ref.sessionId as SessionId);
      if (child === undefined) continue;

      child.session.tree = {
        rootSessionId: child.session.sessionId,
        depth: 0,
        ancestry: [],
      };
      await child.store.append(
        { type: 'session.orphaned', formerParentSessionId: sessionId },
        { ...(actor !== undefined ? { actor } : {}) },
      );
      this.emit('session', child.session);
    }

    live.session.children = [];
    await this.setState(live, 'failed', 'cancelled by the user');
  }

/**
   * What this session is blocked on itself, ignoring anything beneath it.
   *
   * A pending split outranks the state-derived answer, because it *is* the
   * blockage: the session sits in an ordinary state between turns while the
   * question it asked goes unanswered, and an attention computed from state
   * alone would forget it the moment anything else happened.
   */
  private ownAttention(live: LiveSession): Session['needsAttention'] {
    if (live.pendingSplits.size > 0) {
      return { reason: 'split_proposed', since: live.session.needsAttention?.since ?? this.now().toISOString() };
    }
    return attentionFor(live.session.state, live.session.needsAttention?.since ?? this.now().toISOString());
  }

  /**
   * An agent asks to split; a person decides (§4.3).
   *
   * > Automatic splitting is policy-gated and off by default: it multiplies
   * > cost, and a decomposition mistake made autonomously produces a tree of
   * > subtly mis-scoped children that is harder to salvage than a single
   * > overlong session.
   *
   * So this only ever *records* and *asks*. Nothing here creates a session —
   * that is `spawnChild`, and it runs when somebody says yes.
   *
   * Logged when proposed rather than when approved, so the transcript shows
   * what was suggested and declined as well as what happened. A record of only
   * the approved splits hides every decomposition the user thought was wrong,
   * which is the more interesting half when a session goes badly.
   */
  async proposeSplit(
    sessionId: SessionId,
    proposal: Omit<SplitProposal, 'proposalId'>,
    agentId?: AgentId,
  ): Promise<SplitProposal> {
    const live = this.live(sessionId);
    const full: SplitProposal = { ...proposal, proposalId: uuidv7() };

    live.pendingSplits.set(full.proposalId, full);
    live.session.pendingSplits = [...live.pendingSplits.values()];
    await live.store.append(
      { type: 'session.split_proposed', proposal: full },
      { ...(agentId !== undefined ? { agentId } : {}) },
    );

    /**
     * Spend a grant if there is one (§17 Q8).
     *
     * The proposal is written **first**, unconditionally, so an automatic split
     * leaves exactly the transcript a manual one does — proposed, then decided.
     * A path that skipped straight to spawning would produce a child with no
     * record of what was suggested, which is the half §4.3 says is the more
     * interesting one when a session goes badly.
     *
     * What is skipped is `needsAttention`. That is the stall being removed, and
     * it is the only thing being removed.
     */
    if (this.mayAutoSplit(live)) {
      // Through the ordinary decision path, so approval means the same thing
      // however it was reached — including `spawnChild` refusing on a limit or a
      // bad brief, which must still be able to refuse.
      await this.respondSplit(sessionId, full.proposalId, { approved: true }, AUTO_ACTOR);
      // Spent **after** the child exists, not before. Decrementing first charges
      // the grant for a split that did not happen: `respondSplit` throws when
      // the spawn is refused, and a run would then lose an allowance to a
      // malformed proposal it never got a child out of.
      const grant = live.session.splitGrant;
      if (grant !== undefined) {
        live.session.splitGrant = { ...grant, remaining: grant.remaining - 1 };
        this.touch(live);
      }
      return full;
    }

    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    // Up to the root, like any other blockage: a proposal three levels down is
    // as easy to lose as a permission prompt.
    this.rollUp(live);
    return full;
  }

  /**
   * Whether this proposal may be approved without asking.
   *
   * Depth is checked here and not only in `spawnChild`, because the two answer
   * different questions. §4.3's `maxDepth` is the hard ceiling for any split at
   * all; the grant's is how deep a *person was willing to be absent for*, which
   * is normally shallower. Reaching it means the next split asks, which is the
   * grant working rather than failing.
   */
  private mayAutoSplit(live: LiveSession): boolean {
    const grant = live.session.splitGrant;
    if (grant === undefined || grant.remaining <= 0) return false;
    return live.session.tree.depth + 1 <= grant.maxDepth;
  }

  /** Answer a proposal. Approval spawns; refusal is recorded and is not a failure. */
  async respondSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
    actor?: Actor,
  ): Promise<Session | null> {
    const live = this.live(sessionId);
    const proposal = live.pendingSplits.get(proposalId);
    if (proposal === undefined) throw new Error(`no pending split ${proposalId}`);

    // Cleared first: `spawnChild` can refuse on a limit, and a proposal left
    // pending after it was answered would ask the same question forever.
    live.pendingSplits.delete(proposalId);
    live.session.pendingSplits = [...live.pendingSplits.values()];
    await live.store.append(
      {
        type: 'session.split_decided',
        proposalId,
        approved: decision.approved,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
      { ...(actor !== undefined ? { actor } : {}) },
    );

    live.session.needsAttention = this.ownAttention(live);
    this.touch(live);
    this.rollUp(live);

    if (!decision.approved) return null;
    return this.spawnChild(
      sessionId,
      {
        title: proposal.title,
        scope: proposal.scope,
        outOfScope: proposal.outOfScope,
        contract: proposal.contract,
        tokenCeiling: proposal.tokenCeiling,
      },
      actor,
    );
  }

  /**
   * A child hands its result up, within the ceiling it agreed to (§4.3).
   *
   * > The failure mode to prevent: a child returns its transcript, the parent's
   * > context explodes, and you have reproduced the original problem one level
   * > up.
   *
   * An over-ceiling summary is **not** refused, and that is deliberate:
   * `checkResult` returns a verdict rather than throwing so an oversized answer
   * becomes an artifact plus a pointer instead of a failed child. Work that was
   * done well and described at length should not be thrown away for the length.
   * What the child does not get is a larger injection.
   *
   * The result lands on the **parent's** log, because that is who it is for. The
   * child's own transcript already holds the detail, and a person may drill into
   * it — but that is a human reading, not context entering a model.
   */
  async reportResult(
    sessionId: SessionId,
    result: { summary: string; artifactIds?: string[] },
    agentId?: AgentId,
  ): Promise<{ summary: string; truncated: boolean }> {
    const live = this.live(sessionId);
    const parentId = live.session.tree.parentSessionId;
    if (parentId === undefined) throw new Error('this session has no parent to report to');

    const contract = live.contract ?? { summaryMaxTokens: 1_000, artifacts: [] };
    const artifactIds = result.artifactIds ?? [];
    const verdict = checkResult(
      contract,
      result.summary,
      live.session.artifacts.map((a) => ({ kind: a.kind })),
    );

    let summary = result.summary;
    let truncated = false;
    if (verdict.estimatedTokens > contract.summaryMaxTokens) {
      // Written where it can be read in full, and referenced by a line that
      // fits. The child does not get to negotiate a larger injection.
      const stored = await live.store.attach(Buffer.from(result.summary, 'utf8'), 'text/markdown');
      await live.store.append({ type: 'artifact.created', artifactId: stored.sha256, kind: 'result-summary' });
      artifactIds.push(stored.sha256);
      summary =
        `${result.summary.slice(0, 400)}… [full result stored as artifact ${stored.sha256.slice(0, 12)}; ` +
        `${verdict.estimatedTokens} tokens exceeds the agreed ceiling of ${contract.summaryMaxTokens}]`;
      truncated = true;
    }

    const parent = this.sessions.get(parentId as SessionId);
    if (parent !== undefined) {
      await parent.store.append({
        type: 'session.child_result',
        childSessionId: sessionId,
        summary,
        artifactIds,
      });
      this.emit('session', parent.session);
    }

    await this.setState(live, 'done', 'reported its result to its parent');
    void agentId;
    return { summary, truncated };
  }

  /** Current derived state, folded from the log (§5.1). */
  async projection(sessionId: SessionId) {
    return (await this.live(sessionId).store.load()).projection;
  }

  /**
   * Everything here worth having told someone about (§11).
   *
   * Folded from the logs rather than accumulated in memory, so it reads the same
   * after a restart, after a crash, and for a client that was not attached when
   * any of it happened — which is most of the point, since a detached host keeps
   * working while the app is closed.
   *
   * Only the tail of each log is read. An inbox is a list you look at, not an
   * archive, and folding a month of transcript to show twenty lines would make
   * opening it cost more the longer a workspace had been used.
   */
  async inbox(limit = 50): Promise<InboxEntry[]> {
    const readAt = await this.readMarker().read();
    const parts = await Promise.all(
      [...this.sessions.values()].map(async (live) => {
        const from = Math.max(0, live.store.nextSeq - INBOX_EVENT_WINDOW);
        return entriesFrom(live.session, await live.store.readEvents(from), readAt);
      }),
    );
    return merge(parts, limit);
  }

  /**
   * Mark everything up to now as seen.
   *
   * Per workspace, not per client: two devices attached to one host should agree
   * about what has already been looked at, for the same reason the host owns
   * session state at all (§8).
   */
  async markInboxRead(at: Date = this.now()): Promise<void> {
    await this.readMarker().mark(at);
  }

  private readMarker(): ReadMarker {
    return ReadMarker.in(workspaceLayout(this.deps.workspaceRoot).devagents);
  }

  /** Session ids present on disk, whether or not they are loaded (§5.1). */
  async listOnDisk(): Promise<Array<{ sessionId: SessionId; title: string; goal: string }>> {
    const dir = workspaceLayout(this.deps.workspaceRoot).sessionsDir;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // no sessions yet is not an error
    }

    const found: Array<{ sessionId: SessionId; title: string; goal: string }> = [];
    for (const name of names) {
      try {
        const meta = JSON.parse(
          await readFile(join(dir, name, 'session.json'), 'utf8'),
        ) as SessionMeta;
        found.push({ sessionId: meta.sessionId, title: meta.title, goal: meta.goal });
      } catch {
        // A directory without readable metadata is not a session. Skipping it
        // is right: this list drives a picker, and one bad entry must not hide
        // every good one.
      }
    }
    return found;
  }

  /**
   * Reattach to a session that exists on disk — the restart path (§15 Phase 1).
   *
   * Everything comes from the log: state, agents, usage, checklist, artifacts.
   * No handle is opened and no runtime is contacted until a turn is sent, so
   * reopening the app is cheap no matter how many sessions exist, and a session
   * whose provider is currently unreachable still loads and displays.
   *
   * Capabilities are **re-admitted rather than replayed** from `agent.created`.
   * The recorded set is provenance — what it ran under last time — and §3.2 says
   * capabilities belong to adapter + model + installed tool version, any of
   * which can change while the app is closed. Trusting the recording would let
   * an agent resume claiming a capability its upgraded runtime no longer has.
   */
  async resumeSession(sessionId: SessionId): Promise<Session> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.session; // idempotent

    const { store, truncatedBytes } = await SessionStore.open(this.deps.workspaceRoot, sessionId);
    const meta = await store.readMeta();
    const { projection } = await store.load();

    store.onAppend = (event) => {
      this.spoke(sessionId);
      this.emit('event', sessionId, event);
    };

    const target: ExecutionTarget = { kind: 'local' };
    const session: Session = {
      sessionId,
      instanceId: this.deps.instanceId,
      target,
      title: meta.title,
      goal: meta.goal,
      state: projection.state,
      agents: [],
      createdAt: meta.createdAt,
      updatedAt: projection.lastActivityAt ?? meta.createdAt,
      checklist: projection.checklist,
      artifacts: projection.artifacts,
      needsAttention: projection.needsAttention,
      tree: { rootSessionId: sessionId, depth: 0, ancestry: [] },
      children: projection.children,
      peerSessionIds: [],
      pendingSplits: [],
    };

    const live: LiveSession = {
      session,
      store,
      lastEventAt: this.now().getTime(),
      waitingOnQuota: new Set<AgentId>(),
      hops: new Map<AgentId, number>(),
      worktrees: new Map<AgentId, Worktree>(),
      pendingSplits: new Map<string, SplitProposal>(),
      policy: defaultPolicyForTarget(target.kind),
      handles: new Map(),
      specs: new Map(),
      aborts: new Map(),
    };
    this.sessions.set(sessionId, live);

    for (const projected of projection.agents) {
      const spec: AgentSpec = {
        agentId: projected.agentId,
        role: projected.role as AgentRole,
        runtimeId: projected.runtimeId,
        auth: { kind: 'none' },
        toolPolicy: clonePolicy(live.policy),
        limits: projected.limits ?? {},
        workspacePath: this.deps.workspaceRoot,
        ...(projected.model !== undefined ? { model: projected.model } : {}),
        ...(projected.systemPrompt !== undefined ? { systemPrompt: projected.systemPrompt } : {}),
        ...(projected.reasoning !== undefined ? { reasoning: projected.reasoning } : {}),
      };

      const admission = await this.deps.registry.admit(spec, projected.isolation, {});
      if (!admission.ok) {
        // Refusing the whole session would make one uninstalled runtime hide an
        // entire transcript. The agent is skipped, the session loads, and the
        // reason is emitted so the UI can say which agent is unavailable.
        this.emit('agent-unavailable', sessionId, projected.agentId, admission.failures);
        continue;
      }

      live.specs.set(spec.agentId, spec);
      const projectedUsage = projection.usage;
      session.agents.push({
        agentId: spec.agentId,
        role: spec.role,
        spec: stripWorkspacePath(spec),
        resolvedCapabilities: admission.capabilities,
        // Not `running`: nothing is running yet. A record restored as running
        // would show a spinner for a turn that no longer exists.
        status: 'idle',
        isolation: projected.isolation,
        // The native token is not persisted, so resume takes the durable path
        // (§5.4) — which is the path that must work anyway.
        resumeToken: null,
        lastEventSeq: projection.lastSeq,
        usage: {
          inputTokens: projectedUsage.inputTokens,
          outputTokens: projectedUsage.outputTokens,
          cacheReadTokens: projectedUsage.cacheReadTokens,
          cacheWriteTokens: projectedUsage.cacheWriteTokens,
          cost: projectedUsage.cost,
        },
      });
    }

    // Any request the log still shows as pending was waiting on a promise in a
    // process that is gone. Withdraw them so the reloaded session offers no
    // prompt that would do nothing when answered.
    if (projection.pendingPermissions.length > 0) {
      await this.withdrawStale(live, projection.pendingPermissions);
      // And move it out of `awaiting_permission`. Withdrawing the requests but
      // leaving the state would produce a session that reports `needs_permission`
      // with no prompt to answer — stranded in exactly the way this is meant to
      // prevent, just more quietly. `awaiting_input` is the honest successor: a
      // person decides what happens next, which is the same disposition
      // `end_turn` gets (§3.9).
      await this.setState(live, 'awaiting_input', 'permission request withdrawn on reload');
    }

    if (truncatedBytes > 0) {
      this.emit('log-truncated', sessionId, truncatedBytes);
    }
    if (projection.skippedLines > 0) {
      this.emit('log-corrupt', sessionId, projection.skippedLines);
    }

    this.emit('session', session);
    return session;
  }
}

const ATTENTION: Partial<Record<SessionState, AttentionReason>> = {
  awaiting_input: 'needs_input',
  awaiting_permission: 'needs_permission',
  awaiting_credentials: 'needs_credentials',
  awaiting_quota: 'quota_exhausted',
  failed: 'failed',
};

function attentionFor(state: SessionState, since: string): Session['needsAttention'] {
  const reason = ATTENTION[state];
  if (!reason) return null;
  // Sanity: every attention state must be a pause or a terminal failure.
  if (!isPaused(state) && state !== 'failed') return null;
  return { reason, since };
}

function mergeUsage(a: AgentRecord['usage'], b: AgentRecord['usage']): AgentRecord['usage'] {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    // The one rule for adding costs (§10): not knowing is contagious, because a
    // total that quietly drops an unobservable agent is smaller than the truth.
    cost: addCost(a.cost, b.cost),
  };
}

function stripWorkspacePath(spec: AgentSpec): Omit<AgentSpec, 'workspacePath'> {
  const { workspacePath: _drop, ...rest } = spec;
  return rest;
}

