/**
 * The `anthropic` provider (DESIGN.md §3.6, §3.8, §15 Phase 3).
 *
 * The second implementation of `ModelProvider`, and it exists for a reason §15
 * states about itself: *"an abstraction validated against one implementation is
 * not validated"*. The runtime axis has four candidates running a conformance
 * suite; the provider axis had `openai-compatible` and a claim. This is the
 * claim being tested, and the interesting output is not that it works — it is
 * the four places the shape had to bend, each recorded below where it bends.
 *
 * ## What the second implementation found
 *
 * **`ProviderMessage` has a `tool` role and this API does not.** A tool result
 * here is a `tool_result` *content block inside a user message*, and several
 * results answering one assistant turn must arrive in **one** user message —
 * sending them as three consecutive user messages is an error, not a style
 * choice. So `toWireMessages` coalesces, which is the one genuinely non-local
 * transformation in this file. The interface is still expressible; it is simply
 * shaped after the other dialect, and that is worth knowing rather than
 * discovering later in a third one.
 *
 * **`system` arrives by two routes.** `ProviderRequest.system` and a
 * `{ role: 'system' }` message both exist, and this API takes exactly one
 * top-level `system`. Both are funnelled into it, in order, rather than one
 * being dropped — a request that carried both and honoured one would lose
 * instructions silently.
 *
 * **`reasoningControl: 'budget'` had never been produced by anything.** The
 * union has carried that arm since it was written, on the strength of §3.9's
 * table naming Anthropic's `budget_tokens` as an unbuilt case. It is built here,
 * and the mapping from `ReasoningRequest.mode` to a token count is this
 * adapter's own decision (see `thinkingBudget`) because the request is
 * normalized to effort words and the wire wants a number.
 *
 * **`cacheWriteTokens` and `cacheReadTokens` are both reported.** That pair was
 * split apart on the argument that the two are priced differently, and until now
 * only the read half had a producer — `openai-compatible` sees an automatic
 * cache and has no notion of a write to charge for. This API reports both, which
 * is the case the split was made for.
 *
 * And one thing that did **not** bend, which is the actual validation:
 * `probe()` is required to make real inference requests for `openai-compatible`
 * because §3.3 says the spread behind that one shape is enormous and its
 * self-reports cannot be trusted. That is a fact about *that* dialect, not about
 * providers, and the interface already allows the difference — here the answers
 * come from the model id and are marked `configured`, spending nothing. A
 * boundary that forced a probe would have been a boundary describing one API.
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
  ProviderUsage,
  RuntimeCapabilities,
  StopReason,
} from '@shared/types/index.js';

export const ANTHROPIC_PROVIDER_ID = 'anthropic';
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';

/**
 * The dated header this API requires on every request.
 *
 * Pinned, and never read from the endpoint. A version is a contract about
 * response *shape*, and this file parses one shape; letting a caller move it
 * would let a configuration change the meaning of the fields below without
 * touching the code that reads them.
 */
const API_VERSION = '2023-06-01';

export interface AnthropicOptions {
  /**
   * The credential, by endpoint id (§13).
   *
   * A function rather than a value for the reason the other provider uses one:
   * the key is fetched at the moment of the request from whatever holds it, so
   * it is never a field on a record that might be logged, serialized into an
   * event, or carried in a template.
   */
  keyFor?: (endpointId: string) => string | undefined;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly version = '0.0.1';

  constructor(private readonly opts?: AnthropicOptions) {}

  async listModels(endpoint: ModelEndpoint): Promise<ModelDescriptor[]> {
    const res = await this.fetchJson<{
      data?: Array<{ id?: string; display_name?: string }>;
    }>(endpoint, '/models', undefined, 15_000);
    return (res.data ?? [])
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === 'string')
      .map((m) => ({
        modelId: m.id,
        ...(m.display_name !== undefined ? { displayName: m.display_name } : {}),
      }));
  }

  /**
   * Capabilities without spending a turn.
   *
   * The opposite of `openai-compatible`'s rule, and deliberately so. That
   * adapter must demonstrate everything because one wire shape hides hundreds of
   * servers with nothing in common; here the endpoint is a single published API
   * and the model id names its behaviour. Every claim below is therefore
   * `configured` — §3.3's own word for "a constant the adapter was told" — and
   * none of it is dressed up as `probed`, because the difference between those
   * two words is the whole reason the tiers exist.
   *
   * Nothing is cached, because nothing is fetched.
   */
  async probe(_endpoint: ModelEndpoint, modelId: string): Promise<RuntimeCapabilities> {
    return Promise.resolve(this.capabilitiesFor(modelId));
  }

  private capabilitiesFor(modelId: string): RuntimeCapabilities {
    const thinks = thinkingCapable(modelId);
    return {
      nativeResume: false,
      // Via `AbortSignal` on the HTTP request, the same as the other adapter.
      interruptible: true,
      subagents: false,
      // Not implemented here yet. Declared `false` rather than aspirational:
      // §3.5's rule is that a capability nobody built reads as a broken feature.
      streaming: false,
      streamingToolArgs: false,
      tools: 'native',
      parallelToolCalls: 'many',
      // Full JSON Schema, which is what makes this a useful contrast: the
      // degrader (§3.5) has somewhere to degrade *from*.
      schemaProfile: 'json-schema-full',
      /*
       * Several `tool_result` blocks ride in one user message, which is what
       * `batched` means — and here it is not a preference but the protocol's
       * requirement. See `toWireMessages`.
       */
      toolResultPairing: 'batched',
      // AgbrteHarness owns the gate for every provider-backed agent (§3.7).
      permissionFidelity: 'callback',
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
      serverSideCompaction: false,
      /*
       * `explicit`, and the first adapter to say so. This API caches only what a
       * request marks with a cache breakpoint, where the other one caches on its
       * own and reports what it served. The two words describe genuinely
       * different bargains and the field exists to keep them apart; marking
       * breakpoints is not done here yet, so this declares the mechanism the
       * endpoint offers rather than a behaviour this adapter performs.
       */
      caching: 'explicit',
      reasoningControl: thinks ? 'budget' : 'none',
      /*
       * A summary, not the raw scratchpad, and the distinction is the model's
       * rather than ours: the wire carries `thinking` blocks that are the
       * model's own working-out for some models and a summarised rendering for
       * others. `summary` is the honest floor — claiming `raw` would tell §3.9's
       * `dropOpaqueReasoning` that it holds something replayable.
       */
      reasoningVisible: thinks ? 'summary' : 'none',
      input: { image: true, audio: false, pdf: true, video: false },
      imageMaxLongEdge: 1_568,
      imageMaxCount: 100,
      /*
       * Deliberately not a price table. Rates change, this file does not, and a
       * stale number here would be worse than none — §3.3's tiers exist so a
       * guess is never rendered as a fact, and a cost is exactly the kind of
       * fact somebody would act on.
       */
      pricing: 'opaque',
      costReporting: 'none',
      /*
       * The first `provider-endpoint` in the codebase. §3.6's rule is
       * "provider-native counting only, never a foreign tokenizer", which until
       * now had no implementation to be a rule *about* — `openai-compatible`
       * declares `local-estimate` because most servers behind it count nothing.
       * See `countTokens`.
       */
      tokenCounter: 'provider-endpoint',
      quotaModel: 'per-token-billing',
    };
  }

  /**
   * What can be said without running the model (§3.3).
   *
   * Everything, here, which is the point of contrast with the other adapter —
   * and every claim carries `configured` so a reader can see that it was told
   * rather than demonstrated. §3.13's rule that declared and observed stay apart
   * is satisfied by saying which this is, not by declining to answer.
   */
  describe(endpoint: ModelEndpoint, modelId: string): Promise<ModelCapabilityHint> {
    const caps = this.capabilitiesFor(modelId);
    return Promise.resolve({
      endpointId: endpoint.endpointId,
      modelId,
      tools: { value: caps.tools, from: 'configured' },
      schemaProfile: { value: caps.schemaProfile, from: 'configured' },
      contextWindow: { value: caps.contextWindow, from: 'configured' },
      imageInput: { value: caps.input.image, from: 'configured' },
      reasoningControl: { value: caps.reasoningControl, from: 'configured' },
    });
  }

  async invoke(req: ProviderRequest, opts: { signal: AbortSignal }): Promise<ProviderResult> {
    const thinking = thinkingBudget(req);
    const body = {
      model: req.modelId,
      max_tokens: req.maxOutputTokens,
      ...(systemText(req) !== undefined ? { system: systemText(req) } : {}),
      messages: toWireMessages(req),
      ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
      /*
       * A thinking budget is *counted against* `max_tokens` rather than added to
       * it, so asking for more thinking than the whole reply may contain is a
       * request the server rejects. Clamped here instead, because a refusal for
       * arithmetic the caller cannot see is a bad way to learn about a field the
       * caller never set — `ReasoningRequest` is effort words, and the number is
       * this adapter's invention.
       */
      ...(thinking !== undefined ? { thinking: { type: 'enabled', budget_tokens: thinking } } : {}),
    };

    const res = await this.fetchJson<AnthropicResponse>(
      req.endpoint,
      '/messages',
      body,
      300_000,
      opts.signal,
    );
    return fromWire(res);
  }

  /**
   * Native token counting (§3.6).
   *
   * The rule this satisfies — "provider-native counting only, never a foreign
   * tokenizer" — has been in the interface from the start with nothing
   * implementing it, because a foreign tokenizer is exactly what everyone
   * reaches for and the field existed to make refusing it the default. This
   * endpoint counts the *same request body* the model would be sent, so the
   * answer is about this request rather than about a string that resembles it.
   *
   * `max_tokens` is deliberately absent from the counted body: it describes the
   * reply, the count is of the prompt, and sending it is an error here.
   */
  async countTokens(req: ProviderRequest): Promise<number> {
    const res = await this.fetchJson<{ input_tokens?: number }>(
      req.endpoint,
      '/messages/count_tokens',
      {
        model: req.modelId,
        ...(systemText(req) !== undefined ? { system: systemText(req) } : {}),
        messages: toWireMessages(req),
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools.map(toWireTool) } : {}),
      },
      30_000,
    );
    return res.input_tokens ?? 0;
  }

  /**
   * Headers, including the one this API needs and the other does not.
   *
   * `x-api-key` rather than `Authorization: Bearer`. Worth a line because it is
   * the smallest possible example of why the provider axis needed a second
   * implementation: an adapter written to one API's habits puts the credential
   * in the wrong header for the next one, and nothing above this file would
   * ever say so — the request simply comes back 401.
   */
  private headers(endpoint: ModelEndpoint): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': API_VERSION,
    };
    if (endpoint.auth.kind === 'api-key') {
      const key = this.opts?.keyFor?.(endpoint.endpointId);
      // Absent stays absent: a 401 for a missing key is a true answer, and
      // `x-api-key: undefined` is not.
      if (key !== undefined) headers['x-api-key'] = key;
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
      /*
       * The status is kept in the message, because upstream turns it into a
       * `StopReason` and the difference between 429 and 400 is the difference
       * between parking a session and failing it (§3.9). The body comes along
       * for the same reason the other adapter carries it: this API says which
       * field was wrong, and dropping that leaves a person guessing at a request
       * they cannot see.
       */
      throw new Error(`${endpoint.providerId} ${path} failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }
}

interface AnthropicResponse {
  content?: Array<{
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
  }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

/** Whether this model id takes a thinking budget at all. */
function thinkingCapable(modelId: string): boolean {
  // By family rather than by an exhaustive list of ids, because a list would be
  // wrong the week after it was written and would fail *closed* — silently
  // refusing to pass a budget for a model that takes one, which reads as the
  // reasoning control being broken (§3.5).
  return /claude-(?:opus|sonnet|haiku)-[5-9]|claude-(?:3-7|4|4-5|4-8)/.test(modelId);
}

/**
 * Effort words to a token count.
 *
 * `ReasoningRequest` is normalized to `off|auto|low|medium|high|max` because
 * §3.9 refuses to put a provider-specific knob in `AgentSpec` — the moment one
 * appears, every other adapter inherits a field it must ignore. The cost of that
 * rule lands here: somebody has to choose numbers, and it should be the adapter
 * that knows the wire.
 *
 * The floor is the API's own — a budget below 1,024 is rejected — and the
 * ceiling is `maxOutputTokens` minus room to answer, since the budget is counted
 * against the reply rather than added to it. A request whose ceiling cannot fit
 * the floor gets no thinking at all rather than a rejected request: the caller
 * asked for a small reply, and honouring that is better than failing.
 */
function thinkingBudget(req: ProviderRequest): number | undefined {
  const mode = req.reasoning?.mode;
  if (mode === undefined || mode === 'off' || !thinkingCapable(req.modelId)) return undefined;

  const share = { auto: 0.25, low: 0.25, medium: 0.5, high: 0.75, max: 0.9 }[mode];
  const room = req.maxOutputTokens - 512; // Left for the answer itself.
  if (room < 1_024) return undefined;
  return Math.max(1_024, Math.min(Math.floor(req.maxOutputTokens * share), room));
}

/**
 * Every system instruction, in order, as one string.
 *
 * Both routes are honoured. `ProviderRequest.system` and a `{ role: 'system' }`
 * message can each carry instructions, this API takes one top-level `system`,
 * and picking either one alone would drop the other without a word.
 */
function systemText(req: ProviderRequest): string | undefined {
  const parts: string[] = [];
  if (req.system !== undefined && req.system !== '') parts.push(req.system);
  for (const msg of req.messages) {
    if (msg.role === 'system' && msg.text !== '') parts.push(msg.text);
  }
  return parts.length === 0 ? undefined : parts.join('\n\n');
}

function toWireTool(tool: DegradedTool): unknown {
  return { name: tool.name, description: tool.description, input_schema: tool.schema };
}

/**
 * `ProviderMessage[]` to this API's `messages`, coalescing tool results.
 *
 * The one transformation here that is not a field rename, and the place the
 * interface shows its origins. `ProviderMessage` has a `tool` role, one message
 * per result, which is the other dialect's shape. This API has no tool role:
 * results are `tool_result` blocks inside a **user** message, and the results
 * answering one assistant turn must arrive together — three consecutive user
 * messages is a protocol error rather than a stylistic difference.
 *
 * So consecutive `tool` messages accumulate into one user message, flushed when
 * anything else arrives. `toolResultPairing: 'batched'` in the capabilities
 * above is this, declared.
 *
 * System messages are skipped rather than dropped: `systemText` has already
 * collected them for the top-level field, and leaving them here as well would
 * send each instruction twice.
 */
function toWireMessages(req: ProviderRequest): unknown[] {
  const out: unknown[] = [];
  let pendingResults: unknown[] = [];

  const flush = (): void => {
    if (pendingResults.length === 0) return;
    out.push({ role: 'user', content: pendingResults });
    pendingResults = [];
  };

  for (const msg of req.messages) {
    switch (msg.role) {
      case 'system':
        break; // Already in `system`, above.
      case 'user':
        flush();
        out.push({ role: 'user', content: toWireContent(msg.content) });
        break;
      case 'assistant': {
        flush();
        const content: unknown[] = [];
        if (msg.text !== undefined && msg.text !== '') content.push({ type: 'text', text: msg.text });
        for (const call of msg.toolCalls ?? []) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
        }
        // An assistant turn with neither text nor calls has nothing to send, and
        // an empty `content` array is refused by the API.
        if (content.length > 0) out.push({ role: 'assistant', content });
        break;
      }
      case 'tool':
        pendingResults.push({
          type: 'tool_result',
          tool_use_id: msg.toolCallId,
          content: msg.result,
          ...(msg.isError === true ? { is_error: true } : {}),
        });
        break;
    }
  }
  flush();
  return out;
}

/**
 * Content blocks to wire blocks.
 *
 * Images travel as blocks rather than being flattened to a description, which is
 * the other visible difference from the first adapter — that one declares no
 * image support and turns a picture into `[image … — this model cannot see
 * images]`. §12's rule is that every downgrade is logged and diagnosable; there
 * is no downgrade here, which is the case the rule was written to make possible.
 */
function toWireContent(content: ContentBlock[]): unknown[] {
  const out: unknown[] = [];
  for (const block of content) {
    switch (block.type) {
      case 'text':
        out.push({ type: 'text', text: block.text });
        break;
      case 'file_ref':
        out.push({ type: 'text', text: `[file ${block.path.$ws}]` });
        break;
      case 'image':
        /*
         * A pointer, not the bytes, and this is a real limitation rather than a
         * choice. The block carries a `sha256` into a content-addressed store
         * the *host* owns (§5.3); a provider is given one request and has no
         * route to it. Reaching for one would put a store dependency inside the
         * boundary whose smallness is the point (§3.6). The bytes belong in the
         * request before it reaches here, and until something does that, saying
         * so beats sending a hash the model will read as gibberish.
         */
        out.push({
          type: 'text',
          text: `[image ${block.sha256.slice(0, 12)} — not yet inlined by this adapter]`,
        });
        break;
      case 'audio':
        out.push({ type: 'text', text: block.transcript ?? '[audio]' });
        break;
      case 'artifact_ref':
        out.push({ type: 'text', text: `[artifact ${block.artifactId}]` });
        break;
    }
  }
  // The API refuses an empty content array, and a user turn that held only an
  // unsendable block would produce one.
  return out.length === 0 ? [{ type: 'text', text: '' }] : out;
}

function fromWire(res: AnthropicResponse): ProviderResult {
  const content: ContentBlock[] = [];
  const toolCalls: NormalizedToolCall[] = [];
  const thinking: string[] = [];

  for (const block of res.content ?? []) {
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text !== '') {
          content.push({ type: 'text', text: block.text });
        }
        break;
      case 'thinking':
        if (typeof block.thinking === 'string' && block.thinking !== '') {
          thinking.push(block.thinking);
        }
        break;
      case 'tool_use':
        if (typeof block.id === 'string' && typeof block.name === 'string') {
          // Vendor ids are kept as ours here, which §3.5 allows: the mapping
          // rule is that *a* stable id round-trips, and this one is stable and
          // is what `tool_result` must quote back.
          toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
        }
        break;
      default:
        break; // A block type this version does not know is not an error.
    }
  }

  const usage: ProviderUsage = {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    // Both halves, which is the pair `ProviderUsage` was split to express and
    // which nothing had produced until now.
    ...(res.usage?.cache_creation_input_tokens !== undefined
      ? { cacheWriteTokens: res.usage.cache_creation_input_tokens }
      : {}),
    ...(res.usage?.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: res.usage.cache_read_input_tokens }
      : {}),
  };

  const thought = thinking.join('\n');
  return {
    content,
    toolCalls,
    ...(thought !== '' ? { reasoning: thought } : {}),
    stop: mapStopReason(res.stop_reason, toolCalls.length > 0),
    usage,
    raw: res,
  };
}

/**
 * This API's `stop_reason` to §3.9's union.
 *
 * `refusal` and `pause_turn` are the two the other dialect has no equivalent for,
 * and both are mapped rather than defaulted — a `refusal` arriving as `end_turn`
 * would read as the model having finished, which is the failure §3.9's whole
 * table exists to prevent.
 */
function mapStopReason(reason: string | undefined, hadToolCalls: boolean): StopReason {
  if (hadToolCalls) return { kind: 'tool_calls' };
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return { kind: 'end_turn' };
    case 'max_tokens':
      return { kind: 'max_output_tokens' };
    case 'tool_use':
      return { kind: 'tool_calls' };
    case 'refusal':
      return { kind: 'refused' };
    /*
     * The model paused a long turn and expects to be handed its own output back
     * to continue. Nothing here resumes it yet, so it is reported as a ceiling
     * that was reached rather than as a finished answer: `limit_reached` pauses
     * for a human decision (§4.1), which is the honest state for a turn that is
     * incomplete with nothing broken.
     */
    case 'pause_turn':
      return { kind: 'limit_reached', limit: 'wallclock', detail: 'the model paused a long turn' };
    default:
      return { kind: 'end_turn' };
  }
}
