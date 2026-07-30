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
  type LoomEvent,
  type PermissionDecision,
  type PermissionRequest,
  type RuntimeContext,
  type Session,
  type SessionState,
  type ToolPolicy,
  type UserTurn,
  type AgentId,
  type SessionId,
} from '@shared/types/index.js';
import { SessionStore, type SessionMeta } from './store/sessionStore.js';
import { workspaceLayout } from './store/layout.js';
import { rehydrate } from './store/rehydrate.js';
import { pumpAgent, stopReasonSummary } from './runtime/supervisor.js';
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
}

export interface SessionManagerDeps {
  registry: RuntimeRegistry;
  workspaceRoot: string;
  instanceId: InstanceId;
  now?: () => Date;
}

export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<SessionId, LiveSession>();
  private readonly pending = new Map<string, PendingPermission>();
  private readonly now: () => Date;

  constructor(private readonly deps: SessionManagerDeps) {
    super();
    this.now = deps.now ?? (() => new Date());
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const sessionId = newSessionId();
    const createdAt = this.now().toISOString();

    const store = await SessionStore.create(this.deps.workspaceRoot, {
      sessionId,
      instanceId: this.deps.instanceId,
      title: input.title,
      goal: input.goal,
      createdAt,
    });

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
    store.onAppend = (event) => this.emit('event', sessionId, event);

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
    });

    this.emit('session', session);
    return session;
  }

  get(sessionId: SessionId): Session {
    return this.live(sessionId).session;
  }

  list(): Session[] {
    // needsAttention first — with many sessions the scarce resource is your
    // attention, so blocked work must be impossible to miss (§10).
    return [...this.sessions.values()]
      .map((l) => l.session)
      .sort((a, b) => {
        const attention = Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention));
        if (attention !== 0) return attention;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  /**
   * Add an agent, refusing configurations that cannot run safely.
   *
   * Admission happens here rather than at the first tool call, so an
   * `all-or-nothing` runtime never reaches a shared workspace and a role's
   * capability floor is enforced before any work starts (§3.10, §4.2, §9).
   */
  async addAgent(sessionId: SessionId, input: NewAgentInput): Promise<AgentRecord> {
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
      { agentId: spec.agentId, origin: this.originFor(spec) },
    );

    this.touch(live);
    return record;
  }

  /** Send a turn and run it to completion, applying the resulting state. */
  async send(sessionId: SessionId, agentId: AgentId, turn: UserTurn): Promise<void> {
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

    await live.store.append({ type: 'user.turn', content: turn.content }, { agentId });
    await this.setState(live, 'working');

    record.status = 'running';
    const pumped = pumpAgent(handle, live.store, { origin: this.originFor(spec), agentId });
    await handle.send(turn);
    const outcome = await pumped;

    record.resumeToken = outcome.resumeToken;
    record.lastEventSeq = live.store.nextSeq - 1;
    record.usage = mergeUsage(record.usage, outcome.usage);
    record.status = outcome.disposition === 'fail' ? 'stopped' : 'idle';

    // A finished turn releases the handle so the next send resumes cleanly;
    // parked agents are what make many concurrent sessions affordable (§8).
    live.handles.delete(agentId);
    live.aborts.delete(agentId);

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

    if (caps.nativeResume && record.resumeToken !== null) {
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
  async interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    const live = this.live(sessionId);
    const targets = agentId ? [agentId] : [...live.handles.keys()];

    for (const id of targets) {
      const record = live.session.agents.find((a) => a.agentId === id);
      live.aborts.get(id)?.abort(new Error('interrupted'));

      if (record && !record.resolvedCapabilities.interruptible) {
        this.emit('degraded', live.session.sessionId, id, 'runtime is not interruptible');
        continue;
      }
      await live.handles.get(id)?.interrupt();
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
  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error(`no pending permission request ${requestId}`);
    this.pending.delete(requestId);

    const live = this.live(entry.sessionId);
    const spec = live.specs.get(entry.agentId);

    await this.logDecision(live, entry, decision, 'user');
    this.applyGrant(spec, entry, decision);

    entry.resolve(decision);

    // Per session: another session's open prompt must not keep this one parked,
    // and this one's must not be cleared by a sibling being answered.
    if (!this.hasPendingFor(entry.sessionId)) await this.setState(live, 'working');
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
  async events(sessionId: SessionId, fromSeq = 0): Promise<LoomEvent[]> {
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

    store.onAppend = (event) => this.emit('event', sessionId, event);

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

