/**
 * The `openai-compatible` provider's wire translation and probe (DESIGN.md §3.3, §3.6).
 *
 * Everything here runs against a stubbed `fetch`, because the parts most likely
 * to break silently are the mappings — a `finish_reason` we don't recognize, a
 * tool call whose arguments won't parse, an image sent to a model that cannot
 * see it. A live run exercises the happy path and hides all three.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@main/runtime/providers/openaiCompatible.js';
import type { ModelEndpoint, ProviderRequest } from '@shared/types/index.js';

const LOCAL: ModelEndpoint = {
  endpointId: 'local',
  providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
  baseUrl: 'http://127.0.0.1:11434/v1',
  auth: { kind: 'none' },
  locality: 'app-local',
  dataHandling: { provider: 'local' },
};

const CLOUD: ModelEndpoint = { ...LOCAL, endpointId: 'cloud', locality: 'cloud' };

interface Call {
  url: string;
  body: Record<string, unknown> | null;
}

let calls: Call[];
const realFetch = globalThis.fetch;

/** Route each URL to a canned response; record every request. */
function stubFetch(routes: Record<string, unknown>, opts: { status?: number } = {}): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: { body?: string }) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });

    const key = Object.keys(routes).find((k) => url.includes(k));
    if (key === undefined) {
      return new Response('not found', { status: 404 });
    }
    return new Response(JSON.stringify(routes[key]), {
      status: opts.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const chat = (message: unknown, finish = 'stop', usage = { prompt_tokens: 11, completion_tokens: 3 }) => ({
  choices: [{ finish_reason: finish, message }],
  usage,
});

const lastChatBody = (): Record<string, unknown> =>
  calls.filter((c) => c.url.includes('/chat/completions')).at(-1)?.body ?? {};

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    endpoint: LOCAL,
    modelId: 'stub-model',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    maxOutputTokens: 512,
    ...over,
  };
}

const signal = () => ({ signal: new AbortController().signal });

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('listModels', () => {
  it('returns the ids the server advertises', async () => {
    stubFetch({ '/models': { data: [{ id: 'qwen2.5:7b' }, { id: 'llama3' }, { nope: true }] } });
    const models = await new OpenAiCompatibleProvider().listModels(LOCAL);
    expect(models.map((m) => m.modelId)).toEqual(['qwen2.5:7b', 'llama3']);
  });

  it('throws with the status when the server rejects', async () => {
    stubFetch({ '/models': { error: 'boom' } }, { status: 500 });
    await expect(new OpenAiCompatibleProvider().listModels(LOCAL)).rejects.toThrow(/failed: 500/);
  });
});

describe('request translation', () => {
  it('puts the system prompt first, ahead of history', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(request({ system: 'Be terse.' }), signal());

    const messages = lastChatBody()['messages'] as Array<{ role: string; content: string }>;
    // Stable prefix first — correct for caching and harmless otherwise (§3.7).
    expect(messages[0]).toEqual({ role: 'system', content: 'Be terse.' });
    expect(messages[1]?.role).toBe('user');
  });

  it('translates an assistant turn carrying tool calls', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'done' }) });
    await new OpenAiCompatibleProvider().invoke(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', text: 'calling', toolCalls: [{ id: 'c1', name: 'read', args: { file_path: 'a.ts' } }] },
          { role: 'tool', toolCallId: 'c1', name: 'read', result: 'contents' },
        ],
      }),
      signal(),
    );

    const messages = lastChatBody()['messages'] as Array<Record<string, unknown>>;
    // §3.6's `NormalizedTurn[]` cannot express this shape; ProviderMessage can.
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: 'calling',
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } }],
    });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'contents' });
  });

  it('omits tool_calls from an assistant turn that had none', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(
      request({ messages: [{ role: 'assistant', text: 'plain' }] }),
      signal(),
    );
    expect((lastChatBody()['messages'] as Array<Record<string, unknown>>)[0]).not.toHaveProperty('tool_calls');
  });

  it('wraps tool schemas in the function envelope', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    const schema = { type: 'object', properties: { p: { type: 'string' } }, required: ['p'] };
    await new OpenAiCompatibleProvider().invoke(
      request({ tools: [{ name: 'glob', description: 'find files', schema }] }),
      signal(),
    );

    expect(lastChatBody()['tools']).toEqual([
      { type: 'function', function: { name: 'glob', description: 'find files', parameters: schema } },
    ]);
    expect(lastChatBody()['tool_choice']).toBe('auto');
  });

  it('sends no tools key at all when there are none', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(request({ tools: [] }), signal());
    expect(lastChatBody()).not.toHaveProperty('tools');
  });

  it('degrades an image to a pointer that says the model cannot see it', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'look' },
              {
                type: 'image',
                sha256: 'a'.repeat(64) as never,
                mime: 'image/png',
                width: 10,
                height: 10,
                provenance: { kind: 'paste', origin: 'client' },
              },
            ],
          },
        ],
      }),
      signal(),
    );

    const content = (lastChatBody()['messages'] as Array<{ content: string }>)[0]?.content ?? '';
    // Silent dropping is what makes "the model ignored my screenshot" folklore.
    expect(content).toContain('cannot see images');
  });

  it('renders a file reference as a workspace-relative pointer', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(
      request({ messages: [{ role: 'user', content: [{ type: 'file_ref', path: { $ws: 'src/a.ts' } }] }] }),
      signal(),
    );
    expect((lastChatBody()['messages'] as Array<{ content: string }>)[0]?.content).toBe('[file src/a.ts]');
  });
});

describe('response translation', () => {
  it('parses tool calls and normalizes their ids', async () => {
    stubFetch({
      '/chat/completions': chat(
        {
          content: '',
          tool_calls: [
            { id: 'call_x', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } },
          ],
        },
        'tool_calls',
      ),
    });

    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.toolCalls).toEqual([{ id: 'call_x', name: 'read', args: { file_path: 'a.ts' } }]);
    expect(result.stop).toEqual({ kind: 'tool_calls' });
  });

  it('surfaces malformed arguments instead of throwing', async () => {
    stubFetch({
      '/chat/completions': chat(
        { content: '', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{not json' } }] },
        'tool_calls',
      ),
    });

    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    // The harness repair-prompts on this; a throw would lose the whole turn.
    expect(result.toolCalls[0]?.args).toEqual({ __malformed: '{not json' });
  });

  it('skips a tool call with no name', async () => {
    stubFetch({
      '/chat/completions': chat({ content: '', tool_calls: [{ id: 'c1', function: {} }] }, 'tool_calls'),
    });
    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.toolCalls).toEqual([]);
  });

  it('extracts usage', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'ok' }, 'stop', { prompt_tokens: 42, completion_tokens: 9 }) });
    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.usage).toEqual({ inputTokens: 42, outputTokens: 9 });
  });

  it('treats absent usage as zero rather than undefined', async () => {
    stubFetch({ '/chat/completions': { choices: [{ finish_reason: 'stop', message: { content: 'x' } }] } });
    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('emits no text block for an empty response', async () => {
    stubFetch({ '/chat/completions': chat({ content: '' }) });
    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.content).toEqual([]);
  });

  const finishes: Array<[string, string]> = [
    ['stop', 'end_turn'],
    ['length', 'max_output_tokens'],
    ['content_filter', 'content_filtered'],
    ['tool_calls', 'tool_calls'],
    ['something_new', 'end_turn'],
  ];

  for (const [wire, kind] of finishes) {
    it(`maps finish_reason "${wire}" to ${kind}`, async () => {
      stubFetch({ '/chat/completions': chat({ content: 'x' }, wire) });
      const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
      expect(result.stop.kind).toBe(kind);
    });
  }

  it('lets the presence of tool calls override a stop finish_reason', async () => {
    // Some servers report "stop" alongside tool calls; the calls are the truth.
    stubFetch({
      '/chat/completions': chat(
        { content: '', tool_calls: [{ id: 'c1', function: { name: 'glob', arguments: '{}' } }] },
        'stop',
      ),
    });
    const result = await new OpenAiCompatibleProvider().invoke(request(), signal());
    expect(result.stop).toEqual({ kind: 'tool_calls' });
  });
});

describe('probe — capability by demonstration (§3.3)', () => {
  const nestedCall = {
    content: '',
    tool_calls: [
      {
        id: 'c1',
        function: { name: 'get_weather', arguments: '{"city":"Paris","options":{"unit":"celsius"}}' },
      },
    ],
  };

  it('claims native tools and a strict schema when nesting survives', async () => {
    stubFetch({ '/api/show': { model_info: { 'qwen2.arch.context_length': 32768 } }, '/chat/completions': chat(nestedCall, 'tool_calls') });

    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'qwen2.5:7b');
    expect(caps.tools).toBe('native');
    expect(caps.schemaProfile).toBe('strict-subset');
    expect(caps.contextWindow).toBe(32768);
  });

  it('drops to flat-only when the model flattens a nested argument', async () => {
    stubFetch({
      '/api/show': { model_info: {} },
      '/chat/completions': chat(
        { content: '', tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{"city":"Paris","options":"celsius"}' } }] },
        'tool_calls',
      ),
    });

    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'small');
    expect(caps.tools).toBe('native');
    // A reduced profile beats a broken one.
    expect(caps.schemaProfile).toBe('flat-only');
  });

  it('reports no tool support when the model answers in text', async () => {
    stubFetch({ '/api/show': { model_info: {} }, '/chat/completions': chat({ content: 'It is sunny.' }) });

    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'chatty');
    expect(caps.tools).toBe('none');
    expect(caps.schemaProfile).toBe('text-protocol');
    expect(caps.parallelToolCalls).toBe('none');
  });

  it('treats a failed probe as a false capability, never an assumed one', async () => {
    stubFetch({ '/api/show': { model_info: {} } }, { status: 500 });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'broken');
    expect(caps.tools).toBe('none');
  });

  it('falls back to a conservative context window when the server will not say', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'hi' }) });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'unknown');
    // Overstating a window surfaces as a mid-run overflow (§3.6).
    expect(caps.contextWindow).toBe(8192);
  });

  it('never claims native resume — a raw endpoint has no session', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'hi' }) });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'any');
    expect(caps.nativeResume).toBe(false);
    expect(caps.permissionFidelity).toBe('callback');
  });

  it('reports a local endpoint as free and a cloud one as opaque', async () => {
    stubFetch({ '/chat/completions': chat({ content: 'hi' }) });
    const provider = new OpenAiCompatibleProvider();
    expect((await provider.probe(LOCAL, 'm')).pricing).toBe('free');
    expect((await provider.probe(CLOUD, 'm')).costReporting).toBe('none');
  });

  it('caches per endpoint and model', async () => {
    stubFetch({ '/api/show': { model_info: {} }, '/chat/completions': chat({ content: 'hi' }) });
    const provider = new OpenAiCompatibleProvider();

    await provider.probe(LOCAL, 'm1');
    const afterFirst = calls.length;
    await provider.probe(LOCAL, 'm1');
    expect(calls.length).toBe(afterFirst);

    // A different model is a different capability set (§3.2).
    await provider.probe(LOCAL, 'm2');
    expect(calls.length).toBeGreaterThan(afterFirst);
  });
});

/**
 * Whether a model can be asked to think harder (§3.3, §3.4).
 *
 * `reasoningControl` was the constant `'none'` — true of every model anyone had
 * tried, and false as a rule. `AgentSpec.reasoning` is plumbed from the seat all
 * the way to this adapter, so a hard-coded `'none'` meant the field could never
 * be honoured whatever was loaded: a capability describing the adapter's limits
 * while claiming to describe the target's.
 *
 * Ollama answers the question directly. `/api/show` returns a `capabilities`
 * array — `qwen2.5:7b` reports `['completion','tools']`, and a thinking model
 * adds `'thinking'`. Measured against the local server rather than read from a
 * changelog.
 */
describe('reasoning support', () => {
  const show = (capabilities: string[]) => ({
    capabilities,
    model_info: { 'qwen2.context_length': 32_768 },
  });

  it('offers effort control when the model says it can think', async () => {
    stubFetch({ '/api/show': show(['completion', 'tools', 'thinking']), '/models': { data: [] } });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'thinker');
    expect(caps.reasoningControl).toBe('effort');
  });

  it('does not offer it for a model that only completes and calls tools', async () => {
    stubFetch({ '/api/show': show(['completion', 'tools']), '/models': { data: [] } });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'plain');
    expect(caps.reasoningControl).toBe('none');
  });

  it('treats an unanswerable probe as cannot rather than can', async () => {
    // A server that is not Ollama says nothing about thinking. Silence is not
    // an admission of capability — §3.3's direction of travel for every row.
    stubFetch({ '/models': { data: [] } });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'unknown');
    expect(caps.reasoningControl).toBe('none');
  });

  it('still reads the context window from the same answer', async () => {
    // One `/api/show` now serves both facts. Asking twice for a body already in
    // hand is how two facts end up describing different moments.
    stubFetch({ '/api/show': show(['completion']), '/models': { data: [] } });
    const caps = await new OpenAiCompatibleProvider().probe(LOCAL, 'plain');
    expect(caps.contextWindow).toBe(32_768);
    expect(calls.filter((c) => c.url.includes('/api/show'))).toHaveLength(1);
  });

  it('puts the requested effort on the wire for a model that takes it', async () => {
    // The half that makes the capability true. A `reasoningControl: 'effort'`
    // that no request carries describes something the adapter does not do.
    stubFetch({
      '/api/show': show(['completion', 'tools', 'thinking']),
      '/models': { data: [] },
      '/chat/completions': chat({ content: 'ok' }),
    });
    const provider = new OpenAiCompatibleProvider();
    await provider.probe(LOCAL, 'thinker');
    await provider.invoke(request({ modelId: 'thinker', reasoning: { mode: 'max' } }), signal());
    expect(lastChatBody().reasoning_effort).toBe('max');
  });

  /**
   * The one that matters, because getting it wrong is not a no-op.
   *
   * Measured against a live Ollama: `reasoning_effort` is parsed and validated
   * rather than tolerated — `"banana"` returns 400 — and sending *any* value to
   * a model without the `thinking` capability returns 400 as well. So an
   * ungated send does not quietly do nothing; it fails every turn the moment a
   * seat carries an effort and the model behind it is ordinary.
   */
  it('withholds it from a model that would reject the request', async () => {
    stubFetch({
      '/api/show': show(['completion', 'tools']),
      '/models': { data: [] },
      '/chat/completions': chat({ content: 'ok' }),
    });
    const provider = new OpenAiCompatibleProvider();
    await provider.probe(LOCAL, 'plain');
    await provider.invoke(request({ modelId: 'plain', reasoning: { mode: 'max' } }), signal());
    expect(lastChatBody()).not.toHaveProperty('reasoning_effort');
  });

  it('withholds it when the model was never probed', async () => {
    // Unprobed is "cannot tell", and §3.3 spends that in the safe direction.
    stubFetch({ '/chat/completions': chat({ content: 'ok' }) });
    await new OpenAiCompatibleProvider().invoke(request({ reasoning: { mode: 'max' } }), signal());
    expect(lastChatBody()).not.toHaveProperty('reasoning_effort');
  });

  it('sends nothing for auto, which is what sending nothing already means', async () => {
    stubFetch({
      '/api/show': show(['completion', 'tools', 'thinking']),
      '/models': { data: [] },
      '/chat/completions': chat({ content: 'ok' }),
    });
    const provider = new OpenAiCompatibleProvider();
    await provider.probe(LOCAL, 'thinker');
    await provider.invoke(request({ modelId: 'thinker', reasoning: { mode: 'auto' } }), signal());
    expect(lastChatBody()).not.toHaveProperty('reasoning_effort');
  });
});
