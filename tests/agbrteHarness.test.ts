/**
 * `AgbrteHarness` — our own agent loop (DESIGN.md §3.7).
 *
 * Driven by a scripted `ModelProvider`, so the loop, the gate, tool dispatch,
 * and the failure taxonomy are all exercised without a model or a network.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgbrteHarnessRuntime, degradeSchema } from '@main/runtime/runtimes/agbrteHarness.js';
import {
  newAgentId,
  type AgentSpec,
  type ModelEndpoint,
  type ModelProvider,
  type PermissionDecision,
  type ProviderRequest,
  type ProviderResult,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type ToolPolicy,
} from '@shared/types/index.js';

const ENDPOINT: ModelEndpoint = {
  endpointId: 'test',
  providerId: 'stub',
  auth: { kind: 'none' },
  locality: 'app-local',
  dataHandling: { provider: 'stub' },
};

const CAPS: RuntimeCapabilities = {
  nativeResume: false,
  interruptible: true,
  subagents: false,
  streaming: false,
  streamingToolArgs: false,
  tools: 'native',
  parallelToolCalls: 'one',
  schemaProfile: 'strict-subset',
  toolResultPairing: 'batched',
  permissionFidelity: 'callback',
  contextWindow: 32_768,
  maxOutputTokens: 2_048,
  serverSideCompaction: false,
  caching: 'none',
  reasoningControl: 'none',
  reasoningVisible: 'none',
  input: { image: false, audio: false, pdf: false, video: false },
  pricing: 'free',
  costReporting: 'per-request',
  tokenCounter: 'local-estimate',
  quotaModel: 'per-token-billing',
};

/** Returns scripted results in order; records every request it received. */
class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly version = '0.0.1';
  readonly requests: ProviderRequest[] = [];
  private index = 0;

  constructor(
    private readonly script: Array<Partial<ProviderResult> | (() => never)>,
    private readonly caps: Partial<RuntimeCapabilities> = {},
  ) {}

  async listModels() {
    return [{ modelId: 'stub-model' }];
  }

  async probe(): Promise<RuntimeCapabilities> {
    return { ...CAPS, ...this.caps };
  }

  async invoke(req: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(req);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    if (typeof step === 'function') step();
    return {
      content: [],
      toolCalls: [],
      stop: { kind: 'end_turn' },
      usage: { inputTokens: 10, outputTokens: 5 },
      raw: {},
      ...(step as Partial<ProviderResult>),
    };
  }
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-harness-'));
  await writeFile(join(root, 'target.ts'), 'const value = 1;\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'agbrte-harness',
    model: { providerId: 'stub', modelId: 'stub-model' },
    auth: { kind: 'none' },
    toolPolicy: POLICY,
    limits: {},
    workspacePath: root,
    ...over,
  };
}

function context(
  decide: (tool: string, args: unknown) => PermissionDecision = () => ({
    result: 'allow',
    scope: 'once',
  }),
): RuntimeContext & { asked: Array<{ tool: string; args: unknown }> } {
  const asked: Array<{ tool: string; args: unknown }> = [];
  return {
    asked,
    requestPermission: async (ask) => {
      asked.push({ tool: ask.tool, args: ask.args });
      return decide(ask.tool, ask.args);
    },
    reportProgress: () => undefined,
    abortSignal: new AbortController().signal,
  };
}

async function run(
  provider: StubProvider,
  ctx = context(),
  overrides: Partial<AgentSpec> = {},
  maxIterations?: number,
): Promise<RuntimeEvent[]> {
  const runtime = new AgbrteHarnessRuntime({
    provider,
    endpointFor: () => ENDPOINT,
    ...(maxIterations !== undefined ? { maxIterations } : {}),
  });
  const handle = await runtime.start(spec(overrides), ctx);
  const collected: Promise<RuntimeEvent[]> = (async () => {
    const out: RuntimeEvent[] = [];
    for await (const ev of handle.events) out.push(ev);
    return out;
  })();
  await handle.send({ content: [{ type: 'text', text: 'go' }] });
  return collected;
}

describe('AgbrteHarness — basics', () => {
  it('reports capabilities from the provider but owns the gate', async () => {
    const runtime = new AgbrteHarnessRuntime({
      provider: new StubProvider([{}], { permissionFidelity: 'all-or-nothing', subagents: true }),
      endpointFor: () => ENDPOINT,
    });
    const caps = await runtime.capabilities(spec());
    // The gate is ours regardless of what the provider claims (§3.7).
    expect(caps.permissionFidelity).toBe('callback');
    expect(caps.subagents).toBe(false);
  });

  it('refuses a spec with no model', async () => {
    const runtime = new AgbrteHarnessRuntime({ provider: new StubProvider([{}]), endpointFor: () => ENDPOINT });
    // Omitted, not set to undefined: `exactOptionalPropertyTypes` treats those
    // as different, and the runtime must reject the genuinely absent case.
    const { model: _model, ...withoutModel } = spec();
    await expect(runtime.capabilities(withoutModel as AgentSpec)).rejects.toThrow(
      /requires spec.model/,
    );
  });

  it('reports no resume token — there is no provider-side session', async () => {
    const runtime = new AgbrteHarnessRuntime({ provider: new StubProvider([{}]), endpointFor: () => ENDPOINT });
    const handle = await runtime.start(spec(), context());
    expect(handle.resumeToken()).toBeNull();
  });

  it('emits text, usage, and a clean stop for a tool-free answer', async () => {
    const events = await run(
      new StubProvider([{ content: [{ type: 'text', text: 'the answer' }] }]),
    );
    expect(events.map((e) => e.type)).toEqual(['usage', 'text', 'stopped']);
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
  });

  it('reports zero cost for a free local endpoint rather than omitting it', async () => {
    const events = await run(new StubProvider([{}]));
    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toMatchObject({ cost: 0 });
  });
});

describe('AgbrteHarness — the gate', () => {
  const toolThenDone = () =>
    new StubProvider([
      {
        toolCalls: [{ id: 'c1', name: 'read', args: { file_path: 'target.ts' } }],
        stop: { kind: 'tool_calls' },
      },
      { content: [{ type: 'text', text: 'done' }] },
    ]);

  it('asks before executing, and executes when allowed', async () => {
    const ctx = context();
    const events = await run(toolThenDone(), ctx);

    expect(ctx.asked).toEqual([{ tool: 'read', args: { file_path: 'target.ts' } }]);
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ ok: true });
  });

  it('does not execute a denied call, and feeds the reason back to the model', async () => {
    const provider = toolThenDone();
    const ctx = context(() => ({ result: 'deny', reason: 'not that file' }));
    const events = await run(provider, ctx);

    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect(result && 'summary' in result && result.summary).toContain('not that file');

    // The denial must reach the model so it can adapt rather than retry (§13).
    const toolMessage = provider.requests
      .at(-1)
      ?.messages.find((m) => m.role === 'tool');
    expect(toolMessage && 'result' in toolMessage && toolMessage.result).toContain('not that file');
  });

  it('actually mutates the workspace when a write is allowed', async () => {
    await run(
      new StubProvider([
        {
          toolCalls: [
            { id: 'c1', name: 'write', args: { file_path: 'created.ts', content: 'export {};' } },
          ],
          stop: { kind: 'tool_calls' },
        },
        {},
      ]),
    );
    expect(await readFile(join(root, 'created.ts'), 'utf8')).toBe('export {};');
  });

  it('reports an unknown tool as a failed result rather than crashing the loop', async () => {
    const events = await run(
      new StubProvider([
        { toolCalls: [{ id: 'c1', name: 'teleport', args: {} }], stop: { kind: 'tool_calls' } },
        {},
      ]),
    );
    const result = events.find((e) => e.type === 'tool_result');
    expect(result).toMatchObject({ ok: false });
    expect(result && 'summary' in result && result.summary).toContain('no such tool');
    expect(events.at(-1)).toMatchObject({ type: 'stopped' });
  });

  it('surfaces a tool-level confinement refusal', async () => {
    const events = await run(
      new StubProvider([
        {
          toolCalls: [{ id: 'c1', name: 'read', args: { file_path: '../../etc/passwd' } }],
          stop: { kind: 'tool_calls' },
        },
        {},
      ]),
    );
    const result = events.find((e) => e.type === 'tool_result');
    expect(result && 'summary' in result && result.summary).toMatch(/escapes the workspace/);
  });
});

describe('AgbrteHarness — loop control', () => {
  it('stops at the iteration cap instead of looping forever', async () => {
    // A provider that always asks for another tool call.
    const provider = new StubProvider([
      { toolCalls: [{ id: 'c', name: 'glob', args: { pattern: '*' } }], stop: { kind: 'tool_calls' } },
    ]);
    const events = await run(provider, context(), {}, 3);

    expect(provider.requests).toHaveLength(3);
    // Our own ceiling, so `limit_reached` — not `quota_exhausted`, which would
    // park the session waiting on a window that never resets (§3.9).
    expect(events.at(-1)).toMatchObject({
      type: 'stopped',
      stop: { kind: 'limit_reached', limit: 'turns' },
    });
  });

  it('nudges the model when it repeats an identical call', async () => {
    const provider = new StubProvider([
      { toolCalls: [{ id: 'c', name: 'glob', args: { pattern: '*' } }], stop: { kind: 'tool_calls' } },
    ]);
    await run(provider, context(), {}, 5);

    const nudges = provider.requests
      .at(-1)
      ?.messages.filter((m) => m.role === 'system' && /same tool call/.test(m.text));
    expect((nudges ?? []).length).toBeGreaterThan(0);
  });

  it('classifies a provider failure rather than throwing out of send()', async () => {
    const provider = new StubProvider([
      () => {
        throw new Error('fetch failed: ECONNREFUSED');
      },
    ]);
    const events = await run(provider);
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'unavailable' } });
  });

  it('maps an auth failure to the pausing stop reason', async () => {
    const events = await run(
      new StubProvider([
        () => {
          throw new Error('401 unauthorized');
        },
      ]),
    );
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'auth' } });
  });
});

describe('AgbrteHarness — context assembly', () => {
  it('replays a rehydrated seed as ordinary conversation', async () => {
    const provider = new StubProvider([{}]);
    const runtime = new AgbrteHarnessRuntime({ provider, endpointFor: () => ENDPOINT });
    const handle = await runtime.start(spec(), {
      ...context(),
      seedHistory: [
        { role: 'system', content: [{ type: 'text', text: 'You are resuming: fix the bug' }] },
        { role: 'user', content: [{ type: 'text', text: 'earlier question' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'earlier answer' }] },
      ],
    });
    const collected = (async () => {
      for await (const _ of handle.events) void _;
    })();
    await handle.send({ content: [{ type: 'text', text: 'now this' }] });
    await collected;

    const roles = provider.requests[0]?.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('passes the system prompt separately from the message history', async () => {
    const provider = new StubProvider([{}]);
    await run(provider, context(), { systemPrompt: 'Be terse.' });
    expect(provider.requests[0]?.system).toBe('Be terse.');
  });

  /**
   * Pins a measured result, not a preference.
   *
   * Supplying a default system prompt here is the obvious-looking fix for a live
   * flake where the model declines to touch the filesystem. It was tried and
   * measured: it tripled the failure rate on `qwen2.5:7b` and pushed the model
   * off function calling into typing tool calls as prose. The runtime comment
   * has the numbers. This test exists so the next attempt is a deliberate one
   * with fresh measurements behind it, rather than a quiet re-introduction.
   */
  it('sends no system prompt at all when the seat sets none', async () => {
    const provider = new StubProvider([{}]);
    await run(provider, context(), {});
    expect(provider.requests[0]?.system).toBeUndefined();
  });

  it('declares the tool suite to the provider', async () => {
    const provider = new StubProvider([{}]);
    await run(provider);
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toContain('edit');
  });

  it('declares no tools to a model that showed none', async () => {
    const provider = new StubProvider([{}], { tools: 'none' });
    await run(provider);
    expect(provider.requests[0]?.tools).toBeUndefined();
  });
});

describe('degradeSchema', () => {
  const nested = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      opts: { type: 'object', properties: { unit: { type: 'string' } } },
      tags: { type: 'array' },
    },
    required: ['name', 'opts'],
    additionalProperties: false,
  };

  it('leaves a schema untouched for capable profiles', () => {
    expect(degradeSchema(nested, 'strict-subset')).toBe(nested);
    expect(degradeSchema(nested, 'json-schema-full')).toBe(nested);
  });

  it('drops nested and array properties for flat-only', () => {
    const flat = degradeSchema(nested, 'flat-only') as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(flat.properties)).toEqual(['name']);
    // A required key that no longer exists would make every call invalid.
    expect(flat.required).toEqual(['name']);
  });
});

describe('a tool that returns an image (§12.1, §3.6)', () => {
  /**
   * Found auditing the provider boundary against a second API's shape.
   *
   * `ProviderMessage`'s tool role is `result: string`, so non-text a tool
   * produced cannot ride inside the tool result and is pushed as a following
   * **user** message instead. That push was fire-and-forget — `void
   * fitContent(...).then(...)` — and it worked by microtask ordering rather than
   * by construction: the loop awaits `runTool`, which happened to drain the
   * queued push before the next request was built.
   *
   * It holds only while the fitting awaits nothing real, and §12.2 says this
   * call should eventually be handed a resizer. The day it is, the screenshot
   * lands *after* the request meant to carry it and the agent sees its own
   * output one turn late — which would read as a model ignoring an image.
   */
  it('has the image in the very next request, not the one after', async () => {
    const provider = new StubProvider([
      { toolCalls: [{ id: 't1', name: 'screenshot', args: { url: 'http://localhost:1' } }] },
      {},
    ]);
    const runtime = new AgbrteHarnessRuntime({ provider, endpointFor: () => ENDPOINT });

    const handle = await runtime.start(spec(), {
      ...context(),
      // The tool the harness will call, returning a block the way §12.1's
      // screenshot tool does.
      capture: async () => ({
        type: 'image',
        sha256: 'a'.repeat(64) as never,
        mime: 'image/png',
        width: 100,
        height: 80,
        provenance: { kind: 'headless_browser', origin: 'remote' },
      }),
    });

    const seen = (async () => {
      for await (const _ of handle.events) void _;
    })();
    await handle.send({ content: [{ type: 'text', text: 'look at it' }] });
    await seen;

    // Two requests: the one that asked for the tool, and the one after it.
    expect(provider.requests.length).toBeGreaterThanOrEqual(2);
    const second = provider.requests[1]!;

    // The tool result is there, and so is what the tool actually produced.
    expect(second.messages.some((m) => m.role === 'tool')).toBe(true);
    const carried = second.messages.some(
      (m) => m.role === 'user' && m.content.some((b) => b.type === 'image' || /image/i.test((b as { text?: string }).text ?? '')),
    );
    expect(carried).toBe(true);
  });
});

describe('ceilings the user set are ceilings (§3.9, §16)', () => {
  /**
   * `AgentSpec.limits` was stored, logged, projected and rehydrated, and read
   * by nothing. `maxTurns` in particular was accepted by `addAgent`, written to
   * the transcript, and then ignored in favour of the adapter's own default.
   *
   * A limit that is recorded and not enforced is worse than no limit: it is a
   * promise in the log. §16's "cost sprawl" row named per-agent ceilings as the
   * mitigation, and that half of it did not exist.
   */
  const toolCall = { id: 't', name: 'read', args: { file_path: 'a.ts' } };

  it('stops at the turn ceiling the user asked for', async () => {
    // Ten scripted replies, a ceiling of two.
    //
    // The count is the assertion. Checking only the stop reason would pass
    // whether or not the ceiling was read: without it the loop runs to the
    // adapter's own default and emits the *same* `limit_reached: turns`. The
    // first version of this test did exactly that.
    const provider = new StubProvider(
      Array.from({ length: 10 }, () => ({ toolCalls: [toolCall] })),
    );
    const events = await run(provider, context(), { limits: { maxTurns: 2 } });

    expect(provider.requests).toHaveLength(2);
    const stopped = events.find((e) => e.type === 'stopped') as { stop: { kind: string; limit?: string } };
    expect(stopped.stop).toMatchObject({ kind: 'limit_reached', limit: 'turns' });
  });

  it('stops at the tool-call ceiling', async () => {
    const events = await run(
      new StubProvider(Array.from({ length: 10 }, () => ({ toolCalls: [toolCall] }))),
      context(),
      { limits: { maxToolCalls: 3 } },
    );

    const stopped = events.find((e) => e.type === 'stopped') as { stop: { limit?: string } };
    expect(stopped.stop.limit).toBe('tool_calls');
    expect(events.filter((e) => e.type === 'tool_use')).toHaveLength(3);
  });

  it('stops at the token ceiling', async () => {
    const events = await run(
      new StubProvider(
        Array.from({ length: 10 }, () => ({
          toolCalls: [toolCall],
          usage: { inputTokens: 400, outputTokens: 100 },
        })),
      ),
      context(),
      { limits: { tokenCeiling: 1_000 } },
    );

    const stopped = events.find((e) => e.type === 'stopped') as { stop: { limit?: string } };
    expect(stopped.stop.limit).toBe('tokens');
  });

  it('reports a ceiling as reached, never as a spent quota', async () => {
    /**
     * §3.9's distinction, and it is load-bearing: `quota_exhausted` parks the
     * session in `awaiting_quota` whose contract is "resume at `resetsAt`".
     * Nothing here resets — the user chose the number — so it pauses for a
     * person instead.
     */
    const provider = new StubProvider(
      Array.from({ length: 5 }, () => ({ toolCalls: [toolCall] })),
    );
    const events = await run(provider, context(), { limits: { maxTurns: 1 } });

    expect(provider.requests).toHaveLength(1);
    const stopped = events.find((e) => e.type === 'stopped') as { stop: { kind: string } };
    expect(stopped.stop.kind).toBe('limit_reached');
    expect(stopped.stop.kind).not.toBe('quota_exhausted');
  });

  it('does not enforce a cost ceiling it cannot measure', async () => {
    /**
     * `'unknown'` means a cost exists and is not observable (§10). Comparing it
     * to a number would either stop a session that is well under budget or let
     * one run that is well over — both worse than letting the turn and token
     * ceilings do the bounding, which is exactly why §10 pairs its third
     * fidelity with those caps.
     */
    const provider = new StubProvider(
      Array.from({ length: 3 }, () => ({ toolCalls: [toolCall] })),
      { costReporting: 'none' },
    );
    const events = await run(provider, context(), {
      limits: { costCeiling: 0.000001, maxTurns: 3 },
    });

    // Ran to the turn ceiling rather than tripping on an unmeasurable cost.
    const stopped = events.find((e) => e.type === 'stopped') as { stop: { limit?: string } };
    expect(stopped.stop.limit).toBe('turns');
  });
});
