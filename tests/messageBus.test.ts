/**
 * Agents addressing each other (DESIGN.md §4.2, §15 Phase 6).
 *
 * > Every message is an event in the log, so agent-to-agent traffic is auditable
 * > and replayable.
 *
 * A roster whose coordination happened off the record would produce a transcript
 * that shows the work but not the reasoning that directed it — and when a roster
 * misbehaves, what it *tried* to say is usually the interesting part. So the
 * first thing tested is that the log carries the traffic, including the traffic
 * that went nowhere.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { until } from './support/until.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { messageTool, type ToolContext } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import { openWorkspace } from '@main/store/identity.js';
import type {
  AgentId,
  AgentMessage,
  InstanceId,
  OutboundMessage,
  RuntimeContext,
} from '@shared/types/index.js';

// ------------------------------------------------------------------ the tool

function toolCtx(over: Partial<ToolContext> = {}): ToolContext & { sent: OutboundMessage[] } {
  const sent: OutboundMessage[] = [];
  return {
    sent,
    workspaceRoot: '/tmp/ws',
    signal: new AbortController().signal,
    agentId: 'lead' as AgentId,
    leases: new WorkspaceLeases(),
    sendMessage: (m) => sent.push(m),
    roster: ['lead', 'worker'] as AgentId[],
    ...over,
  } as ToolContext & { sent: OutboundMessage[] };
}

describe('the message tool', () => {
  it('sends to a named agent and returns without waiting', async () => {
    const ctx = toolCtx();
    const result = await messageTool.run({ to: 'worker', kind: 'task', text: 'rename the parser' }, ctx);

    expect(result.ok).toBe(true);
    expect(ctx.sent).toEqual([
      { to: 'worker', kind: 'task', content: [{ type: 'text', text: 'rename the parser' }] },
    ]);
    // A lead that blocked until its worker replied would hold a model connection
    // open for the length of somebody else's work, and two agents each waiting
    // on the other is a deadlock that bills by the token.
    expect(result.content).toMatch(/carry on with yours/);
  });

  it('refuses an address that is not in the session, and says who is', async () => {
    const ctx = toolCtx();
    const result = await messageTool.run({ to: 'nobody', kind: 'task', text: 'x' }, ctx);

    // Refused rather than dropped: a message to an id that does not exist would
    // otherwise look sent, and the sender would wait for an answer that was
    // never coming.
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('worker');
    expect(ctx.sent).toEqual([]);
  });

  it('refuses an agent messaging itself', async () => {
    const ctx = toolCtx();
    expect((await messageTool.run({ to: 'lead', kind: 'question', text: 'x' }, ctx)).ok).toBe(false);
  });

  it('says so when there is nobody to message', async () => {
    // A single-agent session has no bus. Reporting success would tell a model
    // its message was delivered to an empty room.
    const { sendMessage, ...rest } = toolCtx();
    void sendMessage;
    const ctx = rest as ToolContext;
    const result = await messageTool.run({ to: 'worker', kind: 'task', text: 'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/single agent/);
  });

  it('rejects a kind outside the vocabulary', async () => {
    const ctx = toolCtx();
    expect((await messageTool.run({ to: 'worker', kind: 'shout', text: 'x' }, ctx)).ok).toBe(false);
  });
});

// --------------------------------------------------------------- delivery

describe('delivery through the session', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-bus-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const QUIET: EchoStep[] = [{ kind: 'stop', stop: { kind: 'end_turn' } }];

  function manager(script: EchoStep[] = QUIET): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  /** Reach the private delivery, which a runtime would otherwise have to drive. */
  const deliver = (
    m: SessionManager,
    sessionId: string,
    from: AgentId,
    message: OutboundMessage,
  ): Promise<void> =>
    (
      m as unknown as {
        deliver: (live: unknown, from: AgentId, m: OutboundMessage) => Promise<void>;
        sessions: Map<string, unknown>;
      }
    ).deliver((m as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId), from, message);

  async function pair(m: SessionManager): Promise<{ sessionId: string; lead: AgentId; worker: AgentId }> {
    const session = await m.createSession({ title: 's', goal: 'g' });
    const lead = await m.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' });
    const worker = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    return { sessionId: session.sessionId, lead: lead.agentId, worker: worker.agentId };
  }

  it('writes the message to the log and wakes the recipient', async () => {
    const m = manager();
    const { sessionId, lead, worker } = await pair(m);

    await deliver(m, sessionId, lead, {
      to: worker,
      kind: 'task',
      content: [{ type: 'text', text: 'rename the parser' }],
    });
    // The fact, not fifty milliseconds. This is the test that flaked: delivery
    // appends the message and *then* wakes the recipient, so a sleep raced the
    // second half and reported an empty log as a missing feature.
    await until(async () =>
      (await m.events(sessionId as never)).some((e) => e.type === 'user.turn'),
    );

    const events = await m.events(sessionId as never);
    const logged = events.find((e) => e.type === 'agent.message') as unknown as {
      message: AgentMessage;
    };
    expect(logged.message).toMatchObject({ from: lead, to: worker, kind: 'task', hops: 1 });

    // Woken, not merely told: a task nobody runs is a note.
    const turns = events.filter((e) => e.type === 'user.turn');
    expect(JSON.stringify(turns)).toContain('rename the parser');
  });

  it('attributes the woken turn to nobody', async () => {
    const m = manager();
    const { sessionId, lead, worker } = await pair(m);
    await deliver(m, sessionId, lead, { to: worker, kind: 'task', content: [{ type: 'text', text: 'go' }] });
    await until(async () =>
      (await m.events(sessionId as never)).some((e) => e.type === 'user.turn'),
    );

    const turn = (await m.events(sessionId as never)).find((e) => e.type === 'user.turn');
    // §5.1: an absent actor means no person acted. Attributing this to whoever
    // happens to be attached would put a name on a turn they never sent.
    expect((turn as unknown as { actor?: unknown }).actor).toBeUndefined();
  });

  it('records a broadcast without waking anyone', async () => {
    const m = manager();
    const { sessionId, lead } = await pair(m);

    await deliver(m, sessionId, lead, {
      to: 'session',
      kind: 'report',
      content: [{ type: 'text', text: 'parser done' }],
    });
    // A duration: the claim below is that a broadcast wakes *nobody*, and an
    // absence only means something if you waited for it.
    await new Promise((r) => setTimeout(r, 50));

    const events = await m.events(sessionId as never);
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
    // One broadcast starting a turn per agent is how a roster of six becomes a
    // fork bomb.
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(0);
  });

  it('records a message to an agent that is not there, and wakes nothing', async () => {
    const m = manager();
    const { sessionId, lead } = await pair(m);
    await deliver(m, sessionId, lead, {
      to: 'ghost' as AgentId,
      kind: 'task',
      content: [{ type: 'text', text: 'x' }],
    });
    // A duration, for the same reason: nothing should have been woken.
    await new Promise((r) => setTimeout(r, 50));

    const events = await m.events(sessionId as never);
    // Still logged. What a roster tried to say is the interesting part when it
    // misbehaves.
    expect(events.some((e) => e.type === 'agent.message')).toBe(true);
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(0);
  });
});


describe('two agents talking in circles', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-hops-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function manager(): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      model: 'none',
    });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  const deliver = (m: SessionManager, sessionId: string, from: AgentId, to: AgentId): Promise<void> =>
    (
      m as unknown as {
        deliver: (live: unknown, from: AgentId, msg: OutboundMessage) => Promise<void>;
        sessions: Map<string, unknown>;
      }
    ).deliver((m as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId), from, {
      to,
      kind: 'question',
      content: [{ type: 'text', text: 'and?' }],
    });

  it('stops after a bounded number of hops without a person', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const a = (await m.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    const b = (await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' })).agentId;

    // Ping-pong, with nobody watching. Without a ceiling this is a conversation
    // with a bill attached.
    const refused = async (): Promise<number> =>
      (await m.events(session.sessionId)).filter(
        (e) =>
          e.type === 'session.state' &&
          /hops without a person/.test(String((e as unknown as { reason?: string }).reason)),
      ).length;

    // Driven until the ceiling actually bites rather than for a fixed number of
    // milliseconds: a sleep encodes a guess about how long a turn takes, and the
    // guess is wrong on a loaded machine.
    const deadline = Date.now() + 5_000;
    while ((await refused()) === 0) {
      if (Date.now() > deadline) throw new Error('the hop ceiling never refused anything');
      for (let i = 0; i < 4; i += 1) {
        await deliver(m, session.sessionId, i % 2 === 0 ? a : b, i % 2 === 0 ? b : a);
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Let the turns this started finish before the fixture is torn down. A
    // `void send` still holds the log open, and on Windows removing a directory
    // out from under an open handle fails the test for a reason that has nothing
    // to do with what it was checking.
    await until(() =>
      [a, b].every(() => m.get(session.sessionId).state !== 'working'),
    );

    const refusals = { length: await refused() };
    // Refused, and recorded — a roster that keeps hitting the ceiling should be
    // visible rather than merely slow.
    expect(refusals.length).toBeGreaterThan(0);
  });

  it('clears the count when a person sends a turn', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const a = (await m.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    const b = (await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' })).agentId;

    for (let i = 0; i < 6; i += 1) {
      await deliver(m, session.sessionId, i % 2 === 0 ? a : b, i % 2 === 0 ? b : a);
      await new Promise((r) => setTimeout(r, 5));
    }

    // A human in the loop is exactly the thing the ceiling exists to wait for.
    await m.send(
      session.sessionId,
      a,
      { content: [{ type: 'text', text: 'carry on' }] },
      { id: 'me', via: 'peer-credential' },
    );

    const live = (m as unknown as { sessions: Map<string, { hops: Map<AgentId, number> }> }).sessions;
    expect(live.get(session.sessionId)?.hops.size).toBe(0);
  });
});

// --------------------------------------------------------- what an adapter may say

describe('what an adapter is allowed to claim', () => {
  it('cannot name a different sender', () => {
    /**
     * A compile-time property, asserted here so a future edit that widens
     * `sendMessage` has to argue with a test. `OutboundMessage` omits `from` and
     * `hops`: the sender is stamped by the owner of the log, which is the only
     * party that cannot be wrong about it, and the hop count is the ceiling's
     * own bookkeeping.
     */
    const ctx: RuntimeContext = {
      abortSignal: new AbortController().signal,
      reportProgress: () => undefined,
      requestPermission: async () => ({ result: 'deny', reason: 'no' }),
      sendMessage: (message) => {
        expect(Object.keys(message).sort()).toEqual(['content', 'kind', 'to']);
      },
    };
    ctx.sendMessage?.({ to: 'worker' as AgentId, kind: 'task', content: [{ type: 'text', text: 'x' }] });
  });
});
