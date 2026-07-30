/**
 * The model provider boundary (DESIGN.md §3.6, §3.8).
 *
 * A `ModelProvider` does one request. It knows nothing about sessions,
 * workspaces, tools-as-policy, or transports — that smallness is the point, and
 * it is what lets `LoomHarness` supply everything above it (§3.7).
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
import type { ReasoningRequest, RuntimeCapabilities, StopReason } from './runtime.js';

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
  /** Loom's id. Vendor ids are mapped to ours (§3.5). */
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
  cachedInputTokens?: number;
}

export interface ProviderResult {
  content: ContentBlock[];
  toolCalls: NormalizedToolCall[];
  stop: StopReason;
  usage: ProviderUsage;
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
  invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult>;
  /** Provider-native counting only. Never a foreign tokenizer (§3.6). */
  countTokens?(req: ProviderRequest): Promise<number>;
}
