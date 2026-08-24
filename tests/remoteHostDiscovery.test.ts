/**
 * Finding the host a remote machine is already running (DESIGN.md §6.4, §8).
 *
 * The script under test runs on the far side, so it is run here **for real** —
 * this machine's Node, real record files, and a real listener. Faking the socket
 * would remove the only part that matters: the question is not "is there a
 * record" but "does anything answer", and every bug this replaces came from
 * treating the first as an answer to the second.
 *
 * The two shapes that made a machine unattachable, and both are cases below:
 *
 *   * a record left by a host that is gone — the app forwarded to it, failed,
 *     and never started a host because a record existed;
 *   * a host that is listening with no machine record — the app started a second
 *     host, which the first one's socket refused.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIND_HOST_SCRIPT } from '@main/host/sshTransport.js';
import { hostSocketPath, listen } from '@shared/host/socketChannel.js';
import type { Server } from 'node:net';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function tempDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agbrte-${tag}-`));
  dirs.push(dir);
  return dir;
}

/**
 * A socket that answers, named the way a host names its own.
 *
 * `hostSocketPath` rather than a path of this test's choosing, because it is the
 * function that decides what a socket path *is* on each platform — a named pipe
 * on Windows, where a path under `tmp` would be a file nothing can connect to.
 */
async function listening(id: string): Promise<string> {
  const socket = hostSocketPath(`discovery-${id}`);
  servers.push(await listen(socket, () => undefined));
  return socket;
}

/** A path shaped like a socket with nothing behind it. */
function dead(id: string): string {
  return hostSocketPath(`gone-${id}`);
}

async function record(path: string, socket: string, pid = 4242): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true }).catch(() => undefined);
  await writeFile(
    path,
    JSON.stringify({ pid, socket, protocol: 23, instanceId: 'inst-x', machineId: 'm-x' }),
  );
}

/** Run the script the way the remote runs it: `node -e <script> <home> <ws>`. */
async function findHost(home: string, workspace: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', FIND_HOST_SCRIPT, home, workspace], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', (d) => (out += String(d)));
    child.on('exit', () => resolve(out));
  });
}

describe('where a machine’s host is listening', () => {
  it('answers with the machine record when its socket answers', async () => {
    const home = await tempDir('home');
    const workspace = await tempDir('ws');
    const socket = await listening('a');
    await record(join(home, 'host.json'), socket, 111);

    expect(JSON.parse(await findHost(home, workspace))).toMatchObject({ socket, pid: 111 });
  });

  it('says nothing about a record whose host is gone', async () => {
    const home = await tempDir('home');
    const workspace = await tempDir('ws');
    await record(join(home, 'host.json'), dead('b'));

    /*
     * Empty, so the caller starts a host — which is the whole point.
     *
     * A record outlives `kill -9` and a reboot, and believing it meant
     * forwarding to a socket nobody answers and reporting *that*: an attach that
     * failed identically every time, on a machine where starting a host would
     * have worked.
     */
    expect(await findHost(home, workspace)).toBe('');
  });

  it('finds the host through another folder when the machine record is missing', async () => {
    const home = await tempDir('home');
    const other = await tempDir('other');
    const wanted = await tempDir('wanted');
    const socket = await listening('c');

    // What the machine looks like after a lost bind race deleted the machine
    // record: a host listening, folders it serves, and nothing at the top.
    await mkdir(join(other, '.agbrte'), { recursive: true });
    await record(join(other, '.agbrte', 'host.json'), socket, 222);
    await writeFile(
      join(home, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ root: other, instanceId: 'inst-other' }] }),
    );

    /*
     * The folder being attached is *not* the folder that answered.
     *
     * This is the case the whole change exists for: attaching a new folder on a
     * machine whose host is up. There is no record for `wanted` — it may not
     * even exist yet — so the only way to find the host is to ask what else this
     * machine serves.
     */
    expect(JSON.parse(await findHost(home, wanted))).toMatchObject({ socket, pid: 222 });
  });

  it('passes over a dead record to reach a live one', async () => {
    const home = await tempDir('home');
    const other = await tempDir('other');
    const workspace = await tempDir('ws');
    const socket = await listening('d');

    // Both on disk, and the stale one is read first. Order must not decide it.
    await record(join(home, 'host.json'), dead('e'));
    await mkdir(join(other, '.agbrte'), { recursive: true });
    await record(join(other, '.agbrte', 'host.json'), socket, 333);
    await writeFile(
      join(home, 'workspaces.json'),
      JSON.stringify({ workspaces: [{ root: other, instanceId: 'inst-other' }] }),
    );

    expect(JSON.parse(await findHost(home, workspace))).toMatchObject({ socket, pid: 333 });
  });

  it('says nothing on a machine that has never run one', async () => {
    const home = await tempDir('home');
    const workspace = await tempDir('ws');

    expect(await findHost(home, workspace)).toBe('');
  });

  /**
   * The state the bug actually left machines in: a host, and nothing on disk.
   *
   * A host restores every folder it has served before it binds, so the host that
   * lost the race held all of them — and its cleanup deleted the machine record
   * *and* every pointer. There was then no record to read anywhere on a machine
   * that was answering fine.
   *
   * POSIX only, like the script: the derived path is `hostSocketPath`'s unix
   * branch, and on Windows a host listens on a named pipe that this expression
   * does not describe. Skipped rather than adapted, because adapting it would be
   * testing an expression this script does not contain.
   */
  it.skipIf(process.platform === 'win32')(
    'finds a host with no record at all, from the machine identity',
    async () => {
      const home = await tempDir('home');
      const workspace = await tempDir('ws');
      const machineId = `derived-${process.pid}`;
      const socket = `${process.env['TMPDIR'] ?? '/tmp'}/agbrte-${machineId}.sock`;
      servers.push(await listen(socket, () => undefined));
      await writeFile(
        join(home, 'machine.json'),
        JSON.stringify({ machineId, createdAt: new Date().toISOString() }),
      );

      const found = JSON.parse(await findHost(home, workspace)) as {
        socket: string;
        pid?: number;
      };
      expect(found.socket).toBe(socket);
      // And it does not invent the rest. A host found this way has said nothing
      // but "I am here" — see `RemoteHostRecord`.
      expect(found.pid).toBeUndefined();
    },
  );
});
