/**
 * Driving `xwd` on the machine a session runs on (DESIGN.md §12.1, §3.3, §3.5).
 *
 * `spawn` is injected, and the dumps are the same builder the decoder's own tests
 * use — so a frame that comes out of this is one the real decoder read, not a
 * stub agreeing with a stub. What cannot be tested here is an actual X server,
 * and that boundary is named in the module: a real display, a real cookie and a
 * real GNOME session are things only the user's machine can answer for.
 *
 * What *is* tested is everything around it, which is where the behaviour lives:
 * a display that refuses the cookie is listed with a reason rather than dropped,
 * a listing stops after the header instead of moving twelve megabytes, a bad
 * display name is refused before a process is started, and a hung `xwd` is killed
 * rather than left holding the connection.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng } from '../src/main/content/png.js';
import {
  DisplayUnreachable,
  grabDisplay,
  listDisplays,
  NoDisplayTool,
  type Spawn,
} from '../src/host/display.js';
import { makeXwd } from './support/xwdDump.js';

const XWD = '/usr/bin/xwd';

interface Scripted {
  /** One buffer, or several, to make the early stop meet a real chunk boundary. */
  stdout?: Buffer | readonly Buffer[];
  stderr?: string;
  code?: number;
  /** Emits nothing and never closes, for the timeout path. */
  hang?: boolean;
}

/**
 * A machine with whatever X displays the test wants.
 *
 * Chunked rather than handed over whole, because the probe's early stop is a
 * reaction to a `data` event: a fake that emitted one buffer would let a broken
 * stop condition pass, since there would be nothing left to arrive after it.
 */
function fakeSpawn(reply: (args: readonly string[]) => Scripted): {
  run: Spawn;
  started: string[][];
  killed: string[];
} {
  const started: string[][] = [];
  const killed: string[] = [];

  const run = ((_command: string, args: readonly string[]) => {
    started.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let dead = false;
    child.kill = (signal?: string): boolean => {
      dead = true;
      killed.push(signal ?? 'SIGTERM');
      return true;
    };

    const script = reply(args);
    setImmediate(() => {
      if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr, 'utf8'));
      const out = script.stdout;
      if (out !== undefined) {
        for (const chunk of Buffer.isBuffer(out) ? [out] : out) {
          // A killed process stops writing, and the probe depends on that being
          // true of the fake as well.
          if (dead) return;
          child.stdout.emit('data', chunk);
        }
      }
      if (dead || script.hang === true) return;
      child.emit('close', script.code ?? 0);
    });

    return child;
  }) as unknown as Spawn;

  return { run, started, killed };
}

/** A dump in quarter-megabyte pieces, the way a real pipe delivers one. */
function chunked(dump: Buffer, size = 256 * 1024): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < dump.length; at += size) out.push(dump.subarray(at, at + size));
  return out;
}

/** A decodable screen of the given size, filled with one colour. */
function screen(width: number, height: number): Buffer {
  const row = new Array<number>(width).fill(0x3366cc);
  return makeXwd({
    width,
    height,
    bpp: 24,
    pixels: new Array<number[]>(height).fill(row),
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('listing the displays on a machine', () => {
  it('probes each one and reports what the header says', async () => {
    const one = screen(2944, 1080);
    const { run, started } = fakeSpawn((args) => {
      const display = args[args.indexOf('-display') + 1];
      return display === ':1'
        ? { stdout: chunked(one) }
        : {
            // What the probe actually met on the second display of a real
            // machine, verbatim in shape.
            stderr: 'xwd: error: Can\'t open display: :1001\nNo protocol specified',
            code: 1,
          };
    });

    const found = await listDisplays({
      run,
      tool: XWD,
      socketDir: dirWith(['X1', 'X1001']),
      env: undefined,
    });

    expect(found.tool).toBe(XWD);
    expect(found.displays.map((d) => d.display)).toEqual([':1', ':1001']);
    expect(found.displays[0]).toEqual({ display: ':1', width: 2944, height: 1080 });
    /*
     * Listed, with a reason. Dropping it would turn a cookie somebody can fix
     * into a display that simply is not there (§3.3), and offering it as if it
     * worked would be a control that fails on press (§3.5).
     */
    expect(found.displays[1]?.width).toBeUndefined();
    expect(found.displays[1]?.unreachable).toContain(':1001');
    // Two processes, one per display: no display is judged from the other's answer.
    expect(started).toHaveLength(2);
  });

  it('names XAUTHORITY when the display refuses the user', async () => {
    /*
     * The failure that will actually happen on somebody's machine, and `xwd:
     * unable to open display` on its own sends them looking at the wrong thing.
     * The variable to set is the whole content of the fix.
     */
    const { run } = fakeSpawn(() => ({
      stderr: 'Xlib: connection refused by server\nXlib: No protocol specified (MIT-MAGIC-COOKIE-1)',
      code: 1,
    }));

    const found = await listDisplays({ run, tool: XWD, socketDir: dirWith(['X1']) });
    expect(found.displays[0]?.unreachable).toMatch(/XAUTHORITY/u);
  });

  it('stops after the header instead of pulling the whole screen down', async () => {
    /*
     * The listing's cost is the reason `readXwdHeader` exists. A 2944×1080 dump
     * is 12.7MB, and paying that per display to populate a dropdown would make
     * the list slower than the view it introduces.
     */
    const one = screen(2944, 1080);
    expect(one.length).toBeGreaterThan(9_000_000);
    const { run, killed } = fakeSpawn(() => ({ stdout: chunked(one) }));

    const found = await listDisplays({ run, tool: XWD, socketDir: dirWith(['X1']) });

    expect(found.displays[0]?.width).toBe(2944);
    // Killed, and killed hard: a probe that left an `xwd` running per refresh
    // would pile up processes on a machine somebody is working on.
    expect(killed).toEqual(['SIGKILL']);
  });

  it('lists the displays it cannot read yet, when the tool is missing', async () => {
    /*
     * §3.3, in the one place it matters most here. There *is* a screen on that
     * machine; what is missing is one `apt install x11-apps`. An empty list would
     * say "no screen", which is a different and wrong answer — and it would send
     * somebody looking at their X server instead of at the host.
     */
    const found = await listDisplays({ tool: null, socketDir: dirWith(['X0', 'X1']) });

    expect(found.tool).toBeNull();
    expect(found.displays).toEqual([{ display: ':0' }, { display: ':1' }]);
  });

  it('says nothing rather than failing on a machine with no X at all', async () => {
    // The ordinary state of a headless server, and not a fault to report.
    const found = await listDisplays({ tool: XWD, socketDir: '/definitely/not/here', env: undefined });
    expect(found.displays).toEqual([]);
  });

  it('takes a display from the environment that no socket lists', async () => {
    /*
     * A socket listing is not the whole truth: an X server reached over TCP, or
     * one whose socket lives elsewhere, appears only in `DISPLAY`.
     */
    const { run } = fakeSpawn(() => ({ stdout: chunked(screen(64, 48)) }));

    const extra = await listDisplays({ run, tool: XWD, socketDir: dirWith(['X1']), env: ':7' });
    expect(extra.displays.map((d) => d.display)).toEqual([':1', ':7']);

    // And `:1.0` is `:1` written with a screen number, not a second display.
    const same = await listDisplays({ run, tool: XWD, socketDir: dirWith(['X1']), env: ':1.0' });
    expect(same.displays.map((d) => d.display)).toEqual([':1']);
  });
});

describe('one frame', () => {
  it('turns a dump into a PNG, and says what the far screen really is', async () => {
    const { run, started } = fakeSpawn(() => ({ stdout: chunked(screen(800, 600)) }));

    const frame = await grabDisplay(':1', { run, tool: XWD, maxEdge: 1600 });

    expect(started[0]).toEqual(['-root', '-display', ':1', '-silent']);
    // Decoded by the codec next door, which is the claim: an X grab becomes an
    // image this app can already show, with nothing installed over there.
    const image = decodePng(frame.png);
    expect([image.width, image.height]).toEqual([800, 600]);
    expect([frame.sourceWidth, frame.sourceHeight]).toEqual([800, 600]);
    // The colour survived the whole path, which a frame of the right size and
    // the wrong bytes would not show.
    expect([...image.rgba.subarray(0, 4)]).toEqual([0x33, 0x66, 0xcc, 255]);
    expect(frame.tookMs).toBeGreaterThanOrEqual(0);
  });

  it('scales down before encoding, and reports both sizes', async () => {
    /*
     * The saving that makes this a live view. A full-size frame of the real
     * machine is 430KB of PNG; the same screen at 400px is a fraction of that,
     * and still shows what is on it. Both sizes travel because a viewer that
     * cannot say the screen is 2944 wide looks like it is showing a small one.
     */
    const { run } = fakeSpawn(() => ({ stdout: chunked(screen(2000, 1000)) }));

    const frame = await grabDisplay(':1', { run, tool: XWD, maxEdge: 400 });

    expect([frame.width, frame.height]).toEqual([400, 200]);
    expect([frame.sourceWidth, frame.sourceHeight]).toEqual([2000, 1000]);
    const image = decodePng(frame.png);
    expect([image.width, image.height]).toEqual([400, 200]);
  });

  it('refuses a name that is not a display, before starting anything', async () => {
    /*
     * Judged first, and the ordering is the lesson rather than the check. Twice
     * in this repository a validator ran *after* the thing it was guarding —
     * `writeProjectServer` and `readSkill` both reported a legal-sounding failure
     * about disk for an input that was never legal — so the assertion here is
     * that no process was started, not merely that it threw.
     */
    const { run, started } = fakeSpawn(() => ({ stdout: Buffer.alloc(0) }));

    await expect(grabDisplay('; rm -rf /', { run, tool: XWD })).rejects.toThrow(/not an X display/u);
    await expect(grabDisplay('-help', { run, tool: XWD })).rejects.toThrow(/not an X display/u);
    expect(started).toEqual([]);
  });

  it('says the tool is missing, and what to install', async () => {
    await expect(grabDisplay(':1', { tool: null })).rejects.toThrow(NoDisplayTool);
    await expect(grabDisplay(':1', { tool: null })).rejects.toThrow(/x11-apps/u);
  });

  it('says nothing is listening, rather than repeating xwd at somebody', async () => {
    const { run } = fakeSpawn(() => ({ stderr: 'xwd: unable to open display ":9"', code: 1 }));

    await expect(grabDisplay(':9', { run, tool: XWD })).rejects.toThrow(
      /nothing is listening on :9/u,
    );
  });

  it('refuses a dump too large to be a screen', async () => {
    /*
     * A ceiling so a display that reports nonsense cannot exhaust the host. The
     * same megabyte is emitted over and over rather than allocating the whole
     * thing — the point is that the limit is reached, not that a test can hold it.
     */
    const megabyte = Buffer.alloc(1024 * 1024);
    const { run, killed } = fakeSpawn(() => ({
      stdout: new Array<Buffer>(140).fill(megabyte),
    }));

    await expect(grabDisplay(':1', { run, tool: XWD })).rejects.toThrow(/not a screen/u);
    expect(killed).toEqual(['SIGKILL']);
  });

  it('kills a grab that never comes back', async () => {
    /*
     * An `xwd` stuck inside a request to a wedged X server, which is exactly what
     * happens on a machine whose GPU driver has fallen over. Without this the
     * viewer's request sits on the session connection forever.
     */
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { run, killed } = fakeSpawn(() => ({ hang: true }));

    const pending = grabDisplay(':1', { run, tool: XWD });
    const asserted = expect(pending).rejects.toThrow(DisplayUnreachable);
    await vi.advanceTimersByTimeAsync(20_000);
    await asserted;

    expect(killed).toEqual(['SIGKILL']);
  });
});

/**
 * A directory holding the named X sockets.
 *
 * Real files rather than a mocked `readdir`: the listing's whole job is to read
 * what is on a machine, and a mock would pin the call instead of the answer.
 */
function dirWith(names: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agbrte-x11-'));
  for (const name of names) writeFileSync(join(dir, name), '');
  return dir;
}
