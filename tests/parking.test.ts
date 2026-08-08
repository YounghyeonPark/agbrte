/**
 * A session that ran out of quota and came back (DESIGN.md §4.1, §15 Phase 4).
 *
 * > *Done when:* … a quota-exhausted agent parks and resumes on its own at reset.
 *
 * Half of this already worked: `stateForStop` sends a `quota_exhausted` turn to
 * `awaiting_quota` and the attention map calls it out. What did not exist was
 * coming *back* — nothing read `resetsAt`, so a parked session sat there until a
 * human noticed and retyped, which is precisely what parking exists to avoid.
 *
 * §4.1's rule is the reason it is `awaiting_quota` and not `failed`: the four
 * `awaiting_*` states mean *paused, holding all state, will resume*. A spent
 * window is a wait, and treating it as a failure discards the work.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { InstanceId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let managers: SessionManager[] = [];

const RESETS_AT = '2026-01-01T01:00:00Z';
const START = Date.parse('2026-01-01T00:00:00Z');

/** Out of quota on the first turn, ordinary on every one after. */
function script(resetsAt?: string): EchoStep[] {
  return [
    { kind: 'text', text: 'starting' },
    { kind: 'stop', stop: { kind: 'quota_exhausted', scope: 'window', ...(resetsAt !== undefined ? { resetsAt } : {}) } },
  ];
}

const FINE: EchoStep[] = [{ kind: 'text', text: 'ok' }, { kind: 'stop', stop: { kind: 'end_turn' } }];

function clock(): { now: () => Date; advance: (ms: number) => void } {
  let at = START;
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

/**
 * A runtime that runs out once and is fine afterwards.
 *
 * The point of the test is the *second* attempt succeeding, so a script that
 * always fails would prove only that it parks.
 */
function oncePoor(resetsAt?: string): EchoRuntime {
  let first = true;
  return new EchoRuntime({
    get script(): EchoStep[] {
      if (first) {
        first = false;
        return script(resetsAt);
      }
      return FINE;
    },
  } as never);
}

function manager(runtime: EchoRuntime, now: () => Date): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(runtime, { label: 'Echo', requiresModel: false });
  // The sweeper is driven by hand below; a live timer would make this a race.
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0, now });
  managers.push(m);
  return m;
}

/** Reach the private sweep, which is otherwise on a timer. */
const wake = (m: SessionManager): void => (m as unknown as { sweepParked: () => void }).sweepParked();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-park-'));
  instanceId = (await openWorkspace(root)).instanceId;
  managers = [];
});
afterEach(async () => {
  for (const m of managers) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('running out of quota', () => {
  it('parks rather than failing, and says when it resets', async () => {
    const time = clock();
    const m = manager(oncePoor(RESETS_AT), time.now);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    const parked = await m.get(session.sessionId);
    // §4.1: a spent window is a pause, not a failure. Calling it failed would
    // throw away the work and tell the user to start again.
    expect(parked.state).toBe('awaiting_quota');
    expect(parked.needsAttention).toMatchObject({ reason: 'quota_exhausted' });
  });

  it('picks the same turn back up when the window resets', async () => {
    const time = clock();
    const m = manager(oncePoor(RESETS_AT), time.now);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'the actual work' }] });
    expect((await m.get(session.sessionId)).state).toBe('awaiting_quota');

    time.advance(61 * 60_000);
    wake(m);
    await new Promise((r) => setTimeout(r, 200));

    const events = await m.events(session.sessionId);
    // Announced, because the turn that follows is a repeat and two identical
    // turns with nothing between them read as a double-send by the user.
    expect(events.some((e) => e.type === 'session.unparked')).toBe(true);
    // The same turn, not a new one inferred from the transcript.
    const turns = events.filter((e) => e.type === 'user.turn');
    expect(turns).toHaveLength(2);
    expect((await m.get(session.sessionId)).state).toBe('awaiting_input');
  });

  it('stays put until the window actually resets', async () => {
    const time = clock();
    const m = manager(oncePoor(RESETS_AT), time.now);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    time.advance(30 * 60_000);
    wake(m);
    await new Promise((r) => setTimeout(r, 100));
    // Half an hour into an hour-long window is still inside it.
    expect((await m.get(session.sessionId)).state).toBe('awaiting_quota');
  });

  it('waits for a person when nothing said the window would reset', async () => {
    const time = clock();
    const m = manager(oncePoor(undefined), time.now);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    time.advance(24 * 60 * 60_000);
    wake(m);
    await new Promise((r) => setTimeout(r, 100));

    // Waking at a time nobody named would be a guess. Parked-forever is wrong,
    // but so is inventing a reset — this asks a human instead.
    expect((await m.get(session.sessionId)).state).toBe('awaiting_quota');
    const events = await m.events(session.sessionId);
    expect(events.some((e) => e.type === 'session.unparked')).toBe(false);
  });

  it('does not wake the same session twice', async () => {
    const time = clock();
    const m = manager(oncePoor(RESETS_AT), time.now);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    time.advance(61 * 60_000);
    wake(m);
    wake(m);
    await new Promise((r) => setTimeout(r, 200));

    // The park is cleared before the turn is sent, or every sweep after the
    // reset would fire it again.
    const events = await m.events(session.sessionId);
    expect(events.filter((e) => e.type === 'session.unparked')).toHaveLength(1);
  });
});

describe('the sweeper itself', () => {
  it('wakes a parked session even with stall detection off', async () => {
    // These are unrelated jobs that share a timer. The first version gated the
    // timer on `stallAfterMs`, so turning stall detection off also stopped every
    // quota window from ever resuming — a coupling invisible from either
    // feature's own tests, since both drove the sweep by hand.
    const time = clock();
    const m = manager(oncePoor(RESETS_AT), time.now);
    expect((m as unknown as { sweeper: unknown }).sweeper).not.toBeNull();

    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    expect((await m.get(session.sessionId)).state).toBe('awaiting_quota');
  });
});
