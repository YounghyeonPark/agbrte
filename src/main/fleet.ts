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

import { byAttentionThenRecency } from '@shared/types/index.js';
import type { HostConnection } from './host/hostConnection.js';
import type { ModelNeed } from './runtime/registry.js';
import type {
  AccessRole,
  AgentId,
  AgentRecord,
  ContentBlock,
  ExecutionTarget,
  HostLocation,
  InstanceId,
  LineageId,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  InboxEntry,
  RuntimeCapabilities,
  Session,
  SessionId,
  SessionProjection,
  Sha256,
} from '@shared/types/index.js';

/** A runtime a host offers, as advertised to the UI. */
export interface FleetRuntime {
  id: string;
  label: string;
  version: string;
  /** Three-valued, because "optional" is a real answer for an installed CLI. */
  model: ModelNeed;
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
  /** Ceiling on reconnect backoff. Lowered by tests so they do not wait. */
  maxBackoffMs?: number;
}

/** One attached host: a workspace, the process owning it, and its sessions. */
export interface AttachedHost {
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  target: ExecutionTarget;
  /** Runtime ids this host actually offers. Empty when its agent host failed. */
  available: string[];
  /** Models it can reach, credentials already stripped. */
  endpoints: Array<{ id: string; label: string; provider: string; authenticated: boolean }>;
  /**
   * Where this workspace was, when the host found it somewhere else (§5.3).
   *
   * Naturally transient: the host records the new location once, so the next
   * host to start reports nothing. That is the right lifetime — a move is news
   * exactly once.
   */
  movedFrom?: string;
  /** What this client was granted. May be less than it asked for. */
  role: AccessRole;
  /** The owning process, so a client can say which one it is talking to. */
  pid: number;
  unavailableReason?: string;
  /**
   * Whether the link is up.
   *
   * A host that is `reconnecting` is *not* gone — the work is still running on
   * the other side, and saying otherwise would tell the user the opposite of
   * what is true at the worst possible moment.
   */
  link: 'connected' | 'reconnecting';
}

interface Entry extends AttachedHost {
  connection: HostConnection;
  unlisten: () => void;
  /** Kept so a dropped link can be dialled again without the caller's help. */
  location: HostLocation;
  /**
   * Highest `seq` delivered per session.
   *
   * This is what makes catch-up exact rather than approximate. `seq` is
   * monotonic per session (§5.4d), so asking for everything after the last one
   * seen loses nothing and repeats nothing — no timestamps, no dedup by
   * content, no guessing.
   */
  seen: Map<string, number>;
  /** Cancels an in-flight reconnect when the host is detached mid-attempt. */
  stopReconnect?: () => void;
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
 *   'event'      (instanceId, sessionId, AgbrteEvent)
 *   'session'    (instanceId, Session)
 *   'permission' (instanceId, PermissionRequest)
 *   'permission-resolved' (instanceId, PermissionResolved)
 *   'queue'      (instanceId, sessionId, agentId, depth)
 *   'host'       (AttachedHost)   — attached, or its state changed
 *   'detached'   (instanceId, reason)
 *   'link'       (instanceId, 'connected' | 'reconnecting', reason)
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

    const entry: Entry = {
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot: identity.workspaceRoot,
      target,
      available: this.deps.runtimes
        .filter((r) => identity.runtimes.includes(r.id))
        .map((r) => r.id),
      ...(identity.movedFrom !== undefined ? { movedFrom: identity.movedFrom } : {}),
      endpoints: (identity.endpoints ?? []).map((e) => ({
        id: e.id,
        label: e.label,
        provider: e.provider,
        authenticated: e.authenticated,
      })),
      role: connection.role,
      pid: identity.pid,
      ...(identity.unavailableReason !== undefined
        ? { unavailableReason: identity.unavailableReason }
        : {}),
      link: 'connected',
      location,
      seen: new Map(),
      connection,
      unlisten: () => undefined,
    };
    this.wire(entry, connection);
    this.entries.set(identity.instanceId, entry);

    this.emit('host', snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Attach this fleet's listeners to a connection.
   *
   * Separate from `attach` because a reconnect needs exactly the same wiring
   * against a different socket. Doing it inline meant a reconnected host would
   * be silently deaf — connected, listed, and delivering nothing.
   */
  private wire(entry: Entry, connection: HostConnection): void {
    const { instanceId } = entry;

    const onEvent = (sessionId: string, event: AgbrteEvent): void => {
      this.owners.set(sessionId as SessionId, instanceId);
      // Dropped rather than re-emitted if we already have it. Catch-up and the
      // live push overlap by construction: the host starts pushing the moment we
      // reconnect, while we are still reading history, so the same event can
      // arrive twice. `seq` is monotonic per session, which makes the check
      // exact rather than a guess.
      const last = entry.seen.get(sessionId) ?? -1;
      if (event.seq <= last) return;
      entry.seen.set(sessionId, event.seq);
      this.emit('event', instanceId, sessionId, event);
    };
    const onSession = (session: Session): void => {
      this.owners.set(session.sessionId, instanceId);
      this.emit('session', instanceId, session);
    };
    const onPermission = (request: PermissionRequest): void => {
      this.emit('permission', instanceId, request);
    };
    const onResolved = (resolved: unknown): void => {
      this.emit('permission-resolved', instanceId, resolved);
    };
    const onQueue = (sessionId: string, agentId: string, depth: number): void => {
      this.emit('queue', instanceId, sessionId, agentId, depth);
    };
    // Two closes, two answers. `closing` is the host saying it is stopping on
    // purpose, so there is nothing to come back to. `closed` is the link
    // breaking, which says nothing about the host — and on a remote workspace it
    // usually means the work is still running perfectly well on the other side.
    const onClosing = (reason: string): void => this.forget(instanceId, reason);
    const onClosed = (reason: string): void => {
      if (!this.entries.has(instanceId)) return; // already detached on purpose
      void this.reconnect(entry, reason);
    };

    connection.on('event', onEvent);
    connection.on('session', onSession);
    connection.on('permission', onPermission);
    connection.on('permission-resolved', onResolved);
    connection.on('queue', onQueue);
    connection.on('closing', onClosing);
    connection.on('closed', onClosed);

    entry.connection = connection;
    entry.unlisten = () => {
      connection.off('event', onEvent);
      connection.off('session', onSession);
      connection.off('permission', onPermission);
      connection.off('permission-resolved', onResolved);
      connection.off('queue', onQueue);
      connection.off('closing', onClosing);
      connection.off('closed', onClosed);
    };
  }

  /**
   * Dial a dropped host again, then replay what was missed.
   *
   * The entry is **kept** while this runs. Removing it would be the easy thing
   * and the wrong one: the sessions are still there, the agent is very likely
   * still working, and a UI that erases the host at the first lost packet tells
   * the user the opposite of what is true at the worst possible moment.
   *
   * Retries do not give up. A closed laptop lid is the case this exists for, and
   * "eight hours later" is a normal amount of time for it — a cap measured in
   * minutes would just be the wrong answer, slightly later.
   */
  private async reconnect(entry: Entry, reason: string): Promise<void> {
    if (entry.link === 'reconnecting') return;
    entry.unlisten();
    entry.link = 'reconnecting';
    this.emit('host', snapshot(entry));
    this.emit('link', entry.instanceId, 'reconnecting', reason);

    let cancelled = false;
    entry.stopReconnect = () => {
      cancelled = true;
    };

    for (let attempt = 0; !cancelled; attempt += 1) {
      await this.pause(this.backoff(attempt));
      if (cancelled || !this.entries.has(entry.instanceId)) return;

      let connection: HostConnection;
      try {
        connection = await this.deps.connect(entry.location);
        const identity = await connection.ready;
        if (identity.instanceId !== entry.instanceId) {
          // A different workspace answered on the path we remembered. Adopting
          // it would silently point every open session at the wrong machine.
          connection.disconnect();
          this.forget(entry.instanceId, 'the workspace at that location is not the same one');
          return;
        }
        // The pid may differ — the host can have been restarted while we were
        // away. That is fine, and worth showing: same sessions, new process.
        entry.pid = identity.pid;
        entry.role = connection.role;
      } catch {
        continue; // still down; wait longer and try again
      }

      this.wire(entry, connection);
      entry.link = 'connected';
      delete entry.stopReconnect;

      await this.catchUp(entry, connection);
      this.emit('host', snapshot(entry));
      this.emit('link', entry.instanceId, 'connected', 'reconnected');
      return;
    }
  }

  /**
   * Replay everything that happened while the link was down.
   *
   * `fromSeq` is exclusive, so the last seq seen is exactly the right thing to
   * ask from: nothing is lost and nothing repeats. That is why the high-water
   * mark is per session rather than per host — sessions advance independently,
   * and one number for the fleet would over- or under-read every session but one.
   */
  private async catchUp(entry: Entry, connection: HostConnection): Promise<void> {
    for (const [sessionId, lastSeq] of [...entry.seen]) {
      try {
        for (const event of await connection.events(sessionId as SessionId, lastSeq)) {
          if (event.seq <= (entry.seen.get(sessionId) ?? -1)) continue;
          entry.seen.set(sessionId, event.seq);
          this.emit('event', entry.instanceId, sessionId, event);
        }
        // The session record itself, since its state may have moved while we
        // were away and no `push.session` reached us.
        this.emit('session', entry.instanceId, await connection.get(sessionId as SessionId));
      } catch {
        // One unreadable session must not abandon the others. It keeps its old
        // high-water mark and catches up on the next reconnect.
      }
    }
    for (const request of await connection.pendingPermissions().catch(() => [])) {
      this.emit('permission', entry.instanceId, request);
    }
  }

  /** Quick at first, then patient. Capped so a long outage still polls. */
  private backoff(attempt: number): number {
    if (attempt === 0) return 0;
    return Math.min(1_000 * 2 ** (attempt - 1), this.deps.maxBackoffMs ?? 30_000);
  }

  private pause(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      // Never hold the process open just to wait for a retry.
      timer.unref?.();
    });
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
    // Stopped first: a reconnect loop that outlived its entry would dial a host
    // nobody is watching, forever.
    entry.stopReconnect?.();
    entry.connection.disconnect();
    this.forget(instanceId, 'detached');
  }

  /**
   * Ask a host to exit, and report whether it agreed.
   *
   * Distinct from `detach`, which only stops watching. This is the one operation
   * where a client asks the *owner* to stop owning, and the owner is entitled to
   * say no: a host holding a live agent must not go down because a window
   * decided it should. So the refusal is a return value, not an exception —
   * "still running, here is why" is an answer, not a failure.
   */
  async shutdownHost(instanceId: InstanceId): Promise<{ stopped: boolean; reason?: string }> {
    const entry = this.require(instanceId);
    const result = await entry.connection.requestShutdown();
    if (result.stopped) {
      // It will close the socket itself; forgetting now keeps the UI from
      // briefly showing a host that is on its way out as "reconnecting".
      entry.stopReconnect?.();
      this.forget(instanceId, 'host stopped');
    }
    return result;
  }

  async detachAll(): Promise<void> {
    for (const instanceId of [...this.entries.keys()]) await this.detach(instanceId);
  }

  /** Drop local bookkeeping for a host that is gone or going. */
  private forget(instanceId: InstanceId, reason: string): void {
    const entry = this.entries.get(instanceId);
    if (!entry) return;
    entry.stopReconnect?.();
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

  /**
   * What one runtime on one host declares it can do.
   *
   * Per host, not per runtime id, because the same adapter answers differently
   * on different machines — a CLI at a different version, an endpoint that is up
   * here and down there. Asking the host is the only way to get the answer for
   * *that* machine (§3.2).
   *
   *  when it could not be asked, which the matrix renders as a gap rather
   * than as an absence of capability.
   */
  async capabilitiesOn(instanceId: InstanceId, runtimeId: string): Promise<RuntimeCapabilities | null> {
    const entry = this.entries.get(instanceId);
    if (!entry) return null;
    try {
      return await entry.connection.capabilities(runtimeId);
    } catch {
      return null;
    }
  }

  /**
   * The inbox across every attached host, newest first.
   *
   * Merged here rather than per host because "what happened while I was away" is
   * one question, and answering it once per workspace would make the user do the
   * interleaving themselves. A host that cannot be reached contributes nothing
   * rather than failing the whole list — its events are still on its disk.
   */
  async inbox(limit = 50): Promise<InboxEntry[]> {
    const parts = await Promise.all(
      [...this.entries.values()].map(async (entry) => {
        try {
          return await entry.connection.inbox(limit);
        } catch {
          return [] as InboxEntry[];
        }
      }),
    );
    return parts
      .flat()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit);
  }

  /** Mark every attached host as read. One gesture, one meaning. */
  async markInboxRead(): Promise<void> {
    await Promise.all(
      [...this.entries.values()].map((entry) =>
        entry.connection.markInboxRead().catch(() => undefined),
      ),
    );
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

  /** Answer a split proposal on whichever host owns the session (§4.3). */
  async respondSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
  ): Promise<Session | null> {
    return this.ownerOf(sessionId).connection.respondSplit(sessionId, proposalId, decision);
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

  async send(
    sessionId: SessionId,
    agentId: AgentId,
    text: string,
    blocks?: ContentBlock[],
  ): Promise<void> {
    return this.ownerOf(sessionId).connection.send(sessionId, agentId, text, blocks);
  }

  /**
   * Put bytes where the session that will reference them can read them (§6.7).
   *
   * Routed through `ownerOf` like everything else, and that is the point: for a
   * local host it is a write next door and for a remote one a chunked transfer
   * over ssh, and §12.1's capture path should no more have to know which than
   * `send` does.
   */
  async putBlob(sessionId: SessionId, data: Buffer, mime: string): Promise<Sha256> {
    return this.ownerOf(sessionId).connection.putBlob(sessionId, data, mime);
  }

  async interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    return this.ownerOf(sessionId).connection.interrupt(sessionId, agentId);
  }

  async events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
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
    endpoints: entry.endpoints.map((e) => ({ ...e })),
    ...(entry.movedFrom !== undefined ? { movedFrom: entry.movedFrom } : {}),
    role: entry.role,
    pid: entry.pid,
    link: entry.link,
    ...(entry.unavailableReason !== undefined
      ? { unavailableReason: entry.unavailableReason }
      : {}),
  };
}
