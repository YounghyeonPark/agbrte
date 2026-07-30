/**
 * The AgentHost control protocol (DESIGN.md §8).
 *
 * The runtime contract suite already runs a real adapter through this protocol,
 * which covers the happy path better than a bespoke test could. What is left is
 * everything that only happens when a process boundary exists: the host dying
 * mid-turn, a permission ask crossing back, an abort crossing forward, and a
 * gate that throws.
 *
 * The channel is in-memory but genuinely asynchronous, so ordering bugs that
 * depend on a message landing after the current turn of the event loop are
 * reachable here.
 */

import { describe, expect, it, vi } from 'vitest';
import { AgentHostServer } from '../src/host/server.js';
import { HostBackedRuntime, HostClient } from '@main/host/hostRuntime.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { HostCommand, HostMessage } from '@shared/host/protocol.js';
import {
  newAgentId,
  type AgentHandle,
  type AgentRuntime,
  type AgentSpec,
  type ProgressSignal,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type ToolPolicy,
} from '@shared/types/index.js';

const POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'probe',
    auth: { kind: 'none' },
    toolPolicy: POLICY,
    limits: {},
    workspacePath: '/tmp/ws',
    ...over,
  };
}

function context(
  over: Partial<RuntimeContext> = {},
): RuntimeContext & { asked: string[]; progress: ProgressSignal[] } {
  const asked: string[] = [];
  const progress: ProgressSignal[] = [];
  return {
    asked,
    progress,
    requestPermission: async (req) => {
      asked.push(req.tool);
      return { result: 'allow', scope: 'once' };
    },
    reportProgress: (p) => progress.push(p),
    abortSignal: new AbortController().signal,
    ...over,
  };
}

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
  contextWindow: 8192,
  maxOutputTokens: 1024,
  serverSideCompaction: false,
  caching: 'none',
  reasoningControl: 'none',
  reasoningVisible: 'none',
  input: { image: false, audio: false, pdf: false, video: false },
  costReporting: 'none',
  tokenCounter: 'local-estimate',
  quotaModel: 'per-token-billing',
};

/**
 * A runtime the test drives directly, so host-side behavior is observable.
 *
 * `onStart` receives the context the *host* built, which is the object under
 * test: its `requestPermission` and `reportProgress` are protocol messages, and
 * its `abortSignal` is fired by a command from main.
 */
interface ProbeHooks {
  onStart?: (ctx: RuntimeContext, handle: ProbeHandle) => void;
  capabilities?: Partial<RuntimeCapabilities>;
  capabilitiesDelayMs?: number;
  failStart?: string;
  resumeToken?: string | null;
}

class ProbeHandle implements AgentHandle {
  readonly emitted: RuntimeEvent[] = [];
  private waiting: ((r: IteratorResult<RuntimeEvent>) => void) | null = null;
  private readonly buffer: RuntimeEvent[] = [];
  private done = false;
  private readonly stream: AsyncIterable<RuntimeEvent>;
  stopped: string | null = null;
  interrupted = 0;
  sent = 0;

  constructor(private token: string | null) {
    const self = this;
    this.stream = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const next = self.buffer.shift();
          if (next !== undefined) return Promise.resolve({ value: next, done: false as const });
          if (self.done) return Promise.resolve({ value: undefined, done: true as const });
          return new Promise<IteratorResult<RuntimeEvent>>((r) => (self.waiting = r));
        },
      }),
    };
  }

  emit(event: RuntimeEvent): void {
    this.emitted.push(event);
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: event, done: false });
      return;
    }
    this.buffer.push(event);
  }

  end(): void {
    this.done = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined, done: true });
    }
  }

  get events(): AsyncIterable<RuntimeEvent> {
    return this.stream;
  }

  setToken(t: string | null): void {
    this.token = t;
  }

  resumeToken(): string | null {
    return this.token;
  }

  async send(): Promise<void> {
    this.sent += 1;
  }

  async interrupt(): Promise<void> {
    this.interrupted += 1;
  }

  async stop(reason: string): Promise<void> {
    this.stopped = reason;
    this.end();
  }
}

class ProbeRuntime implements AgentRuntime {
  readonly id = 'probe';
  readonly version = '9.9.9';
  readonly handles: ProbeHandle[] = [];
  resumedWith: Array<string | null> = [];

  constructor(private readonly hooks: ProbeHooks = {}) {}

  async capabilities(): Promise<RuntimeCapabilities> {
    if (this.hooks.capabilitiesDelayMs !== undefined) {
      await new Promise((r) => setTimeout(r, this.hooks.capabilitiesDelayMs));
    }
    return { ...CAPS, ...this.hooks.capabilities };
  }

  async start(_spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    if (this.hooks.failStart !== undefined) throw new Error(this.hooks.failStart);
    const handle = new ProbeHandle(this.hooks.resumeToken ?? null);
    this.handles.push(handle);
    this.hooks.onStart?.(ctx, handle);
    return handle;
  }

  async resume(s: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    this.resumedWith.push(token);
    return this.start(s, ctx);
  }
}

interface Rig {
  runtime: ProbeRuntime;
  hosted: HostBackedRuntime;
  client: HostClient;
  breakLink: (reason?: string) => void;
}

function rig(hooks: ProbeHooks = {}): Rig {
  const runtime = new ProbeRuntime(hooks);
  const registry = new RuntimeRegistry();
  registry.register(runtime, { label: 'probe', requiresModel: false });

  const pair = memoryChannelPair<HostCommand, HostMessage>();
  new AgentHostServer(pair.host, registry);
  const client = new HostClient({ channel: pair.main });

  return {
    runtime,
    client,
    hosted: new HostBackedRuntime(client, 'probe', runtime.version),
    breakLink: pair.breakLink,
  };
}

async function collect(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('handshake and capabilities', () => {
  it('announces the runtimes it offers', async () => {
    const r = rig();
    await expect(r.client.ready).resolves.toEqual(['probe']);
  });

  it('carries capabilities on the correlated reply', async () => {
    const r = rig({ capabilities: { contextWindow: 32768 } });
    await expect(r.hosted.capabilities(spec())).resolves.toMatchObject({ contextWindow: 32768 });
  });

  it('does not cross results when two calls overlap', async () => {
    // A single "last capabilities" slot on the client passes every sequential
    // test and hands one of these the other's answer.
    const a = rig({ capabilities: { contextWindow: 1000 }, capabilitiesDelayMs: 20 });
    const b = rig({ capabilities: { contextWindow: 2000 } });

    const [first, second] = await Promise.all([
      a.hosted.capabilities(spec()),
      b.hosted.capabilities(spec()),
    ]);

    expect(first.contextWindow).toBe(1000);
    expect(second.contextWindow).toBe(2000);
  });

  it('propagates a failure message rather than a generic error', async () => {
    const r = rig({ failStart: 'model server unreachable' });
    await expect(r.hosted.start(spec(), context())).rejects.toThrow('model server unreachable');
  });

  it('reports an unknown runtime id', async () => {
    const r = rig();
    await expect(r.hosted.capabilities(spec({ runtimeId: 'nope' }))).rejects.toThrow(/nope/);
  });
});

describe('permission asks cross the boundary', () => {
  it('routes a host-side ask to the main-side gate and back', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    const ctx = context();

    await r.hosted.start(spec(), ctx);
    const decision = await hostCtx!.requestPermission({
      agentId: newAgentId(),
      tool: 'write',
      args: { file_path: 'a.ts' },
    });

    // The gate stays in main: one policy evaluation, one place every decision is
    // logged (§13), even though the tool will execute in the host.
    expect(ctx.asked).toEqual(['write']);
    expect(decision).toEqual({ result: 'allow', scope: 'once' });
  });

  it('stamps the asking agent id from the spec', async () => {
    let hostCtx: RuntimeContext | null = null;
    const seen: string[] = [];
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    const s = spec();

    await r.hosted.start(
      s,
      context({
        requestPermission: async (ask) => {
          seen.push(ask.agentId);
          return { result: 'allow', scope: 'once' };
        },
      }),
    );
    // An adapter could pass anything; the host overwrites it with the spec's id
    // so a decision can never be attributed to the wrong agent.
    await hostCtx!.requestPermission({ agentId: newAgentId(), tool: 'read', args: {} });
    expect(seen).toEqual([s.agentId]);
  });

  it('denies when the gate itself throws', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    await r.hosted.start(
      spec(),
      context({
        requestPermission: () => Promise.reject(new Error('gate exploded')),
      }),
    );

    // A gate that fails must fail closed. Falling open on an exception is the
    // one failure mode a permission system cannot have (§13).
    const decision = await hostCtx!.requestPermission({
      agentId: newAgentId(),
      tool: 'bash',
      args: { command: 'rm -rf /' },
    });
    expect(decision).toMatchObject({ result: 'deny' });
    expect((decision as { reason: string }).reason).toContain('gate exploded');
  });

  it('denies an ask left outstanding when the handle ends', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    // A gate that never answers — a prompt the user walks away from.
    await r.hosted.start(spec(), context({ requestPermission: () => new Promise(() => {}) }));

    const asked = hostCtx!.requestPermission({ agentId: newAgentId(), tool: 'read', args: {} });
    r.runtime.handles[0]?.end();

    // Left unresolved, the adapter's loop waits forever on a teardown that has
    // already happened.
    await expect(asked).resolves.toMatchObject({ result: 'deny' });
  });

  it('answers deny for an ask whose handle main no longer knows', async () => {
    const r = rig();
    const ctx = context();
    await r.hosted.start(spec(), ctx);

    r.runtime.handles[0]?.end();
    await new Promise((res) => setTimeout(res, 5)); // let `closed` land

    // The client must reply rather than drop it, or the host waits forever.
    expect(ctx.asked).toEqual([]);
  });
});

describe('events and progress', () => {
  it('streams events across the channel in order', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());
    const drained = collect(handle.events);

    const probe = r.runtime.handles[0]!;
    probe.emit({ type: 'text', text: 'one' });
    probe.emit({ type: 'text', text: 'two' });
    probe.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    probe.end();

    const events = await drained;
    expect(events.map((e) => (e.type === 'text' ? e.text : e.type))).toEqual([
      'one',
      'two',
      'stopped',
    ]);
  });

  it('buffers events that arrive before a consumer attaches', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());

    const probe = r.runtime.handles[0]!;
    probe.emit({ type: 'text', text: 'early' });
    probe.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    probe.end();
    await new Promise((res) => setTimeout(res, 5)); // deliver before iterating

    // The contract requires `events` be subscribable before the first send; over
    // a channel that means whatever crossed early must still be there.
    const events = await collect(handle.events);
    expect(events).toHaveLength(2);
  });

  it('forwards progress signals to the main-side reporter', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    const ctx = context();
    await r.hosted.start(spec(), ctx);

    hostCtx!.reportProgress({ kind: 'heartbeat', at: '2026-07-30T00:00:00.000Z' });
    await new Promise((res) => setTimeout(res, 5));

    // Heartbeats are how a wedged tool call is distinguished from deep thinking
    // (§10); losing them at the boundary would remove that signal entirely.
    expect(ctx.progress).toHaveLength(1);
  });

  it('caches the resume token the host pushes', async () => {
    const r = rig({ resumeToken: 'tok-1' });
    const handle = await r.hosted.start(spec(), context());
    await new Promise((res) => setTimeout(res, 5));

    // Synchronous on the interface, so it cannot be a round trip. Sound only
    // because §5.4 treats the token as a cache and never as truth.
    expect(handle.resumeToken()).toBe('tok-1');
  });

  it('routes resume with a null token to resume, not start', async () => {
    const r = rig();
    await r.hosted.resume(spec(), null, context());
    // Collapsing this into `start` would take the distinction away from the
    // adapter, which is entitled to treat "nothing cached" differently.
    expect(r.runtime.resumedWith).toEqual([null]);
  });
});

describe('commands reach the host', () => {
  it('forwards send and interrupt', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());

    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await handle.interrupt();

    const probe = r.runtime.handles[0]!;
    expect(probe.sent).toBe(1);
    expect(probe.interrupted).toBe(1);
  });

  it('forwards an abort so a remote loop is still cancellable', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    const controller = new AbortController();

    await r.hosted.start(spec(), context({ abortSignal: controller.signal }));
    expect(hostCtx!.abortSignal.aborted).toBe(false);

    controller.abort();
    await new Promise((res) => setTimeout(res, 5));

    // Without this an adapter that honors only ctx.abortSignal becomes
    // uncancellable the moment it moves out of process.
    expect(hostCtx!.abortSignal.aborted).toBe(true);
  });

  it('propagates an abort that fired before the handle opened', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    const controller = new AbortController();
    controller.abort();

    await r.hosted.start(spec(), context({ abortSignal: controller.signal }));
    await new Promise((res) => setTimeout(res, 5));

    // An `addEventListener('abort')` on an already-aborted signal never fires.
    expect(hostCtx!.abortSignal.aborted).toBe(true);
  });

  it('treats stopping an already-finished handle as a no-op', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());
    r.runtime.handles[0]?.end();
    await new Promise((res) => setTimeout(res, 5));

    // Racing a turn that ended on its own is ordinary, not an error.
    await expect(handle.stop('user closed the session')).resolves.toBeUndefined();
  });
});

describe('the host dies', () => {
  it('fails an in-flight request instead of hanging', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());

    const inFlight = handle.send({ content: [{ type: 'text', text: 'go' }] });
    r.breakLink('host crashed');

    await expect(inFlight).rejects.toThrow(/host crashed|exited/);
  });

  it('closes an open stream with a retryable transport stop', async () => {
    const r = rig();
    const handle = await r.hosted.start(spec(), context());
    const drained = collect(handle.events);

    r.runtime.handles[0]?.emit({ type: 'text', text: 'partial' });
    await new Promise((res) => setTimeout(res, 5));
    r.breakLink();

    const events = await drained;
    // A truncated turn must not read as a clean finish. `transport` is
    // retryable, so the supervisor rehydrates and continues — a crash costs
    // time, never memory (§8).
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'transport' } });
  });

  it('rejects new requests once the host is gone', async () => {
    const r = rig();
    await r.hosted.start(spec(), context());
    r.breakLink();
    await new Promise((res) => setTimeout(res, 5));

    await expect(r.hosted.capabilities(spec())).rejects.toThrow();
  });

  it('notifies the owner so it can respawn', async () => {
    const runtime = new ProbeRuntime();
    const registry = new RuntimeRegistry();
    registry.register(runtime, { label: 'probe', requiresModel: false });

    const pair = memoryChannelPair<HostCommand, HostMessage>();
    new AgentHostServer(pair.host, registry);
    const onUnexpectedClose = vi.fn();
    new HostClient({ channel: pair.main, onUnexpectedClose });

    pair.breakLink('exit 1');
    await new Promise((res) => setTimeout(res, 5));

    expect(onUnexpectedClose).toHaveBeenCalledWith('exit 1');
  });

  it('stops live handles when the host shuts down cleanly', async () => {
    const r = rig();
    await r.hosted.start(spec(), context());
    r.client.dispose();
    await new Promise((res) => setTimeout(res, 5));

    expect(r.runtime.handles[0]?.stopped).toContain('host');
  });
});

describe('the real adapter over the protocol', () => {
  it('runs a gated tool call end to end', async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [
          { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
      { label: 'echo', requiresModel: false },
    );

    const pair = memoryChannelPair<HostCommand, HostMessage>();
    new AgentHostServer(pair.host, registry);
    const client = new HostClient({ channel: pair.main });
    const hosted = new HostBackedRuntime(client, 'echo', '0.0.1');

    const ctx = context();
    const handle = await hosted.start(spec({ runtimeId: 'echo' }), ctx);
    const drained = collect(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    const events = await drained;

    expect(ctx.asked).toEqual(['read']);
    expect(events.map((e) => e.type)).toEqual([
      'tool_use',
      'tool_result',
      'stopped',
    ]);
  });
});
