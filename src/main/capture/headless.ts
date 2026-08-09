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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How long a page gets. A hung dev server must not hold the turn open. */
const CAPTURE_TIMEOUT_MS = 30_000;

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
 */
export async function findBrowser(
  candidates: readonly string[] = CANDIDATES,
  exec = run,
): Promise<string | null> {
  for (const candidate of candidates) {
    try {
      await exec(candidate, ['--version'], { timeout: 10_000 });
      return candidate;
    } catch {
      // Not there, or not runnable. Try the next.
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
  opts: { viewport?: Viewport; browser?: string; exec?: typeof run } = {},
): Promise<Capture> {
  const exec = opts.exec ?? run;
  const viewport = opts.viewport ?? DEFAULT_VIEWPORT;
  const browser = opts.browser ?? (await findBrowser(CANDIDATES, exec));
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
        // A screenshot is a read of a page, not a browsing session. Nothing this
        // does should end up in a profile that outlives the call.
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
