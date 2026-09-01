/**
 * A split whose child is created on another host (DESIGN.md §4.3, §17 Q5, §8).
 *
 * §17 Q5 broke a spawn into three steps so a `SessionManager` — which owns one
 * workspace on one host — could still make a child somewhere else: `prepareChild`
 * decides and changes nothing, `createSession` takes the position and brief the
 * child inherits, and `recordChild` commits the edge back on the parent. Until
 * now nothing exercised those three against two hosts. `fleet.test.ts` runs two
 * hosts and never splits between them; `splitWire.test.ts` splits over the
 * protocol and does it through one host answering itself.
 *
 * ## Why a real socket and not `memoryChannelPair`
 *
 * The memory channel hands the peer the *same object*: `queueMicrotask(() =>
 * peer.accept(message))`, no copy and no encoding. That is deliberate and right
 * for testing ordering, and it is blind to every defect that lives in the
 * encoding — a key whose value is `undefined` (present in memory, gone in JSON),
 * a `Date`, a `Map`, a class instance that arrives as a bare object. One of those
 * was real: `prepareChild` returned `parentBudget: undefined` as an explicit key,
 * so the message a socket carried and the message a test saw were different
 * shapes.
 *
 * So these two hosts talk over two actual sockets, in the platform's own form —
 * a named pipe on Windows, a unix socket elsewhere — through the same
 * `SocketChannel` the app uses.
 *
 * ## What this still cannot see, and it is worth naming
 *
 * Two hosts, one **process**. They have their own workspaces, managers, servers
 * and sockets, and they are the same build in the same Node — so a field one
 * side sends and the other does not know is not reachable from here, and neither
 * is a version disagreement. Driving two spawned hosts is blocked on something
 * real rather than on effort: a split begins with `propose_split`, an agent tool
 * with no command on the wire (correctly — §4.3 keeps a proposal inside the
 * session), and the host bundle registers the echo runtime unscripted. Nothing
 * outside a host process can make a session in it propose anything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:net';
import { Fleet, type FleetRuntime } from '@main/fleet.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { connect, hostSocketPath, listen } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { SessionBudget, SessionId } from '@shared/types/index.js';

const RUNTIMES: FleetRuntime[] = [{ id: 'echo', label: 'Echo', version: '0.0.1', model: 'none' }];
const BUDGET: SessionBudget = { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 };

interface Host {
  root: string;
  manager: SessionManager;
  socket: string;
}

const hosts: Host[] = [];
const servers: Server[] = [];
const roots: string[] = [];
let fleet: Fleet | null = null;

/**
 * One host on its own socket, listening for real.
 *
 * Not `connectOrSpawnHost`: that finds *the* host for this machine, and §8 says
 * there is one. Two of them is the point here, so each is stood up directly on
 * a socket named for a machine id nobody else will pick.
 */
async function startHost(tag: string): Promise<Host> {
  const root = await mkdtemp(join(tmpdir(), `agbrte-xhost-${tag}-`));
  roots.push(root);
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
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
  /*
   * Short on purpose, and the first version of this file was not.
   *
   * A unix socket path has to fit in `sun_path` — 104 bytes on macOS — and a CI
   * runner's `TMPDIR` there is a 48-byte `/var/folders/...`. A full uuid put
   * this five bytes over, where `bind` truncates instead of refusing: the socket
   * was created under a shortened name, and the `chmod` that followed reported
   * `ENOENT` on the name we held, which reads as a permissions failure. Green on
   * Windows and Linux, red only on macOS, and only in CI.
   *
   * `socketChannel` now refuses an over-long path and says why. This stays short
   * anyway, because a test that depends on a guard to be correct is a test that
   * stops working the day the guard moves.
   */
  const socket = hostSocketPath(`x${tag}${randomUUID().slice(0, 8)}`);
  servers.push(
    await listen<SessionMessage, SessionCommand>(socket, (channel) => server.accept(channel)),
  );

  const host: Host = { root, manager, socket };
  hosts.push(host);
  return host;
}

/** A fleet that reaches each workspace through its own host's socket. */
function fleetOver(all: Host[]): Fleet {
  const made = new Fleet({
    runtimes: RUNTIMES,
    connect: async ({ workspaceRoot }) => {
      const host = all.find((h) => h.root === workspaceRoot);
      if (host === undefined) throw new Error(`no host for ${workspaceRoot}`);
      const channel = await connect<SessionCommand, SessionMessage>(host.socket);
      return new HostConnection({ channel });
    },
  });
  fleet = made;
  return made;
}

const local = (workspaceRoot: string) => ({ target: { kind: 'local' } as const, workspaceRoot });

/** Raised the way one is really raised: by the session, not by a client. */
async function propose(host: Host, sessionId: SessionId, tokenCeiling: number): Promise<string> {
  const proposal = await host.manager.proposeSplit(sessionId, {
    title: 'port the parser',
    scope: 'port the parser to the new AST, tests included',
    outOfScope: ['the CLI surface', 'anything under docs/'],
    contract: { summaryMaxTokens: 500, artifacts: [] },
    tokenCeiling,
    why: 'the parser is half the remaining work and touches nothing else',
  });
  return proposal.proposalId;
}

beforeEach(() => {
  hosts.length = 0;
  roots.length = 0;
  servers.length = 0;
  fleet = null;
});

afterEach(async () => {
  if (fleet !== null) await fleet.detachAll();
  for (const host of hosts) host.manager.dispose();
  for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('three steps on two hosts', () => {
  it('creates the child on the named host and commits the edge on the parent', async () => {
    const near = await startHost('near');
    const far = await startHost('far');
    const f = fleetOver([near, far]);
    const a = await f.attach(local(near.root));
    const b = await f.attach(local(far.root));

    const parent = await near.manager.createSession({ title: 'the whole job', goal: 'g', budget: BUDGET });
    const child = await f.respondSplit(parent.sessionId, await propose(near, parent.sessionId, 20_000), {
      approved: true,
      instanceId: b.instanceId,
    });

    // Where the work actually landed. Before §17 Q5 this set a field and
    // changed nothing — the log said one machine and the agent ran on another,
    // which is worse than the feature being absent because an absent feature
    // gets noticed.
    expect(child).not.toBeNull();
    expect(far.manager.get(child!.sessionId).title).toBe('port the parser');
    expect(() => near.manager.get(child!.sessionId)).toThrow();

    // The edge, on the parent's own log, on the near host.
    const children = near.manager.get(parent.sessionId).children;
    expect(children.map((c) => c.sessionId)).toEqual([child!.sessionId]);
    expect(children[0]?.instanceId).toBe(b.instanceId);
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it('carries the brief and the position through the encoding, not just the ids', async () => {
    const near = await startHost('near');
    const far = await startHost('far');
    const f = fleetOver([near, far]);
    await f.attach(local(near.root));
    const b = await f.attach(local(far.root));

    const parent = await near.manager.createSession({ title: 'p', goal: 'the whole job', budget: BUDGET });
    const child = await f.respondSplit(parent.sessionId, await propose(near, parent.sessionId, 20_000), {
      approved: true,
      instanceId: b.instanceId,
    });

    /*
     * The fields §4.3 says a child inherits, read off the *far* host.
     *
     * Asserted one by one rather than as "a child exists", because everything
     * here crossed a JSON boundary this path had never been over — and the
     * whole class of defect CLAUDE.md names first is the remote side quietly
     * receiving less than the local side sends.
     */
    const far_ = far.manager.get(child!.sessionId);
    expect(far_.tree).toMatchObject({
      rootSessionId: parent.sessionId,
      parentSessionId: parent.sessionId,
      depth: 1,
      ancestry: [parent.sessionId],
    });
    expect(far_.budget?.tokenCeiling).toBe(20_000);

    const brief = (await far.manager.events(child!.sessionId)).find(
      (e) => e.type === 'session.brief_received',
    );
    expect(brief).toBeDefined();
    expect(brief && 'brief' in brief ? brief.brief.parentGoal : null).toBe('the whole job');
    expect(brief && 'brief' in brief ? brief.brief.outOfScope : null).toEqual([
      'the CLI surface',
      'anything under docs/',
    ]);
  });

  it('debits the near host for what the far host was given', async () => {
    const near = await startHost('near');
    const far = await startHost('far');
    const f = fleetOver([near, far]);
    await f.attach(local(near.root));
    const b = await f.attach(local(far.root));

    const parent = await near.manager.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await f.respondSplit(parent.sessionId, await propose(near, parent.sessionId, 20_000), {
      approved: true,
      instanceId: b.instanceId,
    });

    // §17 Q5's reason for no two-phase commit: the debit lands *after* the child
    // exists, so a creation that fails on the far host leaves nothing behind on
    // the near one. It has to actually land, and it lands here, on the parent.
    expect(near.manager.get(parent.sessionId).budget?.reservedForChildren).toBe(20_000);
  });

  it('splits an unbudgeted parent across hosts without either side inventing a ceiling', async () => {
    const near = await startHost('near');
    const far = await startHost('far');
    const f = fleetOver([near, far]);
    await f.attach(local(near.root));
    const b = await f.attach(local(far.root));

    const parent = await near.manager.createSession({ title: 'p', goal: 'g' });
    const child = await f.respondSplit(parent.sessionId, await propose(near, parent.sessionId, 20_000), {
      approved: true,
      instanceId: b.instanceId,
    });

    /*
     * Protocol v28's optional field, across the boundary it was made optional
     * for. `PreparedChild.parentBudget` is absent, and JSON drops the key
     * rather than carrying a null — so the near host has to commit the edge
     * from a message that is missing something it used to dereference, and the
     * far host has to create a session from a `create` with no budget in it.
     *
     * Both must leave the absence alone. A zero written on either side is a
     * ceiling nobody set, and §4.3 keeps that distinct from unbudgeted.
     */
    expect(child).not.toBeNull();
    expect(far.manager.get(child!.sessionId).budget).toBeUndefined();
    expect(near.manager.get(parent.sessionId).budget).toBeUndefined();
    expect(near.manager.get(parent.sessionId).children).toHaveLength(1);
  });

  it('refuses a host nobody attached rather than quietly running it here', async () => {
    const near = await startHost('near');
    const f = fleetOver([near]);
    await f.attach(local(near.root));

    const parent = await near.manager.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const proposalId = await propose(near, parent.sessionId, 20_000);

    // Falling back to local is the old bug in a new hat: the record would say
    // one machine and the work would happen on another.
    await expect(
      f.respondSplit(parent.sessionId, proposalId, { approved: true, instanceId: 'not-attached' }),
    ).rejects.toThrow(/not attached/);
    expect(near.manager.get(parent.sessionId).children).toHaveLength(0);
  });
});
