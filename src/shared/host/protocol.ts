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
  AgentSpec,
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
