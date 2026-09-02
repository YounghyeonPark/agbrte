/**
 * The `anthropic` adapter against a real HTTP server (DESIGN.md §3.6, §15 Phase 3).
 *
 * ## Why this exists when `anthropic.test.ts` already covers the mappings
 *
 * That file stubs `globalThis.fetch` and asserts on `JSON.parse(init.body)`,
 * which is right for the mappings and blind to everything between building an
 * object and a server reading one. So this runs the adapter against `node:http`
 * on loopback: real headers with the casing a server actually sees, a real GET
 * with no body, real status codes carrying the server's own explanation, and a
 * real abort mid-flight — which is what `interruptible: true` claims.
 *
 * **One thing it deliberately does not claim.** This file was started on the
 * analogy of a `parentBudget: undefined` key that survived an in-memory channel
 * and vanished over a socket, on the theory that a stubbed `fetch` hides the
 * same class of bug. It does not: that channel hands the peer the *same object*
 * with no serialization anywhere, while `JSON.stringify` has always dropped an
 * `undefined` key, so `{ x: undefined }` and `{}` are byte-identical here and in
 * the stub alike. The analogy was wrong and the file is worth having for the
 * other reasons; saying which is which is the point of writing it down.
 *
 * ## What it is still not
 *
 * A call to the vendor. No credential exists for this project and none is going
 * to, so the adapter will never be run against the service it describes — that
 * is recorded in `docs/status.md` as a permanent limit rather than a to-do. What
 * this closes is the distance between *an object we asserted about* and *bytes a
 * server parsed*, which is the part that was in reach.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AnthropicProvider, ANTHROPIC_PROVIDER_ID } from '@main/runtime/providers/anthropic.js';
import type { ModelEndpoint, ProviderRequest } from '@shared/types/index.js';

interface Received {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** The raw bytes, so a test can ask what the wire actually carried. */
  raw: string;
  body: Record<string, unknown>;
}

let server: Server;
let received: Received[];
let endpoint: ModelEndpoint;
let respond: (path: string) => { status: number; body: unknown };

/** A server that answers like the Messages API, and records what it was sent. */
async function listen(): Promise<void> {
  received = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        path: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        raw,
        body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      const answer = respond(req.url ?? '');
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };
  endpoint = {
    endpointId: 'loopback',
    providerId: ANTHROPIC_PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    auth: { kind: 'api-key' },
    locality: 'cloud',
    dataHandling: { provider: 'loopback' },
  };
}

const OK = {
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 4, output_tokens: 2 },
};

function request(over: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    endpoint,
    modelId: 'claude-opus-5',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxOutputTokens: 4_096,
    ...over,
  };
}

const signal = () => ({ signal: new AbortController().signal });

beforeEach(async () => {
  respond = () => ({ status: 200, body: OK });
  await listen();
});
afterEach(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

describe('what actually goes over the wire', () => {
  it('sends a body a server can parse, with the headers this API requires', async () => {
    await new AnthropicProvider({ keyFor: () => 'sk-live' }).invoke(request(), signal());

    const sent = received[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe('/v1/messages');
    // Node lowercases incoming header names, which is the point of checking them
    // here rather than on an object we handed to a stub: the casing this adapter
    // writes has to survive a real request.
    expect(sent.headers['x-api-key']).toBe('sk-live');
    expect(sent.headers['anthropic-version']).toBe('2023-06-01');
    expect(sent.headers['content-type']).toBe('application/json');
    expect(sent.body['model']).toBe('claude-opus-5');
  });

  it('carries no key header at all when there is no key', async () => {
    await new AnthropicProvider().invoke(request(), signal());
    // Absent, not empty. `x-api-key: undefined` would reach the server as the
    // four-character string "undefined" and be answered 401 with a message about
    // an invalid key rather than a missing one.
    expect(received[0]!.headers).not.toHaveProperty('x-api-key');
    expect(received[0]!.raw).not.toContain('undefined');
  });

  it('omits a field it has nothing to say about, rather than sending an empty one', async () => {
    await new AnthropicProvider().invoke(
      request({ reasoning: { mode: 'off' }, tools: [] }),
      signal(),
    );

    /*
     * Note what this does **not** prove, because the first version of this test
     * claimed it did.
     *
     * A key set to `undefined` is *not* catchable here: `JSON.stringify` drops
     * it, so `{ thinking: undefined }` and `{}` are byte-identical on the wire.
     * That was the reasoning behind writing this file — by analogy with the
     * `parentBudget: undefined` key that survived an in-memory channel — and the
     * analogy is wrong. That channel hands the peer the *same object*, with no
     * serialization anywhere; JSON has been dropping such keys the whole time.
     * A real transport buys a great deal (see the rest of this file) and buys
     * nothing at all here.
     *
     * What is still worth asserting is the behaviour: reasoning turned off sends
     * no budget, and an empty tool list is omitted rather than sent as `[]`,
     * which this API reads as a request that has tools and happens to list none.
     * The `raw` check is a cheap guard against an interpolated `undefined`
     * reaching the wire as those nine characters, which JSON does not save you
     * from.
     */
    const sent = received[0]!;
    expect(sent.body).not.toHaveProperty('thinking');
    expect(sent.body).not.toHaveProperty('tools');
    expect(sent.raw).not.toContain('undefined');
  });

  it('sends tool results as blocks in one user message, over the wire', async () => {
    await new AnthropicProvider().invoke(
      request({
        messages: [
          { role: 'assistant', toolCalls: [{ id: 'a', name: 'search', args: { q: '1' } }] },
          { role: 'tool', toolCallId: 'a', name: 'search', result: 'first' },
          { role: 'tool', toolCallId: 'b', name: 'search', result: 'second' },
        ],
      }),
      signal(),
    );

    const messages = received[0]!.body['messages'] as Array<{ role: string; content: unknown[] }>;
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(messages[1]!.content).toHaveLength(2);
  });

  it('counts tokens against the endpoint, without max_tokens', async () => {
    respond = () => ({ status: 200, body: { input_tokens: 77 } });
    const count = await new AnthropicProvider().countTokens(request({ system: 'be brief' }));

    expect(count).toBe(77);
    const sent = received[0]!;
    expect(sent.path).toBe('/v1/messages/count_tokens');
    // Describes the reply, and the count is of the prompt. Sending it is an
    // error at this endpoint, which is why the assertion is on what arrived.
    expect(sent.body).not.toHaveProperty('max_tokens');
    expect(sent.body['system']).toBe('be brief');
  });

  it('lists models through a real GET, with no body', async () => {
    respond = () => ({
      status: 200,
      body: { data: [{ id: 'claude-opus-5', display_name: 'Claude Opus 5' }] },
    });
    const models = await new AnthropicProvider().listModels(endpoint);

    expect(models).toEqual([{ modelId: 'claude-opus-5', displayName: 'Claude Opus 5' }]);
    expect(received[0]!.method).toBe('GET');
    expect(received[0]!.raw).toBe('');
  });
});

describe('what comes back', () => {
  it('reads a reply the server actually serialized', async () => {
    respond = () => ({
      status: 200,
      body: {
        content: [
          { type: 'thinking', thinking: 'working' },
          { type: 'text', text: 'done' },
          { type: 'tool_use', id: 'c1', name: 'search', input: { q: 'x' } },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 9,
          output_tokens: 4,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
        },
      },
    });
    const result = await new AnthropicProvider().invoke(request(), signal());

    expect(result.reasoning).toBe('working');
    expect(result.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'search', args: { q: 'x' } }]);
    expect(result.stop).toEqual({ kind: 'tool_calls' });
    expect(result.usage.cacheWriteTokens).toBe(100);
    expect(result.usage.cacheReadTokens).toBe(200);
  });

  it('keeps the status and the server’s explanation in the error', async () => {
    respond = () => ({
      status: 429,
      body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    });

    // Both halves matter upstream: the status decides whether a session parks or
    // fails (§3.9), and the message is the only thing that says which field or
    // limit was at fault.
    const failing = new AnthropicProvider().invoke(request(), signal());
    await expect(failing).rejects.toThrow(/429/);
    await expect(failing).rejects.toThrow(/slow down/);
  });

  it('aborts a request in flight when the signal fires', async () => {
    // §3.9 declares `interruptible: true` on the strength of this, and a claim
    // about a live socket is worth making against one.
    const slow = createServer(() => {
      /* answers nothing, ever */
    });
    await new Promise<void>((done) => slow.listen(0, '127.0.0.1', done));
    const { port } = slow.address() as { port: number };
    const controller = new AbortController();

    try {
      const inFlight = new AnthropicProvider().invoke(
        request({ endpoint: { ...endpoint, baseUrl: `http://127.0.0.1:${port}/v1` } }),
        { signal: controller.signal },
      );
      controller.abort();
      await expect(inFlight).rejects.toThrow();
    } finally {
      await new Promise<void>((done) => slow.close(() => done()));
    }
  });
});
