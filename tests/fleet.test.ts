/**
 * The fleet — one app, several hosts (DESIGN.md §8, §10).
 *
 * Each host here is a real workspace with a real `SessionManager` and a real
 * agent-host server, reached over an in-memory channel. That matters: the
 * questions worth asking are whether two hosts stay genuinely independent and
 * whether a call lands on the right one, and a mocked manager cannot answer
 * either.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet, type FleetRuntime } from '@main/fleet.js';
import { AgentHostServer } from '../src/host/server.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { HostCommand, HostMessage } from '@shared/host/protocol.js';
import type { InstanceId, SessionId } from '@shared/types/index.js';

const RUNTIMES: FleetRuntime[] = [
  { id: 'echo', label: 'Echo', version: '0.0.1', requiresModel: false },
];

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

let roots: string[] = [];
let fleets: Fleet[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-fleet-'));
  roots.push(dir);
  return dir;
}

/**
 * A fleet whose hosts are real `AgentHostServer`s over in-memory channels.
 *
 * `spawn` is called per workspace *and* again on restart, so the registry is
 * built fresh each time — reusing one would let a stopped handle leak between
 * host generations.
 */
function makeFleet(script?: EchoStep[]): Fleet {
  const fleet = new Fleet({
    runtimes: RUNTIMES,
    spawn: () => {
      const registry = new RuntimeRegistry();
      registry.register(new EchoRuntime(script ? { script } : {}), {
        label: 'Echo',
        requiresModel: false,
      });
      const pair = memoryChannelPair<HostCommand, HostMessage>();
      new AgentHostServer(pair.host, registry);
      return { channel: pair.main };
    },
  });
  fleets.push(fleet);
  return fleet;
}

const DONE: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

beforeEach(() => {
  roots = [];
  fleets = [];
});

afterEach(async () => {
  for (const fleet of fleets) await fleet.detachAll();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('attaching hosts', () => {
  it('attaches several workspaces at once', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    // The restriction this class exists to remove: main used to dispose the
    // previous host whenever a new workspace was opened.
    expect(fleet.hosts()).toHaveLength(2);
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('gives each host its own identity and runtimes', async () => {
    const fleet = makeFleet();
    const host = await fleet.attach(await makeRoot());

    expect(host.available).toEqual(['echo']);
    expect(fleet.runtimesOn(host.instanceId).map((r) => r.id)).toEqual(['echo']);
    expect(host.unavailableReason).toBeUndefined();
  });

  it('is idempotent — attaching the same path twice does not start a second host', async () => {
    const fleet = makeFleet();
    const root = await makeRoot();
    const first = await fleet.attach(root);
    const second = await fleet.attach(root);

    // Two hosts over one log would break §5.1's single writer.
    expect(second.instanceId).toBe(first.instanceId);
    expect(fleet.hosts()).toHaveLength(1);
  });

  it('records the target so §10 can badge the card', async () => {
    const fleet = makeFleet();
    const host = await fleet.attach(await makeRoot(), {
      kind: 'ssh',
      host: 'build-01',
      user: 'ci',
      root: '/srv/work',
    } as never);

    expect(host.target.kind).toBe('ssh');

    const session = await fleet.createSession(host.instanceId, { title: 's', goal: 'g' });
    // Carried onto the session, so a reattach does not have to guess where it ran.
    expect(session.target.kind).toBe('ssh');
  });

  it('attaches a workspace whose host cannot start, read-only', async () => {
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      spawn: () => {
        const pair = memoryChannelPair<HostCommand, HostMessage>();
        // Nothing serves the far end, then the link dies: a host that never
        // handshakes, which is what a broken binary or a dead SSH link looks like.
        pair.breakLink('host binary missing');
        return { channel: pair.main };
      },
    });
    fleets.push(fleet);

    const host = await fleet.attach(await makeRoot());

    // Refusing the attach would let one dead host hide every transcript in that
    // workspace — the opposite of what the log is for.
    expect(host.unavailableReason).toBeDefined();
    expect(host.available).toEqual([]);
    expect(fleet.hosts()).toHaveLength(1);
  });
});

describe('aggregating sessions', () => {
  it('lists sessions from every host together', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    await fleet.createSession(a.instanceId, { title: 'on A', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'on B', goal: 'g' });

    expect(fleet.list().map((s) => s.title).sort()).toEqual(['on A', 'on B']);
  });

  it('re-sorts across hosts so a blocked session cannot hide below an idle one', async () => {
    const fleet = makeFleet([{ kind: 'stop', stop: { kind: 'quota_exhausted', scope: 'weekly' } }]);
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    // Idle on the first host, created *after* so it is the more recent.
    const blocked = await fleet.createSession(a.instanceId, { title: 'blocked', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'idle', goal: 'g' });

    const agent = await fleet.addAgent(blocked.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(blocked.sessionId, agent.agentId, TEXT('go'));

    // Concatenating per-host sorted lists would put 'idle' first. §10 says
    // attention outranks recency, and it has to outrank it globally.
    expect(fleet.list()[0]?.title).toBe('blocked');
    expect(fleet.list()[0]?.needsAttention?.reason).toBe('quota_exhausted');
  });

  it('reports on-disk sessions per host', async () => {
    const first = makeFleet();
    const rootA = await makeRoot();
    const rootB = await makeRoot();
    const a = await first.attach(rootA);
    const b = await first.attach(rootB);
    await first.createSession(a.instanceId, { title: 'A1', goal: 'g' });
    await first.createSession(b.instanceId, { title: 'B1', goal: 'g' });
    await first.detachAll();

    // A fresh fleet over the same folders: nothing loaded, everything on disk.
    const second = makeFleet();
    const a2 = await second.attach(rootA);
    const b2 = await second.attach(rootB);

    const onDisk = await second.listOnDisk();
    expect(onDisk).toHaveLength(2);
    expect(onDisk.find((s) => s.title === 'A1')?.instanceId).toBe(a2.instanceId);
    expect(onDisk.find((s) => s.title === 'B1')?.instanceId).toBe(b2.instanceId);
  });
});

describe('routing by session id', () => {
  it('sends a turn to the host that owns the session', async () => {
    const fleet = makeFleet(DONE);
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });

    const agent = await fleet.addAgent(onA.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onA.sessionId, agent.agentId, TEXT('hello'));

    // The turn is in A's log and nowhere near B's — routing by uuidv7 session id
    // needs no coordination between hosts (§5.2).
    const events = await fleet.events(onA.sessionId);
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(1);
    expect(fleet.hostOf(onA.sessionId)?.instanceId).toBe(a.instanceId);
  });

  it('keeps each host log independent', async () => {
    const fleet = makeFleet(DONE);
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });
    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });

    const agentA = await fleet.addAgent(onA.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onA.sessionId, agentA.agentId, TEXT('only on A'));

    const bEvents = await fleet.events(onB.sessionId);
    expect(bEvents.some((e) => e.type === 'user.turn')).toBe(false);
  });

  it('refuses a session no attached host owns', async () => {
    const fleet = makeFleet();
    await fleet.attach(await makeRoot());
    expect(() => fleet.get('session-nobody-owns' as SessionId)).toThrow(/no attached host/);
  });

  it('routes a resumed session to the host it was resumed on', async () => {
    const first = makeFleet(DONE);
    const root = await makeRoot();
    const host = await first.attach(root);
    const created = await first.createSession(host.instanceId, { title: 'later', goal: 'g' });
    await first.detachAll();

    const second = makeFleet(DONE);
    const again = await second.attach(root);
    // Not routable before it is resumed — the fleet has never seen it.
    expect(second.hostOf(created.sessionId)).toBeNull();

    await second.resumeSession(again.instanceId, created.sessionId);
    expect(second.hostOf(created.sessionId)?.instanceId).toBe(again.instanceId);
    expect(second.get(created.sessionId).title).toBe('later');
  });
});

describe('events carry their host', () => {
  it('tags every forwarded event with the host that produced it', async () => {
    const fleet = makeFleet(DONE);
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const seen: Array<{ instanceId: string; type: string }> = [];
    fleet.on('event', (instanceId: string, _sessionId, event: { type: string }) => {
      seen.push({ instanceId, type: event.type });
    });

    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });
    const agent = await fleet.addAgent(onB.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onB.sessionId, agent.agentId, TEXT('go'));

    // Without the host on the event, a renderer showing two hosts cannot tell
    // which pane a line belongs to.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.instanceId === b.instanceId)).toBe(true);
    expect(seen.some((e) => e.instanceId === a.instanceId)).toBe(false);
  });
});

describe('permissions across hosts', () => {
  it('collects pending requests from every host and answers the right one', async () => {
    const fleet = makeFleet([
      { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });
    const agent = await fleet.addAgent(onB.sessionId, { role: 'worker', runtimeId: 'echo' });

    const turn = fleet.send(onB.sessionId, agent.agentId, TEXT('go'));

    // Wait for the ask to surface, then answer it without knowing which host
    // minted it — which is the fleet's job.
    const request = await new Promise<{ requestId: string; instanceId: string }>((resolve) => {
      fleet.on('permission', (instanceId: string, r: { requestId: string }) =>
        resolve({ instanceId, requestId: r.requestId }),
      );
    });
    expect(request.instanceId).toBe(b.instanceId);
    expect(fleet.pendingPermissions()).toHaveLength(1);

    await fleet.respondPermission(request.requestId, { result: 'deny', reason: 'no' });
    await turn;

    expect(fleet.pendingPermissions()).toHaveLength(0);
    void a;
  });

  it('treats an unknown requestId as stale rather than throwing', async () => {
    const fleet = makeFleet();
    await fleet.attach(await makeRoot());

    let stale: string | null = null;
    fleet.on('permission-stale', (id: string) => (stale = id));

    // The ask may have been withdrawn because the agent stopped; a UI that raced
    // that must not see a failure.
    await expect(
      fleet.respondPermission('gone', { result: 'allow', scope: 'once' }),
    ).resolves.toBe('unknown');
    expect(stale).toBe('gone');
  });
});

describe('detaching', () => {
  it('forgets a host and stops routing to it', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());
    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });

    await fleet.detach(a.instanceId);

    expect(fleet.hosts().map((h) => h.instanceId)).toEqual([b.instanceId]);
    expect(fleet.hostOf(onA.sessionId)).toBeNull();
    expect(() => fleet.get(onA.sessionId)).toThrow(/no attached host/);
  });

  it('stops forwarding events from a detached host', async () => {
    const fleet = makeFleet(DONE);
    const a = await fleet.attach(await makeRoot());
    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });

    const seen: string[] = [];
    fleet.on('event', (_i, _s, e: { type: string }) => seen.push(e.type));

    await fleet.detach(a.instanceId);
    // A listener left attached would forward events for a host the UI has
    // already removed, which renders as a session that cannot be opened.
    expect(seen).toHaveLength(0);
    void onA;
  });

  it('detaching an unknown host is a no-op', async () => {
    const fleet = makeFleet();
    await expect(fleet.detach('nobody' as InstanceId)).resolves.toBeUndefined();
  });

  it('leaves the workspace on disk intact', async () => {
    const fleet = makeFleet();
    const root = await makeRoot();
    const host = await fleet.attach(root);
    await fleet.createSession(host.instanceId, { title: 'kept', goal: 'g' });
    await fleet.detach(host.instanceId);

    // Detach is "stop watching", not "delete".
    const again = makeFleet();
    const reattached = await again.attach(root);
    expect((await again.listOnDisk()).map((s) => s.title)).toEqual(['kept']);
    expect(reattached.instanceId).toBe(host.instanceId);
  });
});
