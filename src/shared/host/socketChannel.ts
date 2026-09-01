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
 * discovery is a file (`.agbrte/host.json`) rather than a registry, and access
 * is enforced by the OS rather than by anything Agbrte has to get right at runtime
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
import { chmodSync, unlinkSync } from 'node:fs';
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
  /**
   * Bytes already read off the socket that belong to this conversation.
   *
   * Needed by the loopback listener, which reads an auth line before deciding
   * whether there will *be* a conversation. TCP does not preserve write
   * boundaries, so a client that writes its token and its `hello` in the same
   * tick delivers both in one segment — and the second one would be dropped on
   * the floor by a reader that stopped at the newline. Handed over explicitly
   * rather than pushed back onto the stream: `unshift` on a socket that has
   * already been switched to flowing mode with an encoding set is exactly the
   * kind of clever that works until it does not.
   */
  pending?: string;
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
  /** Held so `die` can take it off, rather than leaving a dead channel reading. */
  private readonly onData: (chunk: string) => void;

  constructor(
    private readonly socket: Socket,
    private readonly opts: SocketChannelOptions = {},
  ) {
    socket.setEncoding('utf8');
    // Long-lived and mostly idle: without this a NAT or a firewall silently
    // drops the connection and neither side learns until it writes.
    socket.setKeepAlive(true, 30_000);

    this.onData = (chunk: string) => this.ingest(chunk);
    socket.on('data', this.onData);

    // Anything the caller already read goes through the same framer and the same
    // backlog, so a pipelined message is indistinguishable from one that arrived
    // a moment later — which is the only way it can be, since on the wire it is.
    if (opts.pending !== undefined && opts.pending !== '') this.ingest(opts.pending);

    socket.on('error', (err) => this.die(err.message));
    socket.on('close', () => this.die('socket closed'));
    socket.on('end', () => this.die('peer ended the connection'));
  }

  private ingest(chunk: string): void {
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
  }

  /**
   * This conversation is over, whichever end decided it.
   *
   * **The socket goes with it, on every path — not only on `close()`.** That
   * used to be the local-close path's job alone, which left two states nobody
   * wanted: a channel that had already told its owner it was gone while its
   * `data` handler kept framing bytes into a `HostConnection` whose calls were
   * all rejected, and — where the reason was an `end` or an `error` rather than
   * our own `close()` — a socket still subscribed by a listener that could no
   * longer do anything with what arrived. Reading a stream after deciding it is
   * closed is the shape of bug this whole file exists to avoid one process
   * further out, and it had it.
   *
   * Idempotent, and safe to call from inside the socket's own `close` event:
   * `destroy()` on an already-destroyed socket is a no-op, and `closed` guards
   * the announcement.
   */
  private die(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    // Off before destroy: a chunk delivered between the two would be framed
    // into a channel that has already announced its own death.
    this.socket.off('data', this.onData);
    this.socket.destroy();
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
 *
 * ## A socket left by a host that died is not a host
 *
 * `discovery.ts` states the rule for `host.json` and gives the reason: trusting a
 * file left by a dead process "would mean an app that refuses to start a host
 * because a record of a dead one exists — the classic stale-pidfile deadlock".
 * The record was made a hint. **The socket was not**, and it is a file too.
 *
 * A unix socket is only unlinked when the server closes cleanly. Kill the host,
 * lose power, run out of memory, and the path stays — after which every future
 * host fails to bind and the workspace cannot be opened again. Measured on a real
 * Linux host rather than reasoned about: killed with `SIGKILL`, the socket file
 * remained, the next `listen` gave `EADDRINUSE`, and connecting to it gave
 * `ECONNREFUSED`. Nothing was there; the path was simply in the way. What the
 * user saw was "host did not start listening", fifteen seconds later, naming the
 * host rather than the leftover.
 *
 * It has not been hit here because Windows named pipes have no filesystem entry
 * to leave behind, so this is a bug that only exists on the machines this feature
 * is *for*.
 *
 * So a bind conflict asks the question the record already knew to ask: **is
 * anything actually there?** Nothing answering means the socket is debris and is
 * removed; something answering means a real host owns this workspace, which is
 * §6.6's single writer and is refused with that said plainly — including when the
 * owner is another user on a shared box (§17 Q9).
 */
export function listen<Out, In>(
  path: string,
  onConnection: (channel: SocketChannel<Out, In>) => void,
): Promise<Server> {
  return listenOnce<Out, In>(path, onConnection).catch(async (err: unknown) => {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'EADDRINUSE') throw err;

    /*
     * A named pipe in use is a *live* pipe, so Windows skips the probe.
     *
     * It does not skip the sentence, which it used to: the bare `EADDRINUSE`
     * that came back named a path and explained nothing, on the platform where
     * this is now the ordinary way to learn that a host is already running. The
     * probe is what is unavailable there — a pipe leaves no filesystem entry to
     * be debris — not the diagnosis.
     */
    if (process.platform === 'win32' || (await answers(path))) {
      throw new Error(hostAlreadyRunning(path));
    }

    try {
      unlinkSync(path);
    } catch (removeErr) {
      // Cannot remove it, and nothing is listening. On a shared box that is
      // somebody else's leftover in a directory we do not own, and saying which
      // is the difference between a five-minute fix and a support thread.
      throw new Error(
        `${path} is in the way and nothing is listening on it, but it could not be ` +
          `removed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
      );
    }
    return listenOnce<Out, In>(path, onConnection);
  });
}

/**
 * Is anything actually accepting connections there?
 *
 * Exported because two questions need it and they are the same question: a bind
 * conflict asking whether a socket is debris, and a client asking whether the
 * host named in a workspace's record is still alive. Both must never trust a
 * file, and both must be answered without a handshake — the second one is asked
 * about hosts too old to speak this protocol.
 */
export function socketAnswers(target: ChannelTarget): Promise<boolean> {
  return answers(target);
}

/**
 * What a machine's second host is told, in one place.
 *
 * Exported because `listen` is no longer the only thing that says it: a host
 * asks whether the socket answers *before* it writes any record, so the refusal
 * has two sites and must not have two wordings — a person comparing a log line
 * with what the app showed them is entitled to the same sentence.
 */
export function hostAlreadyRunning(path: string): string {
  return (
    `another Agbrte host is already running on this machine, listening on ${path}. ` +
    `One host per machine owns every workspace open on it (§6.6 single writer), ` +
    `so this one will not start. Use the host that is already there, or stop it ` +
    `with \`agbrte stop\`. If it belongs to another user on this machine, it is ` +
    `serving their home directory and not yours — nothing here is shared.`
  );
}

function answers(target: ChannelTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = new Socket();
    const done = (alive: boolean): void => {
      probe.destroy();
      resolve(alive);
    };
    probe.once('connect', () => done(true));
    probe.once('error', () => done(false));
    probe.setTimeout(1_000, () => done(false));
    if (typeof target === 'string') probe.connect(target);
    else probe.connect(target.port, target.host ?? '127.0.0.1');
  });
}

/**
 * How many bytes a unix socket path may be, including its terminator.
 *
 * `sockaddr_un.sun_path` is a fixed array and the size differs: 104 on the BSDs
 * and macOS, 108 on Linux. The real number is used rather than the smaller one
 * everywhere, because refusing a 106-byte path that Linux would have bound is a
 * regression invented to keep one constant.
 */
const SUN_PATH_MAX = process.platform === 'darwin' ? 104 : 108;

/**
 * Why this path cannot be a unix socket, or `null`.
 *
 * **Over the limit, `bind` does not fail — it truncates.** The socket is created
 * at a shortened path, the caller holds the name it asked for, and the first
 * thing to touch that name is what reports the problem. Here that is the `chmod`
 * below, which came back `ENOENT` and read as a permissions failure on a socket
 * that had, as far as anyone could see, just been created successfully. Found on
 * a macOS CI runner, whose `TMPDIR` is a 48-byte `/var/folders/...` path — the
 * machine host's own socket fits there with six bytes to spare, and nothing said
 * so or would have noticed when it stopped being true.
 *
 * Exported for the test, because the interesting case cannot be reached on
 * Windows and this is arithmetic rather than a syscall.
 */
export function tooLongForSocket(path: string): string | null {
  const bytes = Buffer.byteLength(path);
  if (bytes < SUN_PATH_MAX) return null;
  return (
    `socket path is ${bytes} bytes and this platform allows ${SUN_PATH_MAX - 1}: ${path}. ` +
    'A longer path is silently truncated by bind rather than refused, so the socket ' +
    'would be created under a name nothing else computes. Shorten TMPDIR or the id.'
  );
}

function listenOnce<Out, In>(
  path: string,
  onConnection: (channel: SocketChannel<Out, In>) => void,
): Promise<Server> {
  return new Promise((resolve, reject) => {
    // Before binding, because after binding the evidence is gone: the truncated
    // path exists, the one we hold does not, and every later error names the
    // wrong thing. Windows pipes are a namespace rather than a filesystem entry
    // and have no such limit.
    if (process.platform !== 'win32') {
      const tooLong = tooLongForSocket(path);
      if (tooLong !== null) {
        reject(new Error(tooLong));
        return;
      }
    }

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
 * The socket path for a **machine's** host, keyed by its `machineId`.
 *
 * It was keyed by `instanceId` — one checkout — which was exactly one host's
 * scope for as long as a host was one per workspace. It is not any more (§8): a
 * machine runs one host holding however many folders its sessions named, so the
 * key is the machine, minted in `~/.agbrte/machine.json`.
 *
 * That change is what makes two hosts on one machine *structurally* impossible
 * rather than merely discouraged. Before, two folders meant two sockets and
 * nothing at the OS level objected to a second process; now every host on a
 * machine computes the same path, so the second one loses the bind and the
 * handling below asks the only question that matters — is anything actually
 * there — rather than assuming either answer.
 *
 * Neither platform puts the socket inside a workspace. Windows named pipes live
 * in a global namespace, not the filesystem; and a unix socket path has a hard
 * length limit — 104 bytes on macOS, 108 on Linux — which a deep workspace path
 * plus a filename can exceed. `~/.agbrte` would satisfy the first and not
 * reliably the second, so `TMPDIR` keeps it.
 *
 * "Easy to avoid" is what this used to say, and it was avoided by arithmetic
 * nobody had done. A macOS `TMPDIR` is a 48-byte `/var/folders/...`, so the
 * socket a real machine host names there fits with six bytes to spare — and over
 * the limit `bind` truncates rather than refusing, which makes the failure
 * arrive later and somewhere else. `tooLongForSocket` now says it at the bind.
 */
export function hostSocketPath(machineId: string): string {
  if (process.platform === 'win32') {
    // The machine id is already unique, so it needs no hashing — and keeping it
    // readable makes a stuck pipe diagnosable with `handle.exe`.
    return `\\\\.\\pipe\\agbrte-${machineId}`;
  }
  return `${process.env['TMPDIR'] ?? '/tmp'}/agbrte-${machineId}.sock`;
}
