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
import type { ContentSupport, NormalizedTurn } from './content.js';
import type { PermissionAsk, PermissionDecision, PermissionFidelity, ToolPolicy } from './policy.js';

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
  pricing?: { inputPerMTok: number; outputPerMTok: number; currency: string } | 'free' | 'opaque';
  costReporting: CostReporting;
  tokenCounter: 'provider-endpoint' | 'local-estimate' | 'none';
  quotaModel: QuotaModel;
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
  | { kind: 'limit_reached'; limit: 'turns' | 'cost' | 'wallclock'; detail?: string }
  /**
   * A permanent configuration fault — an unknown model id, a malformed request.
   * Retrying cannot help, which is why it is not folded into `invalid_tool_args`.
   */
  | { kind: 'misconfigured'; detail: string }
  | { kind: 'auth' }
  | { kind: 'unavailable' }
  | { kind: 'transport' };

/** Whether the supervisor should retry, pause, or fail on a given stop. */
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
  limits: {
    maxTurns?: number;
    maxToolCalls?: number;
    tokenCeiling?: number;
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

export interface RuntimeContext {
  /** Rehydrated conversation when native resume is unavailable or rejected (§5.4). */
  seedHistory?: NormalizedTurn[];
  /** The host stamps session identity and mints the request id (§13). */
  requestPermission(ask: PermissionAsk): Promise<PermissionDecision>;
  reportProgress(p: ProgressSignal): void;
  /** Single egress endpoint; the gateway routes by provider. Absent unless auth is api-key. */
  modelEgress?: { baseUrl: string; token: string };
  abortSignal: AbortSignal;
}

export interface UserTurn {
  content: NormalizedTurn['content'];
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
}

/** What an adapter emits; the host translates these into durable log events. */
export type RuntimeEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; tool: string; args: unknown }
  | { type: 'tool_result'; id: string; ok: boolean; summary: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cost?: number }
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
