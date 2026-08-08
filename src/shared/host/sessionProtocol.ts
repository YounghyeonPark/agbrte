/**
 * The app ↔ host session protocol (DESIGN.md §6.4, §8).
 *
 * A second protocol, deliberately. `protocol.ts` is the *agent* layer — one
 * `AgentRuntime` reached across a boundary — and it stays exactly what it was.
 * This is the *session* layer: the app asking a host that owns sessions to do
 * things with them.
 *
 * They are separate because the boundaries are separate. §8's table has three
 * processes for one workspace, not two:
 *
 *   app                  clients: render, command; owns no session state
 *   host                 sessions, the event log, the permission gate
 *   agent host (forked)  agent loops, tools
 *
 * ## Why the host owns the log
 *
 * "The session keeps running when the app closes" is not achievable by detaching
 * a process alone. If the app still owned the log, a running agent's events would
 * have nowhere to go the moment the app quit — the work would continue and the
 * transcript would not, which is worse than stopping. §8's table already assigns
 * "log writes" to the host for exactly this reason.
 *
 * ## Roles are granted, not claimed
 *
 * A client asks for `read-write` at handshake and the host decides. Enforcement
 * lives with the owner because a read-only client that can still send is not
 * read-only, and a client cannot be trusted to police itself.
 */

import type {
  AccessRole,
  AgentRecord,
  InstanceId,
  LineageId,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  PermissionResolved,
  Session,
  SessionProjection,
} from '../types/index.js';
import type { HostChannel } from './protocol.js';

export type RequestId = string;

/** What a host reports about itself once a client connects. */
export interface HostIdentity {
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  /** Runtime ids the forked agent host actually registered. */
  runtimes: string[];
  /**
   * Models this host can reach, with no credentials attached.
   *
   * One host can reach several — a local server and a hosted API, two GPUs with
   * different weights — so a client offers a choice rather than assuming one.
   * `provider` travels with them because §13 requires that adding a provider
   * never quietly change where source code is transmitted, and a client that
   * cannot name the recipient cannot show it.
   */
  endpoints?: Array<{
    id: string;
    label: string;
    provider: string;
    baseUrl: string;
    authenticated: boolean;
  }>;
  /** Set when the agent host could not start. Sessions still load read-only. */
  unavailableReason?: string;
  /**
   * Where this workspace was before it moved (§5.3).
   *
   * Carried to clients because it explains a behaviour change they would
   * otherwise see without a cause: agents that resumed natively yesterday
   * rehydrate today. A move leaves no other trace — identity is deliberately not
   * derived from a path — so if the host does not say so, nothing can.
   */
  movedFrom?: string;
  /** The host's own pid, so a client can report which process it is talking to. */
  pid: number;
  /** Protocol version, so a stale app fails loudly rather than subtly. */
  protocol: number;
}

/**
 * Bumped whenever a command's shape changes.
 *
 * A detached host outlives the app that spawned it, so a *newer* app can meet an
 * *older* host — the one direction a single-process design never has to consider.
 * A version mismatch is refused at handshake rather than discovered halfway
 * through a command whose fields moved.
 */
export const SESSION_PROTOCOL_VERSION = 1;

// ------------------------------------------------------------------ app → host

export type SessionCommand =
  /** Always first. Carries the role the client wants. */
  | { t: 'hello'; id: RequestId; role: AccessRole; client: string }
  | { t: 'session.list'; id: RequestId }
  | { t: 'session.listOnDisk'; id: RequestId }
  | { t: 'session.get'; id: RequestId; sessionId: string }
  | { t: 'session.create'; id: RequestId; title: string; goal: string }
  | { t: 'session.resume'; id: RequestId; sessionId: string }
  | { t: 'session.addAgent'; id: RequestId; sessionId: string; input: unknown }
  | { t: 'session.send'; id: RequestId; sessionId: string; agentId: string; text: string }
  | { t: 'session.interrupt'; id: RequestId; sessionId: string; agentId?: string }
  | { t: 'session.events'; id: RequestId; sessionId: string; fromSeq: number }
  | { t: 'session.projection'; id: RequestId; sessionId: string }
  | { t: 'session.queueDepth'; id: RequestId; sessionId: string }
  /**
   * What one runtime declares it can do, on this host.
   *
   * Asked without a session, because §3.13's matrix is consulted *before*
   * choosing a runtime — and capabilities belong to adapter + model + installed
   * version, so only the machine that has the adapter can answer (§3.2).
   */
  | { t: 'runtime.capabilities'; id: RequestId; runtimeId: string }
  /**
   * The durable record of what happened here (§11).
   *
   * Per host, because it is folded from that host's logs — and a detached host
   * is exactly where the events nobody was told about accumulate.
   */
  | { t: 'inbox.list'; id: RequestId; limit?: number }
  | { t: 'inbox.markRead'; id: RequestId }
  | { t: 'permission.pending'; id: RequestId }
  | { t: 'permission.respond'; id: RequestId; requestId: string; decision: PermissionDecision }
  /**
   * Ask the host to exit once nothing is running.
   *
   * Not a kill: a detached host holding a live agent must not be taken down
   * because a window closed. The host decides, and refuses while work is in
   * flight — which is the entire point of it being detached.
   */
  | { t: 'shutdown'; id: RequestId };

// ------------------------------------------------------------------ host → app

export type SessionMessage =
  | { t: 'ok'; id: RequestId; value?: unknown }
  | { t: 'err'; id: RequestId; message: string; name?: string }
  /** Reply to `hello`, and the only place a role is granted. */
  | { t: 'welcome'; id: RequestId; identity: HostIdentity; role: AccessRole }
  // pushes
  | { t: 'push.event'; sessionId: string; event: AgbrteEvent }
  | { t: 'push.session'; session: Session }
  | { t: 'push.permission'; request: PermissionRequest }
  /**
   * A prompt that is no longer open.
   *
   * The other half of `push.permission`. A request reaches every attached
   * client, so an answer has to as well — without this the device that did not
   * answer keeps showing a settled question and only learns otherwise by
   * pressing a button and being told it was too late.
   */
  | { t: 'push.permissionResolved'; resolved: PermissionResolved }
  | { t: 'push.queue'; sessionId: string; agentId: string; depth: number }
  /** The host is going away on purpose, so a client can say so rather than guess. */
  | { t: 'push.closing'; reason: string };

export type AppSideSessionChannel = HostChannel<SessionCommand, SessionMessage>;
export type HostSideSessionChannel = HostChannel<SessionMessage, SessionCommand>;

// --------------------------------------------------------------------- results

/** `session.addAgent` reply. */
export type AddAgentResult = AgentRecord;

/** `session.events` reply. */
export type EventsResult = AgbrteEvent[];

/** `session.projection` reply. */
export type ProjectionResult = SessionProjection;

export interface OnDiskSession {
  sessionId: string;
  title: string;
  goal: string;
}
