/**
 * The `anthropic` provider's wire translation (DESIGN.md §3.3, §3.6, §15 Phase 3).
 *
 * Against a stubbed `fetch`, for the reason its neighbour gives: the parts most
 * likely to break silently are the mappings, and a live run exercises the happy
 * path while hiding every one of them.
 *
 * What is asserted here is chosen by what the *second* implementation of
 * `ModelProvider` is for. §15 says an abstraction validated against one
 * implementation is not validated, so the interesting tests are the places where
 * this API and `openai-compatible` genuinely disagree — a tool result that is
 * not a message, a system prompt with two sources, a reasoning control that is a
 * number rather than a word, and a cache that charges for writes. Anything both
 * adapters do identically is already covered next door.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider, ANTHROPIC_PROVIDER_ID } from '@main/runtime/providers/anthropic.js';
import type { ModelEndpoint, ProviderRequest } from '@shared/types/index.js';

const CLOUD: ModelEndpoint = {
  endpointId: 'anthropic-cloud',
  providerId: ANTHROPIC_PROVIDER_ID,
  auth: { kind: 'api-key' },
  locality: 'cloud',
  dataHandling: { provider: 'anthropic' },
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

let calls: Call[];
const realFetch = globalThis.fetch;

function stubFetch(routes: Record<string, unknown>, opts: { status?: number } = {}): void {
  globalThis.fetch = vi.fn(
    async (input: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
      const url = String(input);
      calls.push({
        url,
        headers: init?.headers ?? {},
        body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      });
      const key = Object.keys(routes).find((k) => url.includes(k));
      if (key === undefined) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(routes[key]), {
        status: opts.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  ) as typeof fetch;
}

const reply = (over: Record<string, unknown> = {}) => ({
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 11, output_tokens: 3 },
  ...over,
});

const lastBody = (path: string): Record<string, unknown> =>
  calls.filter((c) => c.url.includes(path)).at(-1)?.body ?? {};

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    endpoint: CLOUD,
    modelId: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxOutputTokens: 8_192,
    ...over,
  };
}

const signal = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('a tool result is not a message here', () => {
  it('folds consecutive tool results into one user message', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'search twice' }] },
          {
            role: 'assistant',
            toolCalls: [
              { id: 'a', name: 'search', args: { q: 'one' } },
              { id: 'b', name: 'search', args: { q: 'two' } },
            ],
          },
          { role: 'tool', toolCallId: 'a', name: 'search', result: 'first' },
          { role: 'tool', toolCallId: 'b', name: 'search', result: 'second' },
        ],
      }),
      signal(),
    );

    /*
     * The single non-local transformation in the adapter, and the clearest
     * evidence `ProviderMessage` is shaped after the other dialect. There it is
     * one message per result; here results are blocks inside a *user* message,
     * and two consecutive user messages answering one assistant turn is a
     * protocol error rather than a stylistic difference.
     */
    const messages = lastBody('/messages')['messages'] as Array<{
      role: string;
      content: Array<{ type: string; tool_use_id?: string }>;
    }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const results = messages[2]!.content;
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(results.every((r) => r.type === 'tool_result')).toBe(true);
  });

  it('marks a failed result rather than passing it as an answer', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({
        messages: [
          { role: 'assistant', toolCalls: [{ id: 'a', name: 'search', args: {} }] },
          { role: 'tool', toolCallId: 'a', name: 'search', result: 'boom', isError: true },
        ],
      }),
      signal(),
    );

    const messages = lastBody('/messages')['messages'] as Array<{
      content: Array<Record<string, unknown>>;
    }>;
    // A tool that failed and a tool that returned the string "boom" are
    // different things to a model, and only one of them should be retried.
    expect(messages.at(-1)!.content[0]!['is_error']).toBe(true);
  });

  it('drops an assistant turn with nothing in it', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', text: '' },
        ],
      }),
      signal(),
    );

    // An empty `content` array is refused by the API, so a turn that carried
    // neither text nor calls must not become one.
    const messages = lastBody('/messages')['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('the system prompt, which arrives by two routes', () => {
  it('sends both, in order, as one top-level system', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({
        system: 'from the request',
        messages: [
          { role: 'system', text: 'from a message' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
      signal(),
    );

    // `ProviderRequest.system` and a system *message* can each carry
    // instructions; this API takes one field. Honouring either alone would drop
    // the other with nothing said about it.
    expect(lastBody('/messages')['system']).toBe('from the request\n\nfrom a message');
  });

  it('does not also leave the system message in the conversation', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({
        messages: [
          { role: 'system', text: 'be brief' },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
      signal(),
    );

    // The other half of the same bug: collected into `system` *and* left in
    // place sends the instruction twice.
    const messages = lastBody('/messages')['messages'] as Array<{ role: string }>;
    expect(messages.map((m) => m.role)).toEqual(['user']);
  });
});

describe('a reasoning budget, which is the first of its kind', () => {
  it('turns an effort word into a token count', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({ reasoning: { mode: 'high' }, maxOutputTokens: 8_192 }),
      signal(),
    );

    /*
     * `reasoningControl: 'budget'` has been in the union since it was written
     * with nothing producing it. §3.9 keeps provider-specific knobs out of
     * `AgentSpec`, so the request carries an effort word and the adapter owns
     * the arithmetic — which is exactly where a number that only means something
     * on one wire belongs.
     */
    const thinking = lastBody('/messages')['thinking'] as { type: string; budget_tokens: number };
    expect(thinking.type).toBe('enabled');
    expect(thinking.budget_tokens).toBe(Math.floor(8_192 * 0.75));
  });

  it('leaves room to answer, since the budget comes out of the reply', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({ reasoning: { mode: 'max' }, maxOutputTokens: 2_000 }),
      signal(),
    );

    // Counted *against* `max_tokens` rather than added to it, so an unclamped
    // 0.9 share would leave 200 tokens for the answer.
    const thinking = lastBody('/messages')['thinking'] as { budget_tokens: number };
    expect(thinking.budget_tokens).toBeLessThanOrEqual(2_000 - 512);
  });

  it('asks for none when the ceiling cannot hold the floor', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({ reasoning: { mode: 'high' }, maxOutputTokens: 900 }),
      signal(),
    );

    // The API's own floor is 1,024. A caller who asked for a short reply gets
    // one, rather than a request the server rejects for arithmetic they never saw.
    expect(lastBody('/messages')['thinking']).toBeUndefined();
  });

  it('asks for none from a model that does not take one', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(
      request({ modelId: 'claude-2.1', reasoning: { mode: 'high' } }),
      signal(),
    );
    expect(lastBody('/messages')['thinking']).toBeUndefined();
  });

  it('reports the control as a budget, and says it was configured not probed', async () => {
    const hint = await new AnthropicProvider().describe(CLOUD, 'claude-opus-5');
    expect(hint.reasoningControl).toEqual({ value: 'budget', from: 'configured' });
    // §3.3's tiers are only worth carrying if a claim says which it is. Nothing
    // here was demonstrated, and dressing it as `probed` is the confusion the
    // three words exist to prevent.
    expect(hint.tools?.from).toBe('configured');
    expect(hint.contextWindow?.from).toBe('configured');
  });

  it('describes without making a request at all', async () => {
    stubFetch({});
    await new AnthropicProvider().describe(CLOUD, 'claude-opus-5');
    // The contrast with `openai-compatible`, which must demonstrate everything
    // because one wire shape hides hundreds of servers. This endpoint is one
    // published API, so the answers cost nothing — and an interface that forced
    // a probe would have been an interface describing the other adapter.
    expect(calls).toHaveLength(0);
  });
});

describe('usage, including the half nothing had ever reported', () => {
  it('carries cache writes and reads separately', async () => {
    stubFetch({
      '/messages': reply({
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 900,
        },
      }),
    });
    const result = await new AnthropicProvider().invoke(request(), signal());

    // The pair was split apart because writing a cache and reading one are
    // priced differently, and until this adapter only the read half had a
    // producer — the other dialect caches automatically and has no write to
    // charge for.
    expect(result.usage.cacheWriteTokens).toBe(400);
    expect(result.usage.cacheReadTokens).toBe(900);
  });

  it('leaves a cache field absent when the reply carried none', async () => {
    stubFetch({ '/messages': reply() });
    const result = await new AnthropicProvider().invoke(request(), signal());
    // Absent is not zero: "did not report" and "cached nothing" are different
    // sentences, and only one of them is true here.
    expect(result.usage).not.toHaveProperty('cacheWriteTokens');
    expect(result.usage).not.toHaveProperty('cacheReadTokens');
  });
});

describe('what came back', () => {
  it('separates thinking from the answer', async () => {
    stubFetch({
      '/messages': reply({
        content: [
          { type: 'thinking', thinking: 'working it out' },
          { type: 'text', text: 'the answer' },
        ],
      }),
    });
    const result = await new AnthropicProvider().invoke(request(), signal());

    // §3.9 keeps these apart because they are different kinds of thing: one is
    // addressed to the reader and the other is the working-out.
    expect(result.reasoning).toBe('working it out');
    expect(result.content).toEqual([{ type: 'text', text: 'the answer' }]);
  });

  it('reads tool calls out of the content blocks', async () => {
    stubFetch({
      '/messages': reply({
        content: [{ type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'x' } }],
        stop_reason: 'tool_use',
      }),
    });
    const result = await new AnthropicProvider().invoke(request(), signal());

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search', args: { q: 'x' } }]);
    expect(result.stop).toEqual({ kind: 'tool_calls' });
  });

  it('ignores a block type this version does not know', async () => {
    stubFetch({
      '/messages': reply({
        content: [{ type: 'something_new', text: 'ignore me' }, { type: 'text', text: 'kept' }],
      }),
    });
    const result = await new AnthropicProvider().invoke(request(), signal());
    // A new block type is the API moving, not this request failing.
    expect(result.content).toEqual([{ type: 'text', text: 'kept' }]);
  });

  it('reports a refusal as a refusal, not as a finished turn', async () => {
    stubFetch({ '/messages': reply({ content: [], stop_reason: 'refusal' }) });
    const result = await new AnthropicProvider().invoke(request(), signal());
    // The stop reason the other dialect has no equivalent for. Defaulted to
    // `end_turn` it would read as the model having answered, which is the exact
    // confusion §3.9's table exists to prevent.
    expect(result.stop).toEqual({ kind: 'refused' });
  });

  it('parks a paused turn rather than calling it done', async () => {
    stubFetch({ '/messages': reply({ stop_reason: 'pause_turn' }) });
    const result = await new AnthropicProvider().invoke(request(), signal());
    // Nothing here resumes one yet, so it stops for a person: incomplete with
    // nothing broken is what `limit_reached` means (§4.1).
    expect(result.stop).toMatchObject({ kind: 'limit_reached', limit: 'wallclock' });
  });
});

describe('the credential and the headers', () => {
  it('sends the key in this API’s header, not the other one’s', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider({ keyFor: () => 'sk-test' }).invoke(request(), signal());

    // The smallest possible reason the provider axis needed a second
    // implementation: an adapter written to one API's habits puts the
    // credential in the wrong header, and nothing above this file would say so.
    // The request just comes back 401.
    expect(calls.at(-1)!.headers['x-api-key']).toBe('sk-test');
    expect(calls.at(-1)!.headers['authorization']).toBeUndefined();
    expect(calls.at(-1)!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('sends no key header at all when there is no key', async () => {
    stubFetch({ '/messages': reply() });
    await new AnthropicProvider().invoke(request(), signal());
    // A 401 for a missing key is a true answer; `x-api-key: undefined` is not.
    expect(calls.at(-1)!.headers).not.toHaveProperty('x-api-key');
  });

  it('keeps the status in the error, since upstream turns it into a stop reason', async () => {
    stubFetch({ '/messages': { error: { message: 'rate limited' } } }, { status: 429 });
    await expect(new AnthropicProvider().invoke(request(), signal())).rejects.toThrow(/429/);
  });
});

describe('counting tokens, natively', () => {
  it('asks the endpoint about this request', async () => {
    stubFetch({ '/messages/count_tokens': { input_tokens: 1234 } });
    const count = await new AnthropicProvider().countTokens(request({ system: 'be brief' }));

    /*
     * §3.6's "provider-native counting only, never a foreign tokenizer" has been
     * in the interface from the start with nothing implementing it. The counted
     * body is the one the model would be sent, so the answer is about this
     * request rather than about a string that resembles it.
     */
    expect(count).toBe(1234);
    const body = lastBody('/messages/count_tokens');
    expect(body['system']).toBe('be brief');
    expect(body['model']).toBe('claude-opus-5');
    // `max_tokens` describes the reply, the count is of the prompt, and sending
    // it here is an error.
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('declares that it counts at the endpoint', async () => {
    const caps = await new AnthropicProvider().probe(CLOUD, 'claude-opus-5');
    // The first `provider-endpoint` in the codebase; the other adapter says
    // `local-estimate` because most servers behind it count nothing.
    expect(caps.tokenCounter).toBe('provider-endpoint');
    expect(caps.caching).toBe('explicit');
  });
});

describe('models', () => {
  it('keeps the provider’s own id and its display name', async () => {
    stubFetch({
      '/models': { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'x' }] },
    });
    const models = await new AnthropicProvider().listModels(CLOUD);
    // §3.4's rule: the provider's string, verbatim, never reconstructed.
    expect(models).toEqual([
      { modelId: 'claude-opus-5', displayName: 'Claude Opus 5' },
      { modelId: 'x' },
    ]);
  });
});
