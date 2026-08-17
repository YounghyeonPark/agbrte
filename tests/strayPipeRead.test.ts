/**
 * A read that lands on a pipe main has already let go of (DESIGN.md §7, §8).
 *
 * The crash this covers cannot be produced by calling anything: `RangeError
 * [ERR_OUT_OF_RANGE] … at Pipe.onStreamRead` is thrown by Node from inside a
 * C++→JS read callback, with no frame of ours anywhere on the stack. So the test
 * is built the only way it can be — a **real** socket pair over a **real** pipe,
 * flooded, put into the one state that makes Node turn a byte count into an
 * errno, and then left to fail on its own clock.
 *
 * That state is documented in `strayPipeRead.ts`: `destroyed` set while the
 * handle is still open and reading. `_destroy` is what normally makes it
 * unreachable (it closes the handle and assigns `onread = noop`), which is why
 * this test writes the flag rather than calling `destroy()` — calling it would
 * exercise the path that already works and prove nothing.
 *
 * The assertions are the two properties that matter and they are different
 * claims: that the process **survives**, and that it survives **once**. A guard
 * that swallowed without retiring the handle would pass a naive version of this
 * and ship an app that raises the same exception on every subsequent read
 * forever.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installStrayPipeGuard,
  isStrayPipeRead,
  retireStrayReaders,
  STRAY_PIPE_REASON,
} from '@main/strayPipeRead.js';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) server.close();
});

/** A pipe (Windows) or unix socket (elsewhere) with a peer that never stops talking. */
function flooding(name: string): Promise<string> {
  const path =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\agbrte-stray-${process.pid}-${name}`
      : join(tmpdir(), `agbrte-stray-${process.pid}-${name}.sock`);

  // ~4.5 KB frames, the size in the crash report, so the read that lands is the
  // size of a real `push.session` rather than an artificial one.
  const chunk = `${'y'.repeat(4590)}\n`;

  return new Promise((resolve) => {
    const server = createServer((peer) => {
      peer.on('error', () => undefined);
      const pump = (): void => {
        if (peer.destroyed) return;
        for (let i = 0; i < 200; i += 1) peer.write(chunk);
        setImmediate(pump);
      };
      pump();
    });
    servers.push(server);
    server.listen(path, () => resolve(path));
  });
}

/** Connect, read until the stream is genuinely flowing, then hand it over. */
function reader(path: string): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = new Socket();
    sockets.push(socket);
    socket.on('error', () => undefined);
    socket.connect(path, () => {
      socket.setEncoding('utf8');
      let seen = 0;
      socket.on('data', (data: string) => {
        seen += data.length;
        // Only once the handle is demonstrably reading, which is the
        // precondition — a socket that has not read yet cannot deliver a late
        // read to anybody.
        if (seen >= 32 * 1024) resolve(socket);
      });
    });
  });
}

const settle = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('a stray read on a pipe main has let go of', () => {
  it('is absorbed once, the socket is retired, and the process lives', async () => {
    const path = await flooding('absorb');
    const socket = await reader(path);

    const stray: Error[] = [];
    const fatal: Error[] = [];
    let retiredTotal = 0;

    /*
     * Vitest installs its own `uncaughtException` listener and fails the run on
     * anything it sees. Taking them off for the duration is what lets the real
     * exception reach the real guard; they go back in `finally`, including if an
     * assertion throws.
     */
    const prior = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    const uninstall = installStrayPipeGuard({
      handles: () => [socket],
      onStray: (err, retired) => {
        stray.push(err);
        retiredTotal += retired;
      },
      onFatal: (err) => fatal.push(err),
    });

    try {
      // The state, written directly: `destroyed` true while the handle keeps
      // reading. See the header for why this is the honest way to build it.
      (socket as unknown as { destroyed: boolean }).destroyed = true;

      // Long enough for many more reads to land after the first one. Without a
      // repair this is where the second, third and hundredth exception arrive.
      await settle(500);
    } finally {
      uninstall();
      for (const listener of prior) {
        process.on('uncaughtException', listener as (err: Error) => void);
      }
    }

    // It happened at all — otherwise the rest of this test proves nothing.
    expect(stray.length).toBeGreaterThan(0);
    expect(isStrayPipeRead(stray[0])).toBe(true);
    expect(stray[0]?.message).toMatch(/must be a negative integer/);

    // Once. The handle was retired, so the storm stopped rather than repeating
    // for every read still to come.
    expect(stray).toHaveLength(1);
    expect(retiredTotal).toBe(1);
    expect((socket as unknown as { _handle: unknown })._handle).toBeNull();

    // And nothing was mistaken for a fatal error along the way.
    expect(fatal).toEqual([]);
  });

  it('announces the closure so the owner takes its ordinary lost-link path', async () => {
    const path = await flooding('announce');
    const socket = await reader(path);

    const errors: Error[] = [];
    const closes: unknown[] = [];
    socket.on('error', (err) => errors.push(err));
    socket.on('close', (hadError) => closes.push(hadError));

    (socket as unknown as { destroyed: boolean }).destroyed = true;
    expect(retireStrayReaders([socket])).toBe(1);

    // The socket's own events, not a new mechanism: `SocketChannel` already
    // turns `close` into `die`, which `HostConnection` turns into `closed` and
    // `Fleet` turns into a reconnect plus a `shell-exit` per pane on that host.
    expect(errors.map((e) => e.message)).toEqual([STRAY_PIPE_REASON]);
    expect(closes).toEqual([true]);
  });

  it('leaves a healthy socket alone', async () => {
    const path = await flooding('healthy');
    const socket = await reader(path);

    expect(retireStrayReaders([socket])).toBe(0);
    expect((socket as unknown as { _handle: unknown })._handle).not.toBeNull();
    expect(socket.destroyed).toBe(false);
  });

  it('leaves a properly destroyed socket alone', async () => {
    const path = await flooding('destroyed');
    const socket = await reader(path);
    // The ordinary path: `_destroy` closed the handle and neutered `onread`,
    // so there is nothing here for the guard to find — which is precisely why
    // every ordinary close is not a stray read.
    socket.destroy();
    await settle(50);

    expect(retireStrayReaders([socket])).toBe(0);
  });
});

describe('what the guard refuses to answer for', () => {
  const strayLike = (): Error => {
    const err = new RangeError(
      'The value of "err" is out of range. It must be a negative integer. Received 4595',
    );
    (err as NodeJS.ErrnoException).code = 'ERR_OUT_OF_RANGE';
    err.stack = [
      `${err.name}: ${err.message}`,
      '    at Object.getSystemErrorName (node:util:454:11)',
      '    at new ErrnoException (node:internal/errors:733:23)',
      '    at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)',
    ].join('\n');
    return err;
  };

  it('recognises the real shape', () => {
    expect(isStrayPipeRead(strayLike())).toBe(true);
  });

  it('refuses the same code from anywhere else', () => {
    // `ERR_OUT_OF_RANGE` is one of Node's commonest argument errors, and a guard
    // keyed on the code alone would swallow a genuine bug in our own validation.
    const err = new RangeError('The value of "offset" is out of range. Received 12');
    (err as NodeJS.ErrnoException).code = 'ERR_OUT_OF_RANGE';
    err.stack = `${err.name}: ${err.message}\n    at putBlob (file:///app/main.js:1:1)`;
    expect(isStrayPipeRead(err)).toBe(false);
  });

  it('refuses another error raised from the same frame', () => {
    const err = new Error('socket hang up');
    (err as NodeJS.ErrnoException).code = 'ECONNRESET';
    err.stack = `${err.name}: ${err.message}\n    at Pipe.onStreamRead (node:internal/stream_base_commons:216:20)`;
    expect(isStrayPipeRead(err)).toBe(false);
  });

  it('sends everything it does not recognise to the fatal path', () => {
    const fatal: Error[] = [];
    const stray: Error[] = [];
    const target: NodeJS.EventEmitter = new EventEmitter();
    const uninstall = installStrayPipeGuard({
      target,
      handles: () => [],
      onStray: (err) => stray.push(err),
      onFatal: (err) => fatal.push(err),
    });

    const ordinary = new TypeError('undefined is not a function');
    target.emit('uncaughtException', ordinary);
    target.emit('uncaughtException', strayLike());
    uninstall();

    // Both directions in one test, because the property is the *split*: main
    // relies on `onFatal` still showing the error box Electron would have shown,
    // and installing any listener at all is what disabled Electron's own.
    expect(fatal).toEqual([ordinary]);
    expect(stray).toHaveLength(1);
  });
});
