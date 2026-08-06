/**
 * Turn queueing and access roles (DESIGN.md §7, §17 Q14).
 *
 * Several clients may hold read-write access to one session, so two people can
 * send to the same agent. §17 Q14 listed three ways to resolve that — an
 * exclusive owner, a queue, or a soft lock — and this is the queue.
 *
 * The interesting behaviour is not "turns run in order". It is **what does not
 * queue**: an interrupt behind the turn it cancels is useless, and a permission
 * answer behind the turn that is blocked waiting for it is a deadlock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentId, InstanceId, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'gilmok-queue-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manager(script?: EchoStep[]): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime(script ? { script } : {}), {
    label: 'Echo',
    requiresModel: false,
  });
  return new SessionManager({ registry, workspaceRoot: root, instanceId });
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

const ECHOES: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

async function withAgent(
  sm: SessionManager,
): Promise<{ sessionId: SessionId; agentId: AgentId }> {
  const session = await sm.createSession({ title: 's', goal: 'g' });
  const agent = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  return { sessionId: session.sessionId, agentId: agent.agentId };
}

describe('turn ordering', () => {
  it('runs turns in the order they arrived, not concurrently', async () => {
    const sm = manager(ECHOES);
    const { sessionId, agentId } = await withAgent(sm);

    // Two clients sending at almost the same moment. Neither can see the other,
    // so arrival at the owner is the only ordering that exists.
    await Promise.all([
      sm.send(sessionId, agentId, TEXT('first')),
      sm.send(sessionId, agentId, TEXT('second')),
      sm.send(sessionId, agentId, TEXT('third')),
    ]);

    const turns = (await sm.events(sessionId))
      .filter((e) => e.type === 'user.turn')
      .map((e) => (e.content[0] as { text: string }).text);

    expect(turns).toEqual(['first', 'second', 'third']);
  });

  it('never runs two turns for one agent at once', async () => {
    const sm = manager(ECHOES);
    const { sessionId, agentId } = await withAgent(sm);

    await Promise.all([
      sm.send(sessionId, agentId, TEXT('a')),
      sm.send(sessionId, agentId, TEXT('b')),
    ]);

    // Interleaving would show as a turn starting before the previous one stopped.
    const marks = (await sm.events(sessionId))
      .filter((e) => e.type === 'user.turn' || e.type === 'agent.stopped')
      .map((e) => (e.type === 'user.turn' ? 'start' : 'stop'));

    expect(marks).toEqual(['start', 'stop', 'start', 'stop']);
  });

  it('reports the backlog so a client can show it', async () => {
    const sm = manager(ECHOES);
    const { sessionId, agentId } = await withAgent(sm);

    const depths: number[] = [];
    sm.on('queue', (_s, _a, depth: number) => depths.push(depth));

    await Promise.all([
      sm.send(sessionId, agentId, TEXT('a')),
      sm.send(sessionId, agentId, TEXT('b')),
    ]);

    // Sending into a silent queue makes the app look broken; the depth is what
    // lets the composer say "1 waiting".
    expect(Math.max(...depths)).toBeGreaterThan(0);
    expect(sm.queueDepth(agentId)).toBe(0);
  });

  it('lets a failing turn go without stranding the ones behind it', async () => {
    const sm = manager(ECHOES);
    const { sessionId, agentId } = await withAgent(sm);

    const bad = sm.send(sessionId, 'agent-that-does-not-exist' as AgentId, TEXT('nope'));
    const good = sm.send(sessionId, agentId, TEXT('fine'));

    await expect(bad).rejects.toThrow();
    // A rejected turn must not take the queue with it.
    await expect(good).resolves.toBeUndefined();
  });

  it('queues per agent, so two agents are not serialized behind each other', async () => {
    const sm = manager(ECHOES);
    const session = await sm.createSession({ title: 's', goal: 'g' });
    const a = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const b = await sm.addAgent(session.sessionId, { role: 'reviewer', runtimeId: 'echo' });

    // §4.2 has agents in one session running in parallel, so a session-wide
    // queue would serialize work that is meant to be concurrent.
    await Promise.all([
      sm.send(session.sessionId, a.agentId, TEXT('to a')),
      sm.send(session.sessionId, b.agentId, TEXT('to b')),
    ]);

    expect(sm.queueDepth(a.agentId)).toBe(0);
    expect(sm.queueDepth(b.agentId)).toBe(0);
    expect((await sm.events(session.sessionId)).filter((e) => e.type === 'user.turn')).toHaveLength(2);
  });
});

describe('what must not queue', () => {
  it('answers a permission request while a turn is queued behind it', async () => {
    const sm = manager([
      { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const { sessionId, agentId } = await withAgent(sm);

    // This script asks on *every* turn, so the queued turn asks too. The first
    // request is answered explicitly below — that is the assertion; the rest are
    // auto-denied so the queue can drain.
    let firstAsk: ((id: string) => void) | null = null;
    const asked = new Promise<string>((resolve) => (firstAsk = resolve));
    sm.on('permission', (r: { requestId: string }) => {
      if (firstAsk !== null) {
        const announce = firstAsk;
        firstAsk = null;
        announce(r.requestId);
        return;
      }
      void sm.respondPermission(r.requestId, { result: 'deny', reason: 'no' });
    });

    const first = sm.send(sessionId, agentId, TEXT('go'));
    const queued = sm.send(sessionId, agentId, TEXT('behind it'));

    const requestId = await asked;
    // The running turn is blocked *on this answer*. If answering queued behind
    // the turn already waiting, the session would deadlock outright: the answer
    // waits for the turn, the turn waits for the answer.
    await expect(
      sm.respondPermission(requestId, { result: 'deny', reason: 'no' }),
    ).resolves.toBe('answered');

    await Promise.all([first, queued]);
    expect(sm.queueDepth(agentId)).toBe(0);
  });

  it('interrupts without waiting for the queue to drain', async () => {
    const sm = manager(ECHOES);
    const { sessionId, agentId } = await withAgent(sm);

    const turns = Promise.all([
      sm.send(sessionId, agentId, TEXT('a')),
      sm.send(sessionId, agentId, TEXT('b')),
    ]);

    // An interrupt that arrived after the turn it was cancelling had finished
    // would be useless, so it is out-of-band by construction.
    await expect(sm.interrupt(sessionId)).resolves.toBeUndefined();
    await turns;
  });
});
/**
 * Access-role enforcement used to be asserted here against `Fleet`. It moved to
 * `tests/sessionHost.test.ts` when the host became the owner: the fleet no
 * longer holds a guard, and a test against a layer that does not enforce is a
 * test of nothing.
 */
