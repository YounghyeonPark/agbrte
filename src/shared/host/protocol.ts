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
  OutboundPeerMessage,
  PeerDelivery,
  PeerHistory,
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
  /**
   * The session's injected tools, **declared but not carried** (§17 Q20).
   *
   * `SessionTool.run` is a closure over a connection the *owner* holds — an MCP
   * server process it spawned — and a closure cannot cross a process boundary,
   * which is the same problem `requestPermission` and `compact` have and it gets
   * the same answer: the declaration is shipped so the runtime can put the tool
   * in front of the model, and a call becomes a `toolCall`/`toolResult` pair.
   *
   * Omitting it was not a small gap. The runtime is what tells the model which
   * tools exist, so a session with an attached MCP server logged `mcp.attached`,
   * showed the tool in the UI, and then never mentioned it to the model at all —
   * a feature that unit-tests green (they hand the runtime a context directly,
   * in-process) and does nothing whatsoever in the shipping app. That is the
   * same failure `compactAsk` records below, twice over: a hook that exists
   * everywhere except across the one boundary that always exists in production.
   */
  sessionTools?: Array<{ name: string; description: string; schema: object }>;
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
  /**
   * The answer to `toolCall` (§17 Q20).
   *
   * Always sent, including for a handle the owner no longer knows: a tool call
   * is awaited inside a turn in the other process, so silence hangs the turn
   * rather than degrading it — the same argument as `compacted`. A failure is
   * an ordinary tool failure (`ok: false`) and never a dropped reply, because
   * the model has to be told the tool did not work.
   */
  | {
      t: 'toolResult';
      callId: RequestId;
      result: { ok: boolean; summary: string; content: string };
    }
  /**
   * The answer to `peerAsk` (§17 Q22).
   *
   * Always sent, for `toolResult`'s reason: `message_peer` is awaited inside a
   * turn in the other process, and §17 Q22's rule is that a message is *refused
   * rather than dropped* — a model that is not told its message failed will wait
   * for a reply that was never coming.
   */
  | { t: 'peerDelivered'; askId: RequestId; delivery: PeerDelivery }
  /**
   * The answer to `peerHistoryAsk` (§17 Q22).
   *
   * Always sent, by `toolResult`'s rule: a turn in the other process is blocked
   * on it, so a handle the owner no longer knows — or a read that threw — comes
   * back as `error`, a sentence the model can act on, rather than as a silence
   * that hangs the turn.
   */
  | { t: 'peerHistory'; askId: RequestId; history?: PeerHistory; error?: string }
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
  /**
   * The runtime running one of the session's injected tools (§17 Q20).
   *
   * A request, like `ask` and `compactAsk`, and for the identical reason: the
   * loop is here and the MCP connection is over there, owned by whoever owns
   * the log. The gate has already run by the time this is sent — a session tool
   * is a tool, so `requestPermission` settled it in the runtime's own suite —
   * and this is the execution, not a second decision.
   */
  | {
      t: 'toolCall';
      callId: RequestId;
      handleId: HandleId;
      name: string;
      args: Record<string, unknown>;
    }
  | { t: 'progress'; handleId: HandleId; progress: ProgressSignal }
  /**
   * One line the runtime's subprocess printed (§3.12, §7).
   *
   * One-way, like `progress`, and it has to cross for the same reason `token`
   * does: the process with the pipes is *this* one, and `sessions.rawLog` is
   * answered over there. Without it the terminal pane was dark on every real
   * session while the adapter's own unit tests passed — the handle the owner
   * holds is a proxy, and a proxy has no stdout.
   *
   * Lossy by contract: the owner keeps a bounded tail and reports what it
   * dropped, so nothing here needs delivery guarantees or backpressure.
   */
  | { t: 'raw'; handleId: HandleId; line: string }
  /**
   * An agent addressing another (§4.2).
   *
   * One-way, like `progress` and unlike `ask`: nothing is awaited, so there is
   * no reply to correlate. Routing it through the owner rather than between
   * loops is what makes it an event in the log.
   */
  | { t: 'message'; handleId: HandleId; message: OutboundMessage }
  /**
   * An agent addressing a *different session* in its group (§17 Q22).
   *
   * A request and not a one-way `message`, and the difference is the whole
   * reason this exists separately. `sendMessage` returns nothing, so it can be
   * posted and forgotten; `sendPeerMessage` returns a `PeerDelivery`, because a
   * message to another session can be *refused* — wrong group, another machine,
   * a session that has finished — and §17 Q22 requires that refusal to reach the
   * model that sent it rather than being swallowed.
   *
   * It had to cross this channel and did not, which is the third time a hook
   * added only to the owner's own factory has been left undefined on every real
   * session (`sessionTools` and `compact` were the first two). The tool's
   * refusal was `this session is not in a group` — said to sessions that were
   * demonstrably in one, because the context the runtime is handed is assembled
   * on the far side of this boundary, and every unit test builds one by hand.
   */
  | {
      t: 'peerAsk';
      askId: RequestId;
      handleId: HandleId;
      message: OutboundPeerMessage;
    }
  /**
   * An agent reading what a session in its group has done (§17 Q22).
   *
   * A request for the same reason `peerAsk` is one: the logs are on the owner's
   * side, and the answer — including a refusal naming who *is* in the group — is
   * what the model needs back. The read is bounded before it crosses, so nothing
   * here grows with the size of somebody else's session.
   */
  | {
      t: 'peerHistoryAsk';
      askId: RequestId;
      handleId: HandleId;
      sessionId: string;
      since?: number;
    }
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
       * The same runtimes, with what the *owner* needs to register them.
       *
       * `runtimeIds` alone was not enough and the gap was invisible for months.
       * The session host forks this process, receives the ids, advertises them
       * to every client — and built its own `RuntimeRegistry` from a hardcoded
       * list beside the fork. So an installed CLI detected here appeared in the
       * picker and was refused by `admit()` on the very process that had
       * advertised it, with `runtime "cli:claude-code" is not registered`.
       *
       * A descriptor is what closes it: the owner registers a façade for what
       * this process actually has, rather than for what someone typed into a
       * constant. `model` in particular cannot be guessed — an installed CLI is
       * `optional` and `echo` is `none`, and admission refuses a spec carrying a
       * model for the second (§17 Q11).
       *
       * Optional so an agent host built before this field still handshakes.
       * Both bundles are deployed together (`uploadHostBundle` takes the pair),
       * so a skew is close to impossible in practice — and the degradation is
       * still the honest one: no descriptor means the owner cannot register it,
       * so it is not advertised either, and nothing is offered that would fail.
       */
      runtimes?: Array<{ id: string; label: string; model: 'required' | 'optional' | 'none' }>;
      /**
       * Runtimes this process looked for and did not find, with a reason each.
       *
       * Detection is per machine (§3.2, §3.12), and a *failed* detection used to
       * be the one result that reached nobody. One line per manifest, computed
       * once at startup.
       */
      runtimeNotes?: Array<{ id: string; label: string; reason: string }>;
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
      /**
       * The order those are tried in, most preferred first (§3.9).
       *
       * Announced by this process because this is the process that walks it:
       * `loadEndpoints` runs here (§8), and the session host beside it holds no
       * registry. Re-reading the file over there to display an order would let
       * the picture disagree with the routing whenever a write had happened
       * since the fork — which is precisely when somebody is looking at it.
       *
       * Optional, so an agent host built before the field still handshakes. Its
       * absence and an empty array mean the same thing and are rendered the
       * same way: the endpoint list with no order on it. A machine with one
       * model server has no order to show, and that is ordinary rather than a
       * misconfiguration.
       */
      endpointChain?: string[];
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
