/**
 * A host that outlives the process that started it (DESIGN.md §6.4, §8).
 *
 * Real processes, real sockets, real spawning. Everything else about the host is
 * tested over in-memory channels, which is faster and covers more — but none of
 * it can tell you whether `detached: true` actually detached, or whether a
 * second client can find a host nobody told it about. Those only fail for real.
 *
 * The host is started by running the built bundle, so this suite needs
 * `npm run build` first and skips loudly otherwise rather than passing on a
 * stale artefact.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOwnMachine } from './support/machineHome.js';
import { mkdtemp, readFile, rm, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import {
  readHostRecord,
  readMachineRecord,
  writeHostRecord,
  processAlive,
} from '../src/host/discovery.js';
import { machineIdentity } from '../src/host/machine.js';
import { openWorkspace } from '@main/store/identity.js';
import { hostSocketPath } from '@shared/host/socketChannel.js';
import type { HostConnection } from '@main/host/hostConnection.js';

/*
 * Its own machine directory per test (§8).
 *
 * This suite starts real hosts, and a host is one per machine — so without this
 * every test here would share one with every other test in the run, and a case
 * asserting that *nothing* is listening would be handed one that a previous case
 * left lingering. See `support/machineHome.ts`.
 */
useOwnMachine();

const HOST_BUNDLE = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');

let root: string;
let open: HostConnection[] = [];
/** Extra directories a test created, so a move leaves nothing behind. */
let roots: string[] = [];

/** Ask a host to stop, so a test does not leave a process behind. */
async function stopHost(connection: HostConnection): Promise<void> {
  try {
    await connection.requestShutdown();
  } catch {
    // Already gone; nothing to stop.
  }
  connection.disconnect();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-detached-'));
  open = [];
});

afterEach(async () => {
  for (const connection of open) await stopHost(connection);
  for (const extra of roots) await rm(extra, { recursive: true, force: true });
  roots = [];
  await rm(root, { recursive: true, force: true });
});

async function built(): Promise<boolean> {
  try {
    await access(HOST_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

/** Start (or find) a host for the temp workspace, tracked for cleanup. */
async function host(): Promise<HostConnection> {
  const connection = await connectOrSpawnHost({
    workspaceRoot: root,
    hostEntry: HOST_BUNDLE,
    // Node, not Electron: this suite runs under Vitest.
    execPath: process.execPath,
    startupTimeoutMs: 20_000,
  });
  open.push(connection);
  return connection;
}

describe('a detached host', () => {
  it('starts as its own process and answers on a socket', async () => {
    if (!(await built())) {
      // Loud rather than silently passing on a missing artefact.
      throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);
    }

    const connection = await host();
    const identity = await connection.ready;

    // A different pid is the entire claim: sessions are not running inside this
    // process, so this process going away cannot take them with it.
    expect(identity.pid).not.toBe(process.pid);
    expect(processAlive(identity.pid)).toBe(true);
    expect(identity.workspace?.root).toBe(resolve(root));

    /**
     * And it says which bundle it is executing (§6.3).
     *
     * A host keeps running the code it started with, so deploying a newer bundle
     * changes nothing until someone restarts it — and a client comparing files
     * on disk cannot tell whether that has happened. Only the host knows.
     *
     * Compared against `package.json` rather than a literal, because the value
     * is stamped onto the bundle at build time and what matters is that the two
     * agree. A hardcoded string here would pass happily while the build stamped
     * something else.
     */
    const shipped = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { version: string };
    expect(identity.bundleVersion, 'the host cannot say which bundle it runs').toBe(
      shipped.version,
    );
  }, 40_000);

  it('records where it is so another client can find it', async () => {
    if (!(await built())) return;

    const connection = await host();
    const identity = await connection.ready;

    // The pointer record left in the workspace, naming the *machine's* socket
    // (§8). It is not for us — it is for a released client that knows only how
    // to look here, and for a current one deciding whether an older host is
    // holding this folder. `machineId` is what says which.
    const record = await readHostRecord(root);
    expect(record?.pid).toBe(identity.pid);
    expect(record?.socket).toBe(hostSocketPath((await machineIdentity()).machineId));
    expect(record?.machineId).toBe((await machineIdentity()).machineId);

    // And the machine's own record, which is the one a client looks for first.
    const machineRecord = await readMachineRecord();
    expect(machineRecord?.pid).toBe(identity.pid);
    expect(machineRecord?.socket).toBe(record?.socket);
  }, 40_000);

  it('keeps a session alive across a client going away entirely', async () => {
    if (!(await built())) return;

    const first = await host();
    const session = await first.createSession({ title: 'survives', goal: 'g' });
    await first.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    // The app closes. Not a graceful handover — just gone.
    first.disconnect();
    open = open.filter((c) => c !== first);

    // A second client with no knowledge of the first finds the host through the
    // record and connects to the *same* process.
    const second = await host();
    const identity = await second.ready;

    expect((await second.list()).map((s) => s.title)).toEqual(['survives']);
    expect((await second.get(session.sessionId)).agents).toHaveLength(1);
    // Same owner, not a fresh one that happened to read the same log.
    expect(identity.pid).toBe((await readHostRecord(root))?.pid);
  }, 60_000);

  it('runs a turn sent by a client that then leaves', async () => {
    if (!(await built())) return;

    const first = await host();
    const session = await first.createSession({ title: 'keeps working', goal: 'g' });
    const agent = await first.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
    });

    await first.send(session.sessionId, agent.agentId, 'do the thing');
    first.disconnect();
    open = open.filter((c) => c !== first);

    const second = await host();
    const events = await second.events(session.sessionId);

    // The turn was written by the host, into the host's log. Had the app owned
    // the log, this transcript would have gone nowhere the moment it quit.
    expect(JSON.stringify(events)).toContain('do the thing');
    expect(events.some((e) => e.type === 'agent.stopped')).toBe(true);
  }, 60_000);

  it('serves two clients at once, and one leaving does not disturb the other', async () => {
    if (!(await built())) return;

    const a = await host();
    const b = await host();
    await Promise.all([a.ready, b.ready]);

    const session = await a.createSession({ title: 'shared', goal: 'g' });
    // b sees what a created, because there is one owner rather than two copies.
    expect((await b.list()).map((s) => s.sessionId)).toEqual([session.sessionId]);

    a.disconnect();
    open = open.filter((c) => c !== a);

    // The requirement in one line: another device keeps working.
    expect((await b.list()).map((s) => s.title)).toEqual(['shared']);
  }, 60_000);
});

describe('a stale record', () => {
  it('is replaced rather than trusted', async () => {
    if (!(await built())) return;

    const identity = await openWorkspace(root);
    // A host that died without cleaning up — killed, out of memory, power cut.
    await writeHostRecord(root, {
      pid: 999_999,
      socket: hostSocketPath('never-listened'),
      startedAt: new Date().toISOString(),
      instanceId: identity.instanceId,
      // Written by a machine host, so the holder check reads it as one of ours
      // rather than as an older host in the way (§8). The point of the test is
      // the *stale* record, not the guard.
      machineId: 'machine-that-is-gone',
    });

    // Trusting the file would give the classic stale-pidfile deadlock: refusing
    // to start a host because a record of a dead one exists.
    const connection = await host();
    const live = await connection.ready;

    expect(live.pid).not.toBe(999_999);
    expect((await readHostRecord(root))?.pid).toBe(live.pid);
  }, 40_000);
});

describe('processAlive', () => {
  it('recognises this process', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it('reports a pid nothing is using', () => {
    // Diagnostics only — a pid can be reused, so the socket is what actually
    // decides whether a host is usable.
    expect(processAlive(999_999)).toBe(false);
  });
});

/**
 * A workspace that moved while its host kept running (§5.3, §8).
 *
 * This used to be a test about retirement, and the thing it tested has been
 * designed out. The socket was keyed by `instanceId`, which survives a move by
 * design — identity is never derived from a path, which is the whole reason
 * relocation works at all — so a client opening the workspace at its *new*
 * location computed the same socket, reached the host still serving the *old*
 * one, and got answers about a directory that was gone. Every function involved
 * was individually correct, and the fix was for the client to ask that host to
 * retire and start a replacement.
 *
 * A machine-keyed socket removes the premise. There is one host either way, it
 * holds folders by path, and it opens the one it is asked for — so the move
 * costs an `openWorkspace`, not a process. Kept as a test because the *outcome*
 * is what matters and is easy to lose: the workspace answers at its new path,
 * under the same checkout id, with the sessions still in it.
 */
describe('a workspace that moved out from under its host', () => {
  it('serves it at the new path, under the same identity, without a restart', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first`);

    const first = await connectOrSpawnHost({
      workspaceRoot: root,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(first);
    const before = await first.ready;
    expect(resolve(before.workspace?.root ?? '')).toBe(resolve(root));

    // The folder moves. The host does not notice — it has no reason to.
    const moved = `${root}-moved`;
    roots.push(moved);
    await rename(root, moved);

    const second = await connectOrSpawnHost({
      workspaceRoot: moved,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(second);
    const after = await second.ready;

    // The place the workspace actually is. Getting the old path back would mean
    // every file operation aimed at a directory that no longer exists.
    expect(resolve(after.workspace?.root ?? '')).toBe(resolve(moved));
    // Same workspace, so the same identity: a new one here would orphan every
    // session in the folder.
    expect(after.workspace?.instanceId).toBe(before.workspace?.instanceId);
    // And the *same process*, which is the change. A move no longer costs the
    // host, so it no longer costs whatever else that host was running.
    expect(after.pid).toBe(before.pid);
    // Both folders are held, and the host says so — the old path is still there
    // as a name because nothing has told it the directory went away.
    expect(after.workspaces.map((w) => resolve(w.root))).toContain(resolve(moved));
  }, 60_000);
});
