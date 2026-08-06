/**
 * The fleet — one app, several hosts (DESIGN.md §8, §10).
 *
 * §8's concurrency caps are deliberately **per host**: "eight local plus eight on
 * the build box is sixteen running agents, which is the point of remote
 * execution." §10's dashboard carries a target badge per card for the same
 * reason. Both assume the app is watching more than one place at once, and until
 * now it could not: `main.ts` held a single `SessionManager` and disposed the
 * previous agent host whenever a new workspace was opened.
 *
 * This class removes that restriction without touching `SessionManager`, which
 * stays exactly what it was — the owner of **one** workspace, with one
 * append-only log and one agent host. That boundary is load-bearing:
 *
 *  - `instanceId` identifies one checkout on one machine (§5.2), so a manager per
 *    checkout is the honest unit. A manager spanning hosts would have to invent
 *    an identity that no `.devagents/` directory actually holds.
 *  - §5.1's single-writer invariant is per log. N managers over N logs preserves
 *    it; one manager over N logs would be the first place the design needed
 *    conflict resolution, which it deliberately has none of.
 *
 * So the fleet is a router and an aggregator, and nothing else.
 *
 * ## Local hosts today, remote hosts unchanged
 *
 * A "host" here is a workspace with its own agent-host process. That is
 * structurally identical to a remote server: `HostSupervisor` already spawns one
 * host per workspace, and `HostChannel` is an interface precisely so Phase 5 can
 * swap a `utilityProcess` for an SSH stream underneath. Nothing in this file
 * knows which it is, which is the point — when transports land, a remote host
 * attaches through the same `attach()` with a different `spawn`.
 */

import { EventEmitter } from 'node:events';
import { byAttentionThenRecency, SessionManager } from './sessionManager.js';
import { RuntimeRegistry } from './runtime/registry.js';
import { HostSupervisor } from './host/supervisor.js';
import { openWorkspace } from './store/identity.js';
import type {
  AccessRole,
  AgentId,
  ExecutionTarget,
  InstanceId,
  LineageId,
  LoomEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
} from '@shared/types/index.js';
import { AccessDenied } from '@shared/types/index.js';
import type { MainSideChannel } from '@shared/host/protocol.js';

/** A runtime the host offers, as advertised to the UI. */
export interface FleetRuntime {
  id: string;
  label: string;
  version: string;
  requiresModel: boolean;
}

export interface HostSpawner {
  (opts: { workspaceRoot: string }): { channel: MainSideChannel };
}

export interface FleetDeps {
  /** Creates a channel to a new agent-host process for a workspace. */
  spawn: HostSpawner;
  /** What each host is expected to register; reconciled against its handshake. */
  runtimes: FleetRuntime[];
}

/** One attached host: a workspace, its agent host, and its sessions. */
export interface AttachedHost {
  /** Stable identity of this checkout (§5.2). The fleet's primary key. */
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  target: ExecutionTarget;
  /** Runtime ids the host actually reported, or `[]` if it never came up. */
  available: string[];
  /** Set when the host could not start; the sessions still load read-only. */
  unavailableReason?: string;
}

interface Entry extends AttachedHost {
  manager: SessionManager;
  supervisor: HostSupervisor;
  /** Detaches the manager's listeners; called on detach. */
  unlisten: () => void;
}

export class AttachRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AttachRefused';
  }
}

/**
 * Events, all re-emitted from the owning manager with the host attached:
 *
 *   'event'      (instanceId, sessionId, LoomEvent)
 *   'session'    (instanceId, Session)
 *   'permission' (instanceId, PermissionRequest)
 *   'host'       (AttachedHost)              — attached, or its state changed
 *   'detached'   (instanceId)
 */
export class Fleet extends EventEmitter {
  private readonly entries = new Map<InstanceId, Entry>();
  /** sessionId → owning host, so a call can be routed without a search. */
  private readonly owners = new Map<SessionId, InstanceId>();

  constructor(private readonly deps: FleetDeps) {
    super();
  }

  // ------------------------------------------------------------------ hosts

  /**
   * Attach a workspace and start an agent host for it.
   *
   * Idempotent by `instanceId`: attaching a path that is already attached
   * returns the existing host rather than spawning a second process against the
   * same log, which would break single-writer.
   */
  async attach(workspaceRoot: string, target: ExecutionTarget = { kind: 'local' }): Promise<AttachedHost> {
    const identity = await openWorkspace(workspaceRoot);

    const existing = this.entries.get(identity.instanceId);
    if (existing) {
      if (existing.workspaceRoot !== workspaceRoot) {
        // Same instanceId at two paths means a folder was copied *including*
        // `.devagents/instance.json`. §5.3 treats that as a fork to be resolved,
        // not an alias — running both would give one identity two live logs.
        throw new AttachRefused(
          `that workspace has the same instance id as ${existing.workspaceRoot}; ` +
            `it looks like a copy — resolve the fork before attaching both`,
        );
      }
      return snapshot(existing);
    }

    const supervisor = new HostSupervisor({
      spawn: () => this.deps.spawn({ workspaceRoot }),
      runtimes: this.deps.runtimes,
      onRestart: (attempt, reason) => {
        // A restart is not a state change worth re-rendering: any open turn
        // already failed with a `transport` stop, which retries (§8).
        this.emit('host-restart', identity.instanceId, attempt, reason);
      },
    });

    const registry = new RuntimeRegistry();
    for (const entry of supervisor.runtimes()) {
      registry.register(entry.runtime, { label: entry.label, requiresModel: entry.requiresModel });
    }

    const manager = new SessionManager({
      registry,
      workspaceRoot,
      instanceId: identity.instanceId,
    });

    const onEvent = (sessionId: SessionId, event: LoomEvent): void => {
      this.emit('event', identity.instanceId, sessionId, event);
    };
    const onSession = (session: Session): void => {
      this.owners.set(session.sessionId, identity.instanceId);
      this.emit('session', identity.instanceId, session);
    };
    const onPermission = (request: PermissionRequest): void => {
      this.emit('permission', identity.instanceId, request);
    };

    manager.on('event', onEvent);
    manager.on('session', onSession);
    manager.on('permission', onPermission);

    const entry: Entry = {
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot,
      target,
      available: [],
      manager,
      supervisor,
      unlisten: () => {
        manager.off('event', onEvent);
        manager.off('session', onSession);
        manager.off('permission', onPermission);
      },
    };
    this.entries.set(identity.instanceId, entry);

    // Reconcile against what the host really registered. A host that cannot
    // start must not stop the workspace attaching: its sessions still load and
    // their transcripts are still readable, which is the whole point of the log
    // being the truth. The UI shows why nothing can be run there.
    try {
      const ids = new Set(await supervisor.advertised());
      entry.available = this.deps.runtimes.filter((r) => ids.has(r.id)).map((r) => r.id);
    } catch (err) {
      entry.unavailableReason = err instanceof Error ? err.message : String(err);
    }

    this.emit('host', snapshot(entry));
    return snapshot(entry);
  }

  /** Stop a host and forget its sessions. The workspace on disk is untouched. */
  async detach(instanceId: InstanceId): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;

    entry.unlisten();
    entry.supervisor.dispose();
    for (const [sessionId, owner] of [...this.owners]) {
      if (owner === instanceId) this.owners.delete(sessionId);
    }
    this.entries.delete(instanceId);
    this.emit('detached', instanceId);
  }

  async detachAll(): Promise<void> {
    for (const instanceId of [...this.entries.keys()]) await this.detach(instanceId);
  }

  hosts(): AttachedHost[] {
    return [...this.entries.values()].map(snapshot);
  }

  /** Runtimes available on a given host, for the agent picker. */
  runtimesOn(instanceId: InstanceId): FleetRuntime[] {
    const entry = this.entries.get(instanceId);
    if (!entry) return [];
    return this.deps.runtimes.filter((r) => entry.available.includes(r.id));
  }

  // --------------------------------------------------------------- sessions

  /**
   * Every loaded session across every host, in §10's order.
   *
   * Re-sorted rather than concatenated: each manager sorts its own, and merging
   * sorted lists does not preserve a global order — a blocked session on the
   * second host would sit below an idle one on the first.
   */
  list(): Session[] {
    return [...this.entries.values()]
      .flatMap((entry) => entry.manager.list())
      .sort(byAttentionThenRecency);
  }

  /** Sessions on disk but not yet loaded, per host. */
  async listOnDisk(): Promise<
    Array<{ instanceId: InstanceId; sessionId: SessionId; title: string; goal: string }>
  > {
    const found: Array<{
      instanceId: InstanceId;
      sessionId: SessionId;
      title: string;
      goal: string;
    }> = [];
    for (const entry of this.entries.values()) {
      for (const session of await entry.manager.listOnDisk()) {
        found.push({ instanceId: entry.instanceId, ...session });
      }
    }
    return found;
  }

  /** Which host owns a session, or null if the fleet has never seen it. */
  hostOf(sessionId: SessionId): AttachedHost | null {
    const owner = this.owners.get(sessionId);
    const entry = owner === undefined ? undefined : this.entries.get(owner);
    return entry ? snapshot(entry) : null;
  }

  async createSession(
    instanceId: InstanceId,
    input: { title: string; goal: string },
    role: AccessRole = 'read-write',
  ): Promise<Session> {
    requireWrite(role, 'create a session');
    const entry = this.require(instanceId);
    // The session records the host it belongs to, so §10's target badge and any
    // later reattach do not have to guess.
    const session = await entry.manager.createSession({ ...input, target: entry.target });
    this.owners.set(session.sessionId, instanceId);
    return session;
  }

  async resumeSession(instanceId: InstanceId, sessionId: SessionId): Promise<Session> {
    const entry = this.require(instanceId);
    const session = await entry.manager.resumeSession(sessionId);
    this.owners.set(sessionId, instanceId);
    return session;
  }

  /**
   * The manager owning a session.
   *
   * Routing by `sessionId` alone is safe because ids are uuidv7 — unique across
   * hosts without coordination, which is why they were chosen over per-workspace
   * counters (§5.2).
   */
  private ownerOf(sessionId: SessionId): Entry {
    const owner = this.owners.get(sessionId);
    const entry = owner === undefined ? undefined : this.entries.get(owner);
    if (!entry) throw new Error(`no attached host owns session ${sessionId}`);
    return entry;
  }

  get(sessionId: SessionId): Session {
    return this.ownerOf(sessionId).manager.get(sessionId);
  }

  async addAgent(
    sessionId: SessionId,
    input: Parameters<SessionManager['addAgent']>[1],
    role: AccessRole = 'read-write',
  ) {
    requireWrite(role, 'add an agent');
    return this.ownerOf(sessionId).manager.addAgent(sessionId, input);
  }

  /**
   * Send a turn. Requires read-write access.
   *
   * The role is enforced **here**, at the boundary a client connection
   * addresses, and never in the client: a read-only client that can still send
   * is not read-only. Several read-write clients may send at once; the owner
   * queues them in arrival order (§17 Q14).
   */
  async send(
    sessionId: SessionId,
    agentId: AgentId,
    turn: Parameters<SessionManager['send']>[2],
    role: AccessRole = 'read-write',
  ) {
    requireWrite(role, 'send a turn');
    return this.ownerOf(sessionId).manager.send(sessionId, agentId, turn);
  }

  /**
   * Interrupt. Requires read-write, and deliberately **does not queue**.
   *
   * Queueing an interrupt behind the turn it is meant to interrupt would make it
   * arrive after the thing it was cancelling had finished — useless at best.
   * Out-of-band is the only ordering that means anything here.
   */
  async interrupt(sessionId: SessionId, agentId?: AgentId, role: AccessRole = 'read-write') {
    requireWrite(role, 'interrupt');
    return this.ownerOf(sessionId).manager.interrupt(sessionId, agentId);
  }

  /** Turns waiting behind the running one, so a client can show the backlog. */
  queueDepth(sessionId: SessionId, agentId: AgentId): number {
    return this.ownerOf(sessionId).manager.queueDepth(agentId);
  }

  events(sessionId: SessionId, fromSeq = 0) {
    return this.ownerOf(sessionId).manager.events(sessionId, fromSeq);
  }

  projection(sessionId: SessionId) {
    return this.ownerOf(sessionId).manager.projection(sessionId);
  }

  // ------------------------------------------------------------ permissions

  /**
   * Pending requests across every host.
   *
   * A prompt is answered by `requestId`, and the fleet does not know which host
   * minted one until it looks — so `respondPermission` tries each. That is fine
   * at this scale and honest: the alternative is a requestId→host index that can
   * disagree with the managers, and a stale index here would strand an agent.
   */
  pendingPermissions(): Array<{ instanceId: InstanceId; request: PermissionRequest }> {
    return [...this.entries.values()].flatMap((entry) =>
      entry.manager.pendingPermissions().map((request) => ({
        instanceId: entry.instanceId,
        request,
      })),
    );
  }

  /**
   * Answer a request without knowing which host minted it.
   *
   * Each host is asked in turn and the first non-`unknown` answer wins. There is
   * deliberately no requestId→host index: an index can disagree with the
   * managers, and a stale entry here would strand an agent — the exact failure
   * this path exists to remove.
   */
  async respondPermission(
    requestId: string,
    decision: PermissionDecision,
    role: AccessRole = 'read-write',
  ): Promise<'answered' | 'already-answered' | 'unknown'> {
    // Requires write — a decision is what lets a tool run. It does **not** queue:
    // the turn that asked is blocked *on this answer*, so putting it behind that
    // turn would deadlock the session outright.
    requireWrite(role, 'answer a permission request');
    for (const entry of this.entries.values()) {
      const outcome = await entry.manager.respondPermission(requestId, decision);
      if (outcome !== 'unknown') return outcome;
    }
    // Not an error worth throwing: the ask may have been withdrawn because the
    // agent stopped, and a UI that raced that should not see a failure.
    this.emit('permission-stale', requestId);
    return 'unknown';
  }

  private require(instanceId: InstanceId): Entry {
    const entry = this.entries.get(instanceId);
    if (!entry) throw new Error(`no attached host ${instanceId}`);
    return entry;
  }
}

/**
 * Refuse a write from a read-only client, naming what was attempted.
 *
 * Every caller of this is `async`, deliberately: a guard that throws
 * synchronously out of a promise-returning method means `send(...).catch()`
 * never runs, and the caller sees an exception where it was handling a
 * rejection.
 */
function requireWrite(role: AccessRole, action: string): void {
  if (role === 'read-only') throw new AccessDenied(action);
}

function snapshot(entry: Entry): AttachedHost {
  return {
    instanceId: entry.instanceId,
    lineageId: entry.lineageId,
    workspaceRoot: entry.workspaceRoot,
    target: entry.target,
    available: [...entry.available],
    ...(entry.unavailableReason !== undefined
      ? { unavailableReason: entry.unavailableReason }
      : {}),
  };
}
