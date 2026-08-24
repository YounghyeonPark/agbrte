/**
 * What a remote connection asks the host for (DESIGN.md §6.2, §8).
 *
 * One property, and it is the one the remote path got wrong for three releases:
 * the `hello` a remote connection sends must name the folder it is attaching to.
 * A host is one per machine and holds several folders, so the folder a
 * connection gets is the folder it asks for — and a connection that asks for
 * nothing is answered with the host's only workspace while there is one, which
 * is indistinguishable from correct until a second folder is opened. See the
 * header of `connectRemote.ts` for what that looked like from the outside.
 *
 * Everything below the forward is real: the actual `connectRemoteHost`, the
 * actual `HostConnection`, the actual line framing, over an actual loopback
 * socket. The `ssh` is the only thing faked, because it is the only thing that
 * needs a second machine — and the fake `forward` puts a listener on the port
 * `connectRemoteHost` chose, which is exactly what `ssh -L` would have done.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { connectRemoteHost } from '@main/host/connectRemote.js';
import { SocketChannel } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { SshRunner } from '@main/host/sshTransport.js';

/** The stamp the probe reports, so nothing is deployed. */
const DEPLOYED = 'bundle-under-test';

interface Remote {
  runner: SshRunner;
  /** The first command the far side receives, which is the handshake. */
  hello: Promise<SessionCommand>;
  stop: () => void;
}

/**
 * A machine that answers ssh, with a host already running on it.
 *
 * Canned answers for the three questions `connectRemoteHost` asks before it
 * dials — the probe, the pty module, the host record — chosen so the cheap path
 * runs: Node present, bundle current, module loadable, host up. Anything else
 * would put an install in the middle of a test about a handshake.
 */
function remoteWithHostRunning(): Remote {
  const sockets: Socket[] = [];
  let server: Server | null = null;
  let announce: (command: SessionCommand) => void = () => undefined;
  const hello = new Promise<SessionCommand>((resolve) => {
    announce = resolve;
  });

  const runner: SshRunner = {
    exec: async (_alias, command) => {
      if (/uname/.test(command)) {
        return {
          code: 0,
          stdout: `home=/home/ci\narch=x86_64\nplatform=Linux\nnode=/usr/bin/node\nbundle=${DEPLOYED}\n`,
          stderr: '',
        };
      }
      if (/host\.json/.test(command)) {
        return {
          code: 0,
          stdout: JSON.stringify({
            pid: 4242,
            // Named, never dialled: the fake forward below ignores it, as a real
            // one would be the only thing that could reach it.
            socket: '/home/ci/.agbrte/host.sock',
            protocol: 23,
            instanceId: 'inst-remote',
            machineId: 'machine-remote',
          }),
          stderr: '',
        };
      }
      // The pty check, and anything else: succeeded, so nothing installs.
      return { code: 0, stdout: '', stderr: '' };
    },
    upload: async () => undefined,
    forward: async (_alias, port) => {
      server = createServer((socket) => {
        sockets.push(socket);
        const channel = new SocketChannel<SessionMessage, SessionCommand>(socket);
        channel.onMessage((command) => announce(command));
      });
      await new Promise<void>((resolve, reject) => {
        server?.once('error', reject);
        server?.listen(port, '127.0.0.1', resolve);
      });
      return { close: () => server?.close() };
    },
  };

  return {
    runner,
    hello,
    stop: () => {
      for (const socket of sockets) socket.destroy();
      server?.close();
    },
  };
}

const stoppers: Array<() => void> = [];
afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
});

describe('attaching a remote workspace', () => {
  it('names the folder it wants in the handshake', async () => {
    const remote = remoteWithHostRunning();
    stoppers.push(remote.stop);

    const attached = await connectRemoteHost({
      alias: 'box',
      workspaceRoot: '/srv/projects/xxxx',
      bundles: { host: 'unused', agent: 'unused' },
      bundleVersion: DEPLOYED,
      runner: remote.runner,
    });
    stoppers.push(() => attached.close());

    /*
     * `workspace`, and this is the whole test.
     *
     * Without it the host answers with its single folder — the right one by
     * luck, and the wrong one the moment the machine holds two, which is what
     * "one session, one folder" makes the normal case rather than the unusual
     * one.
     */
    expect(await remote.hello).toMatchObject({
      t: 'hello',
      workspace: '/srv/projects/xxxx',
      role: 'read-write',
    });
  });

  it('sends it as the path on the remote, untouched by this machine', async () => {
    const remote = remoteWithHostRunning();
    stoppers.push(remote.stop);

    const attached = await connectRemoteHost({
      alias: 'box',
      // A POSIX path from a Windows app, which is the ordinary case: the folder
      // was picked from a listing of the *remote*. Resolving it here would turn
      // it into `C:\srv\...` and the host would open a folder nobody asked for
      // — so it travels as typed and is resolved on the machine it names.
      workspaceRoot: '/home/ci/Desktop',
      bundles: { host: 'unused', agent: 'unused' },
      bundleVersion: DEPLOYED,
      runner: remote.runner,
    });
    stoppers.push(() => attached.close());

    expect(await remote.hello).toMatchObject({ workspace: '/home/ci/Desktop' });
  });
});
