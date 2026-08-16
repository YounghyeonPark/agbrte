/**
 * The model provider boundary (DESIGN.md §3.6, §3.8).
 *
 * A `ModelProvider` does one request. It knows nothing about sessions,
 * workspaces, tools-as-policy, or transports — that smallness is the point, and
 * it is what lets `AgbrteHarness` supply everything above it (§3.7).
 *
 * ## Correction to §3.6
 *
 * The design specifies `messages: NormalizedTurn[]` on the request. That cannot
 * express a tool-calling loop: an assistant turn may *be* a set of tool calls,
 * and a tool result is a distinct role bound to a call id. Sending only
 * user/assistant/system text would make the second iteration of any loop
 * incoherent. `ProviderMessage` below is the superset actually required;
 * `NormalizedTurn` remains the right shape for seeds and briefs, which carry
 * conversation rather than tool mechanics.
 */

import type { ContentBlock } from './content.js';
import type {
  ModelCapabilityHint,
  ReasoningRequest,
  RuntimeCapabilities,
  StopReason,
} from './runtime.js';

/** Where a model lives, and how a remote session should reach it (§3.8). */
export interface ModelEndpoint {
  endpointId: string;
  providerId: string;
  /** Omitted uses the provider's default. */
  baseUrl?: string;
  auth: { kind: 'none' | 'api-key' | 'oauth' | 'aws-sigv4' | 'gcp-adc' | 'azure-key' };
  /**
   * `target-local` is reached directly from the agent's own box — no tunnel
   * through the user's machine, and nothing to protect since local servers
   * usually need no auth (§3.8).
   */
  locality: 'cloud' | 'app-local' | 'target-local';
  defaultReasoning?: ReasoningRequest;
  costCeilingPerDay?: number;
  /** Recorded and displayed: adding a provider must never quietly change
   *  where source code is transmitted (§13). */
  dataHandling: { provider: string; region?: string; retentionNote?: string };
}

export interface ModelDescriptor {
  modelId: string;
  displayName?: string;
  contextWindow?: number;
}

/** A tool as the provider sees it — already degraded to its dialect (§3.5). */
export interface DegradedTool {
  name: string;
  description: string;
  /** JSON Schema, already reduced to the target's `schemaProfile`. */
  schema: object;
}

export interface NormalizedToolCall {
  /** Agbrte's id. Vendor ids are mapped to ours (§3.5). */
  id: string;
  name: string;
  args: unknown;
}

export type ProviderMessage =
  | { role: 'system'; text: string }
  | { role: 'user'; content: ContentBlock[] }
  | { role: 'assistant'; text?: string; toolCalls?: NormalizedToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; result: string; isError?: boolean };

export interface ProviderRequest {
  endpoint: ModelEndpoint;
  modelId: string;
  system?: string;
  messages: ProviderMessage[];
  tools?: DegradedTool[];
  reasoning?: ReasoningRequest;
  maxOutputTokens: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Tokens written into a prompt cache, and tokens served from one.
   *
   * Two fields because they are **priced differently** — writing a cache
   * typically costs more than an uncached input token and reading one costs far
   * less. This was a single `cachedInputTokens`, which cannot express either
   * price and makes any cost built on it wrong in a direction that varies with
   * how the caller happened to use the cache. Found auditing the provider
   * boundary against APIs that report them separately (§3.6a).
   *
   * Absent means the provider does not report it, which is not the same as zero.
   */
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
}

export interface ProviderResult {
  content: ContentBlock[];
  toolCalls: NormalizedToolCall[];
  stop: StopReason;
  usage: ProviderUsage;
  /**
   * The model's own scratchpad, when it kept one and the wire carried it.
   *
   * Separate from `content` because it is a different kind of thing: an answer
   * is addressed to the reader, and this is the working-out. §3.9 calls it
   * *opaque* — it is provider-shaped and cannot be replayed into a different
   * runtime, which is what `dropOpaqueReasoning` exists to enforce.
   */
  reasoning?: string;
  /** Retained for debugging; never interpreted upstream of the adapter. */
  raw: unknown;
}

export interface ModelProvider {
  readonly id: string;
  readonly version: string;
  listModels(endpoint: ModelEndpoint): Promise<ModelDescriptor[]>;
  /**
   * Establish what this endpoint + model can actually do.
   *
   * §3.3: `openai-compatible` must *always* probe and never trust a
   * self-report — the capability spread across servers behind that one shape is
   * enormous.
   */
  probe(endpoint: ModelEndpoint, modelId: string): Promise<RuntimeCapabilities>;
  /**
   * What can be said about a model *without* running it (§3.3).
   *
   * Optional, and separate from `probe` because the two have costs three orders
   * of magnitude apart: `probe` makes real inference requests behind a
   * two-minute timeout, which is why §3.13 refuses to run it for a model nobody
   * has chosen. This reads whatever the server says about itself — for Ollama a
   * `/api/show` manifest read — and returns cached probe results where one
   * exists, so a picker can put a row's facts on screen without spending a turn
   * per row.
   *
   * Every claim carries where it came from, and a claim that could not be
   * established is **absent**. An adapter with nothing to read returns an empty
   * hint, which the UI shows as unknown rather than as no.
   */
  describe?(endpoint: ModelEndpoint, modelId: string): Promise<ModelCapabilityHint>;
  invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult>;
  /** Provider-native counting only. Never a foreign tokenizer (§3.6). */
  countTokens?(req: ProviderRequest): Promise<number>;
}
