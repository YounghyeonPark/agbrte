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
  ModelCapabilityHint,
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

/**
 * Extra attempts for a reply that arrived empty *and* billed. See `invoke`.
 *
 * Two, not more. The failure is per-sample and independent, so at the measured
 * one-in-nine this takes it to one in seven hundred; a third attempt buys three
 * more zeros nobody will notice and triples the worst-case latency of a turn
 * that is already slow.
 */
const EMPTY_REPLY_RETRIES = 2;

/**
 * A reply with nothing in it that nonetheless cost output tokens.
 *
 * The `outputTokens > 0` half is what separates a defect from an answer. A model
 * that declines to speak spends nothing and has said something by saying
 * nothing; a server that billed for six hundred tokens and returned neither text
 * nor a tool call has lost them.
 *
 * Reasoning counts as having spoken. A reply that is only working-out is
 * strange, but it is *the model's* output arriving intact, and asking again
 * would charge twice for it.
 */
function spentButSaidNothing(result: ProviderResult): boolean {
  return (
    result.content.length === 0 &&
    result.toolCalls.length === 0 &&
    result.reasoning === undefined &&
    result.usage.outputTokens > 0
  );
}

interface ChatChoice {
  finish_reason?: string;
  message?: {
    content?: string | null;
    /**
     * The model's working-out. `reasoning` is Ollama's spelling — measured with
     * `qwen3:0.6b` — and `reasoning_content` is the one vLLM and several
     * gateways use for the same field.
     */
    reasoning?: string;
    reasoning_content?: string;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
  };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /**
     * Reads only. This dialect caches automatically and reports what it served
     * from cache; there is no notion of a *write* to charge for, which is why
     * `cacheWriteTokens` stays absent rather than zero (§3.6a).
     */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAiCompatibleOptions {
  /**
   * Looks up the credential for an endpoint id.
   *
   * Optional so a keyless setup — a local Ollama, the tests — needs nothing.
   */
  keyFor?: (endpointId: string) => string | undefined;
}

interface ShowResponse {
  model_info?: Record<string, unknown>;
  /** Ollama's own list, e.g. `['completion','tools']` or `[…,'thinking']`. */
  capabilities?: string[];
}

/**
 * What a server said about a model, separated from what we assumed.
 *
 * `contextLength: null` is the point of this shape. `contextLengthFrom` folded
 * "the server told us 32768" and "nothing answered, so assume 8192" into one
 * number, which is right for `RuntimeCapabilities` — the harness has to size
 * requests against *something* — and wrong for anything that displays it, since
 * showing an assumption as a fact is the confusion §3.3 spends three tiers
 * avoiding.
 */
interface SelfDescription {
  /** Ollama's capability strings, or null where nothing self-describes. */
  capabilities: string[] | null;
  /** The window the server reported, or null when it reported none. */
  contextLength: number | null;
}

/** The window a model declares, or the conservative floor when it declares none. */
function contextLengthFrom(shown: ShowResponse | null): number {
  return declaredContextLength(shown) ?? CONSERVATIVE_CONTEXT;
}

function declaredContextLength(shown: ShowResponse | null): number | null {
  for (const [k, v] of Object.entries(shown?.model_info ?? {})) {
    if (k.endsWith('.context_length') && typeof v === 'number') return v;
  }
  return null;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  readonly version = '0.0.1';

  /**
   * What a probe found, with the self-description it was built on.
   *
   * The pair is cached rather than the capabilities alone because a
   * `contextWindow` of 8192 has two meanings — the server said so, or nothing
   * answered and this is the floor — and `describe()` has to be able to tell
   * them apart afterwards.
   */
  private readonly probeCache = new Map<
    string,
    { caps: RuntimeCapabilities; described: SelfDescription; probeError?: string }
  >();

  constructor(private readonly opts?: OpenAiCompatibleOptions) {}

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
    if (hit) return hit.caps;

    const shown = await this.show(endpoint, modelId);
    const described: SelfDescription = {
      capabilities: shown?.capabilities ?? null,
      contextLength: declaredContextLength(shown),
    };
    const contextWindow = contextLengthFrom(shown);
    /*
     * Asked of the model, not assumed of the server (§3.3).
     *
     * This was the constant `'none'`, which was true of every model anyone had
     * tried and false as a rule: Ollama reports a `capabilities` array, and a
     * thinking model carries `thinking` in it — `qwen2.5:7b` reports
     * `['completion','tools']`, `deepseek-r1` and `qwen3` add the third. A
     * hard-coded `'none'` means `AgentSpec.reasoning` can never be honoured no
     * matter what is loaded, which is a capability declaring the product's
     * limits rather than the target's.
     *
     * Absent stays `'none'`. A server that does not answer `/api/show` is not an
     * admission that it can think; the effort control is then simply not offered.
     */
    const reasoningControl: RuntimeCapabilities['reasoningControl'] =
      (shown?.capabilities ?? []).includes('thinking') ? 'effort' : 'none';

    let tools: RuntimeCapabilities['tools'] = 'none';
    let schemaProfile: RuntimeCapabilities['schemaProfile'] = 'text-protocol';
    let parallel: RuntimeCapabilities['parallelToolCalls'] = 'none';
    /**
     * Why the probe request never completed, if it did not.
     *
     * `tools: 'none'` stays either way — the harness must not offer tools it
     * cannot verify — but the two roads to it are not the same claim, and
     * anything *displaying* the answer has to be able to tell them apart. A
     * model that answered in prose has been watched failing. An endpoint that
     * refused the connection has been watched doing nothing at all, and
     * reporting that as "this model cannot call tools" would put a defect on a
     * model because a laptop was closed.
     */
    let probeError: string | undefined;

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
    } catch (err) {
      // A failed probe is a `false` capability, never an assumed one — and the
      // reason is kept, so a hint can say *unknown* where the capabilities have
      // to say no.
      probeError = err instanceof Error ? err.message : String(err);
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
      // AgbrteHarness owns the gate for every provider-backed agent (§3.7).
      permissionFidelity: 'callback',
      contextWindow,
      maxOutputTokens: Math.min(4_096, Math.floor(contextWindow / 4)),
      serverSideCompaction: false,
      caching: 'none',
      reasoningControl,
      /*
       * `'raw'` where the model thinks, and observed rather than assumed: a
       * `qwen3:0.6b` turn through this endpoint comes back with 600-odd
       * characters in a `reasoning` field. It is raw rather than a summary —
       * the model's own scratchpad, not a rendering of it — and the adapter now
       * carries it, which is what makes the row true. §3.13 keeps declared and
       * observed apart, and this one is observed.
       */
      reasoningVisible: reasoningControl === 'effort' ? 'raw' : 'none',
      input: { ...ADAPTER_INPUT },
      // A local server bills nothing; `free` is the truth, not a placeholder.
      pricing: endpoint.locality === 'cloud' ? 'opaque' : 'free',
      costReporting: endpoint.locality === 'cloud' ? 'none' : 'per-request',
      tokenCounter: 'local-estimate',
      quotaModel: 'per-token-billing',
    };

    this.probeCache.set(key, {
      caps,
      described,
      ...(probeError !== undefined ? { probeError } : {}),
    });
    return caps;
  }

  /**
   * What can be said without running the model (§3.3).
   *
   * Two sources, kept apart all the way to the screen: a probe that has already
   * happened — free, and the only thing that has watched the model behave — and
   * the server's own account of itself, which is one `/api/show` and is what
   * §3.3 prefers wherever it exists. Neither is invented: a fact from neither
   * source is simply absent from the hint.
   *
   * Never probes. A picker calls this once per listed model, and a `probe()` per
   * row would be two inference requests per row behind a two-minute timeout —
   * the cost §3.13 already refused to pay once, for the same reason.
   */
  async describe(endpoint: ModelEndpoint, modelId: string): Promise<ModelCapabilityHint> {
    const key = `${endpoint.endpointId}::${modelId}`;
    const hit = this.probeCache.get(key);
    if (hit !== undefined) {
      // A probe that never reached the endpoint is not evidence about the
      // model, so the hint falls back to what the server said about itself and
      // carries the reason instead.
      return hit.probeError === undefined
        ? hintFrom(endpoint.endpointId, modelId, hit.described, hit.caps)
        : {
            ...hintFrom(endpoint.endpointId, modelId, hit.described, null),
            error: hit.probeError,
          };
    }

    // Re-read rather than cached: this is the one thing that changes when
    // somebody re-pulls a model, and the caller is a list somebody refreshed.
    const shown = await this.show(endpoint, modelId);
    return hintFrom(
      endpoint.endpointId,
      modelId,
      { capabilities: shown?.capabilities ?? null, contextLength: declaredContextLength(shown) },
      null,
    );
  }

  /** Whether this request may carry `reasoning_effort` at all. */
  private takesEffort(req: ProviderRequest): boolean {
    const mode = req.reasoning?.mode;
    if (mode === undefined || mode === 'auto' || mode === 'off') return false;
    const hit = this.probeCache.get(`${req.endpoint.endpointId}::${req.modelId}`);
    return hit?.caps.reasoningControl === 'effort';
  }

  async invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult> {
    const body = {
      model: req.modelId,
      stream: false,
      max_tokens: req.maxOutputTokens,
      /*
       * Sent only where the model takes it, and that is not a nicety.
       *
       * Measured against a live Ollama: `reasoning_effort` is **parsed and
       * validated**, not tolerated — `"banana"` comes back 400 — and sending
       * any value at all to a model without the `thinking` capability is also
       * **400**. So an ungated send does not degrade to a no-op; it kills every
       * request the moment a seat carries an effort and the model behind it is
       * ordinary. The first version of this did exactly that.
       *
       * The gate is the probe's own answer, read from the cache `probe()` fills
       * before any turn runs. Missing means unprobed, and unprobed means do not
       * send — the same direction §3.3 takes everywhere else.
       *
       * `'auto'` and `'off'` are omitted rather than sent: the first means "let
       * the model decide", which is what sending nothing already means, and the
       * second is not an effort level the wire format has.
       */
      ...(this.takesEffort(req) ? { reasoning_effort: req.reasoning?.mode } : {}),
      messages: toWireMessages(req),
      ...(req.tools && req.tools.length > 0
        ? { tools: req.tools.map(toWireTool), tool_choice: 'auto' }
        : {}),
    };

    /*
     * An empty reply is asked again, and then reported rather than swallowed.
     *
     * Ollama returns `finish_reason: "stop"`, no `content`, no `tool_calls` —
     * **and hundreds of completion tokens billed**. The model generated; the
     * reply carried none of it. Measured against `qwen2.5:7b` by replaying this
     * adapter's own captured request:
     *
     *     /v1/chat/completions   stream:false   7 empty / 57
     *     /v1/chat/completions   stream:true    4 empty / 40
     *     /api/chat (native)     stream:false   2 empty / 69
     *     /api/chat (native)     stream:true    1 empty / 90
     *
     * So it is the OpenAI-compatibility layer, and **streaming does not help** —
     * which is worth writing down, because streaming was the obvious fix and
     * forty runs said no. Ruled out with the request otherwise byte-identical:
     * not `tool_choice`, not `max_tokens`, not the context window (32k
     * available, ~2k used), and not length — 1,222-token replies arrived intact
     * while 537-token ones vanished.
     *
     * Nothing here can fix the server, so this does the two things an adapter
     * can. **Ask again**, because the failure is per-sample and independent: at
     * one turn in nine, two retries take it to one in seven hundred. And when it
     * survives that, **say so**: `transport` rather than a silent `end_turn`,
     * because a turn that spends tokens and produces nothing is not a model with
     * nothing to say. That distinction is what §3.5 means about a capability gap
     * being reported rather than becoming folklore — this one cost a day, an
     * agent in a group waiting on a teammate that had silently done nothing.
     *
     * Bounded at three attempts total, and only for a reply that is empty *and*
     * billed: an empty reply with no tokens spent is a model declining to speak,
     * which is an answer and must not be charged for twice.
     */
    const ask = async (): Promise<ProviderResult> =>
      normalize(
        await this.fetchJson<ChatResponse>(
          req.endpoint,
          '/chat/completions',
          body,
          undefined,
          opts.signal,
        ),
      );

    let result = await ask();
    for (let attempt = 0; attempt < EMPTY_REPLY_RETRIES; attempt += 1) {
      // An interrupt mid-retry is the person's answer, not the server's.
      if (!spentButSaidNothing(result) || opts.signal.aborted) break;
      result = await ask();
    }

    return spentButSaidNothing(result) ? { ...result, stop: { kind: 'transport' } } : result;
  }


  /** Ollama exposes the real context length; other servers may not. */
  /**
   * One `/api/show`, because two facts come out of it.
   *
   * This used to be a context-window fetch that threw the rest of the answer
   * away, and asking twice for a body already in hand is how the two facts end
   * up describing different moments.
   */
  private async show(endpoint: ModelEndpoint, modelId: string): Promise<ShowResponse | null> {
    const base = (endpoint.baseUrl ?? DEFAULT_BASE_URL).replace(/\/v1\/?$/, '');
    try {
      const res = await fetch(`${base}/api/show`, {
        method: 'POST',
        headers: this.headers(endpoint),
        body: JSON.stringify({ model: modelId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as ShowResponse;
    } catch {
      // Not an Ollama server, or unreachable. Null means "could not tell",
      // which every reader below degrades from rather than guesses past.
      return null;
    }
  }

  /**
   * Headers for one request, including a credential when the endpoint has one.
   *
   * The key is fetched here rather than carried on the `ModelEndpoint`, because
   * that object is passed around, logged, and sent to clients. `AuthMode` names
   * an `endpointId` — a *reference* to a credential — and honouring that reading
   * means nobody has to remember to strip a secret before serialising, which is
   * how secrets end up in transcripts.
   */
  private headers(endpoint: ModelEndpoint): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (endpoint.auth.kind === 'api-key') {
      // `endpoint.endpointId`, not `endpoint.auth` — `ModelEndpoint.auth` says
      // what *kind* of credential is needed and `AgentSpec.auth` is the union
      // that names one. Two different types, one word.
      const key = this.opts?.keyFor?.(endpoint.endpointId);
      // Absent is left absent rather than sent empty: a server answering 401 for
      // a missing key says something true, and `Bearer undefined` does not.
      if (key !== undefined) headers['authorization'] = `Bearer ${key}`;
    }
    return headers;
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
      headers: this.headers(endpoint),
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
 * One wire reply, in the shape the rest of the app reads.
 *
 * Module-level and pure, because `invoke` now calls it more than once — an empty
 * reply is asked again — and a normalization that lived inside the request would
 * have had to be copied to do that.
 */
function normalize(res: ChatResponse): ProviderResult {
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

  /*
   * `reasoning`, and `reasoning_content` as the other spelling in the wild.
   *
   * Measured against Ollama's OpenAI-compatible endpoint with `qwen3:0.6b`:
   * the field comes back as `reasoning`. vLLM and several gateways use
   * `reasoning_content` for the same thing, and reading both costs one `??`.
   */
  const thought =
    typeof message?.reasoning === 'string'
      ? message.reasoning
      : typeof message?.reasoning_content === 'string'
        ? message.reasoning_content
        : undefined;

  return {
    content,
    toolCalls,
    ...(thought !== undefined && thought.length > 0 ? { reasoning: thought } : {}),
    stop: mapFinishReason(choice?.finish_reason, toolCalls.length > 0),
    usage: {
      inputTokens: res.usage?.prompt_tokens ?? 0,
      outputTokens: res.usage?.completion_tokens ?? 0,
      ...(res.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cacheReadTokens: res.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    raw: res,
  };
}

/**
 * Deliberately conservative when the server will not say.
 *
 * Overstating a window is the failure §3.6 warns about — it surfaces as a
 * mid-run overflow after the work is already expensive.
 */
const CONSERVATIVE_CONTEXT = 8_192;

/**
 * What this adapter can carry, whatever the weights could.
 *
 * A configured constant in §3.3's sense, and true of the *adapter*: `flatten()`
 * below turns an image block into `[image … — this model cannot see images]`,
 * so a vision model reached through here still cannot be shown a screenshot.
 * Ollama's own `vision` capability is deliberately **not** reported upward,
 * because reporting it would describe weights this code has no way to reach and
 * §12's downgrade would still fire — a promise in the UI and a placeholder on
 * the wire.
 */
const ADAPTER_INPUT = { image: false, audio: false, pdf: false, video: false } as const;

/**
 * One model's facts, each labelled with where it came from (§3.3).
 *
 * Pure, and the only place the three tiers are assigned, so "is this claim
 * probed or merely declared" has one answer rather than one per caller.
 *
 * The asymmetry on `tools` is the interesting line and it is deliberate. A
 * server that lists `tools` for a model is saying its template *can* render
 * them — `qwen3:0.6b` says exactly that and then fails to emit a well-formed
 * call, which is the incident this hint exists for — so a declared yes is
 * offered as `self-described` and never as fact. A declared **no** is much
 * stronger: Ollama refuses the request outright (`CheckCapabilities` →
 * "does not support tools"), so there is nothing left to demonstrate.
 */
function hintFrom(
  endpointId: string,
  modelId: string,
  described: SelfDescription,
  caps: RuntimeCapabilities | null,
): ModelCapabilityHint {
  const declared = described.capabilities;

  const tools: ModelCapabilityHint['tools'] =
    caps !== null
      ? { value: caps.tools, from: 'probed' }
      : declared === null
        ? undefined
        : declared.includes('tools')
          ? { value: 'native', from: 'self-described' }
          : { value: 'none', from: 'self-described' };

  const contextWindow: ModelCapabilityHint['contextWindow'] =
    described.contextLength !== null
      ? { value: described.contextLength, from: 'self-described' }
      : caps !== null
        ? // The floor the harness will actually size against, labelled as the
          // assumption it is rather than shown as a number the server gave.
          { value: caps.contextWindow, from: 'configured' }
        : undefined;

  const reasoningControl: ModelCapabilityHint['reasoningControl'] =
    declared !== null
      ? { value: declared.includes('thinking') ? 'effort' : 'none', from: 'self-described' }
      : caps !== null
        ? { value: caps.reasoningControl, from: 'configured' }
        : undefined;

  return {
    endpointId,
    modelId,
    ...(tools !== undefined ? { tools } : {}),
    ...(caps !== null ? { schemaProfile: { value: caps.schemaProfile, from: 'probed' } } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    // Knowable with nothing asked at all: it is a fact about this adapter.
    imageInput: { value: ADAPTER_INPUT.image, from: 'configured' },
    ...(reasoningControl !== undefined ? { reasoningControl } : {}),
  };
}

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
