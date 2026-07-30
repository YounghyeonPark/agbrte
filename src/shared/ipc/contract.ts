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
 * This is the **Phase 1 subset** of §7's `LoomApi`, not the whole thing. §7
 * specifies `targets`, `capture`, `speech`, hierarchy, and model management;
 * Phase 1 needs one local text session that survives a restart, so those
 * namespaces are deliberately absent rather than present and throwing. An API
 * that exists and fails is worse than one that isn't there — the renderer can't
 * feature-detect against a method that rejects at runtime.
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

export interface WorkspaceInfo {
  root: string;
  /** Tracked, follows a clone (§5.2). */
  lineageId: string;
  /** Gitignored, per checkout (§5.2). */
  instanceId: string;
}

export interface RuntimeInfo {
  id: string;
  version: string;
  toolVersion?: string;
  /** Whether this runtime needs a `model`, i.e. whether it is LoomHarness. */
  requiresModel: boolean;
}

export interface CreateSessionRequest {
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
  workspace: {
    current(): Promise<WorkspaceInfo>;
    /** Native folder picker; returns null if the user cancels. */
    choose(): Promise<WorkspaceInfo | null>;
  };
  runtimes: {
    list(): Promise<RuntimeInfo[]>;
  };
  sessions: {
    list(): Promise<Session[]>;
    create(r: CreateSessionRequest): Promise<Session>;
    /** Sessions found on disk under the current workspace but not yet loaded. */
    listOnDisk(): Promise<Array<{ sessionId: string; title: string; goal: string }>>;
    /** Load a session from its log — the restart path Phase 1 is judged on. */
    resume(sessionId: string): Promise<Session>;
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
    respond(requestId: string, decision: PermissionDecision): Promise<void>;
  };
  /** Push channels. Each returns an unsubscribe function. */
  on: {
    events(cb: (b: EventBatch) => void): () => void;
    /** A session record changed — state, agents, usage. */
    session(cb: (s: Session) => void): () => void;
    permission(cb: (r: PermissionRequest) => void): () => void;
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
  workspaceCurrent: 'loom:workspace.current',
  workspaceChoose: 'loom:workspace.choose',
  runtimesList: 'loom:runtimes.list',
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
