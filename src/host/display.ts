/**
 * The screen of the machine a session runs on (DESIGN.md §12.1, §6.8, §3.3).
 *
 * §12.1 lists three kinds of capture and builds two. Client capture sends *your*
 * screen to a model; remote capture takes a headless browser screenshot of a URL
 * the agent serves. The third — "remote display grab where a real or virtual
 * display exists" — was written down and left unbuilt, and this is it.
 *
 * ## The question it answers, which the other two do not
 *
 * An agent working on a remote machine starts something with a window in it. Not
 * a dev server — a window: an installer, a GUI test, an app it just built. §6.8
 * forwards a port, which reaches a *listener*; §12.1's browser capture reaches a
 * *URL*. Neither reaches a window that is simply open on that machine's desktop,
 * and until now the honest answer to "show me what is on the screen over there"
 * was to install a VNC server.
 *
 * VNC is still the better answer for anything interactive, and nothing here
 * pretends otherwise: there is no input, no clipboard and no cursor. This is a
 * window that shows the far screen, refreshed a few times a second, for the case
 * where you want to *see* what happened and not to *drive* it.
 *
 * ## Why `xwd`, which is a strange choice everywhere else
 *
 * Measured, not assumed. A probe of the machine this was built for — Ubuntu
 * 24.04, a GNOME session logged in on vt2 for six weeks — found:
 *
 * - no ImageMagick (`import`, `convert`), no `scrot`, no `gnome-screenshot`
 * - no `ffmpeg`, no `x11vnc`, no `vncserver`, no `Xvfb`
 * - GNOME's own D-Bus `Screenshot` method refusing: *"Screenshot is not
 *   allowed"*, which is GNOME keeping that API for portal callers
 * - `xwd`, present, working, part of `x11-apps`
 *
 * So `xwd` is not a preference. It is the one thing that was there, and the whole
 * point of this path is that it needs nothing installed on the far machine.
 *
 * ## What it costs, and why this is a few frames a second and not video
 *
 * On that machine, at 2944×1080 and 24bpp: `xwd` takes **0.13s** and produces
 * **12.7MB**; decoding is 0.01s; encoding a PNG is 0.16s for 430KB. So a frame
 * costs about 0.3s of CPU, and `xwd` has **no damage tracking** — every frame is
 * the whole screen, whether or not anything moved.
 *
 * That sets a hard ceiling of roughly three to five frames a second, and it is
 * why nothing here is called video. Encoding H.264 would need an encoder this
 * project does not have and will not add for one feature; a codec of our own
 * would be a large amount of subtle code to make the ceiling slightly higher.
 * The frames are scaled down before they are encoded, which is where the real
 * saving is: a 1600px-wide frame is a fraction of the bytes and still shows what
 * is on the screen.
 *
 * `tookMs` travels with every frame for the same reason the size does — the frame
 * rate is a property of the far machine, and a viewer that cannot say what it is
 * getting invites the reading that something is broken.
 *
 * ## It is a read, and it is not a tool
 *
 * No §13 permission gate, for `files.list`'s reason: there is no model on this
 * path. This is a person with a window open on a machine they are already running
 * a session on, and prompting them to approve their own click is the theatre §13
 * warns about. Nothing here is written to the log, stored as a blob, or attached
 * to a turn — a frame is rendered and dropped.
 *
 * That is also why there is deliberately **no agent tool** for it. Handing a
 * model the whole screen of somebody's workstation is a different decision from
 * showing it to the person sitting there, and it would have to go through the
 * gate with its own name on it. Until somebody asks for that, this is a viewer.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { encodePng } from '@main/content/png.js';
import { scaleRawToFit, scaleToFit, sizeOf } from '@main/content/pixels.js';
import { decodeXwd, readXwdHeader, UnsupportedXwd } from '@main/content/xwd.js';
import { WAYLAND_DISPLAY, type DisplayFrame, type DisplayInfo, type Displays } from '@shared/types/index.js';
import {
  frameFrom,
  openCast,
  portalTools,
  readToken,
  tokenFile,
  writeToken,
  type PortalStream,
  type PortalTools,
} from './portalCapture.js';

export class NoDisplayTool extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoDisplayTool';
  }
}

/**
 * The far machine has a screen and nobody has said yes to it yet.
 *
 * Its own class rather than a `DisplayUnreachable` with a friendlier sentence,
 * because the two mean opposite things to whoever is reading: unreachable is a
 * problem to go and fix, and this is a question waiting for an answer. §4.1 is
 * about exactly this pair — a pause and a failure must never blur.
 */
export class NeedsApproval extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NeedsApproval';
  }
}

export class DisplayUnreachable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DisplayUnreachable';
  }
}

/**
 * One frame, as the host holds it.
 *
 * `DisplayFrame` in `shared/types` is the same record with the PNG base64'd,
 * because that is what a JSON protocol can carry. Kept as two types rather than
 * one with a union-typed field: a `Buffer | string` here would compile on every
 * path that forgot to encode, and the one that matters — the reply — would send
 * `{"type":"Buffer","data":[…]}` to a renderer expecting a data URL.
 */
export interface DisplayGrab extends Omit<DisplayFrame, 'png'> {
  png: Buffer;
}

/**
 * Where `xwd` is, checked by existence.
 *
 * By existence and never by running it with a flag, which is `findBrowser`'s
 * lesson written down twice: a probe that executes the candidate can hang, and
 * `xwd` has no `--version` to hang on — given no arguments it waits for a click
 * on a window, forever. Asking the filesystem is also the question being asked.
 */
const TOOLS: readonly string[] = [
  '/usr/bin/xwd',
  '/usr/X11R6/bin/xwd',
  // XQuartz, for a Mac with X11 on it. Unlikely and cheap to include.
  '/opt/X11/bin/xwd',
];

/** Where X puts its sockets, and therefore where the displays are listed. */
const X11_SOCKETS = '/tmp/.X11-unix';

/**
 * Where a Wayland compositor puts its socket, one directory per user.
 *
 * Checked because of what `xwd` cannot see. Under a Wayland session the X server
 * a client meets is **XWayland**, and its root window is not the compositor's
 * output: grabbing it returns a black or stale rectangle while the desktop is
 * plainly there on the monitor. That is the worst shape a failure can take here —
 * a picture, of nothing, with nothing saying why — and it is exactly what the
 * rest of this module spends its length avoiding.
 *
 * A filesystem fact rather than an environment variable, for the reason the X
 * displays are found the same way: this host is frequently started from a
 * non-login shell over ssh and inherits almost none of a desktop session's
 * environment, so `XDG_SESSION_TYPE` is usually simply absent. A socket in
 * `/run/user/<uid>/` is there whether or not anybody told this process about it.
 */
const WAYLAND_SOCKETS = '/run/user';

/**
 * A hundred bytes is the fixed header, and a little slack covers the window name.
 *
 * The listing stops here rather than reading the frame: a display's size and
 * whether it can be opened at all are both in the header, so paying twelve
 * megabytes per display to find out would make the list cost more than the view.
 */
const PROBE_BYTES = 256;

/**
 * A ceiling on one dump, so a display that reports nonsense cannot exhaust the
 * host.
 *
 * 128MB is chosen against the largest real case rather than as a round number: a
 * pair of 4K monitors side by side at 32bpp is 66MB, and this leaves room above
 * it. Beyond that is not a screen, it is a header that lied.
 */
const MAX_DUMP = 128 * 1024 * 1024;

/** The header arrives at once, so a probe that stalls has nothing to wait for. */
const PROBE_TIMEOUT_MS = 8_000;
/**
 * A grab, against the 0.13s the real machine measured.
 *
 * Twenty seconds is a wide margin on purpose. The thing being waited for is an X
 * server under whatever load the agent has put the machine under, and a frame
 * that arrives late is better than a live view that gives up on a busy box.
 */
const GRAB_TIMEOUT_MS = 20_000;

/** What the viewer gets unless it asks for less. */
export const DEFAULT_MAX_EDGE = 1600;

/** Injectable so the tests can make a machine that has an X display on it. */
export type Spawn = typeof spawn;

interface Collected {
  stdout: Buffer;
  stderr: string;
  /** True when the byte budget was reached and the process was stopped early. */
  stopped: boolean;
  code: number | null;
}

function collect(
  run: Spawn,
  command: string,
  args: readonly string[],
  opts: { timeoutMs: number; stopAfter?: number },
): Promise<Collected> {
  return new Promise<Collected>((resolve, reject) => {
    let child: ReturnType<Spawn>;
    try {
      child = run(command, [...args], { windowsHide: true });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let stopped = false;
    let done = false;

    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      // SIGKILL rather than SIGTERM: a stuck `xwd` is stuck inside a request to
      // the X server, and leaving one behind on every timeout would accumulate
      // processes on a machine somebody is working on.
      child.kill('SIGKILL');
      settle(() =>
        reject(new DisplayUnreachable(`${command} did not finish within ${opts.timeoutMs}ms`)),
      );
    }, opts.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (opts.stopAfter !== undefined && size >= opts.stopAfter) {
        stopped = true;
        child.kill('SIGKILL');
        settle(() => resolve({ stdout: Buffer.concat(chunks), stderr, stopped, code: null }));
        return;
      }
      if (size > MAX_DUMP) {
        child.kill('SIGKILL');
        settle(() =>
          reject(
            new DisplayUnreachable(
              `${command} produced more than ${Math.round(MAX_DUMP / 1024 / 1024)}MB, ` +
                `which is not a screen`,
            ),
          ),
        );
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      settle(() => reject(err));
    });
    child.on('close', (code) => {
      settle(() => resolve({ stdout: Buffer.concat(chunks), stderr, stopped, code }));
    });
  });
}

/**
 * Turn a failure into something somebody can act on.
 *
 * The two that actually happen are worth recognising by name. A cookie this user
 * does not hold is the common one — the probe met it on a second display on the
 * same machine — and `xwd: unable to open display` says nothing about `XAUTHORITY`
 * being the thing to set.
 *
 * What this deliberately does *not* do is go looking for the cookie itself. The
 * candidate list would be a guess (`~/.Xauthority`, a GDM path, a systemd user
 * path that differs by distribution), the machine this was built against needed
 * none of it, and code that tries three locations it has never been tested
 * against is code that reports the wrong reason when all three fail. Naming the
 * variable is a fix somebody can apply; guessing at it is one this cannot verify.
 */
function explain(display: string, stderr: string, code: number | null): string {
  const said = stderr.trim().split('\n').at(-1)?.trim() ?? '';
  if (/authoriz|MIT-MAGIC/iu.test(said)) {
    return (
      `${display} did not authorise this user. The host needs that display's X cookie: ` +
      `set XAUTHORITY for it (a GNOME login keeps one under /run/user/<uid>/gdm/Xauthority).`
    );
  }
  if (/open display/iu.test(said)) return `nothing is listening on ${display}`;
  if (said !== '') return `${display}: ${said}`;
  return `xwd on ${display} exited ${code === null ? 'without a code' : String(code)}`;
}

/** A display name from a client, judged before it becomes an argument. */
function checkName(display: string): void {
  // Positional after `-display`, so a shell is not in play and this is not about
  // injection. It is about `xwd` being handed something that makes it do a
  // different job — and about a typo coming back as an X error rather than as
  // the answer to what was actually wrong.
  if (!/^:\d{1,5}(\.\d{1,3})?$/u.test(display)) {
    throw new Error(`${JSON.stringify(display)} is not an X display name, which looks like ":1"`);
  }
}

/**
 * Whether a Wayland compositor is running on this machine, and for whom.
 *
 * Returns the socket names found, which is more useful than a boolean: a box
 * with `wayland-0` under two different uids is a box where the display somebody
 * means may not be the one this host can reach at all.
 *
 * The environment is consulted too, and second. It is the weaker signal here —
 * usually absent — but it is the only one that survives a compositor whose
 * socket lives somewhere this cannot read.
 */
export async function waylandSockets(
  dir: string,
  env: { XDG_SESSION_TYPE?: string | undefined; WAYLAND_DISPLAY?: string | undefined } = {},
): Promise<string[]> {
  const found: string[] = [];
  try {
    for (const user of await readdir(dir)) {
      // `/run/user/<uid>` is per-user and frequently unreadable by anybody else,
      // which is not a fault: it means no answer about that user, not no Wayland.
      try {
        for (const name of await readdir(`${dir}/${user}`)) {
          if (/^wayland-\d+$/u.test(name)) found.push(`${user}/${name}`);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // No `/run/user` at all: not a systemd machine, or not Linux.
  }

  if (found.length === 0) {
    const typed = env.XDG_SESSION_TYPE?.trim().toLowerCase();
    const named = env.WAYLAND_DISPLAY?.trim();
    if (typed === 'wayland') found.push('XDG_SESSION_TYPE=wayland');
    else if (named !== undefined && named !== '') found.push(`WAYLAND_DISPLAY=${named}`);
  }
  return found;
}

async function socketDisplays(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => /^X\d+$/u.test(name))
      .map((name) => Number(name.slice(1)))
      .sort((a, b) => a - b)
      .map((n) => `:${n}`);
  } catch {
    // No directory means no X on this machine, which is the ordinary state of a
    // headless server and not an error to report (§3.3).
    return [];
  }
}

/** The `xwd` on this machine, or `null`. */
export function findDisplayTool(candidates: readonly string[] = TOOLS): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

/**
 * What this host knows about the portal route, gathered once per listing.
 *
 * `null` means "do not ask", which the tests use and which is also what a machine
 * with no compositor gets: there is nothing to offer and no row to add.
 */
export interface PortalSide {
  tools: PortalTools;
  /** The approval this machine already holds, where somebody has given one. */
  token: string | undefined;
}

/**
 * The Wayland screen, as a row in the same list as the X displays.
 *
 * Every branch here produces a row. None of them produces *silence*, which is
 * the failure this whole module is arranged against: a machine running a
 * compositor has a screen, and a list that simply omitted it would answer "there
 * is no screen over there" (§3.3) to somebody looking straight at one.
 *
 * The order of the checks is the order somebody has to fix them in, and each
 * names the package rather than the symptom. `python3-gi` is not checked here —
 * it is inside python, so asking would mean running python, and a missing binding
 * is reported by the helper's own first line when a grab is actually attempted.
 */
export function waylandRow(portal: PortalSide): DisplayInfo {
  if (portal.tools.python === null) {
    return {
      display: WAYLAND_DISPLAY,
      unreachable:
        'that machine runs Wayland, and its screen can only be read through the desktop ' +
        'portal — which needs python3 on it',
    };
  }
  if (portal.tools.bus === null) {
    return {
      display: WAYLAND_DISPLAY,
      unreachable:
        'no session bus reachable from this host, so there is nothing owning that desktop ' +
        'to ask',
    };
  }
  if (portal.tools.gst === null) {
    return {
      display: WAYLAND_DISPLAY,
      unreachable:
        'the portal can be asked but the stream cannot be read — install gstreamer1.0-tools ' +
        'on that machine',
    };
  }
  if (portal.token === undefined) {
    /*
     * The state that needed a third field.
     *
     * Not `unreachable`, because it is reachable — one click away, on that
     * machine's own monitor. Not ready either: a grab from here would raise a
     * dialog on a screen nobody may be sitting at, and the viewer would show a
     * spinner for three minutes and then an error (§3.5). Measured, on a real
     * machine: two four-minute waits ended with the dialog still up, unanswered.
     */
    return {
      display: WAYLAND_DISPLAY,
      needsApproval:
        'Wayland will not let a program read a desktop without being asked. This puts a ' +
        'dialog on that machine, on its own monitor, once — approving it is remembered and ' +
        'it will not ask again.',
    };
  }
  // Approved. No size, because the portal does not report one until a frame
  // arrives — and a guess here would be a number on screen that nothing checked.
  return { display: WAYLAND_DISPLAY };
}

/**
 * What displays this machine has, and which of them this host can read.
 *
 * Every display is probed rather than assumed, which is §6.4's rule about hosts
 * applied to screens: a socket in `/tmp/.X11-unix` is a *record* that something
 * once listened, and the same probe on the same machine found one display that
 * answered and one that refused the cookie. Only a grab that starts is a fact.
 */
export async function listDisplays(
  opts: {
    run?: Spawn;
    tool?: string | null;
    candidates?: readonly string[];
    socketDir?: string;
    /** `DISPLAY` from the environment, which may name one the sockets do not. */
    env?: string | undefined;
    /** Where per-user runtime sockets live; injected for the tests. */
    runtimeDir?: string;
    /** The two variables that name a Wayland session, where this host has them. */
    session?: { XDG_SESSION_TYPE?: string | undefined; WAYLAND_DISPLAY?: string | undefined };
    /**
     * The portal route, injected the way `tool` is — or `null` to leave it out.
     *
     * Absent means "find out": the tools are looked for and the stored approval
     * is read from disk. `null` is how a caller says it does not want the row at
     * all, which is what the X-only tests want and what keeps them from touching
     * this machine's real `~/.agbrte`.
     */
    portal?: PortalSide | null;
  } = {},
): Promise<Displays> {
  const tool = opts.tool !== undefined ? opts.tool : findDisplayTool(opts.candidates);
  const names = await socketDisplays(opts.socketDir ?? X11_SOCKETS);
  const wayland = await waylandSockets(opts.runtimeDir ?? WAYLAND_SOCKETS, opts.session ?? {});

  /*
   * `DISPLAY` is consulted because a socket listing is not the whole truth: an X
   * server reached over TCP, or one whose socket lives somewhere else, appears
   * only in the environment. Deduped on the display number, since `:1` and `:1.0`
   * are the same screen written two ways.
   */
  const fromEnv = opts.env?.trim();
  if (fromEnv !== undefined && fromEnv !== '' && /^:\d+(\.\d+)?$/u.test(fromEnv)) {
    const number = fromEnv.split('.')[0];
    if (number !== undefined && !names.includes(number)) names.push(number);
  }

  // Carried on every answer rather than only where it changes one, because the
  // caution is about what the *picture* will contain and that is true whether or
  // not this host has a tool to take it with. It is about the **X** rows: the
  // portal row below is the compositor answering for itself, and the caution does
  // not apply to it.
  const note = wayland.length > 0 ? { wayland } : {};

  /*
   * The compositor's own screen, first in the list.
   *
   * First because on a Wayland machine it is the row that works and every X row
   * beside it is XWayland — so the viewer's "pick the first readable one" lands
   * on the picture instead of on the black rectangle. Only added where a
   * compositor was actually found: offering a portal row on a machine with no
   * Wayland on it would be a control that fails on press (§3.5).
   */
  const portal =
    opts.portal !== undefined
      ? opts.portal
      : wayland.length > 0
        ? { tools: portalTools(), token: await readToken() }
        : null;
  const first: DisplayInfo[] = portal === null ? [] : [waylandRow(portal)];

  if (tool === null) {
    // Listed without sizes: the displays are real and the reason each one has no
    // size is the same missing tool, already named in `tool`. Repeating it per
    // row would read as four problems.
    return {
      tool: null,
      displays: [...first, ...names.map((display) => ({ display }))],
      ...note,
    };
  }

  const displays: DisplayInfo[] = [...first];
  for (const display of names) {
    try {
      const head = await collect(
        opts.run ?? spawn,
        tool,
        ['-root', '-display', display, '-silent'],
        { timeoutMs: PROBE_TIMEOUT_MS, stopAfter: PROBE_BYTES },
      );
      if (!head.stopped && head.code !== 0) {
        displays.push({ display, unreachable: explain(display, head.stderr, head.code) });
        continue;
      }
      const header = readXwdHeader(head.stdout);
      displays.push({ display, width: header.width, height: header.height });
    } catch (err) {
      displays.push({
        display,
        unreachable:
          err instanceof UnsupportedXwd
            ? `${display} is a format this cannot read: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      });
    }
  }

  return { tool, displays, ...note };
}

/**
 * How long an approved cast is kept open with nothing pulling from it.
 *
 * A cast is not free to open: even with a token that restores silently, `Start`
 * is three round trips to the portal and a PipeWire node being set up, which is
 * most of a second. Paying that per frame would put the viewer under one frame a
 * second — slower than the X path it exists to beat — so the session is held
 * between pulls.
 *
 * Held, and not held forever. A portal session is a thing on somebody else's
 * machine: GNOME shows a running screencast in its status area, and leaving one
 * up after the window watching it was closed would be this app appearing to
 * record a desktop nobody is looking at. Thirty seconds is comfortably longer
 * than the gap between frames and far shorter than somebody would notice.
 */
const CAST_IDLE_MS = 30_000;

interface HeldCast {
  stream: PortalStream;
  close: () => void;
  /** Absent between a frame landing and the next idle timer being armed. */
  timer?: NodeJS.Timeout;
}

let held: HeldCast | null = null;

/**
 * The open in flight, so two callers cannot each start one.
 *
 * The promise is shared rather than the result, which is the difference between
 * this and the obvious version. `if (held === null) { held = await open() }` reads
 * the state before an await and writes it after: two grabs arriving together —
 * two panes, or two clients on one host — both see `null`, both open a cast, and
 * the second assignment drops the first on the floor with nothing left holding
 * its `close`. A portal session leaked that way is not a leaked object; it is a
 * screencast indicator that stays lit on somebody else's desktop.
 */
let opening: Promise<HeldCast> | null = null;

/**
 * Bumped whenever the held cast is dropped, so an open that was already in flight
 * knows its answer is no longer wanted and closes itself instead of being stored.
 */
let generation = 0;

/** Let go of the portal session, now. Exported because shutdown has to call it. */
export function closeHeldCast(): void {
  generation += 1;
  opening = null;
  if (held === null) return;
  if (held.timer !== undefined) clearTimeout(held.timer);
  held.close();
  held = null;
}

async function heldCast(run: Spawn | undefined, tools: PortalTools, token: string): Promise<HeldCast> {
  if (held !== null) return held;
  if (opening === null) {
    const mine = generation;
    opening = openCast({ ...(run !== undefined ? { run } : {}), tools, token })
      .then((opened) => {
        const cast: HeldCast = { stream: opened.stream, close: opened.close };
        if (generation !== mine) {
          // Somebody closed the cast while this one was being opened. Storing it
          // now would resurrect a session the caller had already let go of.
          opened.close();
          return cast;
        }
        held = cast;
        return cast;
      })
      .finally(() => {
        // Cleared whichever way it went, so a portal that refused once does not
        // make every later attempt await the same rejected promise.
        opening = null;
      });
  }
  return opening;
}

function keepAlive(): void {
  if (held === null) return;
  if (held.timer !== undefined) clearTimeout(held.timer);
  const timer = setTimeout(closeHeldCast, CAST_IDLE_MS);
  // Unref'd so a held cast cannot be the reason this host stays alive. The timer
  // exists to end something, and a process kept running by its own cleanup timer
  // is the shape that turns a tidy-up into a leak.
  timer.unref?.();
  held.timer = timer;
}

/**
 * One frame of the compositor's screen, through the portal.
 *
 * Scaled from the PNG rather than from raw pixels, which is the opposite of the
 * X path above and right for the opposite reason: GStreamer hands over a PNG
 * already, so raw pixels would mean decoding one in order to avoid decoding one.
 * And the decode is skipped outright when the screen is already within the size
 * asked for — the common case on a laptop panel, and the cheapest frame there is.
 */
async function grabWayland(opts: {
  run?: Spawn;
  tools?: PortalTools;
  maxEdge: number;
  token?: string | undefined;
}): Promise<DisplayGrab> {
  const began = Date.now();
  const token = opts.token !== undefined ? opts.token : await readToken();
  if (token === undefined) {
    throw new NeedsApproval(
      'that machine has not approved this yet. Wayland will not let a program read a desktop ' +
        'without being asked, so ask it once — the answer is remembered.',
    );
  }

  const tools = opts.tools ?? portalTools();
  const cast = await heldCast(opts.run, tools, token);
  const node = cast.stream.node;
  keepAlive();

  let png: Buffer;
  try {
    png = await frameFrom(node, { ...(opts.run !== undefined ? { run: opts.run } : {}), tools });
  } catch (err) {
    /*
     * Let go of the session before reporting.
     *
     * A node that stopped answering is usually a session the compositor ended —
     * the person revoked it, the monitor changed, the session locked — and
     * holding a dead handle would make every later grab fail with the same stale
     * error. Dropping it means the next attempt reopens, which is the one thing
     * that can actually recover.
     */
    closeHeldCast();
    throw err;
  }

  /*
   * The size from the header alone, and the scaling skipped where there is none
   * to do.
   *
   * `scaleToFit` would also return these exact bytes — it compares first and
   * hands back its argument untouched — so this is not about the re-encode. It is
   * about the *decode* it does before finding that out, which on a path pulling
   * several frames a second is a whole PNG decode per frame on somebody else's
   * machine. `sizeOf` reads the header and stops.
   */
  const source = sizeOf(png);
  const big = Math.max(source.width, source.height) > opts.maxEdge;
  const fitted = big ? await scaleToFit(png, opts.maxEdge) : png;
  const shown = big ? sizeOf(fitted) : source;
  return {
    display: WAYLAND_DISPLAY,
    png: fitted,
    width: shown.width,
    height: shown.height,
    sourceWidth: source.width,
    sourceHeight: source.height,
    tookMs: Date.now() - began,
  };
}

/**
 * Ask the far machine, once, and keep the answer.
 *
 * The cast is opened and immediately closed. What is wanted is not a frame but
 * the `restore_token` that comes back with the approval — and holding the
 * session open afterwards would leave a screencast indicator up on somebody's
 * desktop for as long as the app was running, which is precisely the impression
 * this feature must not give.
 *
 * A portal that agrees and returns no token is not a failure, and it is not a
 * success either: it means every grab will ask again. Said out loud, because
 * discovering it as a dialog per frame is how somebody concludes the app is
 * broken.
 */
export async function approveDisplay(
  opts: { run?: Spawn; tools?: PortalTools; file?: string } = {},
): Promise<{ remembered: boolean }> {
  const { stream, close } = await openCast({
    ...(opts.run !== undefined ? { run: opts.run } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    mayAsk: true,
  });
  close();

  const token = stream.restoreToken;
  if (token === undefined || token === '') return { remembered: false };
  await writeToken(token, opts.file ?? tokenFile());
  return { remembered: true };
}

/**
 * One frame of a display, as a PNG.
 *
 * Scaled on the raw pixels before encoding, which is the difference between a
 * live view and a slideshow: going through `scaleToFit` would encode the full
 * 2944×1080 frame, decode it and encode it again — three passes where one will
 * do, on the path that repeats several times a second.
 */
export async function grabDisplay(
  display: string,
  opts: {
    run?: Spawn;
    tool?: string | null;
    candidates?: readonly string[];
    maxEdge?: number;
    /** The portal route, for the Wayland row; injected the way `tool` is. */
    portal?: PortalSide;
  } = {},
): Promise<DisplayGrab> {
  if (display === WAYLAND_DISPLAY) {
    // Branched before `checkName`, which judges X display names and would reject
    // this one — correctly, since it is not one.
    return grabWayland({
      ...(opts.run !== undefined ? { run: opts.run } : {}),
      ...(opts.portal !== undefined ? { tools: opts.portal.tools, token: opts.portal.token } : {}),
      maxEdge: opts.maxEdge ?? DEFAULT_MAX_EDGE,
    });
  }
  checkName(display);
  const tool = opts.tool !== undefined ? opts.tool : findDisplayTool(opts.candidates);
  if (tool === null) {
    throw new NoDisplayTool(
      'this host has no xwd, so it cannot read a display; install x11-apps on that machine',
    );
  }

  const began = Date.now();
  const got = await collect(opts.run ?? spawn, tool, ['-root', '-display', display, '-silent'], {
    timeoutMs: GRAB_TIMEOUT_MS,
  });
  if (got.code !== 0) throw new DisplayUnreachable(explain(display, got.stderr, got.code));

  const raw = decodeXwd(got.stdout);
  const scaled = scaleRawToFit(raw, opts.maxEdge ?? DEFAULT_MAX_EDGE);
  return {
    display,
    png: encodePng(scaled),
    width: scaled.width,
    height: scaled.height,
    sourceWidth: raw.width,
    sourceHeight: raw.height,
    tookMs: Date.now() - began,
  };
}
