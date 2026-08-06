/**
 * The socket transport that lets a host outlive the app (DESIGN.md §6.4, §8).
 *
 * Real sockets throughout — a real listener, real connections, real framing. The
 * bugs this transport can have are all about boundaries and timing: a message
 * split across two reads, a peer that dies before a handler attaches, a
 * reconnection to a listener that is still holding a session. None of those are
 * reachable against a mock.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { connect, hostSocketPath, listen, SocketChannel } from '@shared/host/socketChannel.js';

interface Ping {
  n: number;
  text?: string;
}

let servers: Server[] = [];
let dirs: string[] = [];

/**
 * A listener, plus a promise for the connection it accepts.
 *
 * The promise matters: `connect()` resolves on the client side before the
 * server's accept callback necessarily runs, so a test that reaches for the
 * server-side channel immediately races it. That race is the test's problem, not
 * the transport's — but it produced four failures that looked like framing bugs.
 */
async function serve(
  onConnection?: (channel: SocketChannel<Ping, Ping>) => void,
): Promise<{ path: string; accepted: Promise<SocketChannel<Ping, Ping>> }> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-sock-'));
  dirs.push(dir);
  // A unique instance id per test, which is also how a real host names its
  // socket — one per checkout (§5.2).
  const path = hostSocketPath(`test-${process.pid}-${servers.length}-${Date.now()}`);

  let announce!: (c: SocketChannel<Ping, Ping>) => void;
  const accepted = new Promise<SocketChannel<Ping, Ping>>((resolve) => (announce = resolve));

  servers.push(
    await listen<Ping, Ping>(path, (channel) => {
      announce(channel);
      onConnection?.(channel);
    }),
  );
  return { path, accepted };
}

afterEach(async () => {
  for (const server of servers) server.close();
  servers = [];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  dirs = [];
});

/** Collect messages until `count` arrive. */
function collect(channel: SocketChannel<Ping, Ping>, count: number): Promise<Ping[]> {
  return new Promise((resolve) => {
    const got: Ping[] = [];
    channel.onMessage((m) => {
      got.push(m);
      if (got.length === count) resolve(got);
    });
  });
}

describe('framing', () => {
  it('carries messages both ways', async () => {
    const { path } = await serve((channel) => {
      channel.onMessage((m) => channel.post({ n: m.n * 2 }));
    });

    const client = await connect<Ping, Ping>(path);
    const replies = collect(client, 2);
    client.post({ n: 1 });
    client.post({ n: 21 });

    expect(await replies).toEqual([{ n: 2 }, { n: 42 }]);
  });

  it('reassembles a message split across reads', async () => {
    const { path, accepted } = await serve();
    const client = await connect<Ping, Ping>(path);
    const received = collect(await accepted, 1);
    // A stream has no message boundaries. A payload large enough to be split by
    // the OS is the case a naive "parse each chunk" implementation gets wrong,
    // and it only shows up under load.
    const big = 'x'.repeat(200_000);
    client.post({ n: 1, text: big });

    const [message] = await received;
    expect(message?.text).toHaveLength(200_000);
  });

  it('keeps several messages in one read separate', async () => {
    const { path, accepted } = await serve();
    const client = await connect<Ping, Ping>(path);
    const received = collect(await accepted, 3);
    // Written back to back, so they almost certainly arrive in one chunk.
    client.post({ n: 1 });
    client.post({ n: 2 });
    client.post({ n: 3 });

    expect((await received).map((m) => m.n)).toEqual([1, 2, 3]);
  });

  it('buffers what arrives before a handler attaches', async () => {
    const { path, accepted } = await serve();
    const client = await connect<Ping, Ping>(path);
    const channel = await accepted;
    client.post({ n: 7 });
    await new Promise((r) => setTimeout(r, 30));

    // The handshake can land before the server wires its handler; dropping it
    // leaves the peer waiting forever for a reply to a message it never saw.
    const got = await collect(channel, 1);
    expect(got).toEqual([{ n: 7 }]);
  });
});

describe('disconnection', () => {
  it('tells the client when the host goes away', async () => {
    const { path, accepted } = await serve();
    const client = await connect<Ping, Ping>(path);
    const channel = await accepted;

    const closed = new Promise<string | undefined>((resolve) => client.onClose(resolve));
    channel.close();

    await expect(closed).resolves.toBeDefined();
  });

  it('notifies a handler attached after the peer already left', async () => {
    const { path, accepted } = await serve();
    const client = await connect<Ping, Ping>(path);
    const channel = await accepted;

    channel.close();
    await new Promise((r) => setTimeout(r, 30));

    // Registering late must not mean never hearing about it — that is what left
    // `client.ready` pending forever in the utilityProcess version.
    const closed = new Promise<string | undefined>((resolve) => client.onClose(resolve));
    await expect(closed).resolves.toBeDefined();
  });

  it('swallows a post after close instead of throwing', async () => {
    const { path } = await serve();
    const client = await connect<Ping, Ping>(path);
    client.close();

    // A caller racing a disconnect is ordinary; the reply it wanted fails through
    // its own request timeout rather than an exception from the transport.
    expect(() => client.post({ n: 1 })).not.toThrow();
  });

  it('fails to connect when nothing is listening', async () => {
    // The ordinary "no host is running" case. The caller distinguishes it from a
    // real failure by spawning one.
    await expect(connect(hostSocketPath('definitely-not-running'), 500)).rejects.toThrow();
  });
});

describe('reconnection — the point of the whole transport', () => {
  it('accepts a new connection after the first one goes away', async () => {
    const seen: number[] = [];
    const { path } = await serve((channel) => {
      channel.onMessage((m) => {
        seen.push(m.n);
        channel.post({ n: m.n });
      });
    });

    const first = await connect<Ping, Ping>(path);
    const firstReply = collect(first, 1);
    first.post({ n: 1 });
    await firstReply;

    // The app closes.
    first.close();
    await new Promise((r) => setTimeout(r, 30));

    // A different app instance connects to the same still-running host. This is
    // the behaviour a utilityProcess cannot have at all: it dies with its parent.
    const second = await connect<Ping, Ping>(path);
    const secondReply = collect(second, 1);
    second.post({ n: 2 });
    await secondReply;

    expect(seen).toEqual([1, 2]);
  });

  it('serves two clients at once', async () => {
    const { path } = await serve((channel) => {
      channel.onMessage((m) => channel.post({ n: m.n + 100 }));
    });

    const a = await connect<Ping, Ping>(path);
    const b = await connect<Ping, Ping>(path);
    const [ra, rb] = await Promise.all([collect(a, 1), collect(b, 1), a.post({ n: 1 }), b.post({ n: 2 })]);

    // Two devices attached to one session is the requirement, so the listener
    // must not be single-client.
    expect(ra).toEqual([{ n: 101 }]);
    expect(rb).toEqual([{ n: 102 }]);
  });
});

describe('host socket paths', () => {
  it('gives each instance its own socket', () => {
    expect(hostSocketPath('a')).not.toBe(hostSocketPath('b'));
  });

  it('uses a named pipe on Windows and a filesystem socket elsewhere', () => {
    const path = hostSocketPath('abc');
    if (process.platform === 'win32') {
      expect(path.startsWith('\\\\.\\pipe\\')).toBe(true);
    } else {
      expect(path.endsWith('.sock')).toBe(true);
    }
  });
});

describe('socket permissions', () => {
  it('narrows a unix socket to its owner', async () => {
    if (process.platform === 'win32') return; // named pipes carry a DACL instead
    const path = join(tmpdir(), `loom-mode-${process.pid}.sock`);
    const server = await listen(path, () => undefined);
    try {
      // Node creates it `0777 & ~umask`, and connecting needs *write* — so the
      // 0002 umask Ubuntu ships yields 0775, and the owner's group can attach as
      // read-write. Measured on a real host, not assumed.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      server.close();
    }
  });
});
