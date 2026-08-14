/**
 * The IPC contract (DESIGN.md §7).
 *
 * One file, imported by all three processes, so main's handlers and the
 * renderer's calls cannot drift: if a handler's shape changes, the renderer
 * stops typechecking.
 *
 * Channel strings live **here and nowhere else**. The renderer never sees
 * `ipcRenderer`, never names a channel, and cannot reach a channel that isn't
 * on `AgbrteApi` — §7's `contextIsolation: true`, `nodeIntegration: false`,
 * `sandbox: true` are only as good as the surface exposed through them.
 *
 * ## Scope
 *
 * This is a **subset** of §7's `AgbrteApi`, not the whole thing. `capture`,
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

import type { InboxEntry, MatrixCell } from '../types/index.js';
import type {
  AgentRecord,
  AgentRole,
  AgbrteEvent,
  Annotation,
  ContentBlock,
  ImageBlock,
  McpServerConfig,
  PermissionDecision,
  SkillConfig,
  PermissionRequest,
  PermissionResolved,
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
  /**
   * Whether this host is running an older bundle than the app ships (§6.3).
   *
   * Three-valued on purpose, and the third value is the important one:
   * `undefined` means *cannot be determined* — a host older than protocol v7, or
   * one running unstamped from source. A client must not round that down to
   * "out of date", because the offered remedy is restarting the host and that
   * costs whoever is mid-turn on it.
   */
  outdated?: boolean;
  /**
   * Models this host can reach.
   *
   * `provider` is here so the UI can say where a turn's code will go *before* it
   * is sent — §13 requires that adding a provider never quietly change that, and
   * a picker that only shows model names changes it quietly.
   */
  endpoints: Array<{ id: string; label: string; provider: string; authenticated: boolean }>;
  /** Why nothing can run here. Sessions still load and read. */
  unavailableReason?: string;
  /**
   * Where this workspace was before it moved (§5.3).
   *
   * Shown because a move changes behaviour with no other visible cause: agents
   * that resumed natively yesterday rehydrate today. Without saying so, the app
   * would be quietly different for a reason the user cannot see.
   */
  movedFrom?: string;
  /**
   * Whether the app can currently reach this host.
   *
   * `reconnecting` is not `gone`. The sessions are still on the other side and
   * very likely still running, so the UI has to say "we lost the link" rather
   * than "the host disappeared" — those prompt opposite reactions from a user.
   */
  link: 'connected' | 'reconnecting';
}

/** A machine from the user's `~/.ssh/config`, offered instead of a form. */
export interface SshHostInfo {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
}

/** The effort scale, mirrored from `ReasoningRequest` for the client surface. */
export type ReasoningMode = 'off' | 'auto' | 'low' | 'medium' | 'high' | 'max';

export interface RuntimeInfo {
  id: string;
  version: string;
  toolVersion?: string;
  /** Whether this runtime needs a `model`, i.e. whether it is AgbrteHarness. */
  /** Three-valued: an installed CLI takes a model *optionally* (§3.12). */
  model: 'required' | 'optional' | 'none';
}

export interface CreateSessionRequest {
  /** Which attached host to create it on. */
  instanceId: string;
  title: string;
  goal: string;
  /**
   * MCP servers to attach to the new session (§17 Q20). Session-scoped by
   * design — there is no app-level MCP registry for these to default from.
   * The commands run on the session's host, where the workspace is.
   */
  mcpServers?: McpServerConfig[];
  /** Skills to inject at creation (§17 Q21). Session-scoped, durable in the log. */
  skills?: SkillConfig[];
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
  /**
   * Anything that is not typed text — a screen capture, a paste (§12).
   *
   * Alongside `text` rather than replacing it, because a screenshot almost
   * always arrives with a sentence attached and "here, look at this" is the
   * whole message. The blocks are already stored: each names a hash the owning
   * host can resolve, put there by `capture.grab` before this call.
   */
  blocks?: ContentBlock[];
}

/** One thing the user can capture, as the picker sees it. */
export interface CaptureSourceInfo {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  displayId?: string;
  /**
   * A `data:` URL rather than a Buffer.
   *
   * The same payload has to survive Electron's structured clone *and* a JSON
   * WebSocket frame, and only one of those carries a Buffer. Encoding once here
   * is cheaper than discovering in the browser that the preview is `{"0":137,…}`.
   */
  thumbnailDataUrl?: string;
}

/** A capture the user asked for (§12.1). Every field is in the source's own pixels. */
export interface CaptureRequestDto {
  sessionId: string;
  sourceId: string;
  region?: { x: number; y: number; w: number; h: number };
  redactions?: Array<{ x: number; y: number; w: number; h: number }>;
  windowTitle?: string;
  displayId?: string;
}

/**
 * A frame taken and **not stored**, waiting to be drawn on (§12.1, §12.3).
 *
 * The two-step exists because §12.1's guarantee and §12.3's editing only both
 * hold if the drawing happens before the first store. Nothing is on disk when
 * this is returned; `pendingId` is the handle that trades back for the pixels.
 */
export interface CapturePreviewDto {
  pendingId: string;
  /** A downscaled rendering to draw on. Marks are reported in *these* pixels. */
  preview: { dataUrl: string; width: number; height: number };
  /** The size the frame will actually be stored at, so the caller can show it. */
  stored: { width: number; height: number };
}

export interface CaptureCommitDto {
  pendingId: string;
  sessionId: string;
  /**
   * What the user drew, in **preview** coordinates.
   *
   * Scaled to the stored frame's space by the receiver, which is the only side
   * that knows both numbers — the same reason the region overlay reports a drag
   * in its own window's pixels and lets `region.ts` convert.
   */
  annotations?: Annotation[];
}

/** Whether dictation can work here, and if not, what to do about it (§12.4). */
/** A clip this client is holding. The audio itself never leaves the machine. */
export interface StoredClipDto {
  sha256: string;
  transcript: string;
  durationMs: number;
  sessionId: string;
  at: string;
  engine?: string;
  model?: string;
}

/** One hit, with the machine it came from. */
export interface SearchHitDto {
  sessionId: string;
  instanceId: string;
  host: string;
  title: string;
  seq: number;
  at: string;
  kind: string;
  snippet: string;
}

export interface SearchResults {
  hits: SearchHitDto[];
  /** Hosts that could not be asked, by label. Not the same as no results. */
  unreachable: string[];
}

export interface VoiceStatusDto {
  available: boolean;
  /** Names what to install. Absent when it works. */
  reason?: string;
  engine?: string;
  model?: string;
}

export interface TranscriptDto {
  text: string;
  /** Identifies the clip **on this client**, which is the only place it exists. */
  sha256: string;
  durationMs: number;
}

export interface CaptureResultDto {
  block: ImageBlock;
  /** Whether the OCR pre-pass ran, so an unscanned frame is not shown as clean. */
  scanned: boolean;
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
  events: AgbrteEvent[];
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
  recent: AgbrteEvent[];
  /** `seq` the window starts at, so the renderer knows what it is missing. */
  windowFromSeq: number;
  /**
   * Turns waiting behind the running one (§17 Q14).
   *
   * Several read-write clients can send to one agent, so a turn may sit behind
   * someone else's. Sending into a silent queue makes the app look broken, which
   * is the only reason this is on the snapshot at all.
   */
  queued: number;
}

// ----------------------------------------------------------------- the surface

/**
 * What this installation is, for the About page.
 *
 * Injected by whichever process serves the API rather than read by the
 * renderer, because the renderer has no filesystem and the browser client's
 * honest answer is "whatever the server runs". `runtime` is absent in a
 * browser — a tab has no Electron or Node version of its own to report.
 */
export interface AboutInfo {
  name: string;
  version: string;
  description: string;
  /** SPDX identifier, e.g. `Apache-2.0`. The full text ships as `LICENSE`. */
  license: string;
  homepage: string;
  runtime?: { electron?: string; node?: string; platform?: string };
}

/**
 * What the app knows about its own next version.
 *
 * Mirrored from `main/update.ts` rather than imported, because this file is the
 * renderer's contract and the renderer must not reach into main. The shapes are
 * pinned together by a test — two copies of a type that drift are worse than
 * one copy in the wrong place.
 */
export type UpdateState =
  | { phase: 'unsupported'; reason: string }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; reason: string };

/** What one endpoint answered when asked for its models. */
export interface EndpointModelsDto {
  endpointId: string;
  models: string[];
  /** Set when that endpoint could not be reached. The others still answered. */
  error?: string;
  /**
   * What serves this endpoint and whether it can take an install.
   *
   * `undefined` from a host too old to say, which reads as *cannot tell* — so
   * no install control is offered rather than one that would fail.
   */
  runner?: 'ollama' | 'openai-compatible';
  canInstall?: boolean;
  installHint?: string;
}

/** How far one install has got, as the renderer polls it. */
export interface ModelInstallDto {
  endpointId: string;
  tag: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}

export interface AgbrteApi {
  hosts: {
    /** Every attached host. Several may be attached at once (§8). */
    list(): Promise<HostInfo[]>;
    /** Native folder picker, then attach a local workspace. Null if cancelled. */
    add(): Promise<HostInfo | null>;
    /**
     * Machines the user already has configured.
     *
     * The whole reason attaching a remote is easy: hostname, user, port, key,
     * jump host and proxy command are already answered in their ssh config, and
     * answered better than a form could.
     */
    sshHosts(): Promise<SshHostInfo[]>;
    /** Attach a workspace on a configured machine. */
    addRemote(alias: string, workspaceRoot: string): Promise<HostInfo>;
    /** Stop watching a host. The workspace on disk is untouched. */
    remove(instanceId: string): Promise<void>;
    /**
     * Restart a host onto the bundle this app ships (§6.3).
     *
     * A running host keeps executing the bundle it started with, so deploying a
     * newer one changes nothing until it is restarted — which is why this is a
     * separate act rather than something `attach` quietly does. Sessions survive
     * it: they are durable in the event log (§5.4) and resume from there.
     */
    update(instanceId: string): Promise<HostInfo>;
    /**
     * What each endpoint on this host can serve, asked now (§3.8).
     *
     * Refreshable rather than reported once, because the list changes while the
     * host runs: pulling a model is something a person does mid-session and
     * expects to see. Rejects on an older host rather than returning `[]`,
     * since an empty list is indistinguishable from "no models here".
     */
    models(instanceId: string): Promise<EndpointModelsDto[]>;
    /**
     * Begin installing a model on that host (§3.8).
     *
     * Resolves when the pull has *started*. A model is gigabytes; watching it is
     * `installProgress`, polled while somebody is looking at it.
     */
    installModel(instanceId: string, endpointId: string, tag: string): Promise<void>;
    installProgress(instanceId: string): Promise<ModelInstallDto[]>;
    /**
     * Ask a host to exit. It is allowed to refuse.
     *
     * Different from `remove`, which only stops watching. This asks the *owner*
     * to stop owning, and a host holding a live agent says no — a window closing
     * must not take a running turn with it, which is the entire reason the host
     * is a separate process. The refusal comes back as a value with a reason
     * rather than as an error, because "still running" is an answer.
     */
    shutdown(instanceId: string): Promise<{ stopped: boolean; reason?: string }>;
    /** Runtimes offered by one host — they need not be the same everywhere. */
    runtimes(instanceId: string): Promise<RuntimeInfo[]>;
    /**
     * The support matrix for this host's runtimes (§3.13).
     *
     * Per host for the same reason `runtimes` is: the same adapter answers
     * differently on different machines, and the question the matrix exists to
     * answer is "what can this do *here*".
     */
    conformance(instanceId: string): Promise<MatrixCell[]>;
  };
  /**
   * What happened while you were not looking (§11).
   *
   * Across every attached host, because it is one question. Not on `sessions`:
   * an entry may name a session this client has not loaded, and half of them
   * describe sessions that finished with nobody attached.
   */
  inbox: {
    list(limit?: number): Promise<InboxEntry[]>;
    markRead(): Promise<void>;
  };
  /**
   * Your screen, for the sessions that want to see it (§12.1).
   *
   * Not on `sessions` even though a capture is always attached to one: what is
   * capturable belongs to the *client*, and a picker asks before a session is
   * necessarily chosen.
   */
  capture: {
    /**
     * What can be captured here.
     *
     * Empty rather than an error when this client has no screen, so a picker
     * can render "nothing to capture" without a try/catch. `grab` is the
     * asymmetric one: capturing is a thing the user *did*, and it explains.
     */
    sources(): Promise<CaptureSourceInfo[]>;
    /**
     * Take one, store it against the session, and return the block to attach.
     *
     * Stored before it is attached, and by the owning host — which for a remote
     * session means the bytes have already crossed (§6.7) by the time this
     * resolves. The returned block names a hash that side can resolve, so
     * `sessions.send` carries a reference and never an image.
     */
    grab(r: CaptureRequestDto): Promise<CaptureResultDto>;
    /**
     * Drag a rectangle on the screen, then capture it (§12.1).
     *
     * One call rather than select-then-grab, so the renderer never has to hold
     * a display id and turn it into a source id. `null` means the user pressed
     * Escape, which is an ordinary answer and not a failure.
     */
    region(sessionId: string): Promise<CaptureResultDto | null>;
    /**
     * Take a frame and hold it, unstored, for annotation (§12.3).
     *
     * `region: true` opens the overlay first. `null` means the user cancelled
     * the overlay, which is an answer rather than a failure.
     */
    preview(r: {
      sourceId?: string;
      region?: boolean;
      windowTitle?: string;
      displayId?: string;
    }): Promise<CapturePreviewDto | null>;
    /** Paint the blackouts, store, and return the block to attach. */
    commit(r: CaptureCommitDto): Promise<CaptureResultDto>;
    /** Throw the held frame away — the annotator was closed without sending. */
    discard(pendingId: string): Promise<void>;
  };
  /**
   * Dictation, which happens entirely on this machine (§12.4).
   *
   * There is no remote fallback and that is the design, not a gap: audio never
   * reaches a provider, so a client with no local engine cannot dictate and says
   * which two things to install.
   */
  voice: {
    status(): Promise<VoiceStatusDto>;
    /**
     * Transcribe a WAV and keep it here.
     *
     * Returns text, because text is what gets sent — the user edits it first and
     * voice never auto-sends. The clip stays on this client with its transcript,
     * which is what makes a mis-transcription recoverable without the recording
     * ever crossing a network.
     */
    transcribe(r: { wavBase64: string; sessionId: string; locale?: string }): Promise<TranscriptDto>;
    /** What was dictated here, for going back to a transcript that came out wrong. */
    clips(sessionId?: string): Promise<StoredClipDto[]>;
    forget(sha256: string): Promise<void>;
    /**
     * Read something out loud, on this machine's own synthesiser (§12.4).
     *
     * Resolves when it finishes or is replaced. `false` means this client has no
     * voice — a fact about the machine rather than an error, so a caller can
     * hide the control instead of showing one that explains itself after being
     * pressed.
     */
    speak(text: string): Promise<boolean>;
    stopSpeaking(): Promise<void>;
  };
  /**
   * Bringing a remote dev server to a local port (§6.8).
   *
   * Client-only, like `screen` and `speaker`, and for the same class of reason:
   * what comes back is `http://127.0.0.1:<port>`, which is an address on the
   * machine that opened the tunnel. Handing that to a browser on a phone would
   * be a URL pointing at the wrong computer — a subtler wrongness than a missing
   * feature, so it is excluded by type rather than left to fail politely.
   */
  /**
   * Session templates (§17 Q12), derived from sessions rather than authored.
   *
   * Owned by the host because they live in the workspace, beside `memory/`
   * and on the committed side of `.devagents/`'s `.gitignore` — so a
   * colleague gets them by cloning rather than by being told.
   */
  templates: {
    list(instanceId: string): Promise<SessionTemplateDto[]>;
    /** Take one from a session that worked. */
    save(r: { instanceId: string; sessionId: string; name: string }): Promise<SessionTemplateDto>;
    /** Start a session from one. The roster comes from the host's copy. */
    apply(r: { instanceId: string; templateId: string; title?: string }): Promise<Session>;
    remove(r: { instanceId: string; templateId: string }): Promise<boolean>;
  };
  preview: {
    /**
     * What is listening on the machine this session runs on (§6.8).
     *
     * Answered by the host, because the host is where the answer is. Empty is an
     * ordinary answer — nothing is running, or the host predates the command —
     * so a picker renders rather than showing an error nobody can act on.
     */
    detect(instanceId: string): Promise<DetectedPortDto[]>;
    /**
     * Preview servers this host is running (§6.8, §3.12).
     *
     * Started by us rather than by an agent, because a CLI harness reaps what
     * its run started — so an agent-started dev server vanishes shortly after
     * the turn that started it. These belong to the host and outlive both the
     * turn and this app.
     */
    servers(r: { instanceId: string; sessionId?: string }): Promise<PreviewServerDto[]>;
    /** Run a command on the host's machine. A person's request, never a model's. */
    start(r: { instanceId: string; sessionId: string; command: string }): Promise<PreviewServerDto>;
    stopServer(r: { instanceId: string; serverId: string }): Promise<boolean>;
    /** The tail of what it printed — the answer to “nothing is listening”. */
    serverLog(r: { instanceId: string; serverId: string }): Promise<PreviewServerLogDto | null>;
    /**
     * Forward a port on the machine running this session.
     *
     * `reachable: false` is an answer, not a failure — a dev server that is
     * still compiling reports exactly that, and the tunnel is genuinely open.
     */
    open(r: { instanceId: string; sessionId: string; port: number }): Promise<ForwardDto>;
    list(sessionId: string): Promise<ForwardDto[]>;
    close(r: { sessionId: string; port: number }): Promise<boolean>;
    /** Ask again whether anything is answering, keeping the same local port. */
    recheck(r: { sessionId: string; port: number }): Promise<ForwardDto | null>;
  };
  sessions: {
    list(): Promise<Session[]>;
    create(r: CreateSessionRequest): Promise<Session>;
    /**
     * Approve or decline a split an agent proposed (§4.3).
     *
     * Returns the child when approved, `null` when declined — a decline is an
     * ordinary answer and not an error, since "this is the wrong seam" is a
     * judgement the user is entitled to make.
     */
    respondSplit(
      sessionId: string,
      proposalId: string,
      decision: { approved: boolean; reason?: string },
    ): Promise<Session | null>;
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
    /**
     * Move a seat to a different reasoning effort (§3.4).
     *
     * Rejects on a target that does not take one, rather than storing it — the
     * adapter answers 400 to an effort a model cannot use, so a quiet accept
     * would break every later turn far from the control that caused it.
     */
    setReasoning(sessionId: string, agentId: string, mode: ReasoningMode): Promise<void>;
    /**
     * Stored bytes as a `data:` URL, or `null` when they are not here (§12).
     *
     * A URL rather than raw bytes because every consumer is an `<img>`, and
     * fetched per artifact rather than with the snapshot because a session's
     * blobs are unbounded — the list is cheap and the pixels are not.
     */
    blob(sessionId: string, sha256: string, mime?: string): Promise<string | null>;
    /** Events since `fromSeq`, for filling a gap the renderer detected. */
    since(sessionId: string, fromSeq: number): Promise<AgbrteEvent[]>;
    /**
     * The session as a Markdown document (§15 Phase 8).
     *
     * Returns the text rather than writing a file: where it goes is the
     * client's business, and the desktop app has a save dialog while a browser
     * has a download. The document names what it contains, because an export is
     * the moment a transcript leaves the `0700` directory §13 protects it in.
     */
    exportMarkdown(sessionId: string, opts?: { toolArgs?: 'full' | 'summary' }): Promise<string>;
    /**
     * Search every attached host at once (§15 Phase 8).
     *
     * `unreachable` names the machines that could not be asked, because "no
     * results" and "we could not look" are different answers and only one of
     * them means you should stop looking.
     */
    search(query: string, limit?: number): Promise<SearchResults>;
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
  /** This installation: name, version, license. What the About page shows. */
  app: {
    about(): Promise<AboutInfo>;
  };
  /**
   * Updating this app (§13).
   *
   * The download is automatic and the install is not. `installNow` is the only
   * thing that closes the window, and only a person presses it — see
   * `main/update.ts` for why that asymmetry is the whole design.
   */
  update: {
    /** The current state, for a window that opened after the last push. */
    state(): Promise<UpdateState>;
    /** Quit and apply a downloaded update. Does nothing unless one is ready. */
    installNow(): Promise<void>;
  };
  /** Push channels. Each returns an unsubscribe function. */
  on: {
    events(cb: (b: EventBatch) => void): () => void;
    /** A session record changed — state, agents, usage. */
    session(cb: (s: Session) => void): () => void;
    permission(cb: (r: PermissionRequest) => void): () => void;
    /**
     * A prompt that is no longer open — answered elsewhere, or withdrawn.
     *
     * Without this a second device keeps showing a question that has been
     * settled, and finds out only by answering it and being told it was too
     * late. §15 names that the criterion proving the whole topology.
     */
    permissionResolved(cb: (r: PermissionResolved) => void): () => void;
    /** A host was attached, detached, or changed availability. */
    hosts(cb: (hosts: HostInfo[]) => void): () => void;
    update(cb: (state: UpdateState) => void): () => void;
  };
  /** Ack the highest `seq` rendered, so main can resume a paused forwarder. */
  ack(sessionId: string, seq: number): void;
}

// -------------------------------------------------------------------- channels

/** A session template, as the renderer sees it (§17 Q12). */
export interface SessionTemplateDto {
  id: string;
  name: string;
  goal?: string;
  roles: Array<{ role: string; runtimeId: string; isolation: string }>;
  checklist: string[];
  createdAt: string;
}

/** A port the host found listening on its own machine (§6.8). */
export interface DetectedPortDto {
  port: number;
  address: string;
  /** `false` means it is already reachable from off that machine. */
  loopbackOnly: boolean;
}

/** A preview server the host is running for us (§6.8). */
export interface PreviewServerDto {
  id: string;
  sessionId: string;
  command: string;
  pid: number | null;
  startedAt: string;
  exit: { code: number | null; signal: string | null } | null;
}

export interface PreviewServerLogDto {
  id: string;
  lines: string[];
  dropped: number;
}

/** One forwarded port, as the renderer sees it (§6.8). */
export interface ForwardDto {
  sessionId: string;
  remotePort: number;
  localPort: number;
  url: string;
  reachable: boolean;
}

/**
 * Invoke channels. Values are namespaced strings so a stray listener in a
 * devtools console is at least legible in a log.
 */
export const CH = {
  hostsList: 'agbrte:hosts.list',
  hostsAdd: 'agbrte:hosts.add',
  hostsRemove: 'agbrte:hosts.remove',
  hostsShutdown: 'agbrte:hosts.shutdown',
  hostsUpdate: 'agbrte:hosts.update',
  hostsModels: 'agbrte:hosts.models',
  hostsInstallModel: 'agbrte:hosts.installModel',
  hostsInstallProgress: 'agbrte:hosts.installProgress',
  updateState: 'agbrte:update.state',
  updateInstall: 'agbrte:update.install',
  appAbout: 'agbrte:app.about',
  hostsRuntimes: 'agbrte:hosts.runtimes',
  hostsConformance: 'agbrte:hosts.conformance',
  inboxList: 'agbrte:inbox.list',
  sessionsRespondSplit: 'agbrte:sessions.respondSplit',
  inboxMarkRead: 'agbrte:inbox.markRead',
  hostsSsh: 'agbrte:hosts.ssh',
  hostsAddRemote: 'agbrte:hosts.addRemote',
  sessionsList: 'agbrte:sessions.list',
  sessionsCreate: 'agbrte:sessions.create',
  sessionsListOnDisk: 'agbrte:sessions.listOnDisk',
  sessionsResume: 'agbrte:sessions.resume',
  sessionsSnapshot: 'agbrte:sessions.snapshot',
  sessionsAddAgent: 'agbrte:sessions.addAgent',
  sessionsSend: 'agbrte:sessions.send',
  captureSources: 'agbrte:capture.sources',
  captureGrab: 'agbrte:capture.grab',
  captureRegion: 'agbrte:capture.region',
  capturePreview: 'agbrte:capture.preview',
  captureCommit: 'agbrte:capture.commit',
  captureDiscard: 'agbrte:capture.discard',
  voiceStatus: 'agbrte:voice.status',
  voiceTranscribe: 'agbrte:voice.transcribe',
  voiceClips: 'agbrte:voice.clips',
  voiceForget: 'agbrte:voice.forget',
  voiceSpeak: 'agbrte:voice.speak',
  voiceStopSpeaking: 'agbrte:voice.stopSpeaking',
  templatesList: 'agbrte:templates.list',
  templatesSave: 'agbrte:templates.save',
  templatesApply: 'agbrte:templates.apply',
  templatesDelete: 'agbrte:templates.delete',
  previewDetect: 'agbrte:preview.detect',
  previewServers: 'agbrte:preview.servers',
  previewStart: 'agbrte:preview.start',
  previewStopServer: 'agbrte:preview.stopServer',
  previewServerLog: 'agbrte:preview.serverLog',
  previewOpen: 'agbrte:preview.open',
  previewList: 'agbrte:preview.list',
  previewClose: 'agbrte:preview.close',
  previewRecheck: 'agbrte:preview.recheck',
  sessionsInterrupt: 'agbrte:sessions.interrupt',
  sessionsSetReasoning: 'agbrte:sessions.setReasoning',
  sessionsBlob: 'agbrte:sessions.blob',
  sessionsSince: 'agbrte:sessions.since',
  sessionsExport: 'agbrte:sessions.export',
  sessionsSearch: 'agbrte:sessions.search',
  permissionsPending: 'agbrte:permissions.pending',
  permissionsRespond: 'agbrte:permissions.respond',
  ack: 'agbrte:ack',
} as const;

/** Push channels, main → renderer. */
export const PUSH = {
  events: 'agbrte:push.events',
  session: 'agbrte:push.session',
  permission: 'agbrte:push.permission',
  permissionResolved: 'agbrte:push.permissionResolved',
  hosts: 'agbrte:push.hosts',
  update: 'agbrte:push.update',
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
