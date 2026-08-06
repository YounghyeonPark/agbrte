/**
 * The fleet — one app, several hosts (DESIGN.md §8, §10).
 *
 * §8's concurrency caps are deliberately **per host**, and §10's dashboard
 * carries a target badge per card. Both assume the app watches more than one
 * place at once.
 *
 * The fleet is a **router and an aggregator, and nothing else**. Sessions belong
 * to hosts now, so it maps a `sessionId` to the host that owns it, merges lists
 * across hosts, and re-emits pushes with the host attached. That is the job.
 *
 * ## Why every session method is async
 *
 * Because each one is a request to another process. When the fleet held
 * `SessionManager`s directly, `list()` and `get()` could be synchronous; now
 * they cannot, and faking it would mean caching session records in the app —
 * exactly the state that was moved out. A stale cache here would show a session
 * as idle while it was working somewhere else.
 *
 * ## Roles are not enforced here
 *
 * The host enforces them, because the host is the owner. A guard here would be
 * defence in depth against the app itself, which is not a boundary — and worse,
 * a second place where the answer could differ from the authoritative one.
 */

import { EventEmitter } from 'node:events';
import { byAttentionThenRecency } from './sessionManager.js';
import type { HostConnection } from './host/hostConnection.js';
import type {
  AccessRole,
  AgentId,
  AgentRecord,
  ExecutionTarget,
  HostLocation,
  InstanceId,
  LineageId,
  GilmokEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
  SessionProjection,
} from '@shared/types/index.js';

/** A runtime a host offers, as advertised to the UI. */
export interface FleetRuntime {
  id: string;
  label: string;
  version: string;
  requiresModel: boolean;
}

/**
 * Opens a connection to the host owning a workspace, starting one if needed.
 *
 * Takes the whole location rather than a path: which machine is as much a part
 * of "which workspace" as the directory is, and a connector that only saw a path
 * could not tell a local `/srv/work` from a remote one.
 */
export type HostConnector = (location: HostLocation) => Promise<HostConnection>;

export interface FleetDeps {
  connect: HostConnector;
  /** Metadata for the runtime ids a host reports. */
  runtimes: FleetRuntime[];
}

/** One attached host: a workspace, the process owning it, and its sessions. */
export interface AttachedHost {
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  target: ExecutionTarget;
  /** Runtime ids this host actually offers. Empty when its agent host failed. */
  available: string[];
  /** What this client was granted. May be less than it asked for. */
  role: AccessRole;
  /** The owning process, so a client can say which one it is talking to. */
  pid: number;
  unavailableReason?: string;
}

interface Entry extends AttachedHost {
  connection: HostConnection;
  unlisten: () => void;
}

export class AttachRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AttachRefused';
  }
}

/**
 * Events, re-emitted from the owning host:
 *
 *   'event'      (instanceId, sessionId, GilmokEvent)
 *   'session'    (instanceId, Session)
 *   'permission' (instanceId, PermissionRequest)
 *   'queue'      (instanceId, sessionId, agentId, depth)
 *   'host'       (AttachedHost)   — attached, or its state changed
 *   'detached'   (instanceId, reason)
 */
export class Fleet extends EventEmitter {
  private readonly entries = new Map<InstanceId, Entry>();
  /** sessionId → owning host, so a call routes without a search. */
  private readonly owners = new Map<SessionId, InstanceId>();

  constructor(private readonly deps: FleetDeps) {
    super();
  }

  // ------------------------------------------------------------------ hosts

  /**
   * Attach a workspace, connecting to its host and starting one if none is up.
   *
   * Idempotent by `instanceId`: attaching a path already attached returns the
   * existing host rather than opening a second connection to the same owner,
   * which would buy nothing and double every push.
   */
  async attach(location: HostLocation): Promise<AttachedHost> {
    const { workspaceRoot, target } = location;
    let connection;
    try {
      connection = await this.deps.connect(location);
    } catch (err) {
      // No host answered and none could be started. Distinct from a host that
      // *is* up but whose agent host failed — that one attaches read-only.
      throw new AttachRefused(
        `no session host for ${workspaceRoot}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let identity;
    try {
      identity = await connection.ready;
    } catch (err) {
      connection.disconnect();
      throw new AttachRefused(
        `could not talk to the host for ${workspaceRoot}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const existing = this.entries.get(identity.instanceId);
    if (existing) {
      connection.disconnect();
      return snapshot(existing);
    }

    const onEvent = (sessionId: string, event: GilmokEvent): void => {
      this.owners.set(sessionId as SessionId, identity.instanceId);
      this.emit('event', identity.instanceId, sessionId, event);
    };
    const onSession = (session: Session): void => {
      this.owners.set(session.sessionId, identity.instanceId);
      this.emit('session', identity.instanceId, session);
    };
    const onPermission = (request: PermissionRequest): void => {
      this.emit('permission', identity.instanceId, request);
    };
    const onQueue = (sessionId: string, agentId: string, depth: number): void => {
      this.emit('queue', identity.instanceId, sessionId, agentId, depth);
    };
    const onClosing = (reason: string): void => this.forget(identity.instanceId, reason);

    connection.on('event', onEvent);
    connection.on('session', onSession);
    connection.on('permission', onPermission);
    connection.on('queue', onQueue);
    connection.on('closing', onClosing);

    const entry: Entry = {
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot: identity.workspaceRoot,
      target,
      available: this.deps.runtimes
        .filter((r) => identity.runtimes.includes(r.id))
        .map((r) => r.id),
      role: connection.role,
      pid: identity.pid,
      ...(identity.unavailableReason !== undefined
        ? { unavailableReason: identity.unavailableReason }
        : {}),
      connection,
      unlisten: () => {
        connection.off('event', onEvent);
        connection.off('session', onSession);
        connection.off('permission', onPermission);
        connection.off('queue', onQueue);
        connection.off('closing', onClosing);
      },
    };
    this.entries.set(identity.instanceId, entry);

    this.emit('host', snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Stop watching a host.
   *
   * Disconnects; it does **not** stop the host. Leaving is not stopping — that
   * is the point of the host owning the session, and a detach that killed a
   * running agent would undo it.
   */
  async detach(instanceId: InstanceId): Promise<void> {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.connection.disconnect();
    this.forget(instanceId, 'detached');
  }

  async detachAll(): Promise<void> {
    for (const instanceId of [...this.entries.keys()]) await this.detach(instanceId);
  }

  /** Drop local bookkeeping for a host that is gone or going. */
  private forget(instanceId: InstanceId, reason: string): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.unlisten();
    for (const [sessionId, owner] of [...this.owners]) {
      if (owner === instanceId) this.owners.delete(sessionId);
    }
    this.entries.delete(instanceId);
    this.emit('detached', instanceId, reason);
  }

  hosts(): AttachedHost[] {
    return [...this.entries.values()].map(snapshot);
  }

  runtimesOn(instanceId: InstanceId): FleetRuntime[] {
    const entry = this.entries.get(instanceId);
    if (!entry) return [];
    return this.deps.runtimes.filter((r) => entry.available.includes(r.id));
  }

  // --------------------------------------------------------------- sessions

  /**
   * Every session across every host, in §10's order.
   *
   * Re-sorted rather than concatenated: each host sorts its own, and merging
   * sorted lists does not preserve a global order — a blocked session on the
   * second host would sit below an idle one on the first. §10 says attention
   * outranks recency, and it has to outrank it globally.
   */
  async list(): Promise<Session[]> {
    const perHost = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        const sessions = await entry.connection.list();
        for (const session of sessions) this.owners.set(session.sessionId, entry.instanceId);
        return sessions;
      }),
    );
    return perHost.flat().sort(byAttentionThenRecency);
  }

  async listOnDisk(): Promise<
    Array<{ instanceId: InstanceId; sessionId: string; title: string; goal: string }>
  > {
    const perHost = await Promise.all(
      [...this.entries.values()].map(async (entry) =>
        (await entry.connection.listOnDisk()).map((s) => ({ instanceId: entry.instanceId, ...s })),
      ),
    );
    return perHost.flat();
  }

  hostOf(sessionId: SessionId): AttachedHost | null {
    const owner = this.owners.get(sessionId);
    const entry = owner === undefined ? undefined : this.entries.get(owner);
    return entry ? snapshot(entry) : null;
  }

  async createSession(
    instanceId: InstanceId,
    input: { title: string; goal: string },
  ): Promise<Session> {
    const entry = this.require(instanceId);
    const session = await entry.connection.createSession(input);
    this.owners.set(session.sessionId, instanceId);
    return session;
  }

  async resumeSession(instanceId: InstanceId, sessionId: SessionId): Promise<Session> {
    const entry = this.require(instanceId);
    const session = await entry.connection.resumeSession(sessionId);
    this.owners.set(sessionId, instanceId);
    return session;
  }

  /**
   * The host owning a session.
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

  // Every one of these is `async` on purpose. `ownerOf` throws for an unknown
  // session, and a synchronous throw out of a promise-returning method means
  // `fleet.get(id).catch(...)` never runs — the caller gets an exception where
  // it was handling a rejection. Same wart as the old role guard, same fix.

  async get(sessionId: SessionId): Promise<Session> {
    return this.ownerOf(sessionId).connection.get(sessionId);
  }

  async addAgent(sessionId: SessionId, input: unknown): Promise<AgentRecord> {
    return this.ownerOf(sessionId).connection.addAgent(sessionId, input);
  }

  async send(sessionId: SessionId, agentId: AgentId, text: string): Promise<void> {
    return this.ownerOf(sessionId).connection.send(sessionId, agentId, text);
  }

  async interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    return this.ownerOf(sessionId).connection.interrupt(sessionId, agentId);
  }

  async events(sessionId: SessionId, fromSeq = 0): Promise<GilmokEvent[]> {
    return this.ownerOf(sessionId).connection.events(sessionId, fromSeq);
  }

  async projection(sessionId: SessionId): Promise<SessionProjection> {
    return this.ownerOf(sessionId).connection.projection(sessionId);
  }

  async queueDepth(sessionId: SessionId): Promise<number> {
    return this.ownerOf(sessionId).connection.queueDepth(sessionId);
  }

  // ------------------------------------------------------------ permissions

  async pendingPermissions(): Promise<
    Array<{ instanceId: InstanceId; request: PermissionRequest }>
  > {
    const perHost = await Promise.all(
      [...this.entries.values()].map(async (entry) =>
        (await entry.connection.pendingPermissions()).map((request) => ({
          instanceId: entry.instanceId,
          request,
        })),
      ),
    );
    return perHost.flat();
  }

  /**
   * Answer a request without knowing which host minted it.
   *
   * Each host is asked in turn and the first non-`unknown` answer wins. There is
   * deliberately no requestId→host index: an index can disagree with the hosts,
   * and a stale entry would strand an agent — the exact failure the durable
   * pending set exists to remove.
   */
  async respondPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'answered' | 'already-answered' | 'unknown'> {
    for (const entry of this.entries.values()) {
      const outcome = await entry.connection.respondPermission(requestId, decision);
      if (outcome !== 'unknown') return outcome;
    }
    this.emit('permission-stale', requestId);
    return 'unknown';
  }

  private require(instanceId: InstanceId): Entry {
    const entry = this.entries.get(instanceId);
    if (!entry) throw new Error(`no attached host ${instanceId}`);
    return entry;
  }
}

function snapshot(entry: Entry): AttachedHost {
  return {
    instanceId: entry.instanceId,
    lineageId: entry.lineageId,
    workspaceRoot: entry.workspaceRoot,
    target: entry.target,
    available: [...entry.available],
    role: entry.role,
    pid: entry.pid,
    ...(entry.unavailableReason !== undefined
      ? { unavailableReason: entry.unavailableReason }
      : {}),
  };
}
