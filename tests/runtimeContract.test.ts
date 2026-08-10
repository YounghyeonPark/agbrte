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
import { AgbrteHarnessRuntime } from '@main/runtime/runtimes/agbrteHarness.js';
import { CliStdioRuntime } from '@main/runtime/runtimes/cliStdio.js';
import { CLAUDE_CODE_MANIFEST } from '@main/runtime/cli/manifests.js';
import type { CliAgentManifest } from '@main/runtime/cli/manifest.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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
import { recorderFor, scenario } from './support/conformance.js';
import type { Evidence } from '@shared/types/index.js';

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

// -------------------------------------------------------------- the contract

// ------------------------------------------- provider stub, for AgbrteHarness

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

// ------------------------------------------------------------- CLI fixture

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeCli.mjs');

/** The real Claude Code manifest, pointed at a fixture instead of an install. */
function fixtureCliManifest(mode: string): CliAgentManifest {
  return {
    ...CLAUDE_CODE_MANIFEST,
    detect: { ...CLAUDE_CODE_MANIFEST.detect, binary: process.execPath },
    invoke: {
      ...CLAUDE_CODE_MANIFEST.invoke,
      baseArgs: [FAKE_CLI, '--mode', mode, ...CLAUDE_CODE_MANIFEST.invoke.baseArgs],
    },
  };
}

interface Candidate {
  name: string;
  /**
   * The id this adapter carries in a real registry, so a recorded result lines
   * up with the runtime the app is actually holding. Not the display name: the
   * matrix joins on ids, and a mismatch there silently produces a column of
   * `not-run` beside a suite that passed.
   */
  runtimeId: string;
  /**
   * What is on the other end when this candidate passes.
   *
   * §3.13: "a green cell earned by a scripted fixture is not the same claim as
   * one earned against a live endpoint". Recorded per candidate because that is
   * the level at which it actually differs.
   */
  evidence: Evidence;
  /** A runtime whose turn yields text, then usage, then a clean end_turn. */
  make: () => AgentRuntime;
  /** A runtime that performs one gated tool call before finishing. */
  makeGated: () => AgentRuntime;
  expectsResumeToken: string | null;
  /** AgbrteHarness needs a model on the spec; wrapped harnesses must not have one. */
  specOverride?: Partial<AgentSpec>;
}

const CANDIDATES: Candidate[] = [
  {
    name: 'echo',
    runtimeId: 'echo',
    evidence: 'scripted-fixture',
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
    // The provider branch: our own loop over a raw endpoint (§3.7). Included
    // here because a contract validated against one branch is not validated.
    name: 'agbrte-harness',
    runtimeId: 'agbrte-harness',
    evidence: 'scripted-fixture',
    make: () =>
      new AgbrteHarnessRuntime({
        provider: stubProvider([{ content: [{ type: 'text', text: 'hello' }] }]),
        endpointFor: () => STUB_ENDPOINT,
      }),
    makeGated: () =>
      new AgbrteHarnessRuntime({
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
     * An installed CLI, driven as a subprocess (§3.12).
     *
     * The shape furthest from the other three: no loop to hold, one process per
     * turn, a text protocol over a pipe, and a gate that can only refuse ahead
     * of time. It runs here against a fixture that speaks the protocol over real
     * pipes, so what the contract is checking is the adapter rather than a mock
     * of it — the same claims as everyone else, arrived at completely
     * differently.
     */
    name: 'agent-cli-stdio (a real subprocess)',
    runtimeId: 'cli:claude-code',
    // A real OS process over real pipes — the strongest evidence available
    // without a vendor binary installed.
    evidence: 'real-subprocess',
    make: () => new CliStdioRuntime({ manifest: fixtureCliManifest('plain') }),
    makeGated: () => new CliStdioRuntime({ manifest: fixtureCliManifest('deny-once') }),
    // The CLI prints a session id, which is a cache and never truth (§5.4).
    expectsResumeToken: 'sess-fake-1',
    // A real spawn needs a directory that exists; the others never touch it.
    specOverride: { workspacePath: process.cwd() },
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
    // Not a runtime any host offers, so it earns no column. Recorded anyway: the
    // rows are what would prove a regression in the transport, and dropping them
    // because nothing displays them is how a suite quietly stops being read.
    runtimeId: 'agent-host',
    evidence: 'in-process',
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

const recorder = recorderFor('runtime-contract');

/**
 * Run one contract scenario and record what it proved.
 *
 * The version comes off the live adapter rather than a constant, because the
 * matrix uses it to tell a verified cell from a stale one: a result stamped with
 * a version nobody is running is not evidence about the adapter in the app.
 */
function contract(
  candidate: Candidate,
  runtime: AgentRuntime,
  scenarioId: string,
  body: () => Promise<void>,
): Promise<void> {
  return scenario(
    recorder,
    {
      runtimeId: candidate.runtimeId,
      scenarioId,
      adapterVersion: runtime.version,
      evidence: candidate.evidence,
    },
    body,
  );
}

for (const candidate of CANDIDATES) {
  describe(`runtime contract: ${candidate.name}`, () => {
    it('delivers events when subscribed BEFORE the first send', async () => {
      // The host is stream-first, so this is the only ordering that matters —
      // and the ordering that a lazily-created stream silently fails.
      const runtime = candidate.make();
      await contract(candidate, runtime, 'stream-before-send', async () => {
        const handle = await runtime.start(spec(candidate.specOverride), context());

        const drained = drain(handle.events); // subscribe first
        await handle.send({ content: [{ type: 'text', text: 'hi' }] });
        const events = await drained;

        expect(events.length).toBeGreaterThan(0);
        expect(events.some((e) => e.type === 'text')).toBe(true);
      });
    });

    it('ends the turn with an explicit stop, not an implicit failure', async () => {
      const runtime = candidate.make();
      await contract(candidate, runtime, 'explicit-stop', async () => {
        const handle = await runtime.start(spec(candidate.specOverride), context());
        const drained = drain(handle.events);
        await handle.send({ content: [{ type: 'text', text: 'hi' }] });

        const last = (await drained).at(-1);
        expect(last).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
      });
    });

    it('reports usage for the turn', async () => {
      const runtime = candidate.make();
      await contract(candidate, runtime, 'usage-reported', async () => {
        const handle = await runtime.start(spec(candidate.specOverride), context());
        const drained = drain(handle.events);
        await handle.send({ content: [{ type: 'text', text: 'hi' }] });

        const usage = (await drained).find((e) => e.type === 'usage');
        expect(usage).toMatchObject({ type: 'usage', inputTokens: 12, outputTokens: 7 });
      });
    });

    it('returns the same stream on repeated access', async () => {
      const runtime = candidate.make();
      await contract(candidate, runtime, 'stream-once', async () => {
        const handle = await runtime.start(spec(candidate.specOverride), context());
        // A second consumer would race the first for events.
        expect(handle.events).toBe(handle.events);
      });
    });

    it('routes a tool call through the permission gate before executing', async () => {
      const runtime = candidate.makeGated();
      await contract(candidate, runtime, 'gate-before-execute', async () => {
        const ctx = context();
        const handle = await runtime.start(spec(candidate.specOverride), ctx);
        const drained = drain(handle.events);
        await handle.send({ content: [{ type: 'text', text: 'go' }] });
        await drained;

        expect(ctx.asked.map((t) => t.toLowerCase())).toContain('read');
      });
    });

    it('reports a resume token consistent with its declared capability', async () => {
      const runtime = candidate.make();
      await contract(candidate, runtime, 'resume-token-consistent', async () => {
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
    });

    it('declares capabilities as a function of the spec', async () => {
      const runtime = candidate.make();
      await contract(candidate, runtime, 'capabilities-per-spec', async () => {
        await expect(runtime.capabilities(spec(candidate.specOverride))).resolves.toMatchObject({
          permissionFidelity: expect.any(String) as unknown as string,
          contextWindow: expect.any(Number) as unknown as number,
        });
      });
    });
  });
}

// ------------------------------------------------- adapter-specific guarantees

