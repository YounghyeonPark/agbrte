/**
 * The IPC contract (DESIGN.md §7).
 *
 * One file, imported by all three processes, so main's handlers and the
 * renderer's calls cannot drift: if a handler's shape changes, the renderer
 * stops typechecking.
 *
 * Channel strings live **here and nowhere else**. The renderer never sees
 * `ipcRenderer`, never names a channel, and cannot reach a channel that isn't
 * on `LoomApi` — §7's `contextIsolation: true`, `nodeIntegration: false`,
 * `sandbox: true` are only as good as the surface exposed through them.
 *
 * ## Scope
 *
 * This is a **subset** of §7's `LoomApi`, not the whole thing. `capture`,
 * `speech`, hierarchy, and model management are deliberately absent rather than
 * present and throwing: an API that exists and fails is worse than one that
 * isn't there, because the renderer cannot feature-detect against a method that
 * rejects at runtime.
 *
 * `hosts` is the first piece of §7's `targets` namespace to land. Everything here
 * is **host-scoped** rather than assuming one workspace: several hosts can be
 * attached at once, `sessions.list()` spans all of them, and every session and
 * every event batch carries the host it came from. §8's caps are per host and
 * §10's cards carry a target badge, so the aggregate view is the designed one —
 * the previous single-workspace shape was the limitation.
 */

import type {
  AgentRecord,
  AgentRole,
  LoomEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionProjection,
} from '../types/index.js';

// ------------------------------------------------------------------- payloads

/**
 * One attached host: a workspace, its agent host, and its sessions (§8, §10).
 *
 * `instanceId` is the key the renderer routes by, because §5.2 makes it the
 * identity of one checkout on one machine — which is exactly one host.
 */
export interface HostInfo {
  root: string;
  /** Tracked, follows a clone (§5.2). */
  lineageId: string;
  /** Gitignored, per checkout (§5.2). The fleet's primary key. */
  instanceId: string;
  /** `local`, `ssh`, … — §10's target badge comes from this. */
  targetKind: string;
  /** A short label for the badge: the host name, or the folder for local. */
  label: string;
  /** Runtime ids this host actually offers. Empty when it could not start. */
  available: string[];
  /** Why nothing can run here. Sessions still load and read. */
  unavailableReason?: string;
}

export interface RuntimeInfo {
  id: string;
  version: string;
  toolVersion?: string;
  /** Whether this runtime needs a `model`, i.e. whether it is LoomHarness. */
  requiresModel: boolean;
}

export interface CreateSessionRequest {
  /** Which attached host to create it on. */
  instanceId: string;
  title: string;
  goal: string;
}

export interface AddAgentRequest {
  sessionId: string;
  role: AgentRole;
  runtimeId: string;
  systemPrompt?: string;
  model?: { providerId: string; modelId: string; endpointId?: string };
  maxTurns?: number;
}

export interface SendRequest {
  sessionId: string;
  agentId: string;
  text: string;
}

/**
 * A batch of durable events, in `seq` order.
 *
 * §7 caps a batch at 50 ms or 64 events. `firstSeq`/`lastSeq` are carried
 * explicitly so the renderer can detect a gap rather than infer contiguity from
 * array length — a paused-and-resumed forwarder is allowed to skip, and the
 * renderer must be able to tell that it did and refetch.
 */
export interface EventBatch {
  /** The host that produced these. */
  instanceId: string;
  sessionId: string;
  events: LoomEvent[];
  firstSeq: number;
  lastSeq: number;
  /** True when main is withholding events because the renderer is behind. */
  paused: boolean;
}

/** Everything the renderer needs to draw one session without holding its log. */
export interface SessionSnapshot {
  session: Session;
  projection: SessionProjection;
  /** A bounded window of the tail, never the whole transcript (§7). */
  recent: LoomEvent[];
  /** `seq` the window starts at, so the renderer knows what it is missing. */
  windowFromSeq: number;
}

// ----------------------------------------------------------------- the surface

export interface LoomApi {
  hosts: {
    /** Every attached host. Several may be attached at once (§8). */
    list(): Promise<HostInfo[]>;
    /** Native folder picker, then attach. Null if the user cancels. */
    add(): Promise<HostInfo | null>;
    /** Stop watching a host. The workspace on disk is untouched. */
    remove(instanceId: string): Promise<void>;
    /** Runtimes offered by one host — they need not be the same everywhere. */
    runtimes(instanceId: string): Promise<RuntimeInfo[]>;
  };
  sessions: {
    list(): Promise<Session[]>;
    create(r: CreateSessionRequest): Promise<Session>;
    /** Sessions on disk across every attached host, not yet loaded. */
    listOnDisk(): Promise<
      Array<{ instanceId: string; sessionId: string; title: string; goal: string }>
    >;
    /** Load a session from its log — the restart path Phase 1 is judged on. */
    resume(instanceId: string, sessionId: string): Promise<Session>;
    snapshot(sessionId: string, windowSize?: number): Promise<SessionSnapshot>;
    addAgent(r: AddAgentRequest): Promise<AgentRecord>;
    /** Resolves when the turn completes, which may be minutes. */
    send(r: SendRequest): Promise<void>;
    interrupt(sessionId: string, agentId?: string): Promise<void>;
    /** Events since `fromSeq`, for filling a gap the renderer detected. */
    since(sessionId: string, fromSeq: number): Promise<LoomEvent[]>;
  };
  permissions: {
    pending(): Promise<PermissionRequest[]>;
    /**
     * Answer a request. First answer wins.
     *
     * The outcome matters to the UI: with several clients attached, two devices
     * can show the same prompt and both be clicked. `already-answered` means
     * someone else got there first — withdraw the prompt, do not show an error.
     * `unknown` means it is gone entirely, usually withdrawn because the agent
     * stopped.
     */
    respond(
      requestId: string,
      decision: PermissionDecision,
    ): Promise<'answered' | 'already-answered' | 'unknown'>;
  };
  /** Push channels. Each returns an unsubscribe function. */
  on: {
    events(cb: (b: EventBatch) => void): () => void;
    /** A session record changed — state, agents, usage. */
    session(cb: (s: Session) => void): () => void;
    permission(cb: (r: PermissionRequest) => void): () => void;
    /** A host was attached, detached, or changed availability. */
    hosts(cb: (hosts: HostInfo[]) => void): () => void;
  };
  /** Ack the highest `seq` rendered, so main can resume a paused forwarder. */
  ack(sessionId: string, seq: number): void;
}

// -------------------------------------------------------------------- channels

/**
 * Invoke channels. Values are namespaced strings so a stray listener in a
 * devtools console is at least legible in a log.
 */
export const CH = {
  hostsList: 'loom:hosts.list',
  hostsAdd: 'loom:hosts.add',
  hostsRemove: 'loom:hosts.remove',
  hostsRuntimes: 'loom:hosts.runtimes',
  sessionsList: 'loom:sessions.list',
  sessionsCreate: 'loom:sessions.create',
  sessionsListOnDisk: 'loom:sessions.listOnDisk',
  sessionsResume: 'loom:sessions.resume',
  sessionsSnapshot: 'loom:sessions.snapshot',
  sessionsAddAgent: 'loom:sessions.addAgent',
  sessionsSend: 'loom:sessions.send',
  sessionsInterrupt: 'loom:sessions.interrupt',
  sessionsSince: 'loom:sessions.since',
  permissionsPending: 'loom:permissions.pending',
  permissionsRespond: 'loom:permissions.respond',
  ack: 'loom:ack',
} as const;

/** Push channels, main → renderer. */
export const PUSH = {
  events: 'loom:push.events',
  session: 'loom:push.session',
  permission: 'loom:push.permission',
  hosts: 'loom:push.hosts',
} as const;

/** §7's batch limits, shared so main and any test agree on one number. */
export const BATCH_MAX_EVENTS = 64;
export const BATCH_MAX_MS = 50;

/**
 * Unacked events before main stops forwarding. Persistence continues while
 * forwarding is paused — a slow renderer must never be able to stall a run.
 */
export const BACKPRESSURE_WATERMARK = 2_000;

/** Default tail window handed to the renderer. Never the whole log (§7). */
export const DEFAULT_WINDOW = 500;
