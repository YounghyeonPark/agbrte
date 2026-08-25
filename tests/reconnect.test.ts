/**
 * Coming back after the link drops (DESIGN.md §6.4, §8, §15 Phase 5).
 *
 * §15's criterion for this phase is blunt: *pull the network cable mid-turn with
 * zero event loss or duplication.* That is what is under test here, and both
 * halves matter equally — a reconnect that silently drops three events is worse
 * than one that fails loudly, because the transcript then disagrees with the log
 * and nothing says so.
 *
 * The distinction the whole feature turns on is between **two different closes**.
 * A host saying `push.closing` has stopped on purpose and there is nothing to
 * return to. A socket dying says nothing whatsoever about the host — and on a
 * remote workspace it usually means the agent is still working perfectly well on
 * the other side. Treating those the same is what made a dropped tunnel erase a
 * running host from the UI.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { until } from './support/until.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet } from '@main/fleet.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AgentId, AgbrteEvent, SessionId } from '@shared/types/index.js';

const DONE: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const RUNTIMES = [{ id: 'echo', label: 'Echo', version: '1', model: 'none' as const }];

let roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-reconnect-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A fleet whose transport can be cut.
 *
 * The host outlives the connection, exactly as a real one does — that is the
 * property being tested, so faking it by rebuilding the server on reconnect
 * would test nothing.
 */
async function rig(script: EchoStep[] = DONE) {
  const root = await makeRoot();
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId: identity.instanceId });
  const server = new SessionHostServer({
    manager,
    identity: {
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot: root,
      runtimes: ['echo'],
    },
  });

  let reachable = true;
  let live: { host: { close(): void }; main: { close(): void } } | null = null;

  const fleet = new Fleet({
    runtimes: RUNTIMES,
    // Zero so a test does not spend real seconds inside the backoff.
    maxBackoffMs: 1,
    connect: async () => {
      if (!reachable) throw new Error('link is down');
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      live = pair as never;
      return new HostConnection({ channel: pair.main });
    },
  });

  return {
    root,
    fleet,
    manager,
    instanceId: identity.instanceId,
    /** Kill the socket from the far end, as a dying tunnel does. */
    cut(): void {
      live?.host.close();
    },
    /** Keep the link down so reconnects fail until `restore()`. */
    unplug(): void {
      reachable = false;
      live?.host.close();
    },
    restore(): void {
      reachable = true;
    },
    /** The host announcing its own shutdown, which is not a dropped link. */
    async stopHost(): Promise<void> {
      reachable = false;
      server.stop('host stopping');
    },
  };
}


describe('a dropped link', () => {
  it('keeps the host and says it is reconnecting, rather than erasing it', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const states: string[] = [];
    r.fleet.on('link', (_id: unknown, state: unknown) => states.push(state as string));
    const detached: string[] = [];
    r.fleet.on('detached', (_id: unknown, reason: unknown) => detached.push(reason as string));

    r.unplug();
    await until(() => states.includes('reconnecting'));

    // The sessions are still there and the agent may still be working. A UI that
    // drops the host at the first lost packet tells the user the opposite.
    expect(r.fleet.hosts()).toHaveLength(1);
    expect(r.fleet.hosts()[0]!.link).toBe('reconnecting');
    expect(detached).toEqual([]);
  });

  /**
   * A machine that cannot answer must not take the answer for every machine.
   *
   * Reported from a real window: pressing Update on a remote host put
   * `Error invoking remote method 'agbrte:sessions.list': Error: closed
   * locally` across the top of the app. That sentence describes *our own*
   * deliberate disconnect and names nothing anybody can act on — and behind it
   * was every other machine's list, lost to `Promise.all`, because one entry
   * rejecting is the whole result rejecting.
   *
   * Two states reach this, one on purpose and one by accident: `updateHost`
   * closes the link to restart the host, and a tunnel dies on its own. This
   * covers the second, which is the harder one — the entry learns it is down
   * from a close handler that races the rejection of the calls in flight.
   *
   * The answer is the last one that host gave, not an empty list. Nothing about
   * those sessions changed when the link did: they are folders on a disk on the
   * other side, and the row already says the link is reconnecting.
   */
  it('answers what the host last said, rather than failing the list', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });
    await r.fleet.createSession(r.instanceId, { title: 'still here', goal: 'g' });

    expect((await r.fleet.list()).map((s) => s.title)).toEqual(['still here']);

    r.unplug();
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');

    expect((await r.fleet.list()).map((s) => s.title)).toEqual(['still here']);
    // The unopened rows come from the same call for the same reason.
    await expect(r.fleet.listOnDisk()).resolves.toBeInstanceOf(Array);
  });

  it('replays what happened while it was down, losing nothing', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const session = await r.fleet.createSession(r.instanceId, { title: 's', goal: 'g' });
    const agent = await r.fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const seen: AgbrteEvent[] = [];
    r.fleet.on('event', (_i: unknown, _s: unknown, e: unknown) => seen.push(e as AgbrteEvent));

    r.unplug();
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');

    // The work carries on without us — the whole point of the host owning it.
    await r.manager.send(session.sessionId, agent.agentId as AgentId, {
      content: [{ type: 'text', text: 'while you were away' }],
    });
    expect(seen).toHaveLength(0);

    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');
    await until(() => seen.some((e) => e.type === 'agent.stopped'));

    // Everything the host recorded while we were gone arrives on reconnect.
    const types = seen.map((e) => e.type);
    expect(types).toContain('user.turn');
    expect(types).toContain('agent.text');
    expect(types).toContain('agent.stopped');
  });

  it('replays nothing twice', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });
    const session = await r.fleet.createSession(r.instanceId, { title: 's', goal: 'g' });
    const agent = await r.fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const seen: AgbrteEvent[] = [];
    r.fleet.on('event', (_i: unknown, _s: unknown, e: unknown) => seen.push(e as AgbrteEvent));

    // A turn *before* the cut, so catch-up has history it has already delivered.
    await r.fleet.send(session.sessionId, agent.agentId as AgentId, 'first');
    await until(() => seen.some((e) => e.type === 'agent.stopped'));
    const before = seen.length;

    r.unplug();
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');
    // A duration, and correctly so: "no duplicate arrived" is a claim about a
    // period of time, and there is nothing to poll for when the assertion is an
    // absence.
    await new Promise((res) => setTimeout(res, 100));

    // The high-water mark is what makes this exact: `fromSeq` is exclusive, so
    // asking from the last seq seen returns only what came after it.
    expect(seen).toHaveLength(before);
    const seqs = seen.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('does not come back when the host said it was stopping', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const detached: string[] = [];
    r.fleet.on('detached', (_id: unknown, reason: unknown) => detached.push(reason as string));

    // `closing` is a statement about the host, not the link: it has stopped, and
    // dialling again would either fail forever or start a host nobody asked for.
    await r.stopHost();
    await until(() => detached.length > 0);

    expect(r.fleet.hosts()).toHaveLength(0);
  });

  it('stops trying once the host is detached on purpose', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    r.unplug();
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');

    await r.fleet.detach(r.instanceId);
    expect(r.fleet.hosts()).toHaveLength(0);

    // A loop that outlived its entry would dial a host nobody is watching,
    // forever. Restoring the link must not resurrect it.
    r.restore();
    await new Promise((res) => setTimeout(res, 100));
    expect(r.fleet.hosts()).toHaveLength(0);
  });

  it('catches up sessions that were only opened before the cut', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });
    const session = await r.fleet.createSession(r.instanceId, { title: 's', goal: 'g' });
    const agent = await r.fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await r.fleet.send(session.sessionId, agent.agentId as AgentId, 'first');

    const sessions: Array<{ sessionId: SessionId; state: string }> = [];
    r.fleet.on('session', (_i: unknown, s: unknown) => sessions.push(s as never));

    r.unplug();
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');

    // The session record itself, not only its events: state can move while the
    // link is down and no push reaches us, so a client that only replayed events
    // would show a stale state forever.
    await until(() => sessions.some((s) => s.sessionId === session.sessionId));
  });
});

describe('the cable comes out mid-turn (§15 Phase 5)', () => {
  /**
   * Phase 5's second criterion is "pull the network cable **mid-turn** with zero
   * event loss or duplication", and the tests above cut the link and *then* run
   * a turn. That exercises catch-up, which is most of it — but not the harder
   * half: events already in flight when the link drops, and a batch that may
   * have been half delivered.
   *
   * Checked by trying it rather than by reasoning about `fromSeq`, because the
   * failure this guards is a session that quietly shows a line twice or not at
   * all, and nobody reads a transcript closely enough to catch either.
   */
  const CHATTY: EchoStep[] = [
    { kind: 'text', text: 'one' },
    { kind: 'text', text: 'two' },
    { kind: 'text', text: 'three' },
    { kind: 'text', text: 'four' },
    { kind: 'stop', stop: { kind: 'end_turn' } },
  ];

  it('loses nothing and repeats nothing when cut mid-stream', async () => {
    const r = await rig(CHATTY);
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const session = await r.fleet.createSession(r.instanceId, { title: 's', goal: 'g' });
    const agent = await r.fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const seen: AgbrteEvent[] = [];
    let cut = false;
    r.fleet.on('event', (_i: unknown, _s: unknown, e: unknown) => {
      seen.push(e as AgbrteEvent);
      // Cut it the moment the first line of the reply arrives — the turn is
      // running, the host is mid-push, and this client stops being reachable.
      //
      // A one-shot flag rather than reading the link state: the state is what
      // the cut is *about*, and conditioning on it made the unplug fire or not
      // depending on where the reconnect happened to be. That is how this test
      // timed out one run in three before anything was wrong with the code.
      if (!cut && (e as AgbrteEvent).type === 'agent.text') {
        cut = true;
        r.unplug();
      }
    });

    await r.manager.send(session.sessionId, agent.agentId as AgentId, {
      content: [{ type: 'text', text: 'go' }],
    });

    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');
    await until(() => seen.some((e) => e.type === 'agent.stopped'));

    /**
     * The log is the truth, and the claim is about what happened *after this
     * client started watching* — `session.created` and `agent.created` precede
     * the subscription and were never this client's to receive. Comparing
     * against the whole log said two events were lost when they were not; the
     * first version of this test did exactly that.
     */
    const durable = await r.manager.events(session.sessionId);
    const bySeq = seen.map((e) => e.seq);
    const from = Math.min(...bySeq);
    const owed = durable.map((e) => e.seq).filter((n) => n >= from);

    expect(new Set(bySeq).size, `duplicated: ${bySeq.join(',')}`).toBe(bySeq.length);
    expect(bySeq.slice().sort((a, b) => a - b), `gap: ${bySeq.join(',')}`).toEqual(owed);
  }, 30_000);
});
