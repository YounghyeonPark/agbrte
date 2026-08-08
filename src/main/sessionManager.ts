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
  isPaused,
  newAgentId,
  newSessionId,
  uuidv7,
  type PermissionAsk,
  type PolicyRule,
  type AgentHandle,
  type AgentRecord,
  type AgentRole,
  type AgentRuntime,
  type AgentSpec,
  type AttentionReason,
  type EventOrigin,
  type ExecutionTarget,
  type InstanceId,
  type AgbrteEvent,
  type PermissionDecision,
  type PermissionRequest,
  type RuntimeContext,
  type Session,
  type SessionState,
  type ToolPolicy,
  type UserTurn,
  type AgentId,
  type SessionId,
  type Actor,
} from '@shared/types/index.js';
import { SessionStore, type SessionMeta } from './store/sessionStore.js';
import { workspaceLayout } from './store/layout.js';
import { rehydrate } from './store/rehydrate.js';
import { pumpAgent, stopReasonSummary } from './runtime/supervisor.js';
import { groupFor, QuotaScheduler } from './quota.js';
import type { Isolation, RoleRequirements, RuntimeRegistry } from './runtime/registry.js';
import { defaultPolicyForTarget, evaluatePolicy } from './policy/evaluate.js';

export interface CreateSessionInput {
  title: string;
  goal: string;
  target?: ExecutionTarget;
  policy?: ToolPolicy;
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

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, LiveSession>();
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
      // A session created directly is a root of its own tree (§4.3).
      tree: { rootSessionId: sessionId, depth: 0, ancestry: [] },
      children: [],
      peerSessionIds: [],
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
    const isolation = input.isolation ?? 'shared';

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

    const admission = await this.deps.registry.admit(spec, isolation, input.requirements ?? {});
    if (!admission.ok) throw new AdmissionRefused(admission.failures);

    const record: AgentRecord = {
      agentId: spec.agentId,
      role: spec.role,
      spec: stripWorkspacePath(spec),
      resolvedCapabilities: admission.capabilities,
      status: 'idle',
      isolation,
      resumeToken: null,
      lastEventSeq: 0,
      usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    };

    live.session.agents.push(record);
    live.specs.set(spec.agentId, spec);

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

    await live.store.append(
      { type: 'user.turn', content: turn.content },
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

    const pumped = pumpAgent(handle, live.store, { origin: this.originFor(spec), agentId });
    await handle.send(turn);
    const outcome = await pumped;

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

    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(request.requestId, {
        ...request,
        askedAt: this.now().toISOString(),
        resolve,
      });
      this.emit('permission', request);
    });
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
    live.session.state = to;
    live.session.needsAttention = attentionFor(to, this.now().toISOString());
    this.touch(live);

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

  /** Tail the durable log for a session — the renderer's subscription source. */
  async events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
    return this.live(sessionId).store.readEvents(fromSeq);
  }

  /** Current derived state, folded from the log (§5.1). */
  async projection(sessionId: SessionId) {
    return (await this.live(sessionId).store.load()).projection;
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
    };

    const live: LiveSession = {
      session,
      store,
      lastEventAt: this.now().getTime(),
      waitingOnQuota: new Set<AgentId>(),
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
  const cost =
    a.cost === 'unknown' || b.cost === 'unknown' ? ('unknown' as const) : a.cost + b.cost;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cost,
  };
}

function stripWorkspacePath(spec: AgentSpec): Omit<AgentSpec, 'workspacePath'> {
  const { workspacePath: _drop, ...rest } = spec;
  return rest;
}

