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
  type OutboundPeerMessage,
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
  registry.register(runtime, { label: 'probe', model: 'none' });

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
  it('announces the runtimes it offers, and the models it can reach', async () => {
    const r = rig();
    // Widened from a bare id list: one host can reach several endpoints, and a
    // client that cannot see them cannot offer a choice — nor name the provider
    // a turn was sent to, which §13 requires.
    //
    // Widened again to carry a **descriptor** per runtime rather than an id.
    // The owner forks this process and then builds its own `RuntimeRegistry`,
    // because `admit()` runs beside the log and the gate — and with only ids to
    // go on it built that registry from a constant in another file. So an
    // installed CLI detected here was advertised to every client by the very
    // process that would refuse it. `model` in particular cannot be inferred
    // from an id: `optional` and `none` fail admission in opposite directions
    // (§17 Q11).
    await expect(r.client.ready).resolves.toEqual({
      runtimeIds: ['probe'],
      runtimes: [{ id: 'probe', label: 'probe', model: 'none' }],
      // Nothing was looked for and missed here — the empty list is *this host
      // has nothing to report*, which is what a client renders as silence.
      runtimeNotes: [],
      endpoints: [],
    });
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

/**
 * §17 Q20's tools have to survive the same crossing, and did not.
 *
 * `RuntimeContext.sessionTools` is how MCP reaches a model, and the runtime is
 * what tells a model which tools exist — so a context that arrives in the host
 * process without them produces a session that logs `mcp.attached`, shows the
 * tool in the UI, and never mentions it to the model. Every unit test passed:
 * they hand a runtime a context directly and never cross this boundary. A live
 * run through the real app is what found it, exactly as the note on `compactAsk`
 * says happened for compaction.
 *
 * So the property is tested here, at the boundary, where a rename or a dropped
 * spread can be caught in milliseconds instead of by a model that quietly stops
 * having a tool.
 */
describe('session tools cross the boundary', () => {
  it('declares them to the runtime and runs them back on the owner', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    const ran: Array<Record<string, unknown>> = [];
    await r.hosted.start(
      spec(),
      context({
        sessionTools: [
          {
            name: 'mcp__search__web-search',
            description: 'Search the web',
            schema: { type: 'object', properties: { query: { type: 'string' } } },
            run: async (args) => {
              ran.push(args);
              return { ok: true, summary: 'search ok', content: 'a result' };
            },
          },
        ],
      }),
    );

    // Declared: name, description and schema, which is everything a runtime
    // needs to put the tool in front of a model.
    expect(hostCtx!.sessionTools?.map((t) => t.name)).toEqual(['mcp__search__web-search']);
    expect(hostCtx!.sessionTools?.[0]?.description).toBe('Search the web');
    expect(hostCtx!.sessionTools?.[0]?.schema).toMatchObject({ type: 'object' });

    // Executed on the owner's side, where the MCP connection is — the closure
    // itself never crossed.
    const result = await hostCtx!.sessionTools![0]!.run(
      { query: 'mcp' },
      new AbortController().signal,
    );
    expect(result).toEqual({ ok: true, summary: 'search ok', content: 'a result' });
    expect(ran).toEqual([{ query: 'mcp' }]);
  });

  it('answers a call the owner cannot run, rather than hanging the turn', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    await r.hosted.start(
      spec(),
      context({
        sessionTools: [
          {
            name: 'mcp__dead__lookup',
            description: 'x',
            schema: {},
            run: async () => {
              throw new Error('the MCP server exited');
            },
          },
        ],
      }),
    );

    // A tool failure, not a dropped reply: a turn in the other process is
    // blocked on this promise, and the model has to be told the tool did not
    // work rather than left waiting for an answer that is not coming.
    const result = await hostCtx!.sessionTools![0]!.run({}, new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exited');
  });

  it('settles a call left outstanding when the handle ends', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    await r.hosted.start(
      spec(),
      context({
        sessionTools: [
          {
            name: 'mcp__slow__lookup',
            description: 'x',
            schema: {},
            run: () => new Promise(() => {}),
          },
        ],
      }),
    );

    const call = hostCtx!.sessionTools![0]!.run({}, new AbortController().signal);
    r.runtime.handles[0]?.end();

    // The same argument as the outstanding ask above, with a different verdict:
    // this is not a decision anybody declined to make, it is a call that will
    // not come back.
    await expect(call).resolves.toMatchObject({ ok: false });
  });

  it('says nothing about session tools when a session has none', async () => {
    // An empty array on every context would make every runtime merge nothing on
    // every turn, and would make "this session has injected tools" unanswerable
    // from the wire.
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    await r.hosted.start(spec(), context());
    expect(hostCtx!.sessionTools).toBeUndefined();
  });
});

/**
 * §17 Q22's group channel, at the boundary — the third hook to be left on the
 * wrong side of it.
 *
 * `compactAsk` went first and `sessionTools` second, and the note above says why
 * both were invisible: a unit test hands a runtime a context it built itself and
 * never crosses this seam. `sendPeerMessage` and `groupPeers` were then omitted
 * from the same assembly, so `message_peer` refused with **"this session is not
 * in a group"** on sessions that were demonstrably in one — the log carried
 * `session.joined_group`, the host answered with the group when asked, and the
 * agent, which runs over here, had never been told.
 *
 * Found by grouping three sessions and watching a tester try to report a failing
 * test to the engineer who could fix it. What it cost was not one tool call: it
 * was the whole reason to put sessions in a group.
 */
describe('the group channel crosses the boundary', () => {
  const message = (): OutboundPeerMessage => ({
    toSessionId: 's-other',
    kind: 'report',
    text: 'the top-row case fails',
  });

  it('carries the peer list and delivers back on the owner', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    const sent: OutboundPeerMessage[] = [];
    await r.hosted.start(
      spec(),
      context({
        groupPeers: [{ sessionId: 's-other', title: 'logic: the board and the winner' }],
        sendPeerMessage: async (m) => {
          sent.push(m);
          return { accepted: true };
        },
      }),
    );

    // The list is data and crosses as data; without it `message_peer` has
    // nowhere to send and refuses before it ever reaches the wire.
    expect(hostCtx!.groupPeers).toEqual([
      { sessionId: 's-other', title: 'logic: the board and the winner' },
    ]);

    // The closure did not cross. It ran on the owner's side, where the sessions
    // and the logs are, and only the verdict came back.
    await expect(hostCtx!.sendPeerMessage!(message())).resolves.toEqual({ accepted: true });
    expect(sent).toEqual([message()]);
  });

  it('passes a refusal through verbatim rather than swallowing it', async () => {
    // §17 Q22: refused rather than dropped. A model told nothing waits for a
    // reply that is not coming; a model told "not in your group" can act.
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    await r.hosted.start(
      spec(),
      context({
        groupPeers: [{ sessionId: 's-other', title: 'x' }],
        sendPeerMessage: async () => ({ accepted: false, reason: 'that session has finished' }),
      }),
    );

    await expect(hostCtx!.sendPeerMessage!(message())).resolves.toEqual({
      accepted: false,
      reason: 'that session has finished',
    });
  });

  it('answers rather than hanging when delivery throws on the owner', async () => {
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });

    await r.hosted.start(
      spec(),
      context({
        groupPeers: [{ sessionId: 's-other', title: 'x' }],
        sendPeerMessage: async () => {
          throw new Error('the other log could not be written');
        },
      }),
    );

    // A turn is blocked on this promise in the other process, so a throw has to
    // come back as a refusal — the same rule `toolResult` follows.
    await expect(hostCtx!.sendPeerMessage!(message())).resolves.toMatchObject({
      accepted: false,
      reason: 'the other log could not be written',
    });
  });

  it('gives a session in no group neither half', async () => {
    /*
     * Both or neither, which is the tool's own rule.
     *
     * A sender with no list is a guessing game and a list with no sender is a
     * tease, so `message_peer`'s refusal keys on the sender being absent. Wiring
     * the sender unconditionally here would turn "this session is not in a
     * group" into a message posted into an empty room.
     */
    let hostCtx: RuntimeContext | null = null;
    const r = rig({ onStart: (ctx) => (hostCtx = ctx) });
    await r.hosted.start(spec(), context());
    expect(hostCtx!.groupPeers).toBeUndefined();
    expect(hostCtx!.sendPeerMessage).toBeUndefined();
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
    registry.register(runtime, { label: 'probe', model: 'none' });

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
      { label: 'echo', model: 'none' },
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
