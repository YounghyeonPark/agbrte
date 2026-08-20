/**
 * One host per machine, holding the workspaces its sessions named (§5.1, §8).
 *
 * The host used to be one per **workspace**: its socket was keyed by that
 * workspace's `instanceId`, its record lived in the folder, and opening a second
 * project started a second process. It is one per **machine** now — keyed by
 * `machineId`, recorded in `~/.agbrte/host.json`, and holding folders that
 * clients ask it for.
 *
 * Two halves of that are dangerous enough to test with real processes rather
 * than in memory, because neither fails in a way a mock can reproduce:
 *
 *  - **Two hosts on one machine must be impossible.** Before, two folders meant
 *    two sockets and nothing objected to a second process. Now every host
 *    computes the same path, and what settles a bind conflict is §17 Q9's
 *    question — *is anything actually there* — which only a real socket answers.
 *  - **A build from before this change may be holding a workspace.** It listens
 *    where this build does not look, so the two cannot see each other and would
 *    each open the same `events.jsonl` — the one failure §5.1 does not survive.
 *    The only thing standing between them is the record that host left behind.
 *
 * The rest is protocol shape, which is cheaper in memory and tested there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { hostHolding, refuseIfHeldElsewhere } from '../src/host/legacyHost.js';
import { machineIdentity } from '../src/host/machine.js';
import { readKnownWorkspaces, writeKnownWorkspaces } from '../src/host/workspaces.js';
import { readMachineRecord, writeHostRecord } from '../src/host/discovery.js';
import { hostSocketPath, listen } from '@shared/host/socketChannel.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import {
  MIN_CLIENT_PROTOCOL,
  SESSION_PROTOCOL_VERSION,
  type SessionCommand,
  type SessionMessage,
} from '@shared/host/sessionProtocol.js';
import type { InstanceId, LineageId } from '@shared/types/index.js';

const HOST_BUNDLE = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');

const dirs: string[] = [];
const open: HostConnection[] = [];
const managers: SessionManager[] = [];

async function tempDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agbrte-${tag}-`));
  dirs.push(dir);
  return dir;
}

async function built(): Promise<boolean> {
  try {
    await access(HOST_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(async () => {
  for (const connection of open.splice(0)) {
    await connection.requestShutdown().catch(() => undefined);
    connection.disconnect();
  }
  for (const manager of managers.splice(0)) manager.dispose();
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

// ------------------------------------------------------------- real processes

describe('a machine runs one host for every folder on it', () => {
  it('serves two workspaces from one process, on one socket', async () => {
    if (!(await built())) throw new Error('run `npm run build` first');

    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');

    const a = await connectOrSpawnHost({
      workspaceRoot: first,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(a);
    const b = await connectOrSpawnHost({
      workspaceRoot: second,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });

    const one = await a.ready;
    const two = await b.ready;

    // The whole change in one assertion: two folders, one process.
    expect(two.pid).toBe(one.pid);
    expect(two.machineId).toBe(one.machineId);
    // …and each connection is bound to the folder it asked for, rather than
    // both being served whichever one the host happened to start with.
    expect(resolve(one.workspace?.root ?? '')).toBe(resolve(first));
    expect(resolve(two.workspace?.root ?? '')).toBe(resolve(second));
    expect(one.workspace?.instanceId).not.toBe(two.workspace?.instanceId);
    // The host says what it holds, which is what a folder picker reads.
    expect(two.workspaces.map((w) => resolve(w.root))).toEqual(
      expect.arrayContaining([resolve(first), resolve(second)]),
    );

    b.disconnect();
  }, 60_000);

  it('records itself under the machine and leaves a pointer in each folder', async () => {
    if (!(await built())) throw new Error('run `npm run build` first');

    const workspace = await tempDir('ws');
    const connection = await connectOrSpawnHost({
      workspaceRoot: workspace,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(connection);
    const identity = await connection.ready;
    const machine = await machineIdentity();

    const own = await readMachineRecord();
    expect(own?.pid).toBe(identity.pid);
    expect(own?.socket).toBe(hostSocketPath(machine.machineId));

    /*
     * The pointer, and the field that makes it readable.
     *
     * A released client knows only how to look in the workspace, so something
     * has to be here or it starts its own host over this one. `machineId` is
     * what tells a *current* client that the record is one of ours rather than
     * an older per-workspace host in the way.
     */
    const pointer = JSON.parse(
      await readFile(join(workspaceLayout(workspace).dir, 'host.json'), 'utf8'),
    ) as { socket: string; machineId?: string };
    expect(pointer.socket).toBe(own?.socket);
    expect(pointer.machineId).toBe(machine.machineId);
  }, 60_000);

  it('refuses a second host on the machine rather than serving from two', async () => {
    if (!(await built())) throw new Error('run `npm run build` first');

    const workspace = await tempDir('ws');
    const connection = await connectOrSpawnHost({
      workspaceRoot: workspace,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(connection);
    await connection.ready;

    /*
     * §17 Q9's handling, exercised at the new key.
     *
     * Binding the machine's socket a second time must not silently unlink a
     * live one: the question is *is anything actually there*, and something is.
     * Asserted through `listen` rather than by starting a second process,
     * because that is the function that decides and this is the decision.
     */
    const socket = hostSocketPath((await machineIdentity()).machineId);
    await expect(listen(socket, () => undefined)).rejects.toThrow(
      /another Agbrte host is already running on this machine/,
    );
    // The socket, by name. A refusal that says only "in use" is one nobody can
    // act on — and on Windows this is the ordinary way to learn a host is up,
    // because a named pipe cannot be probed and cannot be debris.
    await expect(listen(socket, () => undefined)).rejects.toThrow(socket);
  }, 60_000);
});

// -------------------------------------------------------- an older host in the way

describe('a workspace an older host is already holding', () => {
  it('is refused by name, with the remedy, rather than opened beside it', async () => {
    const workspace = await tempDir('ws-legacy');
    await openWorkspace(workspace);

    // A host from before v21: a record with no `machineId`, on a socket that
    // answers. The socket is a real listener, because "does it answer" is the
    // only question that separates a live host from a leftover (§6.4).
    const socket = hostSocketPath('pretend-older-host');
    const listener = await listen<SessionMessage, SessionCommand>(socket, () => undefined);
    try {
      await writeHostRecord(workspace, {
        pid: process.pid,
        socket,
        startedAt: new Date().toISOString(),
        instanceId: 'older' as InstanceId,
      });

      const holder = await hostHolding(workspace);
      expect(holder?.socket).toBe(socket);

      await expect(refuseIfHeldElsewhere(workspace)).rejects.toThrow(
        /started before one host per machine/,
      );
      // The remedy, by name. "Cannot open this workspace" sends somebody to
      // look at the folder; this sends them to the process in the way.
      await expect(refuseIfHeldElsewhere(workspace)).rejects.toThrow(/agbrte stop/);
      await expect(refuseIfHeldElsewhere(workspace)).rejects.toThrow(String(process.pid));
    } finally {
      listener.close();
    }
  });

  it('is not blocked by a record whose host is gone', async () => {
    const workspace = await tempDir('ws-stale');
    await openWorkspace(workspace);

    // The classic stale pidfile: a record left by a process that was killed.
    // Trusting the file would make the folder unopenable forever (§6.4).
    await writeHostRecord(workspace, {
      pid: 999_999,
      socket: hostSocketPath('nothing-listens-here'),
      startedAt: new Date().toISOString(),
      instanceId: 'older' as InstanceId,
    });

    expect(await hostHolding(workspace)).toBeNull();
    await expect(refuseIfHeldElsewhere(workspace)).resolves.toBeUndefined();
  });

  it('does not mistake this host\'s own pointer for a rival', async () => {
    const workspace = await tempDir('ws-ours');
    await openWorkspace(workspace);
    const socket = hostSocketPath('ours');
    const listener = await listen<SessionMessage, SessionCommand>(socket, () => undefined);
    try {
      await writeHostRecord(workspace, {
        pid: process.pid,
        socket,
        startedAt: new Date().toISOString(),
        instanceId: 'i' as InstanceId,
        machineId: 'machine-1',
      });

      // Recognised two ways over, because a false negative here is the
      // expensive one: it refuses to open a folder this host already serves.
      expect(await hostHolding(workspace, { machineId: 'machine-1' })).toBeNull();
      expect(await hostHolding(workspace, { socket })).toBeNull();
      // …and another machine's host *is* a rival, which is what two
      // `AGBRTE_HOME` directories on one computer produce.
      expect(await hostHolding(workspace, { machineId: 'machine-2' })).not.toBeNull();
    } finally {
      listener.close();
    }
  });
});

// ------------------------------------------------------------- protocol shape

/** A host over an in-memory channel, holding one workspace. */
async function rig(root: string): Promise<SessionHostServer> {
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId: identity.instanceId,
  });
  managers.push(manager);
  return new SessionHostServer({
    manager,
    identity: {
      machineId: 'machine-1',
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot: root,
      runtimes: ['echo'],
    },
    openWorkspace: async (r) => {
      const added = await manager.addWorkspace(r);
      return {
        info: {
          instanceId: added.instanceId,
          lineageId: 'l' as LineageId,
          root: added.root,
        },
      };
    },
  });
}

describe('the handshake describes a machine holding workspaces', () => {
  it('binds a connection to the folder it named, and says which', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const server = await rig(first);

    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const client = new HostConnection({ channel: pair.main, workspace: second });
    const identity = await client.ready;

    expect(resolve(identity.workspace?.root ?? '')).toBe(resolve(second));
    expect(identity.machineId).toBe('machine-1');
    expect(identity.workspaces.map((w) => resolve(w.root))).toEqual(
      expect.arrayContaining([resolve(first), resolve(second)]),
    );
    client.disconnect();
  });

  it('binds to the only workspace when a connection names none', async () => {
    // The shape every direct construction and `agbrte serve` still uses: a host
    // with one folder has nothing to disambiguate, so nothing has to start
    // saying so.
    const root = await tempDir('ws');
    const server = await rig(root);
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const client = new HostConnection({ channel: pair.main });

    const identity = await client.ready;
    expect(resolve(identity.workspace?.root ?? '')).toBe(resolve(root));
    client.disconnect();
  });

  it('refuses a workspace-scoped command on a machine connection, by name', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const server = await rig(first);

    // Two folders open and no folder named: the host declines to guess, because
    // guessing would serve one project's transcripts to a client that asked
    // about another.
    const opener = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(opener.host);
    const first_client = new HostConnection({ channel: opener.main, workspace: second });
    await first_client.ready;

    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const client = new HostConnection({ channel: pair.main });
    const identity = await client.ready;
    expect(identity.workspace).toBeUndefined();
    expect(identity.workspaces).toHaveLength(2);

    await expect(client.templates()).rejects.toThrow(/not to a workspace/);
    // It names the folders, or a person cannot act on it.
    await expect(client.templates()).rejects.toThrow(resolve(first));

    client.disconnect();
    first_client.disconnect();
  });

  it('opens a folder on request and lists what it holds', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const server = await rig(first);
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const client = new HostConnection({ channel: pair.main });
    await client.ready;

    const opened = await client.openWorkspace(second);
    expect(resolve(opened.root)).toBe(resolve(second));

    const held = await client.listWorkspaces();
    expect(held.map((w) => resolve(w.root))).toEqual(
      expect.arrayContaining([resolve(first), resolve(second)]),
    );

    // Idempotent by checkout: asking twice is not two workspaces.
    const again = await client.openWorkspace(second);
    expect(again.instanceId).toBe(opened.instanceId);
    expect(await client.listWorkspaces()).toHaveLength(2);
    client.disconnect();
  });
});

describe('a connection sees its own folder and no other', () => {
  it('lists, and is pushed, only the sessions in the workspace it bound', async () => {
    /*
     * The leak this change could have shipped, and did for one run.
     *
     * "Broadcast to every attached client" was right while a host was one
     * workspace. With several, a connection bound to one project received
     * another project's transcript and permission prompts — and the app, which
     * holds one entry per folder, showed every session under every folder.
     * Found end to end by two hosts on one machine each listing the other's
     * sessions, which is exactly what a per-workspace client must never see.
     */
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const server = await rig(first);

    const here = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(here.host);
    const a = new HostConnection({ channel: here.main, workspace: first });
    await a.ready;

    const there = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(there.host);
    const b = new HostConnection({ channel: there.main, workspace: second });
    await b.ready;

    const pushedToA: string[] = [];
    a.on('session', (session: unknown) => pushedToA.push((session as { title: string }).title));

    const mine = await a.createSession({ title: 'in a', goal: 'g' });
    const yours = await b.createSession({ title: 'in b', goal: 'g' });
    expect(mine.title).toBe('in a');
    expect(yours.title).toBe('in b');

    expect((await a.list()).map((s) => s.title)).toEqual(['in a']);
    expect((await b.list()).map((s) => s.title)).toEqual(['in b']);
    // On disk too, which is the list a picker reads.
    expect((await a.listOnDisk()).map((s) => s.title)).toEqual(['in a']);
    // And the push, which is the half a list cannot catch.
    expect(pushedToA).not.toContain('in b');

    a.disconnect();
    b.disconnect();
  });
});

describe('a client from before the shape changed', () => {
  it('is refused at the handshake rather than served a welcome it will misread', async () => {
    /*
     * §17 Q16's lever, pulled for the first time.
     *
     * A v20 client reads `identity.workspaceRoot`, which this host no longer
     * sends, and `connectOrSpawn` then decides the host is shutting down —
     * a wrong fact reported after a ten-second wait. Worse, that client
     * computes a per-workspace socket, finds nothing, and starts its own host
     * over this one. Refusing at the handshake is the honest half of the
     * answer; the pointer record is the other half.
     */
    const root = await tempDir('ws');
    const server = await rig(root);
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);

    const refused = new Promise<{ name?: string; message: string }>((done) => {
      pair.main.onMessage((message) => {
        if (message.t === 'err') done({ ...(message.name !== undefined ? { name: message.name } : {}), message: message.message });
      });
    });
    pair.main.post({
      t: 'hello',
      id: 'c1',
      role: 'read-write',
      client: 'old-app',
      protocol: SESSION_PROTOCOL_VERSION - 1,
    });

    const error = await refused;
    expect(error.name).toBe('ClientTooOld');
    expect(error.message).toContain(`v${MIN_CLIENT_PROTOCOL}`);
  });

  it('is the only direction refused — this client still reads an older host', async () => {
    /*
     * The half Q16 was actually written about: `agbrte stop` speaks the new
     * protocol and has to be able to retire a host that speaks the old one.
     * `HostConnection` normalises the pre-v21 shape rather than refusing it.
     */
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    const client = new HostConnection({ channel: pair.main });
    pair.host.onMessage((command) => {
      if (command.t !== 'hello') return;
      pair.host.post({
        t: 'welcome',
        id: command.id,
        role: 'read-write',
        identity: {
          instanceId: 'i',
          lineageId: 'l',
          workspaceRoot: '/old/place',
          runtimes: ['echo'],
          pid: 4242,
          protocol: 20,
        },
      } as unknown as SessionMessage);
    });

    const identity = await client.ready;
    expect(identity.workspace?.root).toBe('/old/place');
    expect(identity.workspaces).toHaveLength(1);
    expect(identity.protocol).toBe(20);
    client.disconnect();
  });
});

// -------------------------------------------------------- the machine registry

describe('the folders a machine has served', () => {
  it('survives a restart, so sessions in an unopened folder are still findable', async () => {
    const home = await tempDir('home');
    const workspace = await tempDir('ws');
    await openWorkspace(workspace);

    await writeKnownWorkspaces([{ root: workspace, instanceId: 'i' }], home);
    const known = await readKnownWorkspaces(home);
    expect(known.map((w) => resolve(w.root))).toEqual([resolve(workspace)]);
  });

  it('drops an entry that is no longer a workspace, without failing', async () => {
    const home = await tempDir('home');
    const gone = join(await tempDir('parent'), 'deleted');
    const real = await tempDir('ws');
    await openWorkspace(real);

    await writeKnownWorkspaces(
      [
        { root: gone, instanceId: 'i1' },
        { root: real, instanceId: 'i2' },
      ],
      home,
    );

    // A deleted folder, an unmounted volume and a renamed project all look the
    // same from here, and none of them is a reason a host should not start.
    const known = await readKnownWorkspaces(home);
    expect(known.map((w) => resolve(w.root))).toEqual([resolve(real)]);
  });

  it('never creates a workspace while restoring one', async () => {
    const home = await tempDir('home');
    const parent = await tempDir('parent');
    const notAWorkspace = join(parent, 'just-a-folder');
    await writeFile(join(parent, 'marker'), 'x');

    await writeKnownWorkspaces([{ root: notAWorkspace, instanceId: 'i' }], home);
    await readKnownWorkspaces(home);

    // `mkdir -p` on a deleted folder would quietly resurrect a directory the
    // user removed on purpose, so the restore reads and never writes.
    await expect(access(notAWorkspace)).rejects.toThrow();
  });
});
