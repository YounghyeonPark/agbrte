/**
 * Surviving a read that lands on a pipe main has already let go of
 * (DESIGN.md §7, §8).
 *
 * ## The failure this exists for
 *
 * ```
 * Uncaught Exception:
 * RangeError [ERR_OUT_OF_RANGE]: The value of "err" is out of range.
 *   It must be a negative integer. Received 4595
 *     at Object.getSystemErrorName (node:util:454:11)
 *     at new ErrnoException (node:internal/errors:733:23)
 *     at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)
 * ```
 *
 * That dialog is Electron's `lib/browser/init`, and **only** the browser process
 * installs it — verified by reading the string out of `electron.exe`, and by
 * running a throwing script under `ELECTRON_RUN_AS_NODE=1`, which prints a stack
 * and exits with no dialog at all. So whatever else is true, the process that
 * raises this is *this* one. The pseudoterminal is not: `@lydell/node-pty`
 * appears in `dist/main/agbrteHost.js` and in no other bundle, so the PTY, the
 * `type CON` relay and the shells all live in the detached host, which cannot
 * put a dialog on screen. What main holds is the far end of the host's socket —
 * on Windows a named pipe, which is what `Pipe` in that stack means.
 *
 * ## What Node is actually doing, read rather than guessed
 *
 * `onStreamRead` (node 24.18, `internal/stream_base_commons` line 216, the line
 * in the report) is:
 *
 * ```js
 * if (nread > 0 && !stream.destroyed) { …push the bytes…; return ret; }
 * if (nread === 0) return;
 * if (nread !== UV_EOF) { stream.destroy(new ErrnoException(nread, 'read')); return; }
 * ```
 *
 * A **positive** `nread` therefore reaches `ErrnoException` on exactly one
 * condition: the stream is already flagged `destroyed` while its handle is still
 * open and still reading. `getSystemErrorName` then refuses the positive number,
 * and the `RangeError` is thrown from inside a C++→JS callback where no `catch`
 * of ours can ever be on the stack. That last part is why this is a guard and
 * not a `try`.
 *
 * `net.Socket.prototype._destroy` normally makes that state unreachable: it
 * closes the handle and assigns `handle.onread = noop`. Reproduced here rather
 * than assumed — destroy-during-flood, destroy from a later tick, `execFile`
 * killed on `maxBuffer`, a child killed mid-output, and a host killed while a
 * terminal floods the channel are all clean, in plain node **and** in a real
 * Electron browser process. What does reproduce it, byte for byte including the
 * three stack frames, is a socket whose `destroyed` flag is set while the handle
 * keeps reading. So the state is real, it is reachable from outside our code,
 * and it is not something a caller here can un-write.
 *
 * ## Why a guard, and how narrow it is
 *
 * Two properties make it survivable rather than merely silenced:
 *
 *  - It recognises **one** error: `ERR_OUT_OF_RANGE`, saying a negative integer
 *    was required, raised from `Pipe.onStreamRead`. Anything else — including
 *    another `ERR_OUT_OF_RANGE` from anywhere else — goes to `onFatal`, which
 *    main wires to the same error box Electron would have shown, because
 *    installing any `uncaughtException` listener at all disables Electron's own
 *    (`process.listenerCount('uncaughtException') > 1 || …`). Adding a handler
 *    that quietly ate every future main-process crash would be a far worse bug
 *    than the one being fixed.
 *  - It **repairs the stream** instead of returning to it. A handle left open in
 *    that state raises the same exception on every subsequent read, so swallowing
 *    without retiring converts one crash into an endless one. `retireStrayReaders`
 *    closes exactly the sockets in that state and announces the closure through
 *    the socket's own `close` event, so `SocketChannel` → `HostConnection` →
 *    `Fleet` take the ordinary lost-link path: the host goes to `reconnecting`,
 *    terminals on it are reported closed by name (§8), and the window lives.
 *
 * A pane dying is the right size of failure for a pane. Losing the window — and
 * with it the view of every other host — because one pipe delivered one late
 * read is not.
 */

/** Reported to whoever owned the socket, so the reason is not a bare close. */
export const STRAY_PIPE_REASON =
  'the host connection delivered a read after the socket was already closed; the link will be re-dialled';

/**
 * The one error this guard answers for.
 *
 * All three conditions, deliberately. The code alone is far too broad — it is
 * one of Node's most common argument errors — and the message alone would match
 * a validation failure in our own code. Together with the frame they pin the
 * single site described above.
 */
export function isStrayPipeRead(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  if ((err as NodeJS.ErrnoException).code !== 'ERR_OUT_OF_RANGE') return false;
  if (!/must be a negative integer/.test(err.message)) return false;
  const stack = err.stack ?? '';
  return stack.includes('Pipe.onStreamRead') && stack.includes('stream_base_commons');
}

/**
 * The shape this reaches into. Deliberately structural and optional-everywhere:
 * these are Node internals, and a guard that throws while handling a crash is
 * worse than the crash.
 */
interface SocketLike {
  destroyed?: unknown;
  _handle?: { close?: (cb?: () => void) => void; onread?: unknown } | null;
  emit?: (event: string, ...args: unknown[]) => unknown;
  listenerCount?: (event: string) => number;
}

/** Assigned over `onread` so a completion already in flight lands nowhere. */
const swallow = (): void => undefined;

/**
 * Close every socket that is flagged destroyed but still holds a live handle.
 *
 * Takes the handle list rather than reading it, so this is drivable by a test
 * with a socket it built itself and no process-wide state.
 */
export function retireStrayReaders(handles: readonly unknown[]): number {
  let retired = 0;
  for (const candidate of handles) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const socket = candidate as SocketLike;
    // `destroyed` true with a handle still attached is the whole signature: a
    // socket that went through `_destroy` has `_handle === null` by the time the
    // flag is readable, so a healthy connection can never match.
    if (socket.destroyed !== true) continue;
    const handle = socket._handle;
    if (handle === null || handle === undefined) continue;

    // Order matters: neutered before closed, because closing can deliver a
    // queued completion on the way out and that is the exact read being fixed.
    try {
      handle.onread = swallow;
      handle.close?.();
    } catch {
      // A handle that will not close is already gone. Either way it must not
      // stop the announcement below, which is what keeps the UI honest.
    }
    socket._handle = null;
    retired += 1;

    try {
      // `error` first where somebody is listening, so the reason travels; then
      // `close`, which is the event every owner of a socket in this app already
      // treats as "the link went away". Emitting `error` with no listener would
      // throw, which is why it is asked rather than assumed.
      if ((socket.listenerCount?.('error') ?? 0) > 0) {
        socket.emit?.('error', new Error(STRAY_PIPE_REASON));
      }
      socket.emit?.('close', true);
    } catch {
      // An owner that throws from its own teardown is its own problem; this
      // guard's job is to leave the process alive.
    }
  }
  return retired;
}

export interface StrayPipeGuardOptions {
  /** Recognised, repaired, survived — for the log, never for a dialog. */
  onStray: (err: Error, retired: number) => void;
  /**
   * Everything else, which must keep behaving exactly as it did before this
   * file existed. Main hands this to Electron's own error box.
   */
  onFatal: (err: Error) => void;
  /** Injectable so a test can drive its own socket rather than the process's. */
  handles?: () => readonly unknown[];
  /** Injectable for the same reason. Defaults to this process. */
  target?: NodeJS.EventEmitter;
}

/** Node's own list of live handles, which is where a stray reader will be. */
function activeHandles(): readonly unknown[] {
  const internal = process as unknown as { _getActiveHandles?: () => unknown[] };
  try {
    return internal._getActiveHandles?.() ?? [];
  } catch {
    return [];
  }
}

/**
 * Install the guard. Returns the uninstaller, which tests use and main does not
 * need — a process that is quitting has nothing left to protect.
 */
export function installStrayPipeGuard(opts: StrayPipeGuardOptions): () => void {
  const target = opts.target ?? process;
  const handles = opts.handles ?? activeHandles;

  const onUncaught = (err: Error): void => {
    if (!isStrayPipeRead(err)) {
      opts.onFatal(err);
      return;
    }
    opts.onStray(err, retireStrayReaders(handles()));
  };

  target.on('uncaughtException', onUncaught);
  return () => {
    target.off('uncaughtException', onUncaught);
  };
}
