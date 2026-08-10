/**
 * How many agent loops one host runs at once (DESIGN.md §8, §16).
 *
 * §8 specified this with a number and a discipline — `min(8, cores − 2)`, FIFO
 * above the cap — and nothing implemented it, so concurrency was bounded by
 * nothing. Ten concurrent sessions passed their test because there was no queue,
 * not because queueing worked.
 *
 * The properties that matter are the ones a broken semaphore gets subtly wrong:
 * never more than the cap *at any instant*, and served in the order they asked.
 * Both fail quietly — over-cap shows up as a machine swapping, and unfair
 * ordering as one session out of ten that never moves.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultTurnCap, TurnSlots } from '@main/concurrency.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { until } from './support/until.js';
import type { AgentId, SessionId, ToolPolicy } from '@shared/types/index.js';

describe('the cap holds at every instant', () => {
  it('never runs more than it was given', async () => {
    const slots = new TurnSlots(3);
    let running = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const release = await slots.acquire();
        running += 1;
        peak = Math.max(peak, running);
        // A turn is not synchronous, and a semaphore that only holds across
        // synchronous code holds nothing.
        await new Promise((r) => setTimeout(r, 1));
        running -= 1;
        release();
      }),
    );

    expect(peak).toBe(3);
    expect(slots.running).toBe(0);
  });

  it('does not let a newcomer jump the queue', async () => {
    /**
     * The bug this was written with. Releasing by decrementing and *then* waking
     * a waiter leaves a window: the waiter resumes on a microtask, and anything
     * calling `acquire` in between sees a free slot and takes it. Both proceed,
     * the host runs one over its cap, and the queued turn waits longer for
     * having asked first.
     *
     * Fixed by transferring the slot rather than counting it twice, and this is
     * the assertion that would have caught it — with a cap of one, order is the
     * only thing that can be wrong.
     */
    const slots = new TurnSlots(1);
    const order: number[] = [];

    const first = await slots.acquire();
    const queued = [1, 2, 3].map(async (n) => {
      const release = await slots.acquire();
      order.push(n);
      release();
    });

    // Let all three queue before anything is released.
    await new Promise((r) => setTimeout(r, 5));
    first();
    await Promise.all(queued);

    expect(order).toEqual([1, 2, 3]);
  });

  it('holds the cap when a newcomer arrives in the handoff window', async () => {
    /**
     * The test the other two could not do, and the reason this one exists.
     *
     * Reintroducing the bug — decrement on release, then wake — left every
     * assertion above passing, because none of them puts an `acquire` in the
     * window between the decrement and the woken waiter resuming. That window is
     * a microtask wide and is exactly where the over-cap happens: the newcomer
     * sees a free slot, takes it, and then the waiter increments too.
     *
     * So this calls `acquire` **synchronously after** the release, with no await
     * in between, which is the only way to be inside that window on purpose.
     */
    const slots = new TurnSlots(1);
    let running = 0;
    let peak = 0;

    const track = async (): Promise<void> => {
      const release = await slots.acquire();
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
      release();
    };

    const holder = await slots.acquire();
    running += 1;
    peak = Math.max(peak, running);

    const waiter = track();
    await new Promise((r) => setTimeout(r, 5)); // let it queue

    running -= 1;
    holder();
    const newcomer = track(); // no await between the release and this

    await Promise.all([waiter, newcomer]);
    expect(peak, 'two turns ran at once under a cap of one').toBe(1);
    expect(slots.running).toBe(0);
  });

  it('only reports a wait when there was one', async () => {
    // A queue depth reported for a queue that never formed teaches a user to
    // ignore the message.
    const slots = new TurnSlots(2);
    const waits: number[] = [];

    const a = await slots.acquire((n) => waits.push(n));
    const b = await slots.acquire((n) => waits.push(n));
    expect(waits).toEqual([]);

    const queued = slots.acquire((n) => waits.push(n));
    await new Promise((r) => setTimeout(r, 5));
    expect(waits).toEqual([1]);

    a();
    (await queued)();
    b();
  });

  it('ignores a second release rather than inventing a slot', async () => {
    // A `finally` after an early return is a real shape, and handing out a slot
    // that does not exist is far worse than ignoring a duplicate.
    const slots = new TurnSlots(1);
    const release = await slots.acquire();
    release();
    release();

    expect(slots.running).toBe(0);
  });

  it('leaves the machine something', () => {
    // §8's `min(8, cores − 2)`: the subtraction is for the app and the host
    // process themselves, and the ceiling is because a 64-core box is bounded by
    // RAM and by how many sessions a person can read, not by cores.
    expect(defaultTurnCap()).toBeGreaterThanOrEqual(1);
    expect(defaultTurnCap()).toBeLessThanOrEqual(8);
  });
});

describe('turns queue behind the cap on a real host', () => {
  const roots: string[] = [];
  const managers: SessionManager[] = [];

  beforeEach(() => {
    roots.length = 0;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    for (const root of roots) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('runs six sessions through a cap of two, and finishes all of them', async () => {
    /**
     * The end-to-end shape of §8's promise. What is asserted is that queueing
     * does not lose anything — a cap that dropped the seventh turn, or left it
     * pending forever, would look exactly like a slow machine.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-cap-'));
    roots.push(root);
    const identity = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [
          { kind: 'text', text: 'working' },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
      { label: 'Echo', model: 'none' },
    );
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
      maxConcurrentTurns: 2,
    });
    managers.push(manager);

    const made = await Promise.all(
      Array.from({ length: 6 }, async (_unused, i) => {
        const session = await manager.createSession({ title: `s${i}`, goal: 'g' });
        const agent = await manager.addAgent(session.sessionId, {
          role: 'worker',
          runtimeId: 'echo',
        });
        return { sessionId: session.sessionId, agentId: agent.agentId, i };
      }),
    );

    await Promise.all(
      made.map(({ sessionId, agentId, i }) =>
        manager.send(sessionId as SessionId, agentId as AgentId, {
          content: [{ type: 'text', text: `marker ${i}` }],
        }),
      ),
    );

    for (const { sessionId, i } of made) {
      expect((await manager.get(sessionId as SessionId)).state).toBe('awaiting_input');
      // And still its own work, not a neighbour's — queueing must not reorder
      // whose turn ran where.
      expect(JSON.stringify(await manager.events(sessionId as SessionId))).toContain(`marker ${i}`);
    }
  }, 60_000);
});

describe('a turn waiting for a person is not a turn using the machine', () => {
  const roots: string[] = [];
  const managers: SessionManager[] = [];

  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    for (const root of roots.splice(0)) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('lets another agent run while one is blocked on a prompt, under a cap of one', async () => {
    /**
     * Found by CI on a small runner rather than by reading the code.
     *
     * `defaultTurnCap()` is `min(8, cores − 2)`, which is **1** on any machine
     * with three cores or fewer — a modest VM, a CI runner, a Raspberry Pi. The
     * slot used to be held across a permission prompt, so one unanswered
     * question stopped every agent on the host, on every session, until a human
     * came back. Every development machine here has four cores or more, so it
     * passed everywhere it was ever run, and surfaced as an unrelated tree test
     * timing out on all three CI platforms at once.
     *
     * The cap is pinned to 1 here rather than left to the hardware, because a
     * test whose meaning depends on the core count of the machine running it is
     * the thing that hid this in the first place.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-blockedslot-'));
    roots.push(root);
    const identity = await openWorkspace(root);

    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [
          { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
      { label: 'Echo', model: 'none' },
    );
    // §13's local defaults allow `read` outright, so an agent scripted to call
    // it would finish its turn and never block — which would make this pass for
    // the wrong reason. An empty rule list with `defaultAction: 'ask'` is what
    // actually reaches a human.
    const asks: ToolPolicy = { rules: [], defaultAction: 'ask' };
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
      maxConcurrentTurns: 1,
      stallAfterMs: 0,
    });
    managers.push(manager);

    // One agent, blocked on a prompt nobody is going to answer yet.
    const blocked = await manager.createSession({ title: 'blocked', goal: 'g' });
    const waiter = await manager.addAgent(blocked.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      policy: asks,
    });
    void manager
      .send(blocked.sessionId as SessionId, waiter.agentId as AgentId, {
        content: [{ type: 'text', text: 'go' }],
      })
      .catch(() => undefined);
    await until(() => manager.pendingPermissions().length > 0, 20_000);

    // A different session entirely. Under the old behaviour this could not
    // start: the only slot on the machine was held by a turn waiting for a human.
    const other = await manager.createSession({ title: 'other', goal: 'g' });
    const free = await manager.addAgent(other.sessionId, { role: 'worker', runtimeId: 'echo' });
    const ran = manager.send(other.sessionId as SessionId, free.agentId as AgentId, {
      content: [{ type: 'text', text: 'go' }],
    });

    // It *completing* is the assertion. Under the old behaviour it never
    // resolved: the only slot on the machine was held by a turn waiting for a
    // human, so this one queued behind an answer that was never coming.
    await ran;
    expect((await manager.get(other.sessionId as SessionId)).state).toBe('awaiting_input');
    // And the blocked one is still blocked, not quietly abandoned.
    expect(manager.pendingPermissions().length).toBe(1);
  }, 60_000);

  it('takes a slot back before running the tool it was given permission for', async () => {
    // The other half. Handing the slot back must not mean the work that follows
    // an answer runs outside the cap — a host that let every answered prompt
    // through at once would be uncapped exactly when it is busiest.
    const root = await mkdtemp(join(tmpdir(), 'agbrte-blockedslot-'));
    roots.push(root);
    const identity = await openWorkspace(root);

    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [
          { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
          { kind: 'stop', stop: { kind: 'end_turn' } },
        ],
      }),
      { label: 'Echo', model: 'none' },
    );
    // §13's local defaults allow `read` outright, so an agent scripted to call
    // it would finish its turn and never block — which would make this pass for
    // the wrong reason. An empty rule list with `defaultAction: 'ask'` is what
    // actually reaches a human.
    const asks: ToolPolicy = { rules: [], defaultAction: 'ask' };
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
      maxConcurrentTurns: 1,
      stallAfterMs: 0,
    });
    managers.push(manager);

    const session = await manager.createSession({ title: 's', goal: 'g' });
    const agent = await manager.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      policy: asks,
    });
    const turn = manager.send(session.sessionId as SessionId, agent.agentId as AgentId, {
      content: [{ type: 'text', text: 'go' }],
    });

    await until(() => manager.pendingPermissions().length > 0, 20_000);
    const [request] = manager.pendingPermissions();
    await manager.respondPermission(request!.requestId, { result: 'allow', scope: 'once' });

    // It finishes, which is what proves the slot was retaken rather than lost:
    // a turn that never got one back would hang here forever.
    await turn;
    expect((await manager.get(session.sessionId as SessionId)).state).toBe('awaiting_input');
  }, 60_000);
});
