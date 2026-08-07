/**
 * The runtime contract suite (DESIGN.md §3.13).
 *
 * Every adapter runs these scenarios. This file exists because 158 passing tests
 * did not catch a reference adapter that emitted zero events: every runtime test
 * asserted against `echo`, so the interface was only ever validated by the
 * implementation that happened to satisfy it. §16 names that exact failure mode.
 *
 * The Claude adapter is exercised through its injected `queryFn`, so the real
 * translate/gate code runs against a scripted SDK stream without credentials.
 */

import { describe, expect, it } from 'vitest';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { ClaudeAgentSdkRuntime } from '@main/runtime/runtimes/claudeAgentSdk.js';
import { GilmokHarnessRuntime } from '@main/runtime/runtimes/gilmokHarness.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { AgentHostServer } from '../src/host/server.js';
import { HostBackedRuntime, HostClient } from '@main/host/hostRuntime.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { HostCommand, HostMessage } from '@shared/host/protocol.js';
import {
  newAgentId,
  type AgentRuntime,
  type AgentSpec,
  type PermissionDecision,
  type RuntimeContext,
  type ModelEndpoint,
  type ModelProvider,
  type ProviderResult,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type ToolPolicy,
} from '@shared/types/index.js';
import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

const POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };

/**
 * Wrap a runtime so it is reached through the AgentHost protocol (§8).
 *
 * Real server, real client, real serialization — only the transport is
 * in-process. The runtime id is rewritten to match what the spec will carry,
 * since the host resolves the spec's `runtimeId` through its own registry.
 */
function hostBacked(inner: AgentRuntime): AgentRuntime {
  const registry = new RuntimeRegistry();
  const relabeled = new Proxy(inner, {
    get: (target, prop, recv) => (prop === 'id' ? 'test' : Reflect.get(target, prop, recv)),
  });
  registry.register(relabeled as AgentRuntime, { label: 'hosted', requiresModel: false });

  const pair = memoryChannelPair<HostCommand, HostMessage>();
  new AgentHostServer(pair.host, registry);
  const client = new HostClient({ channel: pair.main });

  return new HostBackedRuntime(client, 'test', inner.version);
}

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'test',
    auth: { kind: 'none' },
    toolPolicy: POLICY,
    limits: {},
    workspacePath: '/tmp/ws',
    ...over,
  };
}

function context(
  decide: () => PermissionDecision = () => ({ result: 'allow', scope: 'once' }),
): RuntimeContext & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    requestPermission: async (req) => {
      asked.push(req.tool);
      return decide();
    },
    reportProgress: () => undefined,
    abortSignal: new AbortController().signal,
  };
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

// ------------------------------------------------------------- SDK stream stub

/** Minimal `Query`: an async generator plus the control methods we call. */
function fakeQuery(
  messages: SDKMessage[],
  hooks: { onOptions?: (o: Options) => void; callGate?: { tool: string; input: Record<string, unknown> } } = {},
): typeof import('@anthropic-ai/claude-agent-sdk').query {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: Options }) => {
    const options = params.options as Options;
    hooks.onOptions?.(options);

    async function* gen(): AsyncGenerator<SDKMessage, void> {
      // Consume one prompt message, proving send() reaches the SDK's input.
      if (typeof params.prompt !== 'string') {
        await (params.prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]().next();
      }
      // Exercise the real gate wiring where the scenario asks for it.
      if (hooks.callGate && options.canUseTool) {
        await options.canUseTool(hooks.callGate.tool, hooks.callGate.input, {
          signal: new AbortController().signal,
        } as never);
      }
      for (const msg of messages) yield msg;
    }

    const it = gen();
    return Object.assign(it, {
      interrupt: async () => undefined,
      setPermissionMode: async () => undefined,
      setModel: async () => undefined,
      applyFlagSettings: async () => undefined,
      stopTask: async () => undefined,
      streamInput: async () => undefined,
      close: () => undefined,
    }) as unknown as Query;
  }) as typeof import('@anthropic-ai/claude-agent-sdk').query;
}

const assistantText = (text: string): SDKMessage =>
  ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    uuid: 'u1',
    session_id: 'sess-contract',
  }) as unknown as SDKMessage;

const resultSuccess = (): SDKMessage =>
  ({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 1,
    result: 'ok',
    usage: { input_tokens: 12, output_tokens: 7 },
    total_cost_usd: 0.003,
    session_id: 'sess-contract',
    uuid: 'u2',
  }) as unknown as SDKMessage;

// -------------------------------------------------------------- the contract

// ------------------------------------------- provider stub, for GilmokHarness

const STUB_CAPS: RuntimeCapabilities = {
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

const STUB_ENDPOINT: ModelEndpoint = {
  endpointId: 'contract',
  providerId: 'stub',
  auth: { kind: 'none' },
  locality: 'app-local',
  dataHandling: { provider: 'stub' },
};

function stubProvider(script: Array<Partial<ProviderResult>>): ModelProvider {
  let i = 0;
  return {
    id: 'stub',
    version: '0.0.1',
    listModels: async () => [{ modelId: 'stub-model' }],
    probe: async () => STUB_CAPS,
    invoke: async () => {
      const step = script[Math.min(i, script.length - 1)] ?? {};
      i += 1;
      return {
        content: [],
        toolCalls: [],
        stop: { kind: 'end_turn' },
        usage: { inputTokens: 12, outputTokens: 7 },
        raw: {},
        ...step,
      } satisfies ProviderResult;
    },
  };
}

interface Candidate {
  name: string;
  /** A runtime whose turn yields text, then usage, then a clean end_turn. */
  make: () => AgentRuntime;
  /** A runtime that performs one gated tool call before finishing. */
  makeGated: () => AgentRuntime;
  expectsResumeToken: string | null;
  /** GilmokHarness needs a model on the spec; wrapped harnesses must not have one. */
  specOverride?: Partial<AgentSpec>;
}

const CANDIDATES: Candidate[] = [
  {
    name: 'echo',
    make: () =>
      new EchoRuntime({
        script: [
          { kind: 'text', text: 'hello' },
          { kind: 'usage', inputTokens: 12, outputTokens: 7, cost: 0.003 },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
    makeGated: () =>
      new EchoRuntime({
        script: [
          { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
    expectsResumeToken: null,
  },
  {
    name: 'claude-agent-sdk',
    make: () =>
      new ClaudeAgentSdkRuntime({
        queryFn: fakeQuery([assistantText('hello'), resultSuccess()]),
      }),
    makeGated: () =>
      new ClaudeAgentSdkRuntime({
        queryFn: fakeQuery([resultSuccess()], {
          callGate: { tool: 'Read', input: { file_path: 'a.ts' } },
        }),
      }),
    // The SDK reports a session id, which is a cache and never truth (§5.4).
    expectsResumeToken: 'sess-contract',
  },
  {
    // The provider branch: our own loop over a raw endpoint (§3.7). Included
    // here because a contract validated against one branch is not validated.
    name: 'gilmok-harness',
    make: () =>
      new GilmokHarnessRuntime({
        provider: stubProvider([{ content: [{ type: 'text', text: 'hello' }] }]),
        endpointFor: () => STUB_ENDPOINT,
      }),
    makeGated: () =>
      new GilmokHarnessRuntime({
        provider: stubProvider([
          {
            toolCalls: [{ id: 'c1', name: 'read', args: { file_path: 'a.ts' } }],
            stop: { kind: 'tool_calls' },
          },
          {},
        ]),
        endpointFor: () => STUB_ENDPOINT,
      }),
    expectsResumeToken: null,
    specOverride: { model: { providerId: 'stub', modelId: 'stub-model' } },
  },
  {
    /**
     * The same echo adapter, reached through the AgentHost control protocol
     * (§8) over an in-memory channel.
     *
     * This candidate tests the claim that moving loops out of the main process
     * is "a relocation behind `AgentRuntime`". Everything the contract demands
     * has to survive serialization and asynchronous delivery: events
     * subscribable before the first `send()`, a stream consumable once, the gate
     * consulted before a tool runs, a terminating stop reason. If the proxy is
     * not a faithful `AgentRuntime`, it fails here rather than in the app.
     */
    name: 'agent-host (echo over the control protocol)',
    make: () =>
      hostBacked(
        new EchoRuntime({
          script: [
            { kind: 'text', text: 'hello' },
            { kind: 'usage', inputTokens: 12, outputTokens: 7, cost: 0.003 },
            { kind: 'stop', stop: { kind: 'end_turn' } },
          ],
        }),
      ),
    makeGated: () =>
      hostBacked(
        new EchoRuntime({
          script: [
            { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
            { kind: 'stop', stop: { kind: 'end_turn' } },
          ],
        }),
      ),
    expectsResumeToken: null,
  },
];

for (const candidate of CANDIDATES) {
  describe(`runtime contract: ${candidate.name}`, () => {
    it('delivers events when subscribed BEFORE the first send', async () => {
      // The host is stream-first, so this is the only ordering that matters —
      // and the ordering that a lazily-created stream silently fails.
      const runtime = candidate.make();
      const handle = await runtime.start(spec(candidate.specOverride), context());

      const drained = drain(handle.events); // subscribe first
      await handle.send({ content: [{ type: 'text', text: 'hi' }] });
      const events = await drained;

      expect(events.length).toBeGreaterThan(0);
      expect(events.some((e) => e.type === 'text')).toBe(true);
    });

    it('ends the turn with an explicit stop, not an implicit failure', async () => {
      const runtime = candidate.make();
      const handle = await runtime.start(spec(candidate.specOverride), context());
      const drained = drain(handle.events);
      await handle.send({ content: [{ type: 'text', text: 'hi' }] });

      const last = (await drained).at(-1);
      expect(last).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
    });

    it('reports usage for the turn', async () => {
      const runtime = candidate.make();
      const handle = await runtime.start(spec(candidate.specOverride), context());
      const drained = drain(handle.events);
      await handle.send({ content: [{ type: 'text', text: 'hi' }] });

      const usage = (await drained).find((e) => e.type === 'usage');
      expect(usage).toMatchObject({ type: 'usage', inputTokens: 12, outputTokens: 7 });
    });

    it('returns the same stream on repeated access', async () => {
      const runtime = candidate.make();
      const handle = await runtime.start(spec(candidate.specOverride), context());
      // A second consumer would race the first for events.
      expect(handle.events).toBe(handle.events);
    });

    it('routes a tool call through the permission gate before executing', async () => {
      const runtime = candidate.makeGated();
      const ctx = context();
      const handle = await runtime.start(spec(candidate.specOverride), ctx);
      const drained = drain(handle.events);
      await handle.send({ content: [{ type: 'text', text: 'go' }] });
      await drained;

      expect(ctx.asked.map((t) => t.toLowerCase())).toContain('read');
    });

    it('reports a resume token consistent with its declared capability', async () => {
      const runtime = candidate.make();
      const caps = await runtime.capabilities(spec(candidate.specOverride));
      const handle = await runtime.start(spec(candidate.specOverride), context());
      const drained = drain(handle.events);
      await handle.send({ content: [{ type: 'text', text: 'hi' }] });
      await drained;

      const token = handle.resumeToken();
      expect(token).toBe(candidate.expectsResumeToken);
      // An adapter must not claim native resume and then supply nothing.
      if (caps.nativeResume) expect(token).not.toBeNull();
    });

    it('declares capabilities as a function of the spec', async () => {
      const runtime = candidate.make();
      await expect(runtime.capabilities(spec(candidate.specOverride))).resolves.toMatchObject({
        permissionFidelity: expect.any(String) as unknown as string,
        contextWindow: expect.any(Number) as unknown as number,
      });
    });
  });
}

// ------------------------------------------------- adapter-specific guarantees

describe('claude-agent-sdk: the configuration its fidelity claim depends on', () => {
  async function capturedOptions(): Promise<Options> {
    let captured: Options | null = null;
    const runtime = new ClaudeAgentSdkRuntime({
      queryFn: fakeQuery([resultSuccess()], { onOptions: (o) => (captured = o) }),
    });
    const handle = await runtime.start(spec(), context());
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'x' }] });
    await drained;
    return captured as unknown as Options;
  }

  it('never passes allowedTools, which would bypass the gate', async () => {
    // "The callback never fires for auto-approved tools" — a bare allowedTools
    // entry would make the declared `callback` fidelity false.
    expect((await capturedOptions()).allowedTools).toBeUndefined();
  });

  it('pins permissionMode to default so nothing is auto-approved', async () => {
    expect((await capturedOptions()).permissionMode).toBe('default');
  });

  it('pins settingSources to [] so settings files add no invisible allow rules', async () => {
    expect((await capturedOptions()).settingSources).toEqual([]);
  });

  it('always supplies canUseTool — without it there is no gate at all', async () => {
    expect(typeof (await capturedOptions()).canUseTool).toBe('function');
  });

  it('passes the workspace as cwd', async () => {
    expect((await capturedOptions()).cwd).toBe('/tmp/ws');
  });

  it('translates a denial into an SDK deny result carrying the reason', async () => {
    let gateResult: unknown = null;
    const runtime = new ClaudeAgentSdkRuntime({
      queryFn: ((params: { prompt: unknown; options?: Options }) => {
        const options = params.options as Options;
        async function* gen(): AsyncGenerator<SDKMessage, void> {
          gateResult = await options.canUseTool?.(
            'Bash',
            { command: 'rm -rf /' },
            { signal: new AbortController().signal } as never,
          );
          yield resultSuccess();
        }
        return Object.assign(gen(), {
          interrupt: async () => undefined,
          close: () => undefined,
        }) as unknown as Query;
      }) as typeof import('@anthropic-ai/claude-agent-sdk').query,
    });

    const ctx = context(() => ({ result: 'deny', reason: 'use git rm instead' }));
    const handle = await runtime.start(spec(), ctx);
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(gateResult).toEqual({ behavior: 'deny', message: 'use git rm instead' });
  });
});
