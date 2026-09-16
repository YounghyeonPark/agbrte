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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng, encodePng } from '../src/main/content/png.js';
import {
  approveDisplay,
  closeHeldCast,
  DisplayUnreachable,
  grabDisplay,
  listDisplays,
  NeedsApproval,
  NoDisplayTool,
  waylandRow,
  waylandSockets,
  type Spawn,
} from '../src/host/display.js';
import { WAYLAND_DISPLAY } from '../src/shared/types/display.js';
import { makeXwd } from './support/xwdDump.js';

const XWD = '/usr/bin/xwd';

interface Scripted {
  /** One buffer, or several, to make the early stop meet a real chunk boundary. */
  stdout?: Buffer | readonly Buffer[];
  stderr?: string;
  code?: number;
  /** Emits nothing and never closes, for the timeout path. */
  hang?: boolean;
  /**
   * Answers and then stays running, which is what the portal helper does.
   *
   * Different from `hang`: the helper prints its one line of JSON and only then
   * holds the session open, because letting it exit would close the bus
   * connection the portal session belongs to and the stream would vanish.
   */
  hold?: boolean;
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
      if (dead || script.hang === true || script.hold === true) return;
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
  /*
   * The held portal session is module state, and that is the point of it — one
   * cast reused across frames rather than three round trips per frame. Module
   * state is also how one test's cast becomes the next test's mysterious pass,
   * so every test starts with none.
   */
  closeHeldCast();
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

describe('a compositor this cannot see', () => {
  /*
   * The gap the feature shipped with, and the shape it used to take: a Wayland
   * machine gave a black rectangle and said nothing, which is a picture of
   * nothing with nothing explaining it — the worst outcome a viewer has, and the
   * one every other field in this module is arranged to avoid.
   *
   * Found on the filesystem rather than in the environment, deliberately. This
   * host is usually started from a non-login shell over ssh and inherits almost
   * none of a desktop session's variables, so `XDG_SESSION_TYPE` is normally
   * simply absent — while a socket under `/run/user/<uid>/` is there whether or
   * not anybody told this process about it.
   */
  it('finds a compositor by its socket, whatever the environment says', async () => {
    const run = mkdtempSync(join(tmpdir(), 'agbrte-run-'));
    mkdirSync(join(run, '1000'));
    writeFileSync(join(run, '1000', 'wayland-0'), '');
    // Beside files that are not it, because `/run/user/<uid>` is full of things.
    writeFileSync(join(run, '1000', 'bus'), '');
    writeFileSync(join(run, '1000', 'pulse'), '');

    expect(await waylandSockets(run, {})).toEqual(['1000/wayland-0']);
  });

  it('reads the environment only when the sockets said nothing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'agbrte-run-'));
    expect(await waylandSockets(empty, { XDG_SESSION_TYPE: 'wayland' })).toEqual([
      'XDG_SESSION_TYPE=wayland',
    ]);
    expect(await waylandSockets(empty, { WAYLAND_DISPLAY: 'wayland-1' })).toEqual([
      'WAYLAND_DISPLAY=wayland-1',
    ]);
    // An X session that happens to have the variable set to nothing is not one.
    expect(await waylandSockets(empty, { XDG_SESSION_TYPE: 'x11', WAYLAND_DISPLAY: '' })).toEqual(
      [],
    );
  });

  it('says nothing rather than guessing when it cannot look', async () => {
    // `/run/user/<uid>` is frequently unreadable by anybody but its owner, and
    // that is not a fault — it means no answer about that user, not no Wayland.
    // §3.3 in its plainest form: an unknown must not render as a `no`.
    expect(await waylandSockets('/definitely/not/here', {})).toEqual([]);
  });

  it('carries the caution beside the displays, and still lists them', async () => {
    /*
     * A caution, never a refusal. Some compositors do put something on the
     * XWayland root, this host cannot know which, and hiding the displays on a
     * guess would withhold a view that might have worked.
     */
    const run = mkdtempSync(join(tmpdir(), 'agbrte-run-'));
    mkdirSync(join(run, '1000'));
    writeFileSync(join(run, '1000', 'wayland-0'), '');
    const { run: spawnFake } = fakeSpawn(() => ({ stdout: chunked(screen(1920, 1080)) }));

    const found = await listDisplays({
      run: spawnFake,
      tool: XWD,
      socketDir: dirWith(['X1']),
      runtimeDir: run,
      /*
       * `null` is "do not offer the portal row", which is what this test is
       * about: the caution beside the **X** displays. Passed rather than left to
       * default for a second reason worth stating — the default probes this
       * machine for `python3` and reads `~/.agbrte`, so a test that omitted it
       * would be asserting against whatever the developer's laptop happens to
       * have installed.
       */
      portal: null,
    });

    expect(found.wayland).toEqual(['1000/wayland-0']);
    expect(found.displays[0]).toEqual({ display: ':1', width: 1920, height: 1080 });
  });

  it('leaves the field off entirely on an X machine', async () => {
    // Absent rather than an empty array: a client checking `!== undefined` is the
    // shape this reads best in, and "we looked and found none" is exactly what an
    // absent optional says here.
    const { run } = fakeSpawn(() => ({ stdout: chunked(screen(64, 48)) }));
    const found = await listDisplays({
      run,
      tool: XWD,
      socketDir: dirWith(['X1']),
      runtimeDir: mkdtempSync(join(tmpdir(), 'agbrte-run-')),
    });
    expect(found.wayland).toBeUndefined();
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

/**
 * The Wayland half (§12.1, v38).
 *
 * `xwd` reads an X display, and under a compositor that is XWayland — whose root
 * window is not the output, so the frame comes back black while the desktop is
 * plainly on the monitor. These cover the route that asks the compositor itself.
 *
 * Both processes are faked, and they are told apart by their first argument:
 * python is invoked as `-c <script>` and GStreamer as `-q <pipeline>`. Nothing
 * here talks to a real portal — that half was measured by hand against a live
 * GNOME 46 machine, and `docs/status.md` records exactly how far it got.
 */
describe('the desktop, through the portal', () => {
  const TOOLS = {
    python: '/usr/bin/python3',
    gst: '/usr/bin/gst-launch-1.0',
    bus: 'unix:path=/run/user/1000/bus',
  };
  const AGREED = `${JSON.stringify({ ok: true, node: 42, restoreToken: 'tok', session: '/s' })}\n`;

  /** A real PNG, because the frame path reads its header for the size. */
  function png(width: number, height: number): Buffer {
    return encodePng({ width, height, rgba: Buffer.alloc(width * height * 4, 0x40) });
  }

  /** A machine with a portal that agrees and a pipeline that produces a frame. */
  function portalMachine(frame: Buffer): ReturnType<typeof fakeSpawn> {
    return fakeSpawn((args) =>
      args[0] === '-c' ? { stdout: Buffer.from(AGREED, 'utf8'), hold: true } : { stdout: frame },
    );
  }

  /** A `/run/user/<uid>/wayland-0`, which is how a compositor is found at all. */
  function runtimeWithCompositor(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-run-'));
    mkdirSync(join(dir, '1000'));
    writeFileSync(join(dir, '1000', 'wayland-0'), '');
    return dir;
  }

  it('names the package for each thing that is missing, and never goes quiet', () => {
    /*
     * Every branch produces a row. That is the invariant under test rather than
     * any one sentence: a machine running a compositor has a screen, and a list
     * that omitted it would answer "there is no screen over there" (§3.3) to
     * somebody looking straight at one.
     */
    expect(waylandRow({ tools: { ...TOOLS, python: null }, token: undefined })).toMatchObject({
      display: WAYLAND_DISPLAY,
      unreachable: expect.stringContaining('python3'),
    });
    expect(waylandRow({ tools: { ...TOOLS, bus: null }, token: undefined })).toMatchObject({
      unreachable: expect.stringContaining('session bus'),
    });
    expect(waylandRow({ tools: { ...TOOLS, gst: null }, token: undefined })).toMatchObject({
      unreachable: expect.stringContaining('gstreamer1.0-tools'),
    });
  });

  it('separates "nobody has said yes yet" from "this cannot work"', () => {
    /*
     * The distinction that needed a third field. A row waiting for consent is one
     * click from working on that machine's own monitor; a row that is unreachable
     * is a problem to go and fix. §4.1 is about this exact pair — a pause and a
     * failure must never blur — and collapsing them would be wrong in whichever
     * direction it was done: as ready it is a control that fails on press (§3.5),
     * as unreachable it is a `no` about a machine that works.
     */
    const waiting = waylandRow({ tools: TOOLS, token: undefined });
    expect(waiting.unreachable).toBeUndefined();
    expect(waiting.needsApproval).toContain('remembered');

    const approved = waylandRow({ tools: TOOLS, token: 'tok' });
    expect(approved.unreachable).toBeUndefined();
    expect(approved.needsApproval).toBeUndefined();
    // And no size, because the portal does not report one until a frame arrives.
    // A guess here would be a number on screen that nothing had checked.
    expect(approved.width).toBeUndefined();
  });

  it('puts the desktop first, ahead of the XWayland displays beside it', async () => {
    /*
     * The order is load-bearing rather than cosmetic. The viewer opens on the
     * first row it can read, and on a Wayland machine every X row beside this one
     * is XWayland — so the wrong order lands somebody on a black rectangle while
     * the working view sits one entry below it.
     */
    const { run } = fakeSpawn(() => ({ stdout: chunked(screen(1920, 1080)) }));
    const found = await listDisplays({
      run,
      tool: XWD,
      socketDir: dirWith(['X1']),
      runtimeDir: runtimeWithCompositor(),
      portal: { tools: TOOLS, token: 'tok' },
    });

    expect(found.displays.map((d) => d.display)).toEqual([WAYLAND_DISPLAY, ':1']);
  });

  it('offers no portal row on a machine with no compositor on it', async () => {
    // Offering one would be a control that fails on press (§3.5): there is
    // nothing on that machine for the portal to be a portal to.
    const { run } = fakeSpawn(() => ({ stdout: chunked(screen(64, 48)) }));
    const found = await listDisplays({
      run,
      tool: XWD,
      socketDir: dirWith(['X1']),
      runtimeDir: mkdtempSync(join(tmpdir(), 'agbrte-run-')),
    });

    expect(found.displays.map((d) => d.display)).toEqual([':1']);
    expect(found.wayland).toBeUndefined();
  });

  it('refuses to grab before anybody has approved, and says so as a question', async () => {
    const { run, started } = portalMachine(png(64, 48));
    await expect(
      grabDisplay(WAYLAND_DISPLAY, { run, portal: { tools: TOOLS, token: undefined } }),
    ).rejects.toThrow(NeedsApproval);
    // And nothing was spawned. A grab that opened a cast first would put a dialog
    // on somebody's monitor as the *side effect* of a refusal.
    expect(started).toEqual([]);
  });

  it('reads a frame, and keeps the source size rather than the scaled one', async () => {
    const { run } = portalMachine(png(2000, 1000));
    const frame = await grabDisplay(WAYLAND_DISPLAY, {
      run,
      maxEdge: 500,
      portal: { tools: TOOLS, token: 'tok' },
    });

    expect(frame.display).toBe(WAYLAND_DISPLAY);
    expect(frame.sourceWidth).toBe(2000);
    expect(frame.sourceHeight).toBe(1000);
    // Scaled to fit, and the picture says what it actually is — the pane shows
    // both, because a 500px frame of a 2000px desktop otherwise reads as a small
    // monitor.
    expect(frame.width).toBe(500);
    expect(decodePng(frame.png).width).toBe(500);
  });

  it('does not decode a frame that is already small enough', async () => {
    /*
     * A screen already within the size asked for comes back untouched — the same
     * bytes, not a re-encode of the same picture.
     *
     * Worth knowing what this does and does not pin down. A revert-check found it
     * still green with `grabWayland`'s own size check removed, because
     * `scaleToFit` independently returns its argument when nothing needed
     * scaling. So this is a test of the *behaviour*, which two mechanisms
     * currently guarantee, and not a test of either one of them.
     *
     * The check in `grabWayland` earns its place anyway, and it is not the one
     * this measures: `scaleToFit` decodes the PNG before discovering it had
     * nothing to do, and skipping that is a decode per frame on the far machine.
     * Nothing observable from out here distinguishes the two, which is why there
     * is no assertion for it rather than a contrived one.
     */
    const original = png(400, 300);
    const { run } = portalMachine(original);
    const frame = await grabDisplay(WAYLAND_DISPLAY, {
      run,
      maxEdge: 800,
      portal: { tools: TOOLS, token: 'tok' },
    });

    expect(frame.png.equals(original)).toBe(true);
    expect(frame.width).toBe(400);
  });

  it('holds one cast across frames, because opening one is most of a second', async () => {
    /*
     * Three round trips to the portal and a PipeWire node being set up, per
     * frame, would put this under one frame a second — slower than the X path it
     * exists to beat. So the session is held between pulls, and what proves it is
     * that the second frame spawns only the pipeline.
     */
    const machine = portalMachine(png(64, 48));
    const opts = { run: machine.run, portal: { tools: TOOLS, token: 'tok' } };

    await grabDisplay(WAYLAND_DISPLAY, opts);
    await grabDisplay(WAYLAND_DISPLAY, opts);

    expect(machine.started.filter((args) => args[0] === '-c')).toHaveLength(1);
    expect(machine.started.filter((args) => args[0] === '-q')).toHaveLength(2);
  });

  it('lets go of the cast when a frame fails, so the next grab can recover', async () => {
    /*
     * A node that stops answering is usually a session the compositor ended — the
     * person revoked it, the screen locked, the monitor changed. Holding the dead
     * handle would make every later grab fail with the same stale error, and the
     * view would never come back without restarting the app.
     */
    let pipelines = 0;
    const machine = fakeSpawn((args) => {
      if (args[0] === '-c') return { stdout: Buffer.from(AGREED, 'utf8'), hold: true };
      pipelines += 1;
      return pipelines === 1
        ? { stderr: 'ERROR: could not link pipewiresrc', code: 1 }
        : { stdout: png(64, 48) };
    });
    const opts = { run: machine.run, portal: { tools: TOOLS, token: 'tok' } };

    await expect(grabDisplay(WAYLAND_DISPLAY, opts)).rejects.toThrow(/pipewiresrc/u);
    await expect(grabDisplay(WAYLAND_DISPLAY, opts)).resolves.toMatchObject({ width: 64 });

    // Two helpers, because the first cast was dropped rather than reused.
    expect(machine.started.filter((args) => args[0] === '-c')).toHaveLength(2);
  });

  it('keeps the approval and does not leave a screencast running to get it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-approve-'));
    const file = join(dir, 'screencast.json');
    const { run, killed } = portalMachine(png(64, 48));

    expect(await approveDisplay({ run, tools: TOOLS, file })).toEqual({ remembered: true });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ restoreToken: 'tok' });
    /*
     * Closed immediately. What is wanted from this step is the token, not a
     * frame, and a session left open would leave a screencast indicator lit on
     * somebody's desktop for as long as the app was running — precisely the
     * impression this feature must not give.
     */
    expect(killed).toEqual(['SIGKILL']);
  });

  it('says when a machine agrees but will not remember, which is not a success', async () => {
    /*
     * A portal is allowed to honour a screencast request and hand back no
     * `restore_token`. The result is a dialog on that monitor for *every frame*,
     * which is not a view — and somebody who learns that by watching it happen
     * concludes the app is broken rather than that their portal is old.
     */
    const forgetful = `${JSON.stringify({ ok: true, node: 42, session: '/s' })}\n`;
    const { run } = fakeSpawn((args) =>
      args[0] === '-c'
        ? { stdout: Buffer.from(forgetful, 'utf8'), hold: true }
        : { stdout: png(8, 8) },
    );
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-approve-'));
    const file = join(dir, 'screencast.json');

    expect(await approveDisplay({ run, tools: TOOLS, file })).toEqual({ remembered: false });
    // And nothing was written, so the row still says it needs permission rather
    // than claiming an approval that would not survive the next frame.
    expect(existsSync(file)).toBe(false);
  });
});
