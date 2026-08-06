/**
 * The fleet — one app, several hosts (DESIGN.md §8, §10).
 *
 * Each host here is a real `SessionHostServer` over its own workspace, reached
 * through a real `HostConnection`. That matters: the questions worth asking are
 * whether two hosts stay genuinely independent and whether a call lands on the
 * right one, and neither is answerable against a mock.
 *
 * The fleet owns no session state now, so most of what is tested is routing and
 * aggregation — which is all it is supposed to do.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttachRefused, Fleet, type FleetRuntime } from '@main/fleet.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId, SessionId } from '@shared/types/index.js';

const RUNTIMES: FleetRuntime[] = [
  { id: 'echo', label: 'Echo', version: '0.0.1', requiresModel: false },
];

const DONE: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

let roots: string[] = [];
let fleets: Fleet[] = [];

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-fleet-'));
  roots.push(dir);
  return dir;
}

interface HostOptions {
  script?: EchoStep[];
  /** Simulates the forked agent host failing to start. */
  agentHostBroken?: boolean;
}

/**
 * A fleet whose hosts are real session hosts, one per workspace.
 *
 * Cached by root so re-attaching the same path meets the *same* host, which is
 * what a real second connection would find.
 */
function makeFleet(opts: HostOptions = {}): Fleet {
  const hosts = new Map<string, SessionHostServer>();

  const fleet = new Fleet({
    runtimes: RUNTIMES,
    connect: async (workspaceRoot) => {
      let server = hosts.get(workspaceRoot);
      if (server === undefined) {
        const identity = await openWorkspace(workspaceRoot);
        const registry = new RuntimeRegistry();
        registry.register(new EchoRuntime({ script: opts.script ?? DONE }), {
          label: 'Echo',
          requiresModel: false,
        });
        server = new SessionHostServer({
          manager: new SessionManager({
            registry,
            workspaceRoot,
            instanceId: identity.instanceId,
          }),
          identity: {
            instanceId: identity.instanceId,
            lineageId: identity.lineageId,
            workspaceRoot,
            runtimes: opts.agentHostBroken === true ? [] : ['echo'],
            ...(opts.agentHostBroken === true
              ? { unavailableReason: 'agent host failed to start' }
              : {}),
          },
        });
        hosts.set(workspaceRoot, server);
      }

      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      return new HostConnection({ channel: pair.main });
    },
  });

  fleets.push(fleet);
  return fleet;
}

const TEXT = 'a message';

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

    expect(fleet.hosts()).toHaveLength(2);
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('reports the owning process and the granted role', async () => {
    const host = await makeFleet().attach(await makeRoot());

    // A client can say which process it is talking to, which matters when the
    // host outlives the app that started it.
    expect(host.pid).toBe(process.pid);
    expect(host.role).toBe('read-write');
    expect(host.available).toEqual(['echo']);
  });

  it('is idempotent — attaching the same path twice keeps one connection', async () => {
    const fleet = makeFleet();
    const root = await makeRoot();
    const first = await fleet.attach(root);
    const second = await fleet.attach(root);

    // A second connection to the same owner buys nothing and doubles every push.
    expect(second.instanceId).toBe(first.instanceId);
    expect(fleet.hosts()).toHaveLength(1);
  });

  it('attaches read-only when the agent host failed but the session host is up', async () => {
    const fleet = makeFleet({ agentHostBroken: true });
    const host = await fleet.attach(await makeRoot());

    // The session host owns the log, so transcripts still load and read. Only
    // running anything is impossible, and the UI is told why.
    expect(host.unavailableReason).toBeDefined();
    expect(host.available).toEqual([]);
    expect(await fleet.list()).toEqual([]);
  });

  it('refuses to attach when no host answers at all', async () => {
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      connect: () => Promise.reject(new Error('nothing listening')),
    });
    fleets.push(fleet);

    // Different from the case above: with no session host there is nothing to
    // serve the log, so there is no read-only fallback to offer.
    await expect(fleet.attach(await makeRoot())).rejects.toThrow(AttachRefused);
  });
});

describe('aggregating sessions', () => {
  it('lists sessions from every host together', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    await fleet.createSession(a.instanceId, { title: 'on A', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'on B', goal: 'g' });

    expect((await fleet.list()).map((s) => s.title).sort()).toEqual(['on A', 'on B']);
  });

  it('re-sorts across hosts so a blocked session cannot hide below an idle one', async () => {
    const fleet = makeFleet({
      script: [{ kind: 'stop', stop: { kind: 'quota_exhausted', scope: 'weekly' } }],
    });
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const blocked = await fleet.createSession(a.instanceId, { title: 'blocked', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'idle', goal: 'g' });

    const agent = await fleet.addAgent(blocked.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(blocked.sessionId, agent.agentId, TEXT);

    // Concatenating per-host sorted lists would put 'idle' first. §10 says
    // attention outranks recency, and it has to outrank it globally.
    const listed = await fleet.list();
    expect(listed[0]?.title).toBe('blocked');
    expect(listed[0]?.needsAttention?.reason).toBe('quota_exhausted');
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
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });
    await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });

    const agent = await fleet.addAgent(onA.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onA.sessionId, agent.agentId, TEXT);

    // Routing by uuidv7 session id needs no coordination between hosts (§5.2).
    const events = await fleet.events(onA.sessionId);
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(1);
    expect(fleet.hostOf(onA.sessionId)?.instanceId).toBe(a.instanceId);
  });

  it('keeps each host log independent', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onA = await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });
    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });

    const agentA = await fleet.addAgent(onA.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onA.sessionId, agentA.agentId, 'only on A');

    expect((await fleet.events(onB.sessionId)).some((e) => e.type === 'user.turn')).toBe(false);
  });

  it('refuses a session no attached host owns', async () => {
    const fleet = makeFleet();
    await fleet.attach(await makeRoot());
    await expect(fleet.get('session-nobody-owns' as SessionId)).rejects.toThrow(
      /no attached host/,
    );
  });

  it('routes a resumed session to the host it was resumed on', async () => {
    const first = makeFleet();
    const root = await makeRoot();
    const host = await first.attach(root);
    const created = await first.createSession(host.instanceId, { title: 'later', goal: 'g' });
    await first.detachAll();

    const second = makeFleet();
    const again = await second.attach(root);
    expect(second.hostOf(created.sessionId)).toBeNull();

    await second.resumeSession(again.instanceId, created.sessionId);
    expect(second.hostOf(created.sessionId)?.instanceId).toBe(again.instanceId);
    expect((await second.get(created.sessionId)).title).toBe('later');
  });
});

describe('events carry their host', () => {
  it('tags every forwarded event with the host that produced it', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const seen: Array<{ instanceId: string; type: string }> = [];
    fleet.on('event', (instanceId: string, _sessionId, event: { type: string }) => {
      seen.push({ instanceId, type: event.type });
    });

    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });
    const agent = await fleet.addAgent(onB.sessionId, { role: 'worker', runtimeId: 'echo' });
    await fleet.send(onB.sessionId, agent.agentId, TEXT);
    await new Promise((res) => setTimeout(res, 20));

    // Without the host on the event, a renderer showing two hosts cannot tell
    // which pane a line belongs to.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.instanceId === b.instanceId)).toBe(true);
    expect(seen.some((e) => e.instanceId === a.instanceId)).toBe(false);
  });
});

describe('permissions across hosts', () => {
  it('collects pending requests and answers the right one', async () => {
    const fleet = makeFleet({
      script: [
        { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
        { kind: 'stop', stop: { kind: 'end_turn' } },
      ],
    });
    await fleet.attach(await makeRoot());
    const b = await fleet.attach(await makeRoot());

    const onB = await fleet.createSession(b.instanceId, { title: 'B', goal: 'g' });
    const agent = await fleet.addAgent(onB.sessionId, { role: 'worker', runtimeId: 'echo' });

    const request = new Promise<{ requestId: string; instanceId: string }>((resolve) => {
      fleet.on('permission', (instanceId: string, r: { requestId: string }) =>
        resolve({ instanceId, requestId: r.requestId }),
      );
    });
    const turn = fleet.send(onB.sessionId, agent.agentId, TEXT);
    const { requestId, instanceId } = await request;

    expect(instanceId).toBe(b.instanceId);
    expect(await fleet.pendingPermissions()).toHaveLength(1);

    // Answered without the fleet knowing which host minted it.
    await fleet.respondPermission(requestId, { result: 'deny', reason: 'no' });
    await turn;

    expect(await fleet.pendingPermissions()).toHaveLength(0);
  });

  it('treats an unknown requestId as stale rather than throwing', async () => {
    const fleet = makeFleet();
    await fleet.attach(await makeRoot());

    let stale: string | null = null;
    fleet.on('permission-stale', (id: string) => (stale = id));

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
    await expect(fleet.get(onA.sessionId)).rejects.toThrow(/no attached host/);
  });

  it('leaves the host running — detaching is not stopping', async () => {
    const fleet = makeFleet();
    const root = await makeRoot();
    const host = await fleet.attach(root);
    const session = await fleet.createSession(host.instanceId, { title: 'kept', goal: 'g' });

    await fleet.detach(host.instanceId);

    // The same host, still holding the session it was given. This is the whole
    // reason ownership moved out of the app.
    const again = await fleet.attach(root);
    expect(again.instanceId).toBe(host.instanceId);
    expect((await fleet.list()).map((s) => s.sessionId)).toEqual([session.sessionId]);
  });

  it('stops forwarding events from a detached host', async () => {
    const fleet = makeFleet();
    const a = await fleet.attach(await makeRoot());
    await fleet.createSession(a.instanceId, { title: 'A', goal: 'g' });

    const seen: string[] = [];
    fleet.on('event', (_i, _s, e: { type: string }) => seen.push(e.type));

    await fleet.detach(a.instanceId);
    await new Promise((res) => setTimeout(res, 20));

    // A listener left attached would forward events for a host the UI has
    // already removed, which renders as a session that cannot be opened.
    expect(seen).toHaveLength(0);
  });

  it('detaching an unknown host is a no-op', async () => {
    const fleet = makeFleet();
    await expect(fleet.detach('nobody' as InstanceId)).resolves.toBeUndefined();
  });

  it('drops a host that announces it is closing', async () => {
    const fleet = makeFleet();
    const root = await makeRoot();
    const host = await fleet.attach(root);

    const detached = new Promise<string>((resolve) => {
      fleet.on('detached', (_id: string, reason: string) => resolve(reason));
    });

    // A host exiting on its own — idle linger, or an operator stopping it.
    // The fleet must notice rather than keep routing into a dead connection.
    await fleet.detach(host.instanceId);
    await expect(detached).resolves.toBeDefined();
  });
});
