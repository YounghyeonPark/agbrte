/**
 * Headless browser capture (DESIGN.md §12.1).
 *
 * > **Remote capture** — for what the agent's code is doing: a **headless
 * > browser screenshot** taken by the host of a URL the agent serves (with
 * > viewport and DPR recorded) … The former lets an agent *see its own output*
 * > and iterate without you in the loop.
 *
 * Everything else in §12 is about getting *your* screen to a model. This is the
 * one that closes a loop without you in it: an agent starts a dev server, looks
 * at what it rendered, and fixes it.
 *
 * ## A browser the user already has, driven as a subprocess
 *
 * Not Playwright, not Puppeteer. The host this runs on is frequently a headless
 * Linux box reached over ssh, and the installer is a single self-contained shell
 * script — adding a package that downloads a browser per platform would be the
 * heaviest dependency in the project by a wide margin, for a feature many
 * sessions never use.
 *
 * So it is the same shape as `agent-cli-stdio` (§3.12): detect what is already
 * installed, drive it, and refuse clearly when it is not there. Chrome and Edge
 * both take `--headless --screenshot`, which needs no protocol client at all.
 *
 * ## Screenshotting a URL is a data-egress decision
 *
 * The image comes back into a model's context, so an agent that can screenshot
 * `http://localhost:8080` can also screenshot an internal dashboard and show it
 * to a third-party provider. That is a §13 decision and it belongs to the
 * permission gate, which is why this is reached through a tool rather than
 * offered as an ambient capability.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * How long a page gets. A hung dev server must not hold the turn open.
 *
 * Sixty rather than thirty, and the thirty was measured wrong rather than chosen
 * wrong: it budgeted for *rendering a page*, and most of the wall clock is
 * Chrome starting — a cold binary, a fresh `--user-data-dir` profile, and on a
 * busy machine a good deal of waiting for a disk. A Windows CI runner took
 * **30282 ms** on a 400×300 solid-colour page, which is not a slow page by any
 * reading.
 *
 * The asymmetry decides the number. Too short fails a capture that would have
 * worked, on exactly the machines least able to spare a retry; too long makes
 * somebody wait for a screenshot that was never coming. A minute is cheap
 * against the first and tolerable against the second.
 */
const CAPTURE_TIMEOUT_MS = 60_000;

export class NoBrowser extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoBrowser';
  }
}

export interface Viewport {
  width: number;
  height: number;
  /** Device pixel ratio, recorded in provenance so a retina shot is legible. */
  dpr: number;
}

export const DEFAULT_VIEWPORT: Viewport = { width: 1280, height: 800, dpr: 1 };

/**
 * Where a browser usually is.
 *
 * Ordered Chrome first, then Edge, then the Linux package names. Nothing here is
 * installed by us and nothing is downloaded; a host with none of them says so.
 */
const CANDIDATES: readonly string[] = [
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
  'msedge',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

/**
 * Find a browser, or `null`.
 *
 * `null` rather than a throw: a host without one is an ordinary state of the
 * world, and the caller's job is to say so rather than to fail starting up —
 * the same reasoning as `detectCli` (§3.12).
 *
 * ## Not `--version`, and Windows is why
 *
 * The obvious probe is to run the thing and see if it answers. `chrome.exe
 * --version` on Windows prints nothing and **does not exit** — so the best
 * browser on the machine was skipped after a ten-second stall, and the scan
 * fell through to Edge. Two costs, and the quiet one is worse: every capture
 * paid ten seconds, and the browser actually used was not the one anybody
 * would have chosen.
 *
 * So an absolute path is checked by *existence*, which is the question being
 * asked, and only a bare name is executed — `--version` on a name resolved
 * through `PATH` is a cheap way to find out whether it resolves to anything, and
 * on the platforms where bare names are the norm it behaves.
 */
export async function findBrowser(
  candidates: readonly string[] = CANDIDATES,
  exec = run,
): Promise<string | null> {
  for (const candidate of candidates) {
    // A path is a claim about the filesystem, so ask the filesystem.
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      await exec(candidate, ['--version'], { timeout: 5_000 });
      return candidate;
    } catch {
      // Not on PATH, or not runnable. Try the next.
    }
  }
  return null;
}

export interface Capture {
  png: Buffer;
  url: string;
  viewport: Viewport;
  /** Which browser took it, so a rendering difference is attributable. */
  browser: string;
}

/**
 * Screenshot a URL with a headless browser.
 *
 * The temporary directory is removed whatever happens. A screenshot of somebody's
 * admin panel left in `/tmp` would be the same leak §12.1 spends its length
 * preventing, arriving through a cleanup nobody wrote.
 */
export async function captureUrl(
  url: string,
  opts: {
    viewport?: Viewport;
    browser?: string;
    exec?: typeof run;
    /**
     * Where to look. Injectable alongside `exec` and for the same reason: since
     * an absolute candidate is now checked by *existence*, a test cannot make a
     * machine that has Chrome look like one that does not by stubbing `exec`.
     */
    candidates?: readonly string[];
  } = {},
): Promise<Capture> {
  const exec = opts.exec ?? run;
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const browser = opts.browser ?? (await findBrowser(opts.candidates ?? CANDIDATES, exec));
  if (browser === null) {
    throw new NoBrowser(
      'no headless-capable browser found on this host; install Chrome, Chromium or Edge',
    );
  }

  const dir = await mkdtemp(join(tmpdir(), 'agbrte-shot-'));
  const out = join(dir, 'shot.png');
  try {
    await exec(
      browser,
      [
        '--headless',
        '--disable-gpu',
        // Ordinary on a container or CI host and harmless elsewhere; without it
        // Chrome refuses to start as root, which is exactly where a remote agent
        // host often runs.
        '--no-sandbox',
        `--screenshot=${out}`,
        `--window-size=${viewport.width},${viewport.height}`,
        `--force-device-scale-factor=${viewport.dpr}`,
        /**
         * A profile of its own, inside the directory removed below.
         *
         * `--incognito` alone was not enough and the failure was silent: without
         * a `--user-data-dir` the browser uses the *default* profile, and when
         * the user already has that browser open it hands off to the running
         * process, exits 0, and writes no file. The caller then sees `ENOENT` on
         * a temp path, which explains nothing about what went wrong.
         *
         * A screenshot is a read of a page, not a browsing session, so a
         * throwaway profile is also what it should have had anyway.
         */
        `--user-data-dir=${join(dir, 'profile')}`,
        '--incognito',
        url,
      ],
      { timeout: CAPTURE_TIMEOUT_MS },
    );

    return { png: await readFile(out), url, viewport, browser };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
