/**
 * The runtime layer (DESIGN.md §3) — the interface both adapter branches
 * present: external harnesses, and AgbrteHarness driven by a ModelProvider.
 *
 * A runtime adapter contains no transport awareness. It sees a local
 * filesystem path and a local egress URL, which are genuinely local to
 * wherever it runs. That is what keeps one adapter identical whether it runs
 * on this machine or inside a remote agent host.
 */

import type { AgentId } from './ids.js';
import type { ContentSupport, ImageBlock, NormalizedTurn } from './content.js';
import type { PermissionAsk, PermissionDecision, PermissionFidelity, ToolPolicy } from './policy.js';
// Type-only, and circular with `session.ts` — which already imports from here.
// `SplitProposal` is a session concept and belongs there; `RuntimeContext` is
// the surface an adapter sees and belongs here. A type-only cycle costs nothing
// at runtime, and moving either type to break it would put it somewhere it does
// not describe.
import type { SplitProposal } from './session.js';

export type AgentRole = 'lead' | 'worker' | 'reviewer' | 'custom';

/**
 * Normalized reasoning control (§3.4). Three incompatible families exist —
 * effort levels, token budgets, nothing at all — and exactly one normalized
 * value is stored. No provider-specific knob may ever appear on AgentSpec:
 * the moment one does, every other adapter inherits a field it must ignore.
 */
export interface ReasoningRequest {
  mode: 'off' | 'auto' | 'low' | 'medium' | 'high' | 'max';
}

/** What a target's tool-schema dialect can actually accept (§3.5). */
export type SchemaProfile =
  | 'json-schema-full'
  | 'strict-subset'
  | 'flat-only'
  | 'text-protocol';

export interface ModelRef {
  providerId: string;
  /** The provider's own string, verbatim — never normalized or reconstructed. */
  modelId: string;
  endpointId?: string;
}

/**
 * Where credentials live (§3.11). Agbrte never stores, proxies, or replays a
 * vendor session token: under `vendor-cli-session` we invoke the user's own
 * tool and stay out of the auth path entirely.
 */
export type AuthMode =
  | { kind: 'api-key'; endpointId: string }
  | { kind: 'vendor-cli-session'; cliId: string; quotaGroup: string }
  | { kind: 'none' };

/** Whether a credential is metered per token or by a resetting window (§3.9). */
export type QuotaModel = 'per-token-billing' | 'windowed-allowance';

/** How much of a run's cost Agbrte can actually observe (§10). */
export type CostReporting = 'per-request' | 'telemetry' | 'none';

export interface RuntimeCapabilities {
  // loop and lifecycle
  nativeResume: boolean;
  interruptible: boolean;
  subagents: boolean;
  streaming: boolean;
  streamingToolArgs: boolean;

  // tools and gating
  tools: 'native' | 'text-protocol' | 'none';
  parallelToolCalls: 'many' | 'one' | 'none';
  schemaProfile: SchemaProfile;
  toolResultPairing: 'batched' | 'one-per-message';
  permissionFidelity: PermissionFidelity;

  // context
  contextWindow: number;
  maxOutputTokens: number;
  serverSideCompaction: boolean;
  caching: 'explicit' | 'automatic' | 'none';

  // reasoning
  reasoningControl: 'effort' | 'budget' | 'none';
  reasoningVisible: 'summary' | 'raw' | 'none';

  // content
  input: ContentSupport;
  imageMaxLongEdge?: number;
  imageMaxCount?: number;

  // economics
  /**
   * What a million tokens costs, when that is a knowable number.
   *
   * `'free'` is a real answer — a local model costs nothing per token — and is
   * distinct from `'opaque'`, which means a price exists and we cannot see it.
   * §10 turns on that distinction: showing `$0.00` for a subscription-backed
   * agent would be a lie.
   *
   * The cache rates are optional because most price lists omit them; absent,
   * cached tokens are billed at the input rate, which is what a provider that
   * does not price them separately actually does.
   */
  pricing?:
    | {
        inputPerMTok: number;
        outputPerMTok: number;
        cacheReadPerMTok?: number;
        cacheWritePerMTok?: number;
        currency: string;
      }
    | 'free'
    | 'opaque';
  costReporting: CostReporting;
  tokenCounter: 'provider-endpoint' | 'local-estimate' | 'none';
  quotaModel: QuotaModel;
}

/**
 * How a single capability claim was established (§3.3).
 *
 * > **Three tiers of confidence, and the doc must not blur them.** A field in
 * > `RuntimeCapabilities` is either *self-described* by the runtime, *probed* by
 * > us, or *configured* — a constant the adapter was told.
 *
 * Named after §3.3's own three words rather than invented ones, because the
 * whole value of carrying this is that a reader can look up what it means. The
 * fourth state — nobody established it — is the *absence* of a claim, never a
 * fourth value: an unknown rendered as a value is the confusion this exists to
 * prevent.
 */
export type CapabilityConfidence = 'probed' | 'self-described' | 'configured';

/** One capability fact and where it came from. Absent ⇒ nobody knows. */
export interface CapabilityClaim<T> {
  value: T;
  from: CapabilityConfidence;
}

/**
 * The few things about one model that decide whether it can do the job (§3.3,
 * §3.5), asked *before* it is chosen.
 *
 * This exists because a degradation nobody is told about reads as the feature
 * being broken. A model whose probe answers `tools: 'none'` can only chat under
 * `AgbrteHarness` — ask it four times to search and nothing happens, with no
 * explanation anywhere. The picker is the last moment that is still cheap to
 * fix, so the facts have to reach it.
 *
 * **A subset of `RuntimeCapabilities`, deliberately.** The full shape is 20-odd
 * fields the orchestrator branches on; this is what a person choosing needs, and
 * every field is optional because *unknown must render as unknown*. A missing
 * claim is never rendered as `false` — those are different sentences and the
 * second one is a lie about a model nobody asked.
 */
export interface ModelCapabilityHint {
  endpointId: string;
  modelId: string;
  /** The one that caused the incident: can it call our tools at all (§3.5). */
  tools?: CapabilityClaim<'native' | 'text-protocol' | 'none'>;
  /** What survived degradation — a `flat-only` model mis-calls nested tools. */
  schemaProfile?: CapabilityClaim<SchemaProfile>;
  contextWindow?: CapabilityClaim<number>;
  /** Whether *Agbrte* will send it an image, not whether the weights could. */
  imageInput?: CapabilityClaim<boolean>;
  reasoningControl?: CapabilityClaim<'effort' | 'budget' | 'none'>;
  /**
   * Why nothing could be established.
   *
   * Carried with the empty hint rather than thrown, for the same reason
   * `EndpointModels.error` is: one model being unreachable is not a reason to
   * have no answer about the others, and "could not ask" is a sentence a picker
   * can show.
   */
  error?: string;
}

/**
 * Why a turn stopped (§3.9). `quota_exhausted` is deliberately distinct from
 * `rate_limited`: a rate limit clears in seconds and is handled by backoff, a
 * windowed allowance may not clear for hours and must park, not fail.
 */
export type StopReason =
  | { kind: 'end_turn' }
  | { kind: 'tool_calls' }
  | { kind: 'max_output_tokens' }
  | { kind: 'refused'; category?: string }
  | { kind: 'content_filtered'; stage: 'input' | 'output' }
  | { kind: 'context_overflow' }
  | { kind: 'invalid_tool_args'; detail: string }
  | { kind: 'rate_limited'; retryAfterMs?: number }
  | { kind: 'quota_exhausted'; scope: 'session' | 'window' | 'daily' | 'weekly'; resetsAt?: string }
  /**
   * A ceiling *we* configured was reached — `maxTurns`, a cost cap, a wall clock.
   *
   * Distinct from `quota_exhausted` because nothing will reset: mapping it there
   * parked a session in `awaiting_quota`, whose contract is "resume at
   * `resetsAt`", for a limit the user set themselves. The work is incomplete but
   * nothing is broken, so it pauses for a human decision.
   */
  | {
      kind: 'limit_reached';
      /**
       * Which ceiling. One value per limit `AgentSpec.limits` can express —
       * this was `'turns' | 'cost' | 'wallclock'` while the spec carried four
       * limits, so two of them had no way to report themselves and would have
       * had to lie about which one fired.
       */
      limit: 'turns' | 'tool_calls' | 'tokens' | 'cost' | 'wallclock';
      detail?: string;
    }
  /**
   * A permanent configuration fault — an unknown model id, a malformed request.
   * Retrying cannot help, which is why it is not folded into `invalid_tool_args`.
   */
  | { kind: 'misconfigured'; detail: string }
  | { kind: 'auth' }
  | { kind: 'unavailable' }
  | { kind: 'transport' };

/**
 * What a stop means for whoever is driving the turn.
 *
 * Read by the CLI, which turns it into an exit code. Not read by the supervisor,
 * despite what this said for a long time: `'retry'` is a classification, and no
 * code re-issues the turn on it. `stateForStop` says what that absence means for
 * the session (§4.1).
 */
export function stopDisposition(
  stop: StopReason,
): 'done' | 'continue' | 'retry' | 'pause' | 'fail' {
  switch (stop.kind) {
    case 'end_turn':
      return 'done';
    case 'tool_calls':
      return 'continue';
    case 'rate_limited':
    case 'unavailable':
    case 'transport':
      return 'retry';
    case 'context_overflow':
    case 'invalid_tool_args':
      return 'retry'; // compact, or repair-prompt, then retry
    case 'quota_exhausted':
    case 'auth':
    case 'limit_reached':
      return 'pause'; // never fail — §4.1, the awaiting_* family
    case 'max_output_tokens':
    case 'refused':
    case 'content_filtered':
    case 'misconfigured':
      return 'fail';
  }
}

export interface AgentSpec {
  agentId: AgentId;
  role: AgentRole;
  /** Which harness. */
  runtimeId: string;
  /** Required iff the harness is AgbrteHarness. */
  model?: ModelRef;
  auth: AuthMode;
  reasoning?: ReasoningRequest;
  systemPrompt?: string;
  toolPolicy: ToolPolicy;
  /**
   * Ceilings this agent stops at, rather than fails at (§3.9).
   *
   * Every one produces `limit_reached`, which is deliberately not
   * `quota_exhausted`: nothing here resets, so the session pauses for a person
   * instead of parking for a window that will never come.
   */
  limits: {
    maxTurns?: number;
    maxToolCalls?: number;
    tokenCeiling?: number;
    /** Only meaningful where cost is observable at all — §10's third row. */
    costCeiling?: number;
    wallClockMs?: number;
  };
  /**
   * Resolved at start by whoever is adjacent to the filesystem.
   * Never persisted — this is environment, not identity (§3.2).
   */
  workspacePath: string;
}

export interface ProgressSignal {
  kind: 'phase' | 'checklist' | 'heartbeat' | 'usage';
  detail?: string;
  /** Emitted independently of model output, so a wedged tool call is
   *  distinguishable from deep thinking (§10). */
  at: string;
}

/** What an owner hands back when it compacts a history (§3.7). */
export interface CompactedHistory {
  /** The replacement conversation, in the same shape as `seedHistory`. */
  turns: NormalizedTurn[];
  /** Estimated size of what was replaced, for the record. */
  beforeTokens: number;
  afterTokens: number;
}

export interface RuntimeContext {
  /** Rehydrated conversation when native resume is unavailable or rejected (§5.4). */
  seedHistory?: NormalizedTurn[];
  /** The host stamps session identity and mints the request id (§13). */
  requestPermission(ask: PermissionAsk): Promise<PermissionDecision>;
  reportProgress(p: ProgressSignal): void;
  /**
   * Address another agent in this session (§4.2).
   *
   * Optional, and honestly so: an adapter that runs its **own** tools — the SDK
   * library, an installed CLI — has no way to call this, because the tool that
   * would is ours and it is not in their suite. Declaring it required would put
   * a method on those adapters that nothing could ever invoke.
   *
   * Fire-and-forget by design. The sender's turn does not wait for the
   * recipient's: a lead that blocked until its worker replied would hold a model
   * connection open for the length of somebody else's work, and two agents
   * waiting on each other is a deadlock with a token bill.
   */
  sendMessage?(message: OutboundMessage): void;
  /**
   * Ask the owner to compact this agent's history (§3.7, §17.18).
   *
   * The division is the one §17.1 arrived at the hard way: **the harness may
   * decide, and may not own.** Only the runtime knows how full the window is —
   * it holds the message array and the context window — and only the owner can
   * read the log, which is what `rehydrate()` compacts from. So the runtime says
   * when and with what budget, and the owner does it and records it.
   *
   * `budgetTokens` is the ceiling for the replacement, passed rather than
   * re-derived so there is one opinion about it.
   *
   * Optional for the same reason `sendMessage` is: an adapter running its own
   * loop — an installed CLI, a vendor SDK — manages its own context and has no
   * message array to replace. Returns `null` when there was nothing to compact,
   * which is not a failure: a session whose log is shorter than its window is
   * the ordinary case, and the caller keeps what it has.
   */
  compact?(budgetTokens: number): Promise<CompactedHistory | null>;
  /**
   * Ask to split this session's scope into a child (§4.3).
   *
   * Optional for the same reason `sendMessage` is: an adapter running its own
   * tools has no way to call it. Fire-and-forget — the proposal goes to a person
   * and the answer arrives, if it arrives, as a new session rather than as a
   * return value. An agent that blocked waiting for approval would hold a model
   * connection open across a human decision.
   */
  proposeSplit?(proposal: Omit<SplitProposal, 'proposalId'>): void;
  /**
   * Screenshot a URL and store the image (§12.1).
   *
   * Optional like the rest: a host with no browser cannot, and a tool that
   * pretended otherwise would report a capture nobody took. It returns a stored
   * `ImageBlock` rather than bytes, because the blob store belongs to the owner
   * of the log and an adapter has no business writing there.
   */
  capture?(o: {
    url: string;
    viewport?: { width: number; height: number; dpr: number };
  }): Promise<ImageBlock>;
  /**
   * Who else is in this session (§4.2).
   *
   * Carried rather than discoverable, because an adapter has no way to ask: it
   * holds a spec, not a session. Without it a `message` tool can only refuse an
   * unknown address after the fact, and cannot tell the model who is available
   * to address in the first place — which is the difference between a roster and
   * a guessing game.
   *
   * A snapshot at start. An agent added mid-turn is not addressable until the
   * next one, which is honest: the alternative is a list that changes under a
   * model between deciding who to ask and asking.
   */
  peers?: AgentId[];
  /** Single egress endpoint; the gateway routes by provider. Absent unless auth is api-key. */
  modelEgress?: { baseUrl: string; token: string };
  /**
   * Tools injected into this *session*, beyond the runtime's own suite (§17 Q20).
   *
   * How MCP reaches an agent, and deliberately the only way it does: the
   * connection to an MCP server is session state — created with the session,
   * recorded in its log, dying with it — so the *host* owns it and the runtime
   * is handed closures, exactly as `capture` and `sendMessage` arrive. A
   * runtime that connected to MCP servers itself would own something that
   * outlives no restart and appears in no transcript, which is the §17.1 rule
   * ("the harness may decide, and may not own") violated in one line.
   *
   * Every call still goes through `requestPermission`: a session tool is a
   * tool, not a bypass. Optional like `sendMessage`, and for the same reason —
   * an adapter running its own tool suite (an installed CLI) has no loop these
   * could enter.
   */
  sessionTools?: SessionTool[];
  abortSignal: AbortSignal;
}

/**
 * One tool the session carries with it (§17 Q20).
 *
 * A narrower shape than the harness's own `ToolDefinition` on purpose: that
 * type's context (leases, workspace root, roster) belongs to the harness's
 * built-ins, while a session tool executes wherever the *host* connected it —
 * an MCP server process, today — and needs none of it. The runtime wraps this
 * into its own suite; the host builds it around a connection it owns.
 */
export interface SessionTool {
  /** Namespaced by origin (`mcp__<serverId>__<tool>`), so it can never shadow a built-in. */
  name: string;
  description: string;
  /** JSON Schema for the arguments, degraded per target by the runtime (§3.5). */
  schema: object;
  run(
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; summary: string; content: string }>;
}

/**
 * One agent addressing another, through the session (DESIGN.md §4.2).
 *
 * Carries normalized `ContentBlock`s rather than a provider's own message shape,
 * which is what lets a Claude-backed lead message an Ollama-backed worker with
 * no translation beyond that worker's declared downgrades.
 *
 * `to: 'session'` is a broadcast: recorded in the transcript and readable by
 * anyone, but it starts no turn. Delivering a broadcast as a turn would mean one
 * message waking every agent in the roster, which is how a roster of six becomes
 * a fork bomb.
 */
/**
 * What an adapter is allowed to say.
 *
 * `from` and `hops` are absent on purpose: the sender is stamped by the owner
 * of the log, which is the only party that cannot be wrong about it, and the hop
 * count is the ceiling's own bookkeeping. An adapter able to set either could
 * forge attribution in a log whose value is that it says who did what, or reset
 * the bound that stops two agents talking in circles.
 */
export type OutboundMessage = Omit<AgentMessage, 'from' | 'hops'>;

export interface AgentMessage {
  from: AgentId;
  to: AgentId | 'session';
  kind: 'task' | 'report' | 'question' | 'answer' | 'review';
  content: NormalizedTurn['content'];
  /**
   * How many messages deep this exchange is.
   *
   * A lead asks a worker, the worker asks back, and without a bound that is a
   * conversation with a bill attached and no one watching. Incremented on every
   * hop and refused past a ceiling; reset whenever a *person* sends a turn,
   * because a human in the loop is the thing the ceiling exists to wait for.
   */
  hops: number;
}

export interface UserTurn {
  content: NormalizedTurn['content'];
}

/**
 * A bounded tail of raw subprocess output (§3.12, §7).
 *
 * The same shape as the preview server log, for the same reason: the
 * interesting part of a long-running process's output is always the end, and
 * `dropped` is what keeps a truncated tail honest about being truncated.
 */
export interface RawTail {
  lines: string[];
  /** Lines dropped off the front, so a shortened tail says it was shortened. */
  dropped: number;
}

export interface AgentHandle {
  send(turn: UserTurn): Promise<void>;
  interrupt(): Promise<void>;
  stop(reason: string): Promise<void>;
  /**
   * The event stream. Two obligations on every adapter:
   *
   *  - **Subscribable before the first `send()`.** The host subscribes first so
   *    no early event is lost, which means an adapter must buffer from
   *    construction rather than opening its stream when a turn arrives. An
   *    adapter that builds its stream lazily yields nothing, and its turns are
   *    indistinguishable from transport failures.
   *  - **Consumable once.** Repeated access returns the same stream; adapters
   *    memoize rather than creating a second consumer.
   *
   * Both are covered by the runtime contract suite, which every adapter runs.
   */
  events: AsyncIterable<RuntimeEvent>;
  /** Opaque, runtime-owned, optional. A cache — never truth (§5.4). */
  resumeToken(): string | null;
  /**
   * What the subprocess behind this handle actually printed — stdout and
   * stderr, unparsed (§3.12).
   *
   * Optional, and honestly so, like `sendMessage` on `RuntimeContext`: only an
   * adapter that *has* a subprocess can answer, and the SDK library or the
   * harness prints nothing a terminal would show. Absent means the UI offers
   * no raw view rather than one that is permanently empty.
   *
   * A live window, not a record: the tail lives and dies with the handle, and
   * the durable transcript is the event log. Read-only by construction — this
   * is §3.12's "prefer documented JSON output over a pty" holding its ground;
   * a tail can be watched, never typed into.
   */
  rawTail?(): RawTail;
}

/** What an adapter emits; the host translates these into durable log events. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  /** The model's working-out, kept apart from its answer (§3.9). */
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; tool: string; args: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string; blobs?: string[] }
  /**
   * What a turn spent.
   *
   * `cost` carries `'unknown'` rather than going absent, because absent is a
   * third state anything summing usage has to guess about — and §10 needs
   * "a cost exists and we cannot see it" said out loud rather than inferred.
   */
  | {
      type: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      cost?: number | 'unknown';
    }
  | { type: 'stopped'; stop: StopReason };

export interface AgentRuntime {
  readonly id: string;
  /**
   * Adapter version, recorded on every event this runtime produces (§5.1).
   *
   * Exposed on the interface because the host has no other way to obtain it: an
   * adapter's module constants are unreachable without importing the adapter,
   * which would be a layering leak. Without this, every transcript recorded
   * `adapterVersion: 'unknown'` and was unattributable.
   */
  readonly version: string;
  /** Version of the underlying vendor tool, where one exists (§3.12). */
  readonly toolVersion?: string;
  /**
   * A function, not a constant: with many providers, capabilities belong to
   * adapter + model + installed tool version, and the orchestrator must know
   * which it has before assigning work (§3.2).
   */
  capabilities(spec: AgentSpec): Promise<RuntimeCapabilities>;
  start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle>;
  resume(spec: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle>;
}
