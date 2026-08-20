/**
 * The control channel for machines that cannot pass a unix socket
 * (DESIGN.md §6.2, §6.4, §13).
 *
 * §6.2 has said `unixSockets: boolean;   // else loopback TCP + bearer token`
 * since the beginning, and the second half existed nowhere — which is why WSL,
 * containers, k8s and dev containers are blocked on one thing rather than four.
 *
 * What is asserted here is mostly *refusal*, because the working case is easy
 * and the failure is not a crash. A unix socket at `0600` proves who you are by
 * OS permission and the host leans on that directly (`grantRole` hands over the
 * role a client asks for, on the reasoning that reaching the socket already
 * proved it). A loopback port proves nothing — every process on the machine can
 * reach it. So the token is not hardening; it is the replacement for the whole
 * basis of trust, and a hole in it is a downgrade dressed as a feature.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { connect as tcpConnect, type Server } from 'node:net';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  connectLoopback,
  ControlAuthFailed,
  listenLoopback,
  newControlToken,
  tokensMatch,
} from '@shared/host/loopback.js';
import { startSessionHost } from '../src/host/hostMain.js';
import { readHostRecord } from '../src/host/discovery.js';
import { HostConnection } from '@main/host/hostConnection.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AgentId, SessionId } from '@shared/types/index.js';

/**
 * The built agent host, which `startSessionHost` forks.
 *
 * Resolved relative to its own bundle in production, so an in-process caller has
 * to say where it is. A missing one is not a skip: it surfaces as "agent refused:
 * could not resolve capabilities", which points at the wrong layer entirely.
 */
const AGENT_HOST = resolve(__dirname, '../dist/main/agentHost.js');

const servers: Server[] = [];
const stops: Array<() => Promise<void>> = [];
const roots: string[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop().catch(() => undefined);
  for (const server of servers.splice(0)) server.close();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A bare listener that just collects whatever gets through. */
async function bare(token: string, deadlineMs?: number) {
  const admitted: Array<{ seen: unknown[] }> = [];
  const { server, port } = await listenLoopback<{ ok: true }, unknown>(
    token,
    (channel) => {
      const entry = { seen: [] as unknown[] };
      admitted.push(entry);
      channel.onMessage((m) => entry.seen.push(m));
    },
    deadlineMs === undefined ? {} : { deadlineMs },
  );
  servers.push(server);
  return { port, admitted };
}

/** Speak to the port by hand, so the client's own politeness is not what passes. */
function raw(port: number, write: string): Promise<{ received: string; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = tcpConnect(port, '127.0.0.1', () => socket.write(write));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => (received += d));
    socket.on('close', () => resolve({ received, closed: true }));
    socket.on('error', () => resolve({ received, closed: true }));
    setTimeout(() => {
      socket.destroy();
      resolve({ received, closed: socket.destroyed });
    }, 800);
  });
}

describe('the token stands in for a file permission', () => {
  it('compares without returning early', () => {
    const token = newControlToken();
    expect(tokensMatch(token, token)).toBe(true);
    expect(tokensMatch(token, token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a'))).toBe(false);
    // Length mismatch must be `false`, not a throw. `timingSafeEqual` raises on
    // unequal lengths, and an exception out of an auth path turns a refusal into
    // a crash — with the connection possibly already adopted.
    expect(tokensMatch(token, '')).toBe(false);
    expect(tokensMatch('', token)).toBe(false);
    expect(tokensMatch(token, `${token}x`)).toBe(false);
  });

  it('is long enough that guessing is not the threat model', () => {
    const a = newControlToken();
    const b = newControlToken();
    expect(a).toHaveLength(64); // 32 bytes, hex
    expect(a).not.toBe(b);
  });
});

describe('nothing gets through without the token', () => {
  it('admits the right one', async () => {
    const token = newControlToken();
    const { port, admitted } = await bare(token);
    const channel = await connectLoopback<unknown, unknown>(port, token);
    expect(admitted).toHaveLength(1);
    channel.close();
  });

  it('refuses the wrong one, and says which failure it was', async () => {
    const { port, admitted } = await bare(newControlToken());
    await expect(connectLoopback(port, newControlToken())).rejects.toBeInstanceOf(ControlAuthFailed);
    // The point is not the error. It is that the callback never fired, so the
    // session server never learned the connection existed.
    expect(admitted, 'an unauthenticated connection reached the host').toHaveLength(0);
  });

  it('refuses a connection that just starts talking', async () => {
    /**
     * The shape that would work if the token lived in `hello` instead of below
     * it: a client that never authenticates, issuing a read. Before this
     * channel existed the equivalent hole was real — a protocol mismatch was
     * *told* no and left connected, and could still read every transcript.
     */
    const { port, admitted } = await bare(newControlToken());
    const result = await raw(port, `${JSON.stringify({ t: 'session.list', id: '1' })}\n`);
    expect(admitted).toHaveLength(0);
    expect(result.closed).toBe(true);
    // And nothing came back. There is nothing useful to tell someone who did
    // not have the token, and a reply is something to iterate against.
    expect(result.received).toBe('');
  });

  it('refuses junk without throwing out of the accept path', async () => {
    const { port, admitted } = await bare(newControlToken());
    for (const junk of ['not json at all\n', '{"t":"auth"}\n', '{"t":"auth","token":42}\n', '\n']) {
      const result = await raw(port, junk);
      expect(result.closed, junk).toBe(true);
    }
    expect(admitted).toHaveLength(0);
    // The listener is still serving: a bad connection must not take the host
    // with it, which a throw from inside `createServer`'s callback would.
    const token = newControlToken();
    const second = await bare(token);
    const channel = await connectLoopback<unknown, unknown>(second.port, token);
    expect(second.admitted).toHaveLength(1);
    channel.close();
  });

  it('drops a connection that authenticates never', async () => {
    // Otherwise anything that connects and says nothing holds a socket for as
    // long as it likes, and the host accumulates them.
    const { port, admitted } = await bare(newControlToken(), 120);
    const result = await raw(port, ''); // connect, send nothing
    expect(result.closed).toBe(true);
    expect(admitted).toHaveLength(0);
  });
});

describe('the port is on this machine, not on the network', () => {
  it('binds loopback only — the difference is one omitted argument', async () => {
    /**
     * Node's default bind is *every* interface. Between a control channel for
     * this machine and an unauthenticated one for the network there is a single
     * argument, and it is the kind of difference that looks identical in every
     * test that runs on one host.
     *
     * So this does not check the argument, it checks the exposure: reach for the
     * same port on a real non-loopback address of this machine, and be refused.
     */
    const { port } = await bare(newControlToken());

    const external = Object.values(networkInterfaces())
      .flat()
      .find((i) => i !== undefined && i.family === 'IPv4' && !i.internal)?.address;

    if (external === undefined) {
      // A machine with no external IPv4 cannot answer this question, and an
      // assertion that silently passes is worse than an absent one.
      expect(external, 'no non-loopback IPv4 here to test against').toBeUndefined();
      return;
    }

    const reached = await new Promise<boolean>((done) => {
      const socket = tcpConnect(port, external);
      const settle = (ok: boolean): void => {
        socket.destroy();
        done(ok);
      };
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
      socket.setTimeout(2_000, () => settle(false));
    });

    expect(reached, `the control port answered on ${external} — it is on the network`).toBe(false);
  }, 15_000);
});

describe('the wire does not lose a pipelined message', () => {
  it('keeps what arrived in the same segment as the token', async () => {
    /**
     * TCP does not preserve write boundaries. A client writing its token and its
     * `hello` in one tick delivers both in one segment, and a reader that stops
     * at the newline swallows the handshake — after which the host waits for a
     * hello that was sent and the client waits for a welcome that never comes.
     *
     * Our own client cannot produce this, because it waits for `auth-ok`. That
     * is exactly why it is worth asserting with a raw socket: the case is
     * unreachable from the code that would have caught it by accident.
     */
    const token = newControlToken();
    const { port, admitted } = await bare(token);
    const hello = { t: 'hello', id: '1', client: 'test', role: 'read-write' };
    await raw(port, `${JSON.stringify({ t: 'auth', token })}\n${JSON.stringify(hello)}\n`);

    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.seen, 'the pipelined message was dropped').toEqual([hello]);
  });
});

describe('a real host, reached over loopback', () => {
  it('serves a whole session and writes its token 0600', async () => {
    /**
     * The end-to-end claim §6.2 makes: a host that cannot use a unix socket is
     * reachable, with everything above the channel unchanged. `HostConnection`
     * is handed the authenticated channel and neither it nor the session server
     * knows which transport it came from — which is the property that makes this
     * a substitute rather than a second path with its own semantics.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-loopback-'));
    roots.push(root);

    const host = await startSessionHost({ workspaceRoot: root,
      control: 'loopback',
      lingerMs: 0,
      agentHostEntry: AGENT_HOST,
      onStopped: () => undefined,
    });
    stops.push(host.stop);
    expect(host.port).toBeGreaterThan(0);

    const record = await readHostRecord(root);
    expect(record?.port).toBe(host.port);
    expect(record?.token).toMatch(/^[0-9a-f]{64}$/);

    if (process.platform !== 'win32') {
      // The record is a credential now. `.agbrte/` is already 0700, so this
      // changes nothing for another user — it is the belt to that braces, and
      // free.
      const mode = (await stat(join(root, '.agbrte', 'host.json'))).mode & 0o777;
      expect(mode, 'the host record carrying a token is readable by others').toBe(0o600);
    }

    const channel = await connectLoopback<SessionCommand, SessionMessage>(
      host.port!,
      record!.token!,
    );
    const connection = new HostConnection({ channel, client: 'agbrte-test@loopback' });
    const identity = await connection.ready;
    expect(identity.workspace?.root).toBe(root);

    const session = await connection.createSession({ title: 'over loopback', goal: 'g' });
    const agent = await connection.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await connection.send(
      session.sessionId as SessionId,
      agent.agentId as AgentId,
      'a turn over a control port',
    );

    const events = await connection.events(session.sessionId as SessionId);
    expect(events.map((e) => e.type)).toContain('agent.stopped');
    expect(JSON.stringify(events)).toContain('a turn over a control port');

    connection.disconnect();
  }, 60_000);

  it('is unreachable with a stale token, and says so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agbrte-loopback-'));
    roots.push(root);
    const host = await startSessionHost({ workspaceRoot: root,
      control: 'loopback',
      lingerMs: 0,
      agentHostEntry: AGENT_HOST,
      onStopped: () => undefined,
    });
    stops.push(host.stop);

    await expect(connectLoopback(host.port!, newControlToken())).rejects.toBeInstanceOf(
      ControlAuthFailed,
    );
  }, 30_000);

  it('never writes the token where a log would carry it', async () => {
    /**
     * §13's rule about credentials has no exception for the ones we minted. The
     * host record is where it lives on purpose; the event log is not, and the
     * log is the file that gets exported, searched and pasted into an issue.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-loopback-'));
    roots.push(root);
    const host = await startSessionHost({ workspaceRoot: root,
      control: 'loopback',
      lingerMs: 0,
      agentHostEntry: AGENT_HOST,
      onStopped: () => undefined,
    });
    stops.push(host.stop);
    const token = (await readHostRecord(root))!.token!;

    const channel = await connectLoopback<SessionCommand, SessionMessage>(host.port!, token);
    const connection = new HostConnection({ channel, client: 'agbrte-test@loopback' });
    await connection.ready;
    const session = await connection.createSession({ title: 't', goal: 'g' });
    const agent = await connection.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await connection.send(session.sessionId as SessionId, agent.agentId as AgentId, 'hello');
    connection.disconnect();

    const log = await readFile(
      join(root, '.agbrte', 'sessions', session.sessionId, 'events.jsonl'),
      'utf8',
    );
    expect(log).not.toContain(token);
  }, 60_000);
});
