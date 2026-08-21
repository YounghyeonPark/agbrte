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
import type { HostIdentity } from '@shared/host/sessionProtocol.js';
import type { EndpointModels, ModelInstallProgress } from '@shared/host/protocol.js';
import { requireTransport } from './host/transports.js';
import {
  authFollowUp,
  CLI_PACKAGES,
  OLLAMA_BASE_URL,
  RouteRefused,
  type SetupPlan,
} from './host/provision.js';
import { SplitRefused } from './sessionManager.js';
import type { SearchHit } from './store/searchSessions.js';
import type { ListeningPort } from './preview/ports.js';
import type { PreviewServer, PreviewServerLog } from './preview/servers.js';
import type { ShellHandle } from './terminal/shell.js';
import type { SessionTemplate } from './store/templates.js';
import type { ModelNeed } from './runtime/registry.js';
import type {
  CreateSessionInput,
  DirListing,
  FilePreview,
  ReasoningRequest,
  AccessRole,
  AgentId,
  AgentRecord,
  ContentBlock,
  ExecutionTarget,
  HostLocation,
  InstanceId,
  LineageId,
  AgbrteEvent,
  ModelCapabilityHint,
  PermissionDecision,
  PermissionRequest,
  InboxEntry,
  RawTail,
  RuntimeCapabilities,
  Session,
  SessionId,
  SessionProjection,
  Sha256,
  ShellProgram,
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
  /**
   * How long `updateHost` waits for the replacement before answering.
   *
   * Lowered by tests for the same reason `maxBackoffMs` is: the failure path
   * spends this entire window dialling on purpose, and a suite should not.
   */
  updateWindowMs?: number;
  /**
   * Puts software on the machine a host runs on (§6.4's bootstrap, reused).
   *
   * Injected for exactly the reason `connect` is: it is the one part of setting
   * a machine up that is transport-specific — `ssh` for a remote, `/bin/sh` for
   * a local one — and a `Fleet` that imported either would be a `Fleet` the
   * CLI and the tests cannot construct. What stays here is the part that is the
   * same everywhere: the capability check, the ordering, and the restart.
   *
   * Absent means this client will not install anything, which `setUpHost`
   * refuses by name rather than by failing to find a method.
   */
  provision?: (
    location: HostLocation,
    plan: SetupPlan,
    onProgress: (step: string) => void,
  ) => Promise<void>;
}

/**
 * What setting a machine up actually achieved, in two independent halves.
 *
 * Two booleans and not one enum, because they fail for unrelated reasons and a
 * person needs both answers: the install is about a network and a disk, the
 * re-detect is about whether anybody was mid-turn on that host. "It worked but
 * the host has not noticed" is a real, common, recoverable state, and rounding
 * it to either success or failure loses the only sentence worth reading.
 */
export interface SetupOutcome {
  installed: boolean;
  redetected: boolean;
  /** What landed, in the user's terms. Never contains a credential. */
  summary: string;
  /** The steps that ran, in order, as they were reported. */
  steps: string[];
  /**
   * What the person still has to do themselves.
   *
   * The honest half of installing a vendor CLI: `claude` needs an interactive
   * `claude auth login` on that machine, and this app cannot supply one — its
   * terminal pane is local-only. Saying so is the difference between an install
   * that works and one that appears to.
   */
  followUp?: string;
  /** Why the second half did not happen. Absent when it did. */
  detail?: string;
}

/**
 * Raise a blocked descendant onto its ancestors, across hosts (§4.3, §17 Q5).
 *
 * `SessionManager.rollUp` does this within a host by walking its own map of live
 * sessions. That map is one workspace, so the moment a parent and child sit on
 * different machines the walk finds nothing and stops — silently, which is the
 * shape §15's criterion cannot survive: *a permission prompt raised by the
 * deepest child appears in the top-level Needs-you rail*.
 *
 * **Derived here rather than pushed to the parent's host.** The fleet already
 * receives every session from every host, so the information is in hand;
 * writing it into the parent's log instead would record, in one machine's
 * durable history, a fact belonging to another's — and would need a new command,
 * a new event, and an answer for what happens when the far host is unreachable.
 * A view can be recomputed on the next list; a log entry cannot be taken back.
 *
 * The descendant's own reason travels up with a `from` breadcrumb, matching
 * `recomputeAttention` exactly and for the reason written there: *something below
 * this needs you* is not actionable unless you can get to it. Two bubbling rules
 * that disagreed about what a raised attention says would be worse than one that
 * stops at a host boundary, because the disagreement would be invisible.
 */
function bubbleAcrossHosts(sessions: Session[]): Session[] {
  const byId = new Map(sessions.map((s) => [s.sessionId, s]));

  for (const session of sessions) {
    const raised = session.needsAttention;
    // Only what a session is asking on its own behalf climbs. Re-raising an
    // already-bubbled attention would attribute a grandchild's question to its
    // parent as though the parent had asked it.
    if (raised === null || raised.from !== undefined) continue;

    for (const ancestorId of session.tree.ancestry) {
      const ancestor = byId.get(ancestorId as SessionId);
      // Absent means that host is not attached. Nothing to raise it onto, and
      // nothing lost: attaching recomputes this from the same sessions.
      if (ancestor === undefined) continue;
      // An ancestor with a question of its own keeps it — its own is nearer the
      // person than a descendant's.
      if (ancestor.needsAttention !== null) continue;
      ancestor.needsAttention = {
        reason: raised.reason,
        since: raised.since,
        from: { sessionId: session.sessionId, title: session.title, path: [session.title] },
      };
    }
  }
  return sessions;
}

/** One attached host: a workspace, the process owning it, and its sessions. */
export interface AttachedHost {
  /**
   * Which machine this host runs on (§5.2, §8).
   *
   * Not a second name for `instanceId`. Two folders on one build box are two
   * checkouts and *one* machine, and every question of the form "can these
   * reach each other" is about the machine — which is why asking `instanceId`
   * produced sentences like "those sessions are on 2 machines" about one
   * computer.
   *
   * `undefined` from a host that predates this field, and that is *cannot tell*
   * rather than *a different machine*: a caller must fall back to something it
   * can defend rather than treating an absent id as a distinct one.
   */
  machineId?: string;
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
  /**
   * Models it can reach, credentials already stripped.
   *
   * `baseUrl` travels because a decision depends on it: "install Ollama" must
   * not add a second endpoint to a host that already has one pointed at
   * `127.0.0.1:11434` — including the *implicit* one a host with no endpoints
   * file falls back to. The handshake has always carried it and this dropped
   * it, so the question could only be answered by a round trip that guessed.
   * It is not a secret: `PublicEndpoint` is defined as everything except the
   * key, and the URL is half of what §13 requires be legible before a turn.
   */
  endpoints: Array<{
    id: string;
    label: string;
    provider: string;
    baseUrl: string;
    authenticated: boolean;
  }>;
  /**
   * Runtimes this host looked for and did not find, with why (§3.12).
   *
   * Carried so a picker can say *Claude Code: not detected on this host (…)*
   * rather than silently omitting the row. Omission is indistinguishable from a
   * bug in the picker, which is what it cost the person who spent a session
   * looking for a runtime the host had quietly declined to offer.
   *
   * Empty from a host older than protocol v16 — which reads as *nothing to
   * say*, exactly today's screen, rather than as *everything was found*.
   */
  runtimeNotes: Array<{ id: string; label: string; reason: string }>;
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
  /**
   * This host is being restarted on purpose (§6.3, `updateHost`).
   *
   * A host stopping normally means the workspace has no owner and the entry
   * should go. During an update it means the opposite — a replacement is being
   * started for the same workspace — and the two arrive as the identical
   * `push.closing`. Without this flag the update's own shutdown erased the host
   * from the UI a beat before its replacement appeared, and any failure in
   * between left the user with an empty sidebar.
   */
  updating?: true;
  /**
   * Live events parked while a catch-up reads history.
   *
   * Present only for the length of a reconnect. Its absence is the normal state
   * and means "deliver as they arrive"; see `onEvent` for what it is for.
   */
  holding?: Array<[string, AgbrteEvent]>;
}

/**
 * How long `updateHost` waits for the replacement before answering the person.
 *
 * A bound rather than the reconnect loop's patience, because this is a button
 * that was just pressed: an answer is owed. It is generous because the connector
 * behind it has its own waits — the departing host has to release the socket
 * before a new one can take it, and a remote one may redeploy a bundle first —
 * and a window shorter than the work it is waiting on would report a failure
 * that was only slowness. Giving up does not stop the dialling; it stops the
 * silence.
 */
const UPDATE_WINDOW_MS = 90_000;

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
 *   'shell'      (shellId, data)  — a person's terminal, never an agent's (§7)
 *   'shell-exit' (shellId, exitCode, signal?)
 */
export class Fleet extends EventEmitter {
  private readonly entries = new Map<InstanceId, Entry>();
  /** sessionId → owning host, so a call routes without a search. */
  private readonly owners = new Map<SessionId, InstanceId>();
  /**
   * shellId → the host running it, so typing routes without a search.
   *
   * Separate from `owners` rather than folded into it, because the two answer
   * different questions with different lifetimes: a session outlives every
   * connection to it and is re-resolvable from disk, while a terminal exists
   * only as long as the process holding it. Merging them would put something
   * unrecoverable in the map that everything else treats as a cache.
   */
  private readonly shellHosts = new Map<string, InstanceId>();

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

    /*
     * The workspace this connection was bound to (§8).
     *
     * A host is one per machine now and holds several folders, so the handshake
     * describes the machine and names the folder this connection got. A
     * connection with none is a *machine* connection — a real state, and not one
     * an entry can be built from, because an entry is a workspace. Refused by
     * name rather than defaulted to the host's first folder, which would attach
     * a card labelled with one project and pointed at another.
     */
    const bound = identity.workspace;
    if (bound === undefined) {
      connection.disconnect();
      throw new AttachRefused(
        `the host on that machine did not open ${workspaceRoot}` +
          (identity.workspaces.length === 0
            ? ''
            : ` — it is holding ${identity.workspaces.map((w) => w.root).join(', ')}`),
      );
    }

    const existing = this.entries.get(bound.instanceId);
    if (existing) {
      connection.disconnect();
      return snapshot(existing);
    }

    const entry: Entry = {
      instanceId: bound.instanceId,
      lineageId: bound.lineageId,
      workspaceRoot: bound.root,
      target,
      available: [],
      endpoints: [],
      runtimeNotes: [],
      role: connection.role,
      pid: identity.pid,
      link: 'connected',
      location,
      seen: new Map(),
      connection,
      unlisten: () => undefined,
    };
    // The same call the reconnect path makes, so there is one place that turns a
    // handshake into a host record rather than two that can drift.
    this.adopt(entry, identity, connection);
    this.wire(entry, connection);
    this.entries.set(bound.instanceId, entry);

    this.emit('host', snapshot(entry));
    return snapshot(entry);
  }

  /**
   * Write a handshake into the host record — every handshake, not just the first.
   *
   * ## Why this is a method rather than an object literal in `attach`
   *
   * A host is a **detached process that outlives the app and can be replaced**
   * (§6.4, §8). The `instanceId` belongs to the *workspace*, not to the process,
   * so a host that exits and is respawned answers on the same identity — and
   * `reconnect` is built to keep the entry precisely because that is the normal
   * case. What it did not do was re-read the handshake, so everything derived
   * from the *first* one was frozen for the life of the app:
   *
   *   - `available` — the runtimes offered. A host that had Claude Code on PATH
   *     when the app attached went on being offered it after being replaced by
   *     one that did not, and `addAgent` then failed with `runtime
   *     "cli:claude-code" is not registered` against a picker that looked right.
   *   - `endpoints` — the models reachable, which change with an edited
   *     endpoints file and a restart.
   *   - `bundleVersion` — the very thing `updateHost` restarts a host to change,
   *     so "outdated" survived the update that fixed it.
   *   - `movedFrom` — news exactly once (§5.3), and a stale copy re-announces a
   *     move that already happened.
   *   - `unavailableReason` — a host whose agent host failed and was restarted
   *     into a working one kept the old apology.
   *
   * Every one of those is a *claim about the process*, and the process is the
   * thing that changed. The workspace identity is what stays, and `reconnect`
   * checks that separately before calling this.
   *
   * The optional fields are **deleted** when the new handshake omits them rather
   * than left alone. Absent means *cannot be determined* for `bundleVersion` and
   * *nothing happened* for the other two, and a value that outlives its evidence
   * is worse than no value: it is a claim nothing supports.
   */
  private adopt(entry: Entry, identity: HostIdentity, connection: HostConnection): void {
    /*
     * The bound workspace, when the handshake named one.
     *
     * A reconnect that comes back *unbound* leaves the entry's own fields alone
     * rather than clearing them: the entry is a workspace, and a host that
     * answered without binding it has not told us the folder is gone — only
     * that this connection is not working in it. Overwriting with `undefined`
     * would put a card with no path on screen for a workspace that is fine.
     */
    const bound = identity.workspace;
    if (bound !== undefined) {
      entry.lineageId = bound.lineageId;
      entry.workspaceRoot = bound.root;
    }
    // Deleted rather than left stale when a host stops reporting one: an entry
    // reattached to an older host must read as *cannot tell*, not as the machine
    // the previous handshake happened to name.
    if (identity.machineId === undefined) delete entry.machineId;
    else entry.machineId = identity.machineId;
    entry.pid = identity.pid;
    entry.role = connection.role;

    // Reconciled against what this app knows how to label. A host may register
    // more than this app lists — that is a newer host, and offering an id with
    // no metadata would put a blank row in the picker.
    entry.available = this.deps.runtimes
      .filter((r) => identity.runtimes.includes(r.id))
      .map((r) => r.id);
    entry.endpoints = (identity.endpoints ?? []).map((e) => ({
      id: e.id,
      label: e.label,
      provider: e.provider,
      baseUrl: e.baseUrl,
      authenticated: e.authenticated,
    }));
    entry.runtimeNotes = (identity.runtimeNotes ?? []).map((n) => ({ ...n }));

    if (identity.bundleVersion === undefined) delete entry.bundleVersion;
    else entry.bundleVersion = identity.bundleVersion;

    if (bound?.movedFrom === undefined) delete entry.movedFrom;
    else entry.movedFrom = bound.movedFrom;

    if (identity.unavailableReason === undefined) delete entry.unavailableReason;
    else entry.unavailableReason = identity.unavailableReason;
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
      /*
       * Held, not delivered, while a catch-up is reading history.
       *
       * The host starts pushing the instant we reconnect, and what it pushes is
       * whatever is happening *now* — which on a turn that ran through the
       * outage is seq 8 while seqs 3..7 are still sitting in the log unread.
       * Delivered straight through, that push advanced the high-water mark to 8
       * before `catchUp` had asked for anything, so the request went out as
       * "everything after 8" and **seqs 3 to 7 were lost for the life of the
       * app** — the exact failure §15's criterion names, and it survived because
       * an in-memory cut has no interval in which a host writes unobserved.
       * Measured against a real host: `[2, 8, 9]` delivered out of `[2..9]`.
       *
       * Holding also keeps them in order. Emitting 8 and 9 and then 3 to 7 would
       * trade a gap for a transcript that goes backwards, which is not better.
       */
      if (entry.holding !== undefined) {
        entry.holding.push([sessionId, event]);
        return;
      }
      this.deliver(entry, sessionId, event);
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
    //
    // Three, during an update: a host stopping *because this fleet asked it to
    // restart* has a replacement on the way, and `updateHost` owns the whole
    // transition. Both handlers stand down for it rather than racing it — one
    // would erase the host, the other would start a second dialling loop.
    const onClosing = (reason: string): void => {
      if (entry.updating === true) return;
      this.forget(instanceId, reason);
    };
    const onClosed = (reason: string): void => {
      if (entry.updating === true) return;
      if (!this.entries.has(instanceId)) return; // already detached on purpose
      void this.reconnect(entry, reason);
    };

    /*
     * Terminal traffic, re-emitted untouched and out of the event path.
     *
     * No `owners` update, no `seen` guard, no `seq`: none of those apply to a
     * stream that is not in a log and cannot be caught up on. It is here rather
     * than on a side channel because the host socket is already the one
     * connection to that machine, and opening a second one per terminal would
     * mean a second thing to authenticate, reconnect, and get wrong.
     */
    const onShell = (shellId: string, data: string): void => {
      this.emit('shell', shellId, data);
    };
    const onShellExit = (shellId: string, exitCode: number, signal?: number): void => {
      this.shellHosts.delete(shellId);
      this.emit('shell-exit', shellId, exitCode, signal);
    };

    connection.on('event', onEvent);
    connection.on('session', onSession);
    connection.on('permission', onPermission);
    connection.on('permission-resolved', onResolved);
    connection.on('queue', onQueue);
    connection.on('shell', onShell);
    connection.on('shell-exit', onShellExit);
    connection.on('closing', onClosing);
    connection.on('closed', onClosed);

    entry.connection = connection;
    entry.unlisten = () => {
      connection.off('event', onEvent);
      connection.off('session', onSession);
      connection.off('permission', onPermission);
      connection.off('permission-resolved', onResolved);
      connection.off('queue', onQueue);
      connection.off('shell', onShell);
      connection.off('shell-exit', onShellExit);
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
    await this.redial(entry, { reason: 'reconnected' });
  }

  /**
   * Dial until it answers, or until the caller's patience runs out.
   *
   * Split out of `reconnect` because `updateHost` needs the same loop with a
   * *deadline* on it: a dropped link has no reason to give up — the laptop lid
   * is the case it exists for — while a person waiting on a button pressed a
   * moment ago is owed an answer. One loop rather than two, because the half
   * that is easy to get wrong is what happens on success (adopt the whole
   * handshake, rewire, replay), and two copies of that would drift.
   *
   * `null` means connected. A string is the last reason it did not, which is the
   * only half of a failure a user can act on.
   *
   * The entry is **kept** throughout. Removing it would be the easy thing and the
   * wrong one: the sessions are still there, the agent is very likely still
   * working, and a UI that erases the host at the first lost packet tells the
   * user the opposite of what is true at the worst possible moment.
   */
  private async redial(
    entry: Entry,
    opts: {
      reason: string;
      deadline?: number;
    },
  ): Promise<string | null> {
    let cancelled = false;
    entry.stopReconnect = () => {
      cancelled = true;
    };

    let last = 'nothing answered';
    for (let attempt = 0; !cancelled; attempt += 1) {
      await this.pause(this.backoff(attempt));
      if (cancelled || !this.entries.has(entry.instanceId)) return 'no longer attached';

      let connection: HostConnection;
      try {
        connection = await this.deps.connect(entry.location);
        const identity = await connection.ready;
        if (identity.workspace?.instanceId !== entry.instanceId) {
          // A different workspace answered on the path we remembered — or none
          // did, which is the same fact stated more weakly. Adopting either
          // would silently point every open session at the wrong folder.
          connection.disconnect();
          const wrong = 'the workspace at that location is not the same one';
          this.forget(entry.instanceId, wrong);
          return wrong;
        }
        /*
         * The whole handshake, not just the pid.
         *
         * The pid may differ — the host can have been restarted while we were
         * away, which is fine and worth showing: same sessions, new process. But
         * a *new process* is a new answer to every other question the handshake
         * asks, and taking only the pid recorded that the process had changed
         * while continuing to describe the old one. See `adopt`.
         */
        this.adopt(entry, identity, connection);
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
        // Checked after the attempt rather than before it, so a deadline always
        // buys at least one try and the reason reported is a real one.
        if (opts.deadline !== undefined && Date.now() >= opts.deadline) return last;
        continue; // still down; wait longer and try again
      }

      /*
       * Cleared here rather than where it was set, because `wire` is next.
       *
       * `updating` tells the close handlers to stand down while there is no
       * connection to lose. The moment there is one again that suppression is
       * wrong, and the gap it would leave is not theoretical: `catchUp` below is
       * a round trip, and a replacement that died inside it would have its
       * `closed` swallowed by handlers this line is about to install — leaving
       * an entry marked connected to a host that is gone, with nothing dialling.
       */
      delete entry.updating;

      /*
       * Live pushes go into a queue until the history has been read.
       *
       * Set before `wire` and released after `catchUp`, because the window
       * between them is precisely where a push and a replay disagree about
       * where history ends. See `onEvent`.
       */
      const held: Array<[string, AgbrteEvent]> = [];
      entry.holding = held;

      this.wire(entry, connection);
      entry.link = 'connected';
      delete entry.stopReconnect;

      try {
        await this.catchUp(entry, connection);
      } finally {
        // By identity, not by presence: if this connection died inside the
        // catch-up, a *new* redial is already holding its own queue, and
        // clearing that one would put the bug back for it.
        if (entry.holding === held) delete entry.holding;
        for (const [sessionId, event] of held) this.deliver(entry, sessionId, event);
      }
      this.emit('host', snapshot(entry));
      this.emit('link', entry.instanceId, 'connected', opts.reason);
      return null;
    }
    return 'cancelled';
  }

  /**
   * Emit one event, once.
   *
   * The high-water mark moves *here*, at delivery, and nowhere else — so
   * "delivered" and "counted as delivered" cannot come apart. They did: a live
   * push advanced the mark on arrival while its delivery was still pending
   * behind a catch-up, and the catch-up then skipped everything below it.
   */
  private deliver(entry: Entry, sessionId: string, event: AgbrteEvent): void {
    // Dropped rather than re-emitted if we already have it. Catch-up and the
    // live push overlap by construction, so the same event can arrive twice.
    // `seq` is monotonic per session, which makes the check exact rather than a
    // guess.
    const last = entry.seen.get(sessionId) ?? -1;
    if (event.seq <= last) return;
    entry.seen.set(sessionId, event.seq);
    this.emit('event', entry.instanceId, sessionId, event);
  }

  /**
   * Replay everything that happened while the link was down.
   *
   * `fromSeq` is exclusive, so the last seq seen is exactly the right thing to
   * ask from: nothing is lost and nothing repeats. That is why the high-water
   * mark is per session rather than per host — sessions advance independently,
   * and one number for the fleet would over- or under-read every session but one.
   *
   * Called with live pushes held (see `onEvent`), which is what makes the mark it
   * reads the one from *before* the reconnect rather than one the first push
   * already moved.
   */
  private async catchUp(entry: Entry, connection: HostConnection): Promise<void> {
    for (const [sessionId, lastSeq] of [...entry.seen]) {
      try {
        for (const event of await connection.events(sessionId as SessionId, lastSeq)) {
          this.deliver(entry, sessionId, event);
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
   * Sessions survive it. They are durable in the event log (§5.4) and resume
   * from it, which is the same guarantee that lets a host outlive the app — so
   * this costs the running turn, not the work.
   *
   * ## Why this is not `shutdownHost` followed by `attach`
   *
   * That is what it was, and it never once worked. `shutdownHost` **forgets the
   * host the moment it agrees to stop** — right, for a stop, because there is
   * nothing coming back — so the sidebar emptied and the reattach began from
   * nothing. Then `attach` dialled the same socket while the old host was still
   * on it: a host answers `{stopped:true}` *before* it stops, and closing preview
   * servers, terminals, the agent host and the listener takes long enough that
   * the connect always won the race. `HostConnection.ready` then rejected with
   * `peer ended the connection`, `attach` turned that into `AttachRefused`, and
   * the user was left with **nothing attached and no further attempt made** —
   * having pressed a button whose entire promise was that the host comes back.
   *
   * So the host is not forgotten and not reattached. It is a *restart* of a
   * process serving a workspace this fleet is already watching, which is the
   * same fact a dropped link reports, and it gets the same treatment: the entry
   * stays, the link goes to `reconnecting`, and `redial` brings the replacement
   * in under the identity that was already there. The `seen` high-water marks
   * survive with it, so `catchUp` replays across the restart with no loss and no
   * duplicates — which reattaching could not do, since a fresh `attach` starts
   * with an empty map.
   *
   * The two ways it can still fail are both answers rather than silences:
   *   - **The host refuses to stop** — work is in flight, which it is entitled
   *     to say. Nothing was touched, so the previous host is still attached and
   *     still connected, and the reason is reported verbatim.
   *   - **The replacement will not come up** — reported with what the last dial
   *     said, and the entry is *kept* with a redial running behind it, so the
   *     machine stays on screen and returns by itself when whatever was wrong
   *     stops being wrong.
   */
  async updateHost(instanceId: InstanceId): Promise<AttachedHost> {
    const entry = this.require(instanceId);

    /*
     * Set before the request, not after the reply.
     *
     * The reply and the host's `push.closing` can arrive in the same read — the
     * host posts `{stopped:true}` and stops on the next tick — so by the time
     * this method resumes, `onClosing` may already have run `forget` and emitted
     * `detached`. Marking the entry first is what makes that handler able to
     * tell "the host is going away" from "the host is going away *because we are
     * restarting it*", which are the same event with opposite meanings.
     */
    entry.updating = true;

    /*
     * Every other workspace open on that machine, marked too (§8).
     *
     * A host is one per *machine* and holds several folders, so restarting one
     * folder's host restarts them all — they share the process, not just the
     * machine. `onClosing` reads `updating` to tell "the host is going away"
     * from "the host is going away *because we are restarting it*", and without
     * this every sibling entry took the first reading and was **forgotten**:
     * updating one project dropped the others out of the sidebar, mid-turn,
     * with their sessions perfectly intact and nothing on screen saying so.
     *
     * Matched on `machineId`, and an entry that does not report one is left
     * alone: absence means *cannot tell* (§6.7), and marking an entry that may
     * be on a different machine would suppress a `forget` that was correct.
     */
    const peers =
      entry.machineId === undefined
        ? []
        : [...this.entries.values()].filter(
            (other) => other !== entry && other.machineId === entry.machineId,
          );
    for (const peer of peers) peer.updating = true;

    const releasePeers = (): void => {
      for (const peer of peers) delete peer.updating;
    };

    let result: { stopped: boolean; reason?: string };
    try {
      result = await entry.connection.requestShutdown();
    } catch (err) {
      // The link died while asking, so we do not know whether it heard us. That
      // is a dropped link and gets a dropped link's answer: keep the host, keep
      // dialling. Saying "stopped" here would be a guess.
      delete entry.updating;
      releasePeers();
      void this.reconnect(entry, 'the link dropped while asking the host to restart');
      throw new AttachRefused(
        `could not ask the host for ${entry.workspaceRoot} to restart: ` +
          `${err instanceof Error ? err.message : String(err)}. It is still listed and ` +
          `reconnecting; nothing was stopped.`,
      );
    }

    if (!result.stopped) {
      delete entry.updating;
      releasePeers();
      throw new AttachRefused(
        `the host would not stop${result.reason === undefined ? '' : `: ${result.reason}`}. ` +
          `It keeps running the version it started with until it does.`,
      );
    }

    // It agreed, so it is going. From here the entry describes a process that
    // will not answer again — but the workspace, its identity and its sessions
    // are unchanged, which is why the entry stays.
    entry.unlisten();
    entry.connection.disconnect();
    entry.link = 'reconnecting';
    this.emit('host', snapshot(entry));
    this.emit('link', instanceId, 'reconnecting', 'restarting onto the shipped bundle');

    /*
     * The siblings go down with it, so they are told and dialled again.
     *
     * Marked `reconnecting` before the wait rather than after: they are already
     * unreachable at this point, and a card claiming `connected` about a process
     * that has agreed to exit is the one state the link badge exists to prevent.
     */
    for (const peer of peers) {
      peer.unlisten();
      peer.connection.disconnect();
      peer.link = 'reconnecting';
      this.emit('host', snapshot(peer));
      this.emit('link', peer.instanceId, 'reconnecting', 'the host for this machine is restarting');
    }

    const failure = await this.redial(entry, {
      reason: 'restarted onto the shipped bundle',
      deadline: Date.now() + (this.deps.updateWindowMs ?? UPDATE_WINDOW_MS),
    });
    delete entry.updating;

    /*
     * Redialled after the one that was asked for, not in parallel with it.
     *
     * The replacement host opens the folder it is started with; a sibling's
     * folder is reopened by the sibling's own connection saying so in `hello`
     * (§8). Doing that before the host exists would just be a failed dial with a
     * backoff behind it. No deadline on these: the person pressed a button about
     * *one* workspace, and the others coming back is the ordinary reconnect the
     * fleet never gives up on.
     */
    for (const peer of peers) {
      delete peer.updating;
      if (this.entries.has(peer.instanceId)) {
        void this.redial(peer, { reason: 'the host for this machine restarted' });
      }
    }

    if (failure === null) return snapshot(entry);

    // Still listed, still being dialled — but the person who pressed the button
    // is told plainly that the machine is between hosts and why, rather than
    // watching a spinner that means nothing to them.
    if (this.entries.has(instanceId)) {
      void this.redial(entry, { reason: 'restarted onto the shipped bundle' });
    }
    throw new AttachRefused(
      `stopped this host to update it, and the replacement did not come up: ${failure}. ` +
        `The sessions are safe in their log on ${entry.workspaceRoot}; the host stays listed ` +
        `and will attach itself as soon as one answers there.`,
    );
  }

  /**
   * Make a machine able to run an agent, then make the host notice (§6.4, §3.8).
   *
   * ## Every route ends the same way, and that is the design
   *
   * A host builds its runtime list, its endpoint list and its `runtimeNotes`
   * **once, at startup** — `buildHostRegistry` runs `detectCli` in the forked
   * agent host and `loadEndpoints` reads the file exactly once. So installing a
   * CLI, starting an Ollama or writing an endpoint changes the machine and
   * changes nothing the app can see. Re-detecting means restarting the host,
   * which is `updateHost` and which already works: the entry stays, the link
   * goes to `reconnecting`, `redial` brings the replacement in under the same
   * identity, and the `seen` high-water marks survive so the transcript replays
   * across the restart with no loss and no duplicates.
   *
   * Making the host re-read those lists live was the alternative and is worse in
   * a specific way: `loadEndpoints` lives in the *agent host*, and re-reading it
   * mid-turn would let a request change where it is being sent between the
   * decision and the call. A restart is a bounded, visible cost that §5.4 has
   * already made safe.
   *
   * ## Half-success is an outcome, never an exception
   *
   * The two halves fail independently and for unrelated reasons — an install
   * fails because of a network or a disk, a restart fails because somebody is
   * mid-turn on that host and it is entitled to refuse. Collapsing them into one
   * thrown error would produce the worst sentence available: "installing Claude
   * Code failed" about a machine that now has Claude Code on it. So the return
   * value says which half happened, and only a *refused route* or a *failed
   * install* throws.
   */
  async setUpHost(
    instanceId: InstanceId,
    plan: SetupPlan,
    onProgress?: (step: string) => void,
  ): Promise<SetupOutcome> {
    const entry = this.require(instanceId);
    const steps: string[] = [];
    const report = (step: string): void => {
      steps.push(step);
      onProgress?.(step);
    };

    /*
     * A read-only client may not change the machine, and this is the *only*
     * place two of these three routes can be stopped.
     *
     * `endpoints.add` is gated by the host, which is where §7 says enforcement
     * belongs — a client cannot be trusted to police itself. But installing a
     * CLI or an Ollama never reaches the host at all: it goes over the
     * transport, from this process, so the host's gate is not on that path and
     * an unchecked route would let a browser pinned to `read-only` by a
     * workspace's access policy put a gigabyte of software on somebody's build
     * box. The role granted at handshake is the honest thing to check, because
     * it is the host's own answer about this client rather than this client's
     * opinion of itself.
     */
    if (entry.role === 'read-only') {
      throw new RouteRefused(
        `this client has read-only access to ${entry.workspaceRoot}, so it cannot change that ` +
          `machine. Whoever owns that workspace can do it from a client with write access.`,
      );
    }

    /*
     * The transport is asked, not assumed (§6.2).
     *
     * An Ollama is a daemon that has to outlive the connection that started it,
     * which is exactly what `persistentProcesses` describes — and the refusal
     * names the capability rather than the kind, so a future transport that
     * lacks it gets a true sentence without anybody editing this.
     */
    const transport = requireTransport(entry.target);
    if (plan.kind === 'ollama' && !transport.capabilities.persistentProcesses) {
      throw new RouteRefused(
        `${transport.label} cannot hold a process open after the connection closes, and an ` +
          `Ollama server has to keep running. Add an API endpoint instead, or install Ollama ` +
          `on a machine that can.`,
      );
    }

    const where = entry.target.kind === 'ssh' ? (entry.target.alias ?? entry.target.host) : 'this machine';
    let summary: string;
    let followUp: string | undefined;

    if (plan.kind === 'endpoint') {
      /*
       * The one route that never touches the transport.
       *
       * It goes over the session channel because that is the only path a
       * credential may take: an `ssh` command line is readable in `ps` by every
       * account on that machine. See `SESSION_PROTOCOL_VERSION`'s v20 note.
       *
       * Nothing here logs, copies or reports `plan.endpoint` — `describePlan`
       * is the only thing allowed to describe it, and it omits the key by
       * construction rather than by remembering to.
       */
      report(`writing the endpoint on ${where}`);
      const written = await entry.connection.addEndpoint(plan.endpoint);
      summary =
        `Added "${written.endpointId}" to ${written.path} on ${where}` +
        `${written.authenticated ? ', with the key kept on that machine' : ''}.`;
      if (written.authenticated) {
        // §6.5's table, said at the moment the choice is made rather than in a
        // document: this is the *remote-resident credential* row, and its whole
        // point — and its whole cost — is that the run continues with the lid
        // shut because the key is over there.
        followUp =
          `That key now lives on ${where} and not on this computer, which is what lets a ` +
          `detached run keep going while this app is closed — and means anyone with an ` +
          `account on ${where} that can read your home directory can use it.`;
      }
    } else {
      const provision = this.deps.provision;
      if (provision === undefined) {
        throw new RouteRefused(
          'this client cannot install software on a machine — it was built without a ' +
            'provisioner. Attach the workspace from the desktop app to do it.',
        );
      }
      await provision(entry.location, plan, report);

      if (plan.kind === 'cli') {
        summary = `${CLI_PACKAGES[plan.cli].label} is installed on ${where}.`;
        followUp = authFollowUp(plan.cli, where);
      } else {
        summary = `Ollama is serving on ${where}.`;
        /*
         * The daemon is not the job — an endpoint pointed at it is.
         *
         * A host with no `endpoints.json` already falls back to
         * `http://127.0.0.1:11434/v1`, so on most machines this is correctly a
         * no-op and writing one anyway would be a change to somebody's machine
         * for nothing. A host *with* a file and no local entry is the case that
         * needs it, and is the case where stopping at "the daemon is up" would
         * leave a server nobody is pointed at — which is the failure this
         * branch exists to prevent.
         */
        if (!entry.endpoints.some((e) => sameOrigin(e.baseUrl, OLLAMA_BASE_URL))) {
          report(`pointing ${where} at it`);
          const written = await entry.connection.addEndpoint({
            id: 'ollama',
            label: 'Ollama (that machine)',
            provider: 'local',
            baseUrl: OLLAMA_BASE_URL,
          });
          summary += ` Added "${written.endpointId}" so this host can reach it.`;
        }
      }
    }

    report('restarting the host so it picks up what changed');
    try {
      await this.updateHost(instanceId);
      return { installed: true, redetected: true, summary, steps, ...(followUp !== undefined ? { followUp } : {}) };
    } catch (err) {
      // Named as the half it is. `updateHost` keeps the host listed and keeps
      // dialling, so this is "not yet" rather than "gone" — and the thing that
      // was installed is still installed.
      return {
        installed: true,
        redetected: false,
        summary,
        steps,
        ...(followUp !== undefined ? { followUp } : {}),
        detail: `${summary} The host did not restart, so it has not noticed yet: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
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
    // Terminals on that host are gone with the process — announced rather than
    // dropped quietly, because a pane that simply stops receiving looks like a
    // hung shell, and "the host stopped" is something a person can act on.
    for (const [shellId, owner] of [...this.shellHosts]) {
      if (owner !== instanceId) continue;
      this.shellHosts.delete(shellId);
      this.emit('shell-exit', shellId, -1, undefined);
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

  // ---------------------------------------------------------------- terminals

  /**
   * Open the **user's own** terminal on a host's machine.
   *
   * Not an agent seat: it emits no events, is not queued behind a turn, and the
   * session's durable record is unchanged by anything typed into it. It is here
   * on `Fleet` rather than beside `send` because the only thing the fleet does
   * for it is route — which is the same job it does for a preview server.
   *
   * ## Refused by name on a remote host, and why that is a deployment fact
   *
   * A remote host is *two bundled `.js` files* copied to `~/.agbrte` by
   * `uploadHostBundle`, with no `node_modules` beside them — so the PTY binary
   * simply is not on that machine, and the honest failure is a sentence rather
   * than a `MODULE_NOT_FOUND` from four processes away. The **protocol** is
   * already locality-blind (`shell.*` carries a `shellId`, bytes and a size, and
   * nothing else), so lifting this means shipping the module with the bundle,
   * not redesigning anything.
   *
   * Refused here rather than left to the host for the same reason `attach`
   * refuses an unimplemented locality before dialling: a refusal that names the
   * machine is one somebody can act on, and this is the layer that knows which
   * machine it is.
   */
  async openShell(
    instanceId: InstanceId,
    sessionId: SessionId,
    opts?: { program?: ShellProgram; cols?: number; rows?: number },
  ): Promise<ShellHandle> {
    const entry = this.host(instanceId);
    if (entry.target.kind !== 'local') {
      throw new Error(
        `a terminal on ${describeTarget(entry.target)} is not available yet — the host bundle deployed ` +
          'to a remote machine has no PTY module beside it. Open a terminal on this machine, ' +
          `or reach ${describeTarget(entry.target)} with your own ssh.`,
      );
    }
    if (!entry.connection.supports('shell.open')) {
      throw new Error(
        `the host for ${entry.workspaceRoot} is older than this app and cannot open a terminal — ` +
          'restart it to pick up the current bundle',
      );
    }

    /*
     * The program selector is passed straight through, and this layer does not
     * check it.
     *
     * Deliberate: the fleet knows which *machine* a session is on and nothing at
     * all about which CLIs are installed there. A check here would need a
     * cached copy of the host's detection, and a cached copy is exactly how the
     * picker and the admission gate came to disagree once already. The host owns
     * the answer because the host is where the binaries are.
     */
    const handle = await entry.connection.openShell(sessionId, opts);
    this.shellHosts.set(handle.shellId, instanceId);
    return handle;
  }

  // ------------------------------------------------------------ workspace files

  /**
   * One directory of a host's workspace (§6.6, §7).
   *
   * Routing and a version check, and nothing else — the same job this class does
   * for a preview server. **No caching of the tree here**, deliberately: a
   * workspace is being edited by an agent while somebody looks at it, so a
   * cached listing is a listing that is wrong exactly when the session is
   * working. Each expand is a round trip, which is the cost the click is buying.
   *
   * Unlike `previewServers`, a failure is **not** swallowed into an empty list.
   * A person clicked a folder; an empty answer would read as "this folder is
   * empty" and send them looking for a bug in the wrong place. The refusal — a
   * path that escaped, a host too old, a link that died — carries a sentence and
   * the sidebar shows it.
   *
   * Refused by name for a host too old, rather than by `CommandUnavailable`'s
   * generic wording, because the machine is the actionable part: `openShell`
   * makes the same trade one method up, and for the same reason.
   */
  async listFiles(instanceId: InstanceId, path: string, limit?: number): Promise<DirListing> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('files.list')) {
      throw new Error(
        `the host for ${entry.workspaceRoot} is older than this app and cannot list files — ` +
          'restart it to pick up the current bundle',
      );
    }
    return entry.connection.listFiles(path, limit);
  }

  /**
   * One file's text from a host's workspace.
   *
   * Bounded on the *host* rather than here: this layer knows which machine, not
   * how big the file is, and a cap enforced on the near side would be a cap a
   * different client could skip. See `workspace/files.ts`.
   */
  async readFile(instanceId: InstanceId, path: string): Promise<FilePreview> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('files.read')) {
      throw new Error(
        `the host for ${entry.workspaceRoot} is older than this app and cannot read files — ` +
          'restart it to pick up the current bundle',
      );
    }
    return entry.connection.readFile(path);
  }

  /** Keystrokes, routed by `shellId` alone. */
  async writeShell(shellId: string, data: string): Promise<boolean> {
    const entry = this.shellHost(shellId);
    if (entry === null) return false;
    return entry.connection.writeShell(shellId, data);
  }

  async resizeShell(shellId: string, cols: number, rows: number): Promise<boolean> {
    const entry = this.shellHost(shellId);
    if (entry === null) return false;
    return entry.connection.resizeShell(shellId, cols, rows);
  }

  async closeShell(shellId: string): Promise<boolean> {
    const entry = this.shellHost(shellId);
    this.shellHosts.delete(shellId);
    if (entry === null) return false;
    return entry.connection.closeShell(shellId);
  }

  /**
   * The host running one terminal, or `null` if it has gone.
   *
   * `null` rather than a throw: every caller is reacting to something a person
   * did in a pane — a keystroke, a window resize, a close — and a terminal that
   * ended a moment earlier is an ordinary race, not an error worth a banner.
   */
  private shellHost(shellId: string): Entry | null {
    const instanceId = this.shellHosts.get(shellId);
    if (instanceId === undefined) return null;
    return this.entries.get(instanceId) ?? null;
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
  /**
   * Ask a host what models it can reach, now.
   *
   * Errors are not swallowed here, unlike `templates()`. That one answers "what
   * can I show in a list" and an empty sidebar is a fine degradation; this one
   * is asked because somebody pressed refresh, and telling them "no models"
   * when the truth is "the endpoint refused" would send them to fix the wrong
   * thing.
   */
  async models(instanceId: InstanceId): Promise<EndpointModels[]> {
    return this.host(instanceId).connection.models();
  }

  /**
   * What one model can actually do, before somebody picks it (§3.3).
   *
   * `null` for a host too old to answer — three-valued, like `outdated`, and for
   * the same reason. The two answers a client must never confuse are "asked, and
   * this model cannot call tools" and "nobody could ask", and an older host must
   * degrade to the second rather than to the first. The remedy differs too: one
   * is choose a different model, the other is update the host.
   */
  async modelCapabilities(
    instanceId: InstanceId,
    endpointId: string,
    modelId: string,
  ): Promise<ModelCapabilityHint | null> {
    const entry = this.host(instanceId);
    if (!entry.connection.supports('models.capabilities')) return null;
    return entry.connection.modelCapabilities(endpointId, modelId);
  }

  async installModel(instanceId: InstanceId, endpointId: string, tag: string): Promise<void> {
    await this.host(instanceId).connection.installModel(endpointId, tag);
  }

  async installProgress(instanceId: InstanceId): Promise<ModelInstallProgress[]> {
    return this.host(instanceId).connection.installProgress();
  }

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
    return bubbleAcrossHosts(perHost.flat()).sort(byAttentionThenRecency);
  }

  /** Answer a split proposal on whichever host owns the session (§4.3). */
  async respondSplit(
    sessionId: SessionId,
    proposalId: string,
    /** `instanceId` picks the machine; absent means the parent's own (§17 Q5). */
    decision: { approved: boolean; reason?: string; instanceId?: string },
  ): Promise<Session | null> {
    const parent = this.ownerOf(sessionId);
    const elsewhere = decision.approved ? this.hostFor(decision.instanceId, parent) : null;
    // The ordinary case, and the one every existing test drives: the child
    // belongs where its parent already is, so the parent's host does all three
    // steps itself and nothing crosses a boundary.
    if (elsewhere === null) {
      return parent.connection.respondSplit(sessionId, proposalId, decision);
    }

    /*
     * Three steps on two machines (§17 Q5).
     *
     * Safe without a two-phase commit because of the order the local path
     * already had: preparing changes nothing, so a creation that fails on the
     * far host leaves no debit on the near one. The parent's proposal *is*
     * settled by step one either way — that is the parent's own history, and it
     * was answered whatever becomes of the child.
     */
    const prepared = await parent.connection.prepareSplit(sessionId, proposalId, decision);
    if (prepared === null) return null;

    const child = await elsewhere.connection.createSession(prepared.create);
    this.owners.set(child.sessionId, elsewhere.instanceId);
    await parent.connection.recordChild(
      sessionId,
      child,
      prepared.parentBudget,
      prepared.contract,
    );
    return child;
  }

  /**
   * Put sessions in a group, refusing to pretend one can span two machines
   * (§17 Q22).
   *
   * This is the layer that can tell, and the only one. A `SessionManager` knows
   * one workspace, so all it can say is "I do not have that session" — true, and
   * useless to somebody looking at two hosts in a sidebar. The fleet knows both
   * machines by the names the user gave them, so it names them.
   *
   * **Refused rather than split into two groups**, or quietly grouped on the
   * first host, or grouped everywhere and silently undeliverable. That is
   * `applyTemplate`'s reasoning verbatim — the alias may not be the machine they
   * meant, so naming it is the useful act and choosing for them is not — and
   * §16's oldest recorded failure is a target that was recorded and not
   * enforced. A group whose members cannot reach each other is exactly that
   * failure with a new field.
   *
   * Cross-host groups are the named open question in §17 Q22: the delivery would
   * have to cross a host boundary, and unlike `bubbleAcrossHosts` — which
   * derives a *view* the fleet can recompute — it would write into another
   * machine's durable log, which cannot be taken back if the far host is
   * unreachable halfway through.
   *
   * **The constraint is one host, and it was being described as one folder.**
   * The check keyed on `instanceId` and the sentence said "machines", so two
   * folders on one build box — two checkouts, one computer — were refused with
   * a claim that was simply false, and a person with a session in each was told
   * to do something about machines that were not involved. What actually has to
   * be true is that both sessions are held by the same *host process*, because
   * delivery is a lookup in one manager's `sessions` map; a host serving several
   * workspaces satisfies that across folders, and this refusal stops firing for
   * them without anything here being special-cased (§8). `machineId` is what
   * makes the two remaining refusals separable, and they are genuinely different
   * problems: another machine is §17 Q22 and unbuilt, while another host on
   * *this* machine is something the user can fix by opening both folders on one
   * host.
   */
  async group(sessionIds: SessionId[], name: string, groupId?: string): Promise<Session[]> {
    if (sessionIds.length === 0) throw new AttachRefused('name at least one session to group');

    const owners = new Map<InstanceId, Entry>();
    for (const sessionId of sessionIds) {
      const owner = this.ownerOf(sessionId);
      owners.set(owner.instanceId, owner);
    }

    if (owners.size > 1) {
      const entries = [...owners.values()];
      const where = entries.map(labelOf).sort();
      /*
       * Grouped by machine, and an unreported `machineId` counts as its own.
       *
       * A host too old to say which machine it is on must not be folded in with
       * one that did: the honest reading of absence is *cannot tell* (§6.7), and
       * assuming "same machine" would produce the more confident of the two
       * refusals about a fact nobody established. Keyed on the entry's own
       * `instanceId` in that case, which is what this check used before and is
       * exactly as strong as it ever was.
       */
      const machines = new Set(entries.map((e) => e.machineId ?? `instance:${e.instanceId}`));
      if (machines.size > 1) {
        throw new AttachRefused(
          `those sessions are on ${machines.size} machines (${where.join(', ')}), and sessions ` +
            'in a group message each other, which does not cross machines yet. Group the ones ' +
            'on each machine separately.',
        );
      }
      throw new AttachRefused(
        `those sessions are in ${owners.size} workspaces on one machine (${where.join(', ')}), ` +
          'served by separate hosts — a group is delivered inside one host, so both folders ' +
          'have to be open on the same one.',
      );
    }

    const [entry] = [...owners.values()];
    if (entry === undefined) throw new AttachRefused('no attached host owns those sessions');
    if (!entry.connection.supports('session.group')) {
      throw new AttachRefused(
        `the host for ${labelOf(entry)} is too old to group sessions. Update it and try again.`,
      );
    }
    return entry.connection.groupSessions(sessionIds, name, groupId);
  }

  /** Take one session out of its group. Routed to whoever owns it. */
  async ungroup(sessionId: SessionId): Promise<Session> {
    const entry = this.ownerOf(sessionId);
    if (!entry.connection.supports('session.ungroup')) {
      throw new AttachRefused(
        `the host for ${labelOf(entry)} is too old to change a session's group.`,
      );
    }
    return entry.connection.ungroupSession(sessionId);
  }

  async listOnDisk(): Promise<
    Array<{
      instanceId: InstanceId;
      sessionId: string;
      title: string;
      goal: string;
      group?: { groupId: string; name: string };
    }>
  > {
    const perHost = await Promise.all(
      [...this.entries.values()].map(async (entry) =>
        (await entry.connection.listOnDisk()).map((s) => ({
          // The host's answer wins where it gives one: a host serving several
          // workspaces knows which of them a row came from, and the entry's own
          // id is only right for a host that has exactly one.
          ...s,
          instanceId: (s.instanceId as InstanceId | undefined) ?? entry.instanceId,
        })),
      ),
    );
    return perHost.flat();
  }

  hostOf(sessionId: SessionId): AttachedHost | null {
    const owner = this.owners.get(sessionId);
    const entry = owner === undefined ? undefined : this.entries.get(owner);
    return entry ? snapshot(entry) : null;
  }

  async createSession(instanceId: InstanceId, input: CreateSessionInput): Promise<Session> {
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

  /**
   * Do something to a session on its host, loading it there first if need be.
   *
   * **A host's memory is not the truth about which sessions exist** — the log
   * is (§5.4). A host loads a session on demand and a *replacement* host starts
   * with none loaded at all, so every id a client is holding across a restart
   * points at something real that the process now serving it has never read.
   * The old code sent those straight through, and what came back was
   * `unknown session <uuid>` — raised, correctly, by a host that had been alive
   * for two hundred milliseconds, and shown to a person who had pressed
   * *Update* and nothing else.
   *
   * So an unloaded session is not an error here, it is a load. `session.resume`
   * is a **read** on the host — it opens no handle and contacts no runtime until
   * a turn is sent — which is what makes doing it inside a `get` defensible
   * rather than a side effect smuggled into a query. It is also exactly what the
   * person clicking *Resume* in the sidebar asks for, so the two paths cannot
   * disagree about what opening a session means.
   *
   * Deliberately **not** used by `catchUp`. That runs on every reconnect, over
   * every session this app has ever seen an event for, and resuming them all
   * because a laptop woke up would load a hundred logs to answer a question
   * nobody asked. Catch-up talks to the connection directly and lets an
   * unloaded session keep its high-water mark for the next time.
   *
   * One retry, not a loop: if a resume did not make the session findable, the
   * second failure is a different problem and repeating would only delay it.
   */
  private async onSession<T>(
    sessionId: SessionId,
    call: (connection: HostConnection) => Promise<T>,
  ): Promise<T> {
    const entry = this.ownerOf(sessionId);
    try {
      return await call(entry.connection);
    } catch (err) {
      if (!isUnknownSession(err, sessionId)) throw err;
      try {
        await entry.connection.resumeSession(sessionId);
      } catch {
        // Nothing on disk under that id, an unreadable store, or a host that
        // will not serve it. The original error is the true one; this one would
        // describe the recovery rather than the problem.
        throw err;
      }
      return await call(entry.connection);
    }
  }

  // Every one of these is `async` on purpose. `ownerOf` throws for an unknown
  // session, and a synchronous throw out of a promise-returning method means
  // `fleet.get(id).catch(...)` never runs — the caller gets an exception where
  // it was handling a rejection. Same wart as the old role guard, same fix.

  async get(sessionId: SessionId): Promise<Session> {
    return this.onSession(sessionId, (c) => c.get(sessionId));
  }

  async addAgent(sessionId: SessionId, input: unknown): Promise<AgentRecord> {
    return this.onSession(sessionId, (c) => c.addAgent(sessionId, input));
  }

  async send(
    sessionId: SessionId,
    agentId: AgentId,
    text: string,
    blocks?: ContentBlock[],
  ): Promise<void> {
    return this.onSession(sessionId, (c) => c.send(sessionId, agentId, text, blocks));
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
    return this.onSession(sessionId, (c) => c.putBlob(sessionId, data, mime));
  }

  async interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    return this.onSession(sessionId, (c) => c.interrupt(sessionId, agentId));
  }

  async setReasoning(
    sessionId: SessionId,
    agentId: AgentId,
    reasoning: ReasoningRequest,
  ): Promise<void> {
    return this.onSession(sessionId, (c) => c.setReasoning(sessionId, agentId, reasoning));
  }

  async blob(sessionId: SessionId, sha256: Sha256, mime?: string): Promise<Buffer | null> {
    return this.onSession(sessionId, (c) => c.getBlob(sessionId, sha256, mime));
  }

  /**
   * The host an approved child should run on, or `null` for the parent's own.
   *
   * Chosen by whoever approves, not named by the agent that proposed. §4.3 keeps
   * splits user-approved because a decomposition mistake is expensive, and the
   * same person is the one who knows which machine should do the work — an
   * agent naming a host would be picking from a fleet it cannot see.
   *
   * An unknown instance is refused rather than quietly run here. Falling back to
   * local is the old bug in a new hat: the record would say one machine and the
   * work would happen on another.
   */
  private hostFor(instanceId: string | undefined, parent: Entry): Entry | null {
    if (instanceId === undefined || instanceId === parent.instanceId) return null;
    const host = this.entries.get(instanceId as InstanceId);
    if (host === undefined) {
      throw new SplitRefused(
        `this split asks for a child on host ${instanceId}, which is not attached; ` +
          'attach that machine first, or approve the child where the parent runs',
      );
    }
    return host;
  }

  async events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
    return this.onSession(sessionId, (c) => c.events(sessionId, fromSeq));
  }

  async projection(sessionId: SessionId): Promise<SessionProjection> {
    return this.onSession(sessionId, (c) => c.projection(sessionId));
  }

  async queueDepth(sessionId: SessionId): Promise<number> {
    return this.onSession(sessionId, (c) => c.queueDepth(sessionId));
  }

  /**
   * The raw CLI tail behind one agent (§3.12).
   *
   * `null` for a host too old to answer, like `preview.log` and for the same
   * reason: the terminal pane polls this every second, and an older host's
   * honest answer — "I cannot tell you" — has to read as nothing-to-show, not
   * as an error banner arriving once a second.
   */
  async rawLog(sessionId: SessionId, agentId: AgentId): Promise<RawTail | null> {
    if (!this.ownerOf(sessionId).connection.supports('agent.rawLog')) return null;
    return this.onSession(sessionId, (c) => c.rawLog(sessionId, agentId));
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
 * Is this the host saying "I have not loaded that one"?
 *
 * By name first, which is what `UnknownSession` exists for, and by the sentence
 * as well — because the host on the other end may predate that class, and a
 * client meeting an older host is not an edge case here: it is what an update
 * *is*, and what a fleet holding one updated machine and three that are not
 * looks like every day.
 *
 * Compared against this session's own id rather than a prefix, so a message
 * about some other session can never be read as an answer about this one.
 */
function isUnknownSession(err: unknown, sessionId: SessionId): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'UnknownSession' || err.message === `unknown session ${sessionId}`;
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

/**
 * Whether two endpoint URLs reach the same server.
 *
 * Compared by origin rather than by string, because `http://127.0.0.1:11434/v1`
 * and `http://127.0.0.1:11434/v1/` and `http://localhost:11434/v1` are one
 * server and three strings — and the consequence of getting it wrong is a second
 * endpoint added beside a working one, which shows up in the picker as two
 * identical rows nobody can choose between. An unparseable URL is *not* the same
 * as anything, which is the safe direction: the worst case is one redundant
 * entry, and the other error would leave a daemon with nothing pointed at it.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    // `localhost` and `127.0.0.1` are the same machine and different hostnames.
    const host = (u: URL): string => (u.hostname === 'localhost' ? '127.0.0.1' : u.hostname);
    return left.protocol === right.protocol && host(left) === host(right) && left.port === right.port;
  } catch {
    return false;
  }
}

function snapshot(entry: Entry): AttachedHost {
  return {
    // Copied, for the reason `bundleVersion` documents below: this function is
    // the only way an entry ever leaves the fleet, so a field written onto the
    // entry and not listed here is a field that no reader has ever seen.
    ...(entry.machineId !== undefined ? { machineId: entry.machineId } : {}),
    instanceId: entry.instanceId,
    lineageId: entry.lineageId,
    workspaceRoot: entry.workspaceRoot,
    target: entry.target,
    available: [...entry.available],
    endpoints: entry.endpoints.map((e) => ({ ...e })),
    runtimeNotes: entry.runtimeNotes.map((n) => ({ ...n })),
    /*
     * Copied, which it was not.
     *
     * `attach` read `bundleVersion` off the handshake and wrote it onto the
     * entry, and this function — the only way an entry ever leaves the fleet —
     * silently dropped it. So `AttachedHost.bundleVersion` was `undefined` at
     * every reader, `isOutdated()` in the IPC layer took that as *cannot be
     * determined* exactly as its comment says it should, and §6.3's "this host
     * is running older code than the app ships" badge could never appear.
     *
     * Nothing failed. The three-valued design degraded correctly all the way to
     * the window, on evidence that had been thrown away one line earlier —
     * which is why a field that was carried across two processes, documented in
     * three places and never once delivered raised no alarm. Found by a test
     * asserting a *replaced* host's version follows, i.e. by asking the
     * question this field exists to answer.
     */
    ...(entry.bundleVersion !== undefined ? { bundleVersion: entry.bundleVersion } : {}),
    ...(entry.movedFrom !== undefined ? { movedFrom: entry.movedFrom } : {}),
    role: entry.role,
    pid: entry.pid,
    link: entry.link,
    ...(entry.unavailableReason !== undefined
      ? { unavailableReason: entry.unavailableReason }
      : {}),
  };
}
