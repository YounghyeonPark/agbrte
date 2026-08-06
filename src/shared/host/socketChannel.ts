/**
 * A `HostChannel` over a stream socket (DESIGN.md §6.4, §8).
 *
 * This is the transport that makes a host **outlive the app**. An Electron
 * `utilityProcess` cannot: it is a child of the app by construction, so a
 * session running inside one dies when the window closes. A detached process
 * listening on a socket can be reconnected to by whatever opens next — a
 * relaunched app, or a different one.
 *
 * ## Why a named pipe / unix socket rather than a TCP port
 *
 * No port to allocate, collide over, or accidentally expose. A Windows named
 * pipe and a unix domain socket are both reachable by path, which means host
 * discovery is a file (`.devagents/host.json`) rather than a registry, and access
 * is enforced by the OS rather than by anything Gilmok has to get right at runtime
 * — see `listen`, which narrows the socket to its owner. A TCP listener
 * on localhost is reachable by every process on the machine, including a browser
 * a model persuaded someone to open.
 *
 * ## Framing
 *
 * Newline-delimited JSON. A stream has no message boundaries, so something must
 * supply them, and NDJSON is what the event log already uses — one fewer format
 * in the system, and a channel dump is greppable for the same reason a log is.
 * `JSON.stringify` never emits a raw newline, so the delimiter is unambiguous
 * without escaping.
 *
 * A partial line at the end of a read is **held, never parsed**. That is the same
 * rule `LineAccumulator` enforces for the log, and for the same reason: handing a
 * truncated line to a parser is how a torn read becomes corrupt data.
 */

import { createServer, Socket, type Server } from 'node:net';
import { chmodSync } from 'node:fs';
import type { HostChannel } from './protocol.js';

/** Split a buffer into whole lines, holding any trailing partial. */
class LineFramer {
  private held = '';

  push(chunk: string): string[] {
    const combined = this.held + chunk;
    const lines = combined.split('\n');
    // The last element is either an empty string (chunk ended on a newline) or a
    // partial line. Either way it is not ready to parse.
    this.held = lines.pop() ?? '';
    return lines.filter((line) => line.trim() !== '');
  }
}

interface SocketChannelOptions {
  /** Called for a line that will not parse, so corruption is visible. */
  onMalformed?: (line: string, err: unknown) => void;
}

/**
 * One side of a socket conversation.
 *
 * Both directions use the same class; only the type parameters differ, which is
 * what lets the host and the app share every framing and buffering rule instead
 * of implementing it twice with subtly different edge cases.
 */
export class SocketChannel<Out, In> implements HostChannel<Out, In> {
  private handler: ((m: In) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private readonly backlog: In[] = [];
  private readonly framer = new LineFramer();
  private closed = false;
  private closeReason: string | undefined;

  constructor(
    private readonly socket: Socket,
    private readonly opts: SocketChannelOptions = {},
  ) {
    socket.setEncoding('utf8');
    // Long-lived and mostly idle: without this a NAT or a firewall silently
    // drops the connection and neither side learns until it writes.
    socket.setKeepAlive(true, 30_000);

    socket.on('data', (chunk: string) => {
      for (const line of this.framer.push(chunk)) {
        let message: In;
        try {
          message = JSON.parse(line) as In;
        } catch (err) {
          // Skipped, not fatal: one unreadable frame must not take down a
          // connection carrying a running session.
          this.opts.onMalformed?.(line, err);
          continue;
        }
        if (this.handler === null) {
          // The handshake can arrive before a handler attaches, and losing it
          // leaves the peer waiting forever for a reply to a message it never
          // saw delivered.
          this.backlog.push(message);
          continue;
        }
        this.handler(message);
      }
    });

    socket.on('error', (err) => this.die(err.message));
    socket.on('close', () => this.die('socket closed'));
    socket.on('end', () => this.die('peer ended the connection'));
  }

  post(message: Out): void {
    if (this.closed || this.socket.destroyed) return;
    // Backpressure is deliberately ignored: `write` buffers, and the alternative
    // — dropping or blocking — would either lose a durable event or stall the
    // agent that produced it.
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: (m: In) => void): void {
    this.handler = handler;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
    // Already gone: notify immediately rather than never. A peer can die before
    // the client finishes constructing, and dropping that left the client
    // waiting forever for a handshake that was never coming.
    if (this.closed) handler(this.closeReason);
  }

  close(): void {
    this.die('closed locally');
    this.socket.destroy();
  }

  private die(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    this.closeHandler?.(reason);
  }
}

/**
 * Accepts connections; each one becomes a channel.
 *
 * The socket is narrowed to its owner as soon as it exists. Node creates a unix
 * socket with `0777 & ~umask`, and connecting to one needs *write* permission —
 * so under the umask of `0002` that Ubuntu ships, the default is `0775` and any
 * member of the owner's group can attach. Measured on a real host rather than
 * assumed. That is survivable only where each user has a private group; on a
 * machine with a shared `dev` or `staff` group it hands a colleague a
 * `read-write` client, because the host grants the role a client asks for
 * (`grantRole`, §6.4) on the reasoning that reaching the socket already proved
 * who you are. That reasoning is only sound if reaching it is actually
 * restricted.
 *
 * Windows named pipes are not chmod-able and do not need to be: the default DACL
 * grants the creating user and administrators, not everyone.
 */
export function listen<Out, In>(
  path: string,
  onConnection: (channel: SocketChannel<Out, In>) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => onConnection(new SocketChannel<Out, In>(socket)));
    server.on('error', reject);
    server.listen(path, () => {
      if (process.platform !== 'win32') {
        try {
          chmodSync(path, 0o600);
        } catch (err) {
          // Refuse to serve rather than serve wider than intended: a host that
          // silently kept a group-writable socket would look identical to one
          // that is locked down.
          server.close();
          reject(new Error(`could not restrict ${path}: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
      }
      resolve(server);
    });
  });
}

/**
 * Where to connect: a socket path, or a loopback port.
 *
 * Both exist because the local host listens on a pipe or unix socket, while a
 * remote one is reached through an `ssh -L` forward whose local end is TCP —
 * OpenSSH can forward to a local unix socket too, but not portably on Windows.
 */
export type ChannelTarget = string | { port: number; host?: string };

/** Connect to a listening host. Rejects if nothing is there. */
export function connect<Out, In>(
  target: ChannelTarget,
  timeoutMs = 5_000,
): Promise<SocketChannel<Out, In>> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const where = typeof target === 'string' ? target : `${target.host ?? '127.0.0.1'}:${target.port}`;

    const fail = (err: Error): void => {
      socket.destroy();
      reject(err);
    };

    const timer = setTimeout(() => fail(new Error(`timed out connecting to ${where}`)), timeoutMs);

    socket.once('error', (err) => {
      clearTimeout(timer);
      // ENOENT / ECONNREFUSED here is the ordinary "no host is running" case, and
      // the caller distinguishes it from a real failure by trying to spawn one.
      fail(err);
    });

    const onReady = (): void => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(new SocketChannel<Out, In>(socket));
    };

    if (typeof target === 'string') socket.connect(target, onReady);
    else socket.connect(target.port, target.host ?? '127.0.0.1', onReady);
  });
}

/**
 * The socket path for a workspace, keyed by its `instanceId`.
 *
 * Keyed by instance rather than by path because §5.2 already makes `instanceId`
 * the identity of one checkout on one machine — which is exactly the scope of
 * one host. Two checkouts of the same repo get different sockets for free, and a
 * moved workspace keeps its own.
 *
 * Neither platform puts the socket inside `.devagents/`. Windows named pipes
 * live in a global namespace, not the filesystem; and a unix socket path has a
 * hard length limit around 104 bytes, which a deep workspace path plus a
 * filename can exceed — an unusual failure to debug, and easy to avoid.
 */
export function hostSocketPath(instanceId: string): string {
  if (process.platform === 'win32') {
    // The instance id is already unique per checkout, so it needs no hashing —
    // and keeping it readable makes a stuck pipe diagnosable with `handle.exe`.
    return `\\\\.\\pipe\\gilmok-${instanceId}`;
  }
  return `${process.env['TMPDIR'] ?? '/tmp'}/gilmok-${instanceId}.sock`;
}
