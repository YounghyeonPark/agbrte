/**
 * Reading a Wayland screen, through the portal (DESIGN.md §12.1, §3.3).
 *
 * `display.ts` reads an **X** display with `xwd`, and under Wayland that is
 * XWayland — whose root window is not the compositor's output, so the grab comes
 * back black while the desktop is plainly there on the monitor. This is the path
 * that actually asks the compositor.
 *
 * ## What was measured before any of this was written
 *
 * On a real GNOME 46 machine, over its own session bus:
 *
 * - `org.freedesktop.portal.Screenshot` v2 exists and is **not usable here**.
 *   With `interactive: false` it refuses in 0.01s (response code 2); with
 *   `interactive: true` it puts a dialog up and waits. A still per frame behind a
 *   dialog per frame is not a live view, and an unattended refusal is not one
 *   either.
 * - `org.freedesktop.portal.ScreenCast` **v5**, which is where `persist_mode`
 *   lives: consent once, and a token that works silently afterwards. That is the
 *   only shape in which this feature can exist on Wayland at all.
 * - PipeWire running, and GStreamer present with `pipewiresrc`, `videoconvert`
 *   and `pngenc`. Nothing here is installed by us — the same rule `xwd` follows:
 *   drive what is already there, refuse clearly when it is not.
 *
 * ## The consent is a feature, and it is once
 *
 * `Start` puts a dialog on the far machine's screen — confirmed by name,
 * `"Share Screen"` from `xdg-desktop-portal-gnome`. Nothing can route around
 * that, and nothing should: a program that could silently read a desktop is the
 * thing Wayland exists to prevent. What `persist_mode` buys is that it happens
 * **once**, and the token is kept where the machine keeps its own facts (§5.1).
 *
 * ## What this repository cannot verify
 *
 * The portal conversation is verified: `CreateSession` and `SelectSources` both
 * returned success against a real portal with exactly the options below, and
 * `Start` was seen to raise its dialog. What has never run is the half **past**
 * that dialog — nobody has approved one yet, so no `restore_token` has come back
 * and no frame has been read. `docs/status.md` says so rather than letting a
 * green suite imply otherwise.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PORTAL_HELPER } from './portalHelper.js';

export class NoPortal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoPortal';
  }
}

/** Injectable, so the tests can make a machine with a portal on it. */
export type Spawn = typeof spawn;

/** What one approved screen cast is, once the portal has agreed to it. */
export interface PortalStream {
  /** The PipeWire node carrying the frames. */
  node: number;
  /**
   * The token that makes the next grab silent, where the portal gave one.
   *
   * Absent is not a failure: a portal may honour `persist_mode` and return
   * nothing, in which case every grab asks again — which is worth saying out
   * loud rather than discovering as a dialog per frame.
   */
  restoreToken?: string;
}

/** Where a helper's one line of JSON lands, before it is believed. */
interface HelperAnswer {
  ok: boolean;
  reason?: string;
  detail?: string;
  code?: number;
  node?: number;
  restoreToken?: string | null;
}

/**
 * How long to wait at the consent dialog.
 *
 * Two numbers because they are two different questions. A restore token makes
 * `Start` silent, so anything beyond a few seconds means it is not working and
 * waiting longer only hides that. A first approval is somebody walking to a
 * machine, and three minutes is the difference between "they were not there" and
 * "it does not work" — a distinction two four-minute waits on a real machine
 * turned out to be exactly about.
 */
const SILENT_WAIT_S = 12;
const CONSENT_WAIT_S = 180;

/** A frame is a whole screen; the same ceiling `display.ts` argues for. */
const MAX_FRAME = 128 * 1024 * 1024;

/**
 * Where the machine keeps its approval.
 *
 * `~/.agbrte` is the install area (§5.1): outside every workspace, in no
 * repository, in no template. The token is not a credential in §13's sense — it
 * grants nothing to anybody who is not already on that machine's session bus —
 * but it is a machine fact and this is where machine facts live. `AGBRTE_HOME`
 * is honoured for the reason hazard 2 in CLAUDE.md exists: a `= homedir()`
 * default once made every host in a test run share one directory.
 */
export function tokenFile(home = process.env['AGBRTE_HOME']): string {
  const root = home ?? join(process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.', '.agbrte');
  return join(root, 'screencast.json');
}

export async function readToken(file = tokenFile()): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as { restoreToken?: unknown };
    return typeof raw.restoreToken === 'string' && raw.restoreToken !== ''
      ? raw.restoreToken
      : undefined;
  } catch {
    // No file, bad JSON, or a directory that does not exist yet. All of them
    // mean the same thing — nobody has approved this machine — and none of them
    // is worth an error in front of somebody who is about to be asked.
    return undefined;
  }
}

export async function writeToken(token: string, file = tokenFile()): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify({ restoreToken: token }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

/** Where `python3` and `gst-launch-1.0` are, checked by existence. */
const PYTHONS: readonly string[] = ['/usr/bin/python3', '/usr/local/bin/python3'];
const GSTS: readonly string[] = ['/usr/bin/gst-launch-1.0', '/usr/local/bin/gst-launch-1.0'];

/**
 * By existence and never by running it with a flag.
 *
 * `findBrowser`'s lesson, written down a third time: a probe that executes the
 * candidate can hang, and asking the filesystem is the question actually being
 * asked.
 */
function firstThere(candidates: readonly string[]): string | null {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return null;
}

export interface PortalTools {
  python: string | null;
  gst: string | null;
  /** The session bus this host can reach, or `null` where it cannot see one. */
  bus: string | null;
}

/**
 * What this host has to work with.
 *
 * The bus address is derived from the runtime directory rather than read from
 * `DBUS_SESSION_BUS_ADDRESS`, for the reason the Wayland sockets are found the
 * same way: a host started from a non-login shell over ssh inherits almost none
 * of a desktop session's environment. Measured on a real machine, where that
 * variable was absent and `XDG_SESSION_TYPE` said `tty` — the ssh session's own
 * answer, not the desktop's.
 */
export function portalTools(uid = typeof process.getuid === 'function' ? process.getuid() : null): PortalTools {
  const python = firstThere(PYTHONS);
  const gst = firstThere(GSTS);
  const socket = uid === null ? null : `/run/user/${uid}/bus`;
  const bus = socket !== null && existsSync(socket) ? `unix:path=${socket}` : null;
  return { python, gst, bus };
}

function reasonFor(answer: HelperAnswer): string {
  switch (answer.reason) {
    case 'no-gi':
      return 'that machine has python3 without its GLib bindings; install python3-gi';
    case 'no-session-bus':
      return 'no session bus was reachable, so there is no portal to ask';
    case 'start':
      /*
       * The one a person can act on, and the one that will happen most. Code 1
       * is a refusal and anything else here is the wait running out — which on a
       * first approval means nobody was at the machine, measured twice.
       */
      return answer.code === 1
        ? 'the person at that machine declined to share the screen'
        : 'nobody approved the share on that machine — the dialog is on its screen';
    case 'no-stream':
      return 'the portal agreed and then offered no stream, which is a compositor fault';
    default:
      return `the portal refused at ${answer.reason ?? 'an unnamed step'}${
        answer.detail === undefined ? '' : `: ${answer.detail}`
      }`;
  }
}

/**
 * Open a cast of the far machine's screen, asking for consent only if it must.
 *
 * The helper holds the session open after it answers — closing its bus
 * connection closes the session and the node vanishes — so the caller gets a
 * `close` to call and must call it.
 */
export async function openCast(
  opts: {
    run?: Spawn;
    tools?: PortalTools;
    token?: string | undefined;
    /** True on the deliberate one-time approval, false for an ordinary grab. */
    mayAsk?: boolean;
  } = {},
): Promise<{ stream: PortalStream; close: () => void }> {
  const tools = opts.tools ?? portalTools();
  if (tools.python === null) throw new NoPortal('that machine has no python3 to ask the portal with');
  if (tools.bus === null) {
    throw new NoPortal('no session bus on that machine, so nothing owns a desktop to share');
  }

  const run = opts.run ?? spawn;
  const wait = opts.mayAsk === true ? CONSENT_WAIT_S : SILENT_WAIT_S;
  const child = run(tools.python, ['-c', PORTAL_HELPER, opts.token ?? '', String(wait)], {
    windowsHide: true,
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: tools.bus },
  });

  const answer = await new Promise<HelperAnswer>((resolve, reject) => {
    let line = '';
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => {
        child.kill('SIGKILL');
        settle(() => reject(new NoPortal('the portal helper never answered')));
      },
      (wait + 30) * 1000,
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      line += chunk.toString('utf8');
      const end = line.indexOf('\n');
      if (end === -1) return;
      try {
        settle(() => resolve(JSON.parse(line.slice(0, end)) as HelperAnswer));
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', () => {
      // Exited without a line: the helper prints one whatever happens, so this
      // is python itself failing to start rather than the portal saying no.
      settle(() => reject(new NoPortal('the portal helper exited without answering')));
    });
  }).catch((err: unknown) => {
    child.kill('SIGKILL');
    throw err;
  });

  if (!answer.ok || answer.node === undefined) {
    child.kill('SIGKILL');
    throw new NoPortal(reasonFor(answer));
  }

  const stream: PortalStream = {
    node: answer.node,
    ...(typeof answer.restoreToken === 'string' && answer.restoreToken !== ''
      ? { restoreToken: answer.restoreToken }
      : {}),
  };
  return { stream, close: () => child.kill('SIGKILL') };
}

/**
 * One frame off an open cast, as PNG bytes.
 *
 * `num-buffers=1` rather than a stream: the viewer above pulls one frame at a
 * time and waits for it, so a pipeline that kept running would be producing
 * pictures nobody asked for on somebody else's machine.
 */
export async function frameFrom(
  node: number,
  opts: { run?: Spawn; tools?: PortalTools; timeoutMs?: number } = {},
): Promise<Buffer> {
  const tools = opts.tools ?? portalTools();
  if (tools.gst === null) {
    throw new NoPortal(
      'that machine has no gst-launch-1.0 to read the stream with; install gstreamer1.0-tools',
    );
  }

  const run = opts.run ?? spawn;
  const child = run(
    tools.gst,
    [
      '-q',
      'pipewiresrc',
      `path=${node}`,
      'num-buffers=1',
      '!',
      'videoconvert',
      '!',
      'pngenc',
      '!',
      'fdsink',
    ],
    { windowsHide: true, ...(tools.bus === null ? {} : { env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: tools.bus } }) },
  );

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let done = false;
    const settle = (fn: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      settle(() => reject(new NoPortal('the stream produced no frame in time')));
    }, opts.timeoutMs ?? 20_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > MAX_FRAME) {
        child.kill('SIGKILL');
        settle(() => reject(new NoPortal('the stream produced more than a screen could be')));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => {
      const png = Buffer.concat(chunks);
      if (code === 0 && png.length > 0) {
        settle(() => resolve(png));
        return;
      }
      settle(() =>
        reject(
          new NoPortal(
            stderr.trim() === ''
              ? `gst-launch exited ${code === null ? 'without a code' : String(code)}`
              : (stderr.trim().split('\n').at(-1) as string),
          ),
        ),
      );
    });
  });
}
