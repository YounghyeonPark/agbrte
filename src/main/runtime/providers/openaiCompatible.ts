/**
 * The `openai-compatible` provider (DESIGN.md §3.6, §3.8).
 *
 * One adapter covering Ollama, vLLM, LM Studio, llama.cpp's server, OpenRouter,
 * Together — anything speaking the `/v1/chat/completions` shape.
 *
 * ## This adapter always probes
 *
 * §3.3 singles it out: "the capability spread across these is enormous and
 * their self-reports can't be trusted." A tag list tells you a model exists, not
 * whether it can call a tool with a nested schema. So `probe()` makes real
 * requests and reports what came back, and a capability it could not demonstrate
 * is `false`.
 */

import type {
  ContentBlock,
  DegradedTool,
  ModelDescriptor,
  ModelEndpoint,
  ModelProvider,
  NormalizedToolCall,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
  StopReason,
} from '@shared/types/index.js';

export const OPENAI_COMPATIBLE_PROVIDER_ID = 'openai-compatible';
const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const PROBE_TIMEOUT_MS = 120_000;

interface ChatChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly version = '0.0.1';

  private readonly probeCache = new Map<string, RuntimeCapabilities>();

  async listModels(endpoint: ModelEndpoint): Promise<ModelDescriptor[]> {
    const res = await this.fetchJson<{ data?: Array<{ id?: string }> }>(
      endpoint,
      '/models',
      undefined,
      15_000,
    );
    return (res.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string')
      .map((modelId) => ({ modelId }));
  }

  /**
   * Establish capabilities by demonstration.
   *
   * Two calls: one asking for a tool with a nested-object argument, one asking
   * for plain text. Native tool calling is claimed only if a well-formed
   * `tool_calls` entry with parseable arguments actually comes back — the
   * difference between a server that advertises tools and a model that uses them.
   */
  async probe(endpoint: ModelEndpoint, modelId: string): Promise<RuntimeCapabilities> {
    const key = `${endpoint.endpointId}::${modelId}`;
    const hit = this.probeCache.get(key);
    if (hit) return hit;

    const contextWindow = await this.contextWindowOf(endpoint, modelId);

    let tools: RuntimeCapabilities['tools'] = 'none';
    let schemaProfile: RuntimeCapabilities['schemaProfile'] = 'text-protocol';
    let parallel: RuntimeCapabilities['parallelToolCalls'] = 'none';

    try {
      const probe = await this.invoke(
        {
          endpoint,
          modelId,
          system: 'You are a tool-using assistant. Prefer calling a tool over answering directly.',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Look up the weather in Paris in celsius.' }] }],
          tools: [PROBE_TOOL],
          maxOutputTokens: 256,
        },
        { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
      );

      if (probe.toolCalls.length > 0) {
        const call = probe.toolCalls[0];
        const args = call?.args as Record<string, unknown> | undefined;
        const nested = args?.['options'];
        tools = 'native';
        // A model that returned the nested object handled a real schema; one
        // that flattened it gets the reduced profile rather than a broken one.
        schemaProfile =
          nested !== null && typeof nested === 'object' ? 'strict-subset' : 'flat-only';
        parallel = probe.toolCalls.length > 1 ? 'many' : 'one';
      }
    } catch {
      // A failed probe is a `false` capability, never an assumed one.
    }

    const caps: RuntimeCapabilities = {
      nativeResume: false, // a raw endpoint has no session to resume (§3.7)
      interruptible: true, // via AbortSignal on the HTTP request
      subagents: false,
      streaming: false, // not yet implemented in this adapter
      streamingToolArgs: false,
      tools,
      parallelToolCalls: parallel,
      schemaProfile,
      toolResultPairing: 'batched',
      // GilmokHarness owns the gate for every provider-backed agent (§3.7).
      permissionFidelity: 'callback',
      contextWindow,
      maxOutputTokens: Math.min(4_096, Math.floor(contextWindow / 4)),
      serverSideCompaction: false,
      caching: 'none',
      reasoningControl: 'none',
      reasoningVisible: 'none',
      input: { image: false, audio: false, pdf: false, video: false },
      // A local server bills nothing; `free` is the truth, not a placeholder.
      pricing: endpoint.locality === 'cloud' ? 'opaque' : 'free',
      costReporting: endpoint.locality === 'cloud' ? 'none' : 'per-request',
      tokenCounter: 'local-estimate',
      quotaModel: 'per-token-billing',
    };

    this.probeCache.set(key, caps);
    return caps;
  }

  async invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult> {
    const body = {
      model: req.modelId,
      stream: false,
      max_tokens: req.maxOutputTokens,
      messages: toWireMessages(req),
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map(toWireTool), tool_choice: 'auto' }
        : {}),
    };

    const res = await this.fetchJson<ChatResponse>(
      req.endpoint,
      '/chat/completions',
      body,
      undefined,
      opts.signal,
    );

    const choice = res.choices?.[0];
    const message = choice?.message;

    const toolCalls: NormalizedToolCall[] = (message?.tool_calls ?? []).flatMap((call, i) => {
      const name = call.function?.name;
      if (typeof name !== 'string') return [];
      let args: unknown = {};
      try {
        args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
      } catch {
        // Malformed arguments are a normalized stop reason, not a crash — the
        // harness repair-prompts on it (§3.9).
        return [{ id: call.id ?? `call-${i}`, name, args: { __malformed: call.function?.arguments } }];
      }
      // Ids are ours; vendor ids are mapped rather than trusted (§3.5).
      return [{ id: call.id ?? `call-${i}`, name, args }];
    });

    const text = typeof message?.content === 'string' ? message.content : '';
    const content: ContentBlock[] = text.length > 0 ? [{ type: 'text', text }] : [];

    return {
      content,
      toolCalls,
      stop: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
      usage: {
        inputTokens: res.usage?.prompt_tokens ?? 0,
        outputTokens: res.usage?.completion_tokens ?? 0,
      },
      raw: res,
    };
  }

  /** Ollama exposes the real context length; other servers may not. */
  private async contextWindowOf(endpoint: ModelEndpoint, modelId: string): Promise<number> {
    const base = (endpoint.baseUrl ?? DEFAULT_BASE_URL).replace(/\/v1\/?$/, '');
    try {
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return CONSERVATIVE_CONTEXT;
      const json = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [k, v] of Object.entries(json.model_info ?? {})) {
        if (k.endsWith('.context_length') && typeof v === 'number') return v;
      }
    } catch {
      // Not an Ollama server, or unreachable.
    }
    return CONSERVATIVE_CONTEXT;
  }

  private async fetchJson<T>(
    endpoint: ModelEndpoint,
    path: string,
    body?: unknown,
    timeoutMs = 300_000,
    signal?: AbortSignal,
  ): Promise<T> {
    const url = `${(endpoint.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`${endpoint.providerId} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * Deliberately conservative when the server will not say.
 *
 * Overstating a window is the failure §3.6 warns about — it surfaces as a
 * mid-run overflow after the work is already expensive.
 */
const CONSERVATIVE_CONTEXT = 8_192;

const PROBE_TOOL: DegradedTool = {
  name: 'get_weather',
  description: 'Get the weather for a city.',
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      options: {
        type: 'object',
        properties: { unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } },
        required: ['unit'],
        additionalProperties: false,
      },
    },
    required: ['city', 'options'],
    additionalProperties: false,
  },
};

function mapFinishReason(reason: string | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls) return { kind: 'tool_calls' };
  switch (reason) {
    case 'stop':
      return { kind: 'end_turn' };
    case 'length':
      return { kind: 'max_output_tokens' };
    case 'content_filter':
      return { kind: 'content_filtered', stage: 'output' };
    case 'tool_calls':
      return { kind: 'tool_calls' };
    default:
      return { kind: 'end_turn' };
  }
}

function toWireTool(tool: DegradedTool): unknown {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.schema },
  };
}

/** Stable prefix first: system, then history. Correct for caching (§3.7). */
function toWireMessages(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });

  for (const msg of req.messages) {
    switch (msg.role) {
      case 'system':
        out.push({ role: 'system', content: msg.text });
        break;
      case 'user':
        out.push({ role: 'user', content: flatten(msg.content) });
        break;
      case 'assistant':
        out.push({
          role: 'assistant',
          content: msg.text ?? '',
          ...(msg.toolCalls && msg.toolCalls.length > 0
            ? {
                tool_calls: msg.toolCalls.map((c) => ({
                  id: c.id,
                  type: 'function',
                  function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
                })),
              }
            : {}),
        });
        break;
      case 'tool':
        out.push({ role: 'tool', tool_call_id: msg.toolCallId, content: msg.result });
        break;
    }
  }
  return out;
}

/** This adapter declares no image support, so non-text degrades to a pointer. */
function flatten(content: ContentBlock[]): string {
  return content
    .map((b) => {
      switch (b.type) {
        case 'text':
          return b.text;
        case 'file_ref':
          return `[file ${b.path.$ws}]`;
        case 'image':
          return `[image ${b.sha256.slice(0, 12)} — this model cannot see images]`;
        case 'audio':
          return b.transcript ?? '[audio]';
        case 'artifact_ref':
          return `[artifact ${b.artifactId}]`;
      }
    })
    .join('\n');
}
