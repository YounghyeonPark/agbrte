/**
 * The control channel for machines that cannot pass a unix socket
 * (DESIGN.md §6.2, §6.4, §13).
 *
 * > `unixSockets: boolean;   // else loopback TCP + bearer token`
 *
 * Written in the capability table from the beginning and implemented nowhere,
 * which is why WSL, containers, k8s and dev containers are all blocked on the
 * same thing rather than on four different things. `SshRunner` is
 * `exec`/`upload`/`forward`; the first two are nearly a one-liner for `wsl -d`
 * or `docker exec`, and `forward` is not, because there is no way to carry a
 * Linux unix socket out of a WSL2 VM to Windows — `\\wsl$` is 9p and an
 * `AF_UNIX` path does not survive it.
 *
 * ## The token replaces the entire basis for trusting a client
 *
 * This is the sentence to read before anything else here. A unix socket at
 * `0600` and a Windows named pipe carry an **OS-enforced** claim: reaching one
 * proves you are the user who owns the workspace. The host leans on that
 * directly — `grantRole` hands a client the role it asks for, on the reasoning
 * that "reaching the socket already proved who you are", and `accessPolicy`
 * calls itself a seatbelt rather than a lock for the same reason.
 *
 * A loopback TCP port has no such property. **Every process on the machine can
 * connect to it**, including a browser a model persuaded someone to open —
 * `socketChannel` already says so, as the argument for not using TCP at all. So
 * the token is not a hardening measure added on top of the existing check. It is
 * the *replacement* for the check that a unix socket got for free, and if it is
 * weaker than the file permission it stands in for, moving to TCP is a downgrade
 * dressed as a feature.
 *
 * Which is why the token is kept in the host record, inside `.agbrte/` at
 * `0700` (§13), in a file written `0600`. Reading it then requires exactly the
 * filesystem permission that reaching the unix socket required. Same gate, same
 * owner, expressed in the only currency this transport has.
 *
 * ## Consequences, each of which is a way to get this wrong
 *
 * **Bound to `127.0.0.1`, never `0.0.0.0`.** The difference is "processes on
 * this machine" versus "everyone who can route to it", and the default in Node
 * is the second one. That is one omitted argument between a local control
 * channel and an unauthenticated remote one.
 *
 * **Authenticated before the protocol, not inside it.** Putting the token in
 * `hello` would leave a connection that never says hello able to issue
 * `session.list` and `session.events` — which is exactly the hole found when a
 * protocol mismatch was *told* no and left connected. So the check happens at
 * the channel layer: until the first line verifies, there is no channel, and the
 * session server never learns the connection exists.
 *
 * **Compared in constant time.** `a === b` on strings returns early at the first
 * differing character. Over a loopback socket that difference is small and
 * noisy, but it is also free to remove, and "the timing signal was probably too
 * small to use" is not a thing to write down and rely on.
 *
 * **A wrong token closes the connection.** No error message describing what was
 * wrong, no second attempt on the same socket. There is nothing useful to tell
 * someone who did not have the token, and a retry loop would turn the port into
 * something to sit and guess against.
 *
 * **An unauthenticated connection has a deadline.** Otherwise anything that
 * connects and says nothing holds a socket open for as long as it likes, and the
 * host accumulates them.
 *
 * The token is never logged, never put in an event, and never included in an
 * error string — it is a credential, and §13's rule about those has no exception
 * for the ones we minted ourselves.
 */

import { createServer, Socket, type Server } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { SocketChannel } from './socketChannel.js';

/**
 * 32 bytes, hex.
 *
 * Long enough that guessing is not a threat model, so the deadline and the
 * connection close below are about tidiness rather than about brute force.
 */
export function newControlToken(): string {
  return randomBytes(32).toString('hex');
}

/** Constant-time equality, safe on inputs of any length or shape. */
export function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // `timingSafeEqual` throws on a length mismatch rather than returning false,
  // and an exception thrown from an auth path is how a refusal becomes a crash.
  // Comparing lengths first does leak the length — which is fixed and public.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** How long an unauthenticated connection may sit there. */
export const AUTH_DEADLINE_MS = 5_000;

/**
 * The most that will be read while waiting for the auth line.
 *
 * A peer that connects and streams megabytes without ever sending a newline
 * would otherwise be buffered in full by a host that has not yet decided to
 * trust it. Generous next to a token line, small next to memory.
 */
const MAX_AUTH_BYTES = 8 * 1024;

/** The one line spoken before there is a channel. */
interface AuthLine {
  t: 'auth';
  token: string;
}

/**
 * The one line spoken back.
 *
 * The first draft had no reply, on the argument that answering differently to a
 * wrong token than to a right one is an oracle. That argument does not survive
 * contact with the failure it produces. Without an acknowledgement the client
 * has nothing to wait for, so it must hand over the channel optimistically — and
 * a refusal is a close that arrives a round trip later, by which time the
 * channel exists and the error the user sees is `socket closed`. A stale token
 * would then be indistinguishable from a host that crashed, which are opposite
 * problems with opposite fixes.
 *
 * And the oracle is not one. The secret is 256 bits, so "that token was wrong"
 * tells a guesser exactly what the close already told them, at a rate limited by
 * the same round trip. Trading a real diagnostic for a theoretical signal was
 * the wrong way round.
 */
interface AuthOkLine {
  t: 'auth-ok';
}

export class ControlAuthFailed extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ControlAuthFailed';
  }
}

export interface LoopbackListener {
  server: Server;
  /** The port the OS chose. Ephemeral, so two hosts cannot collide. */
  port: number;
}

/**
 * Listen on loopback, admitting only connections that present the token.
 *
 * `onConnection` is called **after** authentication, so a caller sees the same
 * thing it sees from `listen` on a unix socket: a channel belonging to somebody
 * entitled to it. Nothing downstream needs to know which transport it came from,
 * which is the property that makes this a substitute rather than a second path.
 */
export function listenLoopback<Out, In>(
  token: string,
  onConnection: (channel: SocketChannel<Out, In>) => void,
  opts: { port?: number; deadlineMs?: number } = {},
): Promise<LoopbackListener> {
  const deadline = opts.deadlineMs ?? AUTH_DEADLINE_MS;

  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      guard<Out, In>(socket, token, deadline, onConnection);
    });
    server.on('error', reject);
    // `127.0.0.1` explicitly. Node's default is every interface, and this is the
    // one place where that default would publish a control channel to the
    // network instead of to the machine.
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      if (port === 0) {
        server.close();
        reject(new Error('loopback listener got no port'));
        return;
      }
      resolve({ server, port });
    });
  });
}

function guard<Out, In>(
  socket: Socket,
  token: string,
  deadlineMs: number,
  onConnection: (channel: SocketChannel<Out, In>) => void,
): void {
  socket.setEncoding('utf8');
  let buffer = '';
  let settled = false;

  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      socket.destroy();
    }
  }, deadlineMs);
  // The host is long-lived and this timer is short; without `unref` a stray
  // half-open connection would keep a process alive that has nothing to do.
  timer.unref?.();

  const refuse = (): void => {
    settled = true;
    clearTimeout(timer);
    // Destroyed rather than answered. Someone without the token learns only that
    // the connection went away, which is all there is to tell them.
    socket.destroy();
  };

  const onData = (chunk: string): void => {
    if (settled) return;
    buffer += chunk;

    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > MAX_AUTH_BYTES) refuse();
      return;
    }

    const line = buffer.slice(0, newline);
    // Everything after the newline belongs to the conversation that is about to
    // start. TCP does not preserve write boundaries, so a client writing its
    // token and its `hello` in the same tick arrives as one segment — and a
    // reader that stopped at the newline would silently swallow the handshake.
    const rest = buffer.slice(newline + 1);

    let parsed: AuthLine;
    try {
      parsed = JSON.parse(line) as AuthLine;
    } catch {
      refuse();
      return;
    }

    if (parsed?.t !== 'auth' || typeof parsed.token !== 'string' || !tokensMatch(parsed.token, token)) {
      refuse();
      return;
    }

    settled = true;
    clearTimeout(timer);
    socket.off('data', onData);
    socket.write(`${JSON.stringify({ t: 'auth-ok' } satisfies AuthOkLine)}\n`);
    onConnection(new SocketChannel<Out, In>(socket, { pending: rest }));
  };

  socket.on('data', onData);
  // A peer that hangs up mid-handshake is ordinary. Swallowed so it cannot
  // become an unhandled 'error' on a socket nobody has adopted yet.
  socket.on('error', () => refuse());
}

/** Dial a loopback control port, presenting the token first. */
export function connectLoopback<Out, In>(
  port: number,
  token: string,
  timeoutMs = 5_000,
  host = '127.0.0.1',
): Promise<SocketChannel<Out, In>> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(
      () => fail(new Error(`timed out connecting to the control port on ${host}`)),
      timeoutMs,
    );

    // A refusal is a close with no reply, so this side cannot tell "wrong token"
    // from "the host went away" by reading — and should not try. What it can say
    // is that the connection closed before anything came back, which is the
    // honest description of both.
    const onEarlyClose = (): void => {
      clearTimeout(timer);
      reject(
        new ControlAuthFailed(
          'the host closed the control connection without answering — the token is stale or wrong',
        ),
      );
    };

    socket.once('error', (err) => {
      clearTimeout(timer);
      fail(err);
    });

    socket.setEncoding('utf8');
    let buffer = '';

    const onData = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        if (buffer.length > MAX_AUTH_BYTES) fail(new Error('the control port answered with nonsense'));
        return;
      }

      const line = buffer.slice(0, newline);
      // Same rule as the host side, for the same reason: whatever follows the
      // acknowledgement belongs to the conversation, and dropping it would lose
      // a message that was legitimately sent.
      const rest = buffer.slice(newline + 1);

      let parsed: AuthOkLine;
      try {
        parsed = JSON.parse(line) as AuthOkLine;
      } catch {
        fail(new Error('the control port answered with nonsense'));
        return;
      }
      if (parsed?.t !== 'auth-ok') {
        fail(new ControlAuthFailed('the host refused the control token'));
        return;
      }

      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onEarlyClose);
      socket.removeAllListeners('error');
      resolve(new SocketChannel<Out, In>(socket, { pending: rest }));
    };

    socket.connect(port, host, () => {
      socket.once('close', onEarlyClose);
      socket.on('data', onData);
      // Written before anything else on the socket, and never logged.
      socket.write(`${JSON.stringify({ t: 'auth', token } satisfies AuthLine)}\n`);
    });
  });
}
