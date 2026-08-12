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
import { basename } from 'node:path';

import { byAttentionThenRecency, describeTarget, sameTarget } from '@shared/types/index.js';
import type { HostConnection } from './host/hostConnection.js';
import { requireTransport } from './host/transports.js';
import type { SearchHit } from './store/searchSessions.js';
import type { ListeningPort } from './preview/ports.js';
import type { PreviewServer, PreviewServerLog } from './preview/servers.js';
import type { SessionTemplate } from './store/templates.js';
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

/** A hit, with the machine it came from attached. */
export interface FleetSearchHit extends SearchHit {
  instanceId: InstanceId;
  host: string;
}

export interface FleetSearch {
  hits: FleetSearchHit[];
  /** Hosts that could not be asked, by label. Not the same as no results. */
  unreachable: string[];
}

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
  /**
   * The bundle this host is executing, when it says (§6.3).
   *
   * `undefined` from a host older than protocol v7 or running unstamped from
   * source, and that is a third answer rather than a missing one: it means *this
   * cannot be determined*, which a client must not round down to "out of date".
   * The remedy on a mismatch is restarting the host, and offering it against a
   * guess costs somebody their running turn.
   */
  bundleVersion?: string;
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

    /**
     * Refuse a locality that does not work, before anything is dialled.
     *
     * Here rather than in the connector, which is where this was missing: the
     * connector is a dependency, so a check inside the app's copy is a check the
     * CLI does not have and the next one will not have either. The failure it
     * replaces is the quiet kind — an unimplemented kind fell through to the
     * local branch and ran the work on this machine under a badge saying
     * otherwise.
     */
    requireTransport(target);

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
      ...(identity.bundleVersion === undefined ? {} : { bundleVersion: identity.bundleVersion }),
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

  /**
   * Restart a host onto the bundle this app ships (§6.3).
   *
   * A host keeps executing the bundle it started with, so deploying a newer one
   * changes nothing until it restarts. `attach` already re-uploads when the
   * version differs — what it will not do is interrupt a running host to make
   * the new code take effect, and it should not: that decision belongs to a
   * person, on a machine that may be running somebody's overnight work.
   *
   * Stop, then attach the same location again. The upload is `attach`'s job and
   * stays there rather than being repeated here; this method is the *when*.
   *
   * Sessions survive it. They are durable in the event log (§5.4) and resume
   * from it, which is the same guarantee that lets a host outlive the app — so
   * this costs the running turn, not the work.
   *
   * The location is captured before stopping, because `shutdownHost` forgets the
   * entry and with it the only record of where the host was.
   */
  async updateHost(instanceId: InstanceId): Promise<AttachedHost> {
    const { location } = this.require(instanceId);

    const result = await this.shutdownHost(instanceId);
    if (!result.stopped) {
      throw new AttachRefused(
        `the host would not stop${result.reason === undefined ? '' : `: ${result.reason}`}. ` +
          `It keeps running the version it started with until it does.`,
      );
    }

    return this.attach(location);
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
  /**
   * Search every attached host at once (§15 Phase 8).
   *
   * In parallel, because the slow one is a remote over ssh and doing them in
   * turn would make the search take as long as the sum rather than the max.
   *
   * A host that fails does not fail the search. An unreachable machine is an
   * ordinary state of a fleet — §6 already says an unreachable workspace stays
   * "visible and searchable but not resumable" — and a search box that returns
   * an error because one of four hosts is asleep is a search box nobody trusts.
   * The caller is told which hosts answered, so "no results" and "we could not
   * ask" stay distinguishable.
   */
  /**
   * Ports listening on the machine a host runs on (§6.8).
   *
   * Returns `[]` for a host too old to answer, rather than propagating. The
   * caller's question is "what could I preview", and an older host's honest
   * answer to that is "I cannot tell you" — which looks the same as "nothing" to
   * a picker, and unlike an exception does not replace a working feature with an
   * error the user cannot act on.
   */
  /**
   * Preview servers on a host's machine (§6.8).
   *
   * Unlike `previewPorts`, a failure here is **not** swallowed. Asking what is
   * running is a question a UI asks on open, so an empty answer is fine — but
   * starting one is something a person did on purpose, and swallowing its
   * failure would leave them looking at a list that never gains a row.
   */
  async previewServers(instanceId: InstanceId, sessionId?: SessionId): Promise<PreviewServer[]> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('preview.servers')) return [];
    try {
      return await entry.connection.previewServers(sessionId);
    } catch {
      return [];
    }
  }

  async startPreviewServer(
    instanceId: InstanceId,
    sessionId: SessionId,
    command: string,
  ): Promise<PreviewServer> {
    return this.host(instanceId).connection.startPreviewServer(sessionId, command);
  }

  async stopPreviewServer(instanceId: InstanceId, serverId: string): Promise<boolean> {
    return this.host(instanceId).connection.stopPreviewServer(serverId);
  }

  async previewServerLog(
    instanceId: InstanceId,
    serverId: string,
  ): Promise<PreviewServerLog | null> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('preview.log')) return null;
    return entry.connection.previewServerLog(serverId);
  }

  /**
   * Templates a host offers (§17 Q12).
   *
   * Empty for a host too old to answer, like `previewPorts`: a picker asking on
   * open must render rather than raise. Saving and applying are different — a
   * person did those on purpose, and swallowing their failure would leave them
   * looking at a list that never gains a row.
   */
  async templates(instanceId: InstanceId): Promise<SessionTemplate[]> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('template.list')) return [];
    try {
      return await entry.connection.templates();
    } catch {
      return [];
    }
  }

  /**
   * Save a template, stamped with where this host is.
   *
   * The target is added here because this is the only layer that has one. A host
   * knows a workspace; `ssh build-01` is *this app's* name for the route to it,
   * and it lives in the entry. The host used to derive it from `session.target`,
   * which is `{kind:'local'}` on every session that has ever existed — so no
   * template could carry a target and the refusal below could never fire.
   */
  async saveTemplate(
    instanceId: InstanceId,
    sessionId: SessionId,
    name: string,
  ): Promise<SessionTemplate> {
    const entry = this.host(instanceId);
    return entry.connection.saveTemplate(sessionId, name, entry.target);
  }

  /**
   * Apply a template, refusing to quietly run it on the wrong machine.
   *
   * `SessionTemplate.target` documented this from the day it was written — "a
   * user who does not have that alias gets a refusal naming it, which is more
   * useful than silently running somewhere else — the failure §16 already
   * records for execution targets" — and the code did the thing that sentence
   * forbids. `template.apply` rebuilt the roster, the goal and the checklist and
   * never read `target` at all.
   *
   * Nothing looked broken, because the field was also impossible to populate. So
   * the promise sat in a doc comment being believed, which is §16's shape
   * exactly: recorded, not enforced. It costs one comparison now that anything
   * can set it.
   *
   * Refusing rather than attaching the right machine on the user's behalf: "we
   * run this on the build box" is a claim about *their* setup, and the alias may
   * not exist here, may point somewhere else, or may be a machine they did not
   * mean to start work on. Naming it is the useful act; choosing for them is not.
   */
  async applyTemplate(instanceId: InstanceId, templateId: string, title?: string): Promise<Session> {
    const entry = this.host(instanceId);

    /**
     * Asked through the connection, deliberately, and not through `templates()`
     * one method up.
     *
     * That one answers "what can I show in a list", so it returns `[]` when the
     * host is too old or the call fails — right for a sidebar, and catastrophic
     * here. The first version of this guard used it, which made the refusal
     * **fail open**: any error listing templates produced `undefined`, `find`
     * matched nothing, the check was skipped, and the template ran on the wrong
     * machine. That is the bug this guard exists to prevent, reintroduced by the
     * guard itself, and it would have been invisible — the success path is
     * identical.
     *
     * A check that cannot see is a check that must refuse.
     */
    if (!entry.connection.supports('template.list')) {
      throw new AttachRefused(
        `this host cannot list templates, so there is no way to tell whether ` +
          `"${templateId}" is meant for another machine. Upgrade the host to apply it.`,
      );
    }
    const template = (await entry.connection.templates()).find((t) => t.id === templateId);

    if (template?.target !== undefined && !sameTarget(template.target, entry.target)) {
      throw new AttachRefused(
        `the template "${template.name}" runs on ${describeTarget(template.target)}, and ` +
          `this host is ${describeTarget(entry.target)}. Attach that machine and apply the ` +
          `template there, or save a copy of the template for this one.`,
      );
    }

    return entry.connection.applyTemplate(templateId, title);
  }

  async deleteTemplate(instanceId: InstanceId, templateId: string): Promise<boolean> {
    return this.host(instanceId).connection.deleteTemplate(templateId);
  }

  private host(instanceId: InstanceId): Entry {
    const entry = this.entries.get(instanceId);
    if (entry === undefined) throw new Error(`no attached host ${instanceId}`);
    return entry;
  }

  async previewPorts(instanceId: InstanceId): Promise<ListeningPort[]> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('preview.ports')) return [];
    try {
      return await entry.connection.previewPorts();
    } catch {
      return [];
    }
  }

  async search(query: string, limit = 50): Promise<FleetSearch> {
    const entries = [...this.entries.values()];
    const asked = await Promise.all(
      entries.map(async (entry) => {
        try {
          const hits = await entry.connection.search(query, limit);
          return { entry, hits, ok: true as const };
        } catch {
          return { entry, hits: [] as SearchHit[], ok: false as const };
        }
      }),
    );

    return {
      hits: asked.flatMap(({ entry, hits }) =>
        hits.map((hit) => ({ ...hit, instanceId: entry.instanceId, host: labelOf(entry) })),
      ),
      // Named rather than counted: "3 of 4 hosts answered" needs to say *which*
      // one did not, or the user cannot tell whether to go and wake it.
      unreachable: asked.filter((a) => !a.ok).map(({ entry }) => labelOf(entry)),
    };
  }

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

/**
 * A short name for a machine, for saying which one a hit came from.
 *
 * The alias over the hostname, because the alias is what the user chose and
 * what they would type; the folder for a local workspace, because "local"
 * repeated across four rows says nothing.
 */
function labelOf(entry: Entry): string {
  const target = entry.target as { alias?: string; host?: string; distro?: string };
  return (
    target.alias ??
    target.host ??
    target.distro ??
    // `basename`, not a hand-rolled split. The first version split on a
    // character class that lost its backslash through two layers of escaping, so
    // a Windows path never split and every local host was labelled with its full
    // path. The smoke check printed it, which is the only reason it was noticed.
    basename(entry.workspaceRoot)
  );
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
