/**
 * The AgentHost control protocol (DESIGN.md §8, §6.4).
 *
 * §8 puts agent loops in a separate process: they are long-running,
 * CPU-bursty, and prone to hanging on a wedged subprocess, and none of that
 * should be able to take the window down.
 *
 * ## Why this protocol looks the way it does
 *
 * `RuntimeContext` cannot cross a process boundary. It carries two callbacks
 * and an `AbortSignal`, so each becomes a message: `requestPermission` becomes
 * an ask/answer pair, `reportProgress` becomes a one-way notification, and
 * aborting becomes a command. Everything else on `AgentSpec` is already plain
 * data, which is not an accident — §3.2 keeps environment (`workspacePath`) and
 * identity separate precisely so a spec can be shipped somewhere else.
 *
 * ## The same shape as the remote host
 *
 * A local `utilityProcess` and a remote `agbrte-agent-host` differ only in the
 * channel underneath. Defining this over an abstract `HostChannel` rather than
 * Electron's `MessagePort` is what lets Phase 5 reuse it over SSH — and, more
 * immediately, what lets the whole thing be tested in-process with a pair of
 * in-memory channels instead of booting Electron.
 */

import type {
  CompactedHistory,
  AgentSpec,
  ModelCapabilityHint,
  NormalizedTurn,
  PermissionAsk,
  PermissionDecision,
  AgentId,
  OutboundMessage,
  SplitProposal,
  ProgressSignal,
  RuntimeEvent,
  UserTurn,
} from '../types/index.js';

/** Correlates a request with its reply. Host-opaque; main mints them. */
export type RequestId = string;

/**
 * What one endpoint answered when asked for its models.
 *
 * `error` rather than a rejected request, because one endpoint being
 * unreachable is not a reason to have no answer about the others — a laptop
 * with a local Ollama and a hosted API is the ordinary case, and the local one
 * is down whenever the laptop is somewhere else.
 */
export interface EndpointModels {
  endpointId: string;
  models: string[];
  error?: string;
  /**
   * What is serving this endpoint, and whether a model can be installed into it.
   *
   * Carried with the list rather than asked separately because a client needs
   * both to render one control: a menu offering "install" against a runner that
   * takes its model at launch is a button that cannot work. Absent from a host
   * older than this field, which reads as *cannot tell* — the same three-valued
   * shape `outdated` uses, for the same reason.
   */
  runner?: 'ollama' | 'openai-compatible';
  canInstall?: boolean;
  /** When it cannot: what to do instead, in the user's terms. */
  installHint?: string;
  /**
   * What each listed model can do, as far as anything here can say for free
   * (§3.3, §3.5).
   *
   * Carried with the list for the same reason `runner` is: a client needs both
   * to draw one row, and a second round trip per model to fill in a badge would
   * be N round trips fired by opening a menu.
   *
   * **Free means free.** These are self-descriptions — one `/api/show` per
   * model against a server that has one — plus any probe result already cached
   * on this host. Nothing here runs a model. The expensive answer is
   * `model.capabilities`, asked for the one model somebody actually chose.
   *
   * Absent, or an absent entry, means *nobody asked or nobody could tell*, which
   * a client must render as unknown rather than as no.
   */
  capabilities?: ModelCapabilityHint[];
}

/** How far one model install has got. Reported per attempt, never deleted. */
export interface ModelInstallProgress {
  endpointId: string;
  tag: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  error?: string;
}
/** Identifies one live agent handle inside the host. */
export type HandleId = string;

/** The serializable part of `RuntimeContext`. */
export interface HostContext {
  seedHistory?: NormalizedTurn[];
  modelEgress?: { baseUrl: string; token: string };
  /** The session's roster at start, so an adapter's tools can address it (§4.2). */
  peers?: AgentId[];
}

// -------------------------------------------------------------- main → host

export type HostCommand =
  | { t: 'capabilities'; id: RequestId; spec: AgentSpec }
  /**
   * Which models each endpoint can serve, asked now rather than at startup.
   *
   * The `ready` handshake advertises *endpoints*; this asks each of them what
   * it currently has. A host learns its endpoints once and would otherwise
   * report the same answer for as long as it runs — so a model pulled after the
   * host started is invisible to every client until something restarts, which is
   * the wrong shape for a list that changes by design.
   */
  | { t: 'models'; id: RequestId }
  /**
   * Establish what one model can do, spending whatever that costs (§3.3).
   *
   * The counterpart to the free hints on `models` above, and separate from them
   * because the cost is: `openai-compatible` answers this by *making real
   * requests*, so it is asked once, for the model somebody selected, and never
   * for a list. The answer is cached in the provider, which is the same cache
   * the run that follows will read — the probe is paid for once whoever asks.
   */
  | { t: 'model.capabilities'; id: RequestId; endpointId: string; modelId: string }
  /** Begin pulling a model into an endpoint that can accept one. */
  | { t: 'model.install'; id: RequestId; endpointId: string; tag: string }
  /** How far every install started on this host has got. */
  | { t: 'model.progress'; id: RequestId }
  | { t: 'start'; id: RequestId; handleId: HandleId; spec: AgentSpec; ctx: HostContext }
  /**
   * `token` may be null and that is **not** the same as `start`: an adapter is
   * entitled to treat "resume with nothing cached" differently from a fresh
   * start, and collapsing the two on the main side would hide that choice.
   */
  | {
      t: 'resume';
      id: RequestId;
      handleId: HandleId;
      spec: AgentSpec;
      token: string | null;
      ctx: HostContext;
    }
  | { t: 'send'; id: RequestId; handleId: HandleId; turn: UserTurn }
  | { t: 'interrupt'; id: RequestId; handleId: HandleId }
  | { t: 'stop'; id: RequestId; handleId: HandleId; reason: string }
  /** Fires the handle's `ctx.abortSignal` inside the host. */
  | { t: 'abort'; handleId: HandleId }
  /** The answer to a `permission-ask`. */
  | { t: 'permission'; askId: RequestId; decision: PermissionDecision }
  /**
   * The answer to `compactAsk` (§3.7). `history: null` means the owner had
   * nothing worth carrying, which the runtime treats as "keep what you have".
   */
  | { t: 'compacted'; askId: RequestId; history: CompactedHistory | null }
  | { t: 'shutdown' };

// -------------------------------------------------------------- host → main

export type HostMessage =
  /**
   * Reply to any command carrying an `id`. `value` carries the result — for
   * `capabilities`, the `RuntimeCapabilities`.
   *
   * Deliberately not a separate `caps` message paired with an `ok`: two
   * concurrent `capabilities` calls would then have to be matched to their
   * payloads by arrival order, and the obvious implementation (one "last
   * capabilities" slot) silently hands the wrong set to one of them. Carrying
   * the value on the correlated reply makes that unrepresentable.
   */
  | { t: 'ok'; id: RequestId; value?: unknown }
  | { t: 'err'; id: RequestId; message: string; name?: string }
  | { t: 'event'; handleId: HandleId; event: RuntimeEvent }
  /** The handle's event stream ended. Exactly one per handle. */
  | { t: 'closed'; handleId: HandleId }
  | { t: 'ask'; askId: RequestId; handleId: HandleId; ask: PermissionAsk }
  /**
   * The runtime asking its owner to compact (§3.7, §17.18).
   *
   * A request rather than a notification, and it has to cross this channel for
   * the same reason a permission ask does: the runtime runs in the host process
   * and the log is written in the owner's. Without it the hook is simply absent
   * on every real session — which is what happened, and what a live test caught
   * after the unit tests had passed by handing the runtime a context directly.
   */
  | { t: 'compactAsk'; askId: RequestId; handleId: HandleId; budgetTokens: number }
  | { t: 'progress'; handleId: HandleId; progress: ProgressSignal }
  /**
   * An agent addressing another (§4.2).
   *
   * One-way, like `progress` and unlike `ask`: nothing is awaited, so there is
   * no reply to correlate. Routing it through the owner rather than between
   * loops is what makes it an event in the log.
   */
  | { t: 'message'; handleId: HandleId; message: OutboundMessage }
  /** An agent asking to split its session (§4.3). One-way, like `message`. */
  | { t: 'proposeSplit'; handleId: HandleId; proposal: Omit<SplitProposal, 'proposalId'> }
  /**
   * Pushed whenever the host's view of a resume token changes.
   *
   * `AgentHandle.resumeToken()` is synchronous and cannot become a round trip,
   * so the proxy caches whatever the host last reported. That is sound only
   * because §5.4 already treats the token as a cache and never as truth — if it
   * is stale or absent, resume falls through to rehydration from the log, which
   * is the path that has to work anyway.
   */
  | { t: 'token'; handleId: HandleId; token: string | null }
  /** Host is up and ready for commands. Sent once. */
  | {
      t: 'ready';
      runtimeIds: string[];
      /**
       * Models this host can reach, without their credentials.
       *
       * Carried so a client can offer a choice rather than assume one, and so
       * `provider` reaches the UI — §13 requires that adding a provider never
       * quietly change where source code is transmitted, and a client that
       * cannot name the recipient cannot show it.
       */
      endpoints?: Array<{
        id: string;
        label: string;
        provider: string;
        baseUrl: string;
        authenticated: boolean;
      }>;
    };

// ------------------------------------------------------------------- channel

/**
 * A bidirectional message channel.
 *
 * Deliberately minimal so an Electron `utilityProcess`, an SSH stream, and a
 * test double can all satisfy it. `post` must be fire-and-forget, and messages
 * must arrive in order — both hold for `postMessage` and for a stream carrying
 * length-prefixed frames.
 */
export interface HostChannel<Out, In> {
  post(message: Out): void;
  onMessage(handler: (message: In) => void): void;
  /** Called when the peer is gone; a client must fail its pending requests. */
  onClose(handler: (reason?: string) => void): void;
  close(): void;
}

export type MainSideChannel = HostChannel<HostCommand, HostMessage>;
export type HostSideChannel = HostChannel<HostMessage, HostCommand>;
