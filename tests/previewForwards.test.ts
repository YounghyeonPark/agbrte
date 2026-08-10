/**
 * Preview forwarding (DESIGN.md §6.8), and the first reader of a declared
 * capability.
 *
 * `TransportCapabilities.portForwardOut` has existed since §6.2 was written and
 * was read by nothing. §16 keeps finding that shape; this is where the promise
 * gets kept for one of the six booleans.
 *
 * The behavioural half was verified against a real host — a loopback-bound
 * server on a build box, unreachable from here except through the tunnel,
 * fetched with HTTP 200 and the right bytes. What is here is the part that
 * wants to be run on every commit: the lifetime rules, and the defect the real
 * run exposed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ForwardRefused,
  PreviewForwards,
  probeLocalPort,
  type ForwardHandle,
} from '@main/preview/forwards.js';
import { createServer } from 'node:net';
import type { ExecutionTarget, SessionId } from '@shared/types/index.js';

const SSH: ExecutionTarget = { kind: 'ssh', alias: 'build-01', host: 'build-01' };
const LOCAL: ExecutionTarget = { kind: 'local' };
const A = 'session-a' as SessionId;
const B = 'session-b' as SessionId;

/** A fleet of fake tunnels that remember whether they were closed. */
function harness(opts: { reachable?: boolean } = {}) {
  const closed: number[] = [];
  const opened: Array<{ localPort: number; remotePort: number }> = [];
  let next = 40_000;

  const forwards = new PreviewForwards({
    freePort: () => Promise.resolve((next += 1)),
    probe: () => Promise.resolve(opts.reachable ?? true),
    open: (_target, localPort, remotePort): Promise<ForwardHandle> => {
      opened.push({ localPort, remotePort });
      return Promise.resolve({ close: () => closed.push(localPort) });
    },
  });

  return { forwards, closed, opened };
}

describe('a forward belongs to a session', () => {
  it('is listed under it and torn down with it', async () => {
    const { forwards, closed } = harness();
    const three = await forwards.forward(A, SSH, 3000);
    const eight = await forwards.forward(A, SSH, 8080);

    expect(forwards.list(A).map((f) => f.remotePort)).toEqual([3000, 8080]);
    expect(forwards.closeSession(A)).toBe(2);
    expect(forwards.list(A)).toEqual([]);
    // A live `ssh -N` left behind is both a leak and a lie: the port keeps
    // answering after the session that explained it is gone.
    expect(closed.sort()).toEqual([three.localPort, eight.localPort].sort());
  });

  it('does not take a neighbour’s down', async () => {
    // The failure that comes from keying by port alone: two sessions previewing
    // 3000 on different machines, and closing one kills the other's tunnel.
    const { forwards, opened } = harness();
    await forwards.forward(A, SSH, 3000);
    await forwards.forward(B, SSH, 3000);
    expect(opened).toHaveLength(2);

    forwards.closeSession(A);
    expect(forwards.list(A)).toEqual([]);
    expect(forwards.list(B).map((f) => f.remotePort)).toEqual([3000]);
  });

  it('opens one tunnel for the same port asked twice', async () => {
    const { forwards, opened } = harness();
    const first = await forwards.forward(A, SSH, 3000);
    const second = await forwards.forward(A, SSH, 3000);
    expect(second.localPort).toBe(first.localPort);
    expect(opened, 'a second ssh was started to the same place').toHaveLength(1);
  });

  it('closes one without disturbing the rest', async () => {
    const { forwards } = harness();
    await forwards.forward(A, SSH, 3000);
    await forwards.forward(A, SSH, 8080);
    expect(forwards.close(A, 3000)).toBe(true);
    expect(forwards.close(A, 3000)).toBe(false);
    expect(forwards.list(A).map((f) => f.remotePort)).toEqual([8080]);
  });
});

describe('a locality that cannot forward says so', () => {
  it('reads the capability §6.2 declared and nothing consulted', async () => {
    const { forwards, opened } = harness();
    // `hosted` is `portForwardOut: false` — §6.9 gives it no transport at all,
    // so there is nothing to tunnel through.
    await expect(
      forwards.forward(A, { kind: 'hosted', serviceId: 'svc', agentRef: 'a' }, 3000),
    ).rejects.toBeInstanceOf(ForwardRefused);
    // Refused before dialling, so the message names the locality rather than
    // describing whatever tool failed inside it.
    expect(opened).toHaveLength(0);
  });

  it('needs no tunnel for a port already on this machine', async () => {
    const { forwards, opened } = harness();
    const here = await forwards.forward(A, LOCAL, 3000);
    expect(here.localPort).toBe(3000);
    expect(here.url).toBe('http://127.0.0.1:3000');
    expect(opened, 'started a tunnel from localhost to localhost').toHaveLength(0);
  });

  it('refuses something that is not a port', async () => {
    const { forwards } = harness();
    for (const bad of [0, -1, 70_000, 1.5, Number.NaN]) {
      await expect(forwards.forward(A, SSH, bad)).rejects.toBeInstanceOf(ForwardRefused);
    }
  });
});

describe('a forward that opened is not a forward that works', () => {
  it('reports an empty far end instead of pretending', async () => {
    /**
     * The defect the real run exposed. `ssh -N -L` binds the local end
     * immediately, so the transport's readiness check — "the port answers" — is
     * true for a remote port with nothing behind it. Forwarding port 9 on a
     * live host reported success, and the failure arrived at fetch time as a
     * reset. That reads as "the preview is broken" and sends the user to debug
     * the wrong machine.
     */
    const { forwards } = harness({ reachable: false });
    const dead = await forwards.forward(A, SSH, 9);
    expect(dead.reachable).toBe(false);
    // Reported, not refused: the tunnel is genuinely open and correct.
    expect(dead.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(forwards.list(A)).toHaveLength(1);
  });

  it('can be asked again, because a server that is still compiling looks dead', async () => {
    /**
     * The reason `reachable: false` is not a refusal. Opening the forward before
     * the dev server finishes starting is the *ordinary* order of events, and
     * tearing it down would break the common case to catch a typo. Rechecking
     * keeps the same local port, so a browser tab already open on it starts
     * working rather than needing a new URL.
     */
    let alive = false;
    const forwards = new PreviewForwards({
      freePort: () => Promise.resolve(45_000),
      probe: () => Promise.resolve(alive),
      open: () => Promise.resolve({ close: () => undefined }),
    });

    const booting = await forwards.forward(A, SSH, 3000);
    expect(booting.reachable).toBe(false);

    alive = true;
    const ready = await forwards.recheck(A, 3000);
    expect(ready?.reachable).toBe(true);
    expect(ready?.localPort, 'the URL changed under an open tab').toBe(booting.localPort);
    expect(await forwards.recheck(A, 9999)).toBeNull();
  });

  it('probes by whether the connection survives, since a server says nothing first', async () => {
    /**
     * Against real sockets rather than the injected probe. A dev server sends
     * nothing until it is asked, so "it did not hang up" is the only positive
     * signal available at the TCP layer — and the measured gap is 4–5 ms for a
     * dead forward against indefinitely for a live one.
     */
    const server = createServer(() => undefined); // accepts, says nothing — like a dev server
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    expect(await probeLocalPort(port, 120)).toBe(true);
    server.close();

    // Nothing listening: a connect that is refused outright.
    expect(await probeLocalPort(port, 120)).toBe(false);
  }, 10_000);

  it('treats a far end that hangs up immediately as dead', async () => {
    // What `ssh -L` to a dead remote port actually does: accept locally, then
    // reset once the far side refuses. A probe that only checked `connect`
    // would call this alive, which is the bug.
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    expect(await probeLocalPort(port, 500)).toBe(false);
    server.close();
  }, 10_000);
});

describe('shutdown lets nothing linger', () => {
  it('closes every session’s forwards', async () => {
    const { forwards, closed } = harness();
    await forwards.forward(A, SSH, 3000);
    await forwards.forward(B, SSH, 8080);
    forwards.closeAll();
    expect(closed).toHaveLength(2);
    expect(forwards.list(A)).toEqual([]);
    expect(forwards.list(B)).toEqual([]);
  });

  it('does not call a handle twice', async () => {
    const close = vi.fn();
    const forwards = new PreviewForwards({
      freePort: () => Promise.resolve(46_000),
      probe: () => Promise.resolve(true),
      open: () => Promise.resolve({ close }),
    });
    await forwards.forward(A, SSH, 3000);
    forwards.close(A, 3000);
    forwards.closeSession(A);
    forwards.closeAll();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
