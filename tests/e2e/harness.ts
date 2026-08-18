/**
 * Launching the real app for end-to-end tests (DESIGN.md §14).
 *
 * Everything here exists to make a launch reproducible and isolated: a
 * throwaway workspace, a throwaway Electron profile, and an environment with the
 * traps already handled.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as netCreateServer } from 'node:net';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');

/**
 * Path to the Electron binary, from the package rather than assembled by hand.
 *
 * The `electron` package's main export *is* the path string, but importing it
 * normally gives the Electron API types instead, so this goes through `require`.
 * Hardcoding `node_modules/electron/dist/electron.exe` worked and was wrong: it
 * is Windows-only, and on macOS the binary lives inside `Electron.app`.
 */
const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  /** The workspaces the app attached, in order. */
  workspaces: string[];
  /** The first, for the common single-host case. */
  workspace: string;
  close(): Promise<void>;
}

/**
 * Launch the built app against a given workspace.
 *
 * `userDataDir` is per-launch so tests never touch the developer's real profile,
 * and `AGBRTE_WORKSPACE_ROOT` pins the workspace instead of letting main fall back
 * to that profile directory.
 */
export async function launch(...workspaces: string[]): Promise<LaunchedApp> {
  if (workspaces.length === 0) throw new Error('launch needs at least one workspace');
  const userDataDir = await mkdtemp(join(tmpdir(), 'agbrte-e2e-profile-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Inherited from any Electron-based parent terminal; it would silently run
  // main as plain Node with no window at all. See scripts/launch.mjs.
  delete env['ELECTRON_RUN_AS_NODE'];
  // Several roots, delimiter-separated, so the app attaches several hosts at
  // once — which is how the multi-host view gets exercised (§8).
  env['AGBRTE_WORKSPACE_ROOT'] = workspaces.join(delimiter);
  // Hosts are detached now, so they outlive the app a test just closed. A short
  // linger stops a suite run from leaving one process per temp workspace behind
  // — the production default is minutes, which is right for a person and wrong
  // for a test that makes a dozen throwaway workspaces.
  env['AGBRTE_HOST_LINGER_MS'] = '3000';
  /*
   * The version this checkout ships, for the same reason `scripts/launch.mjs`
   * sets it: the app path here is `dist/main`, which has no `package.json`, so
   * `app.getVersion()` answers with Electron's version instead of this
   * project's — and §6.3's outdated-host badge compares that against the host
   * bundle's stamp. A packaged build has the file; these tests drive the same
   * arrangement a developer does, so they need the same answer.
   */
  env['AGBRTE_VERSION'] = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ).version as string;

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [join(ROOT, 'dist/main/main.js'), `--user-data-dir=${userDataDir}`],
    env,
    cwd: ROOT,
  });

  const window = await app.firstWindow();
  // `data-testid`, not a styling class: the previous `.app` selector broke on a
  // pure restyle and reported it as five failing tests.
  await window.waitForSelector('[data-testid=app]');

  return {
    app,
    window,
    workspaces,
    workspace: workspaces[0]!,
    close: async () => {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/** A temp directory that is a real git repository. */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-e2e-repo-'));
  // A real repo, because "edits a real repo" is the acceptance criterion and a
  // bare temp folder would not prove the workspace machinery works on one.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@agbrte.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'agbrte e2e'], { cwd: dir });
  return dir;
}

const OLLAMA = 'http://127.0.0.1:11434';

/** Whether a local OpenAI-compatible server has the model we need. */
export async function modelAvailable(model: string): Promise<boolean> {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).some((m) => m.name === model);
  } catch {
    return false;
  }
}

/**
 * Load the model into memory before the tests that depend on it.
 *
 * Without this, whichever live test ran first absorbed a cold start — Ollama
 * reading ~4.7 GB from disk — and intermittently blew a 150 s timeout, while
 * every later test finished in about four seconds. The tests were flaky in a way
 * that had nothing to do with the app: the failure said "the file was never
 * written" when the truth was "the model had not finished loading".
 *
 * `keep_alive` holds it resident for the rest of the run, past Ollama's default
 * five-minute idle unload. One generated token is enough to force the load.
 */
export async function warmModel(model: string): Promise<void> {
  const response = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: 'hi',
      stream: false,
      keep_alive: '15m',
      options: { num_predict: 1 },
    }),
    // Generous: this is the one place a cold start is expected and acceptable.
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) {
    throw new Error(`could not warm ${model}: HTTP ${response.status}`);
  }
  await response.json();
}

/**
 * A `agbrte web` server on a free port, with its own throwaway workspace.
 *
 * Shared because the phone spec needs the same thing in a different file:
 * Playwright will not let a describe block change the browser engine, so
 * WebKit-at-phone-size has to live on its own.
 */
export async function serveWebFixture(): Promise<{
  url: string;
  repo: string;
  stop: () => Promise<void>;
}> {
  const repo = await makeRepo();
  const port = await new Promise<number>((done, fail) => {
    const probe = netCreateServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(chosen));
    });
  });
  const url = `http://127.0.0.1:${port}/`;
  const server = spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', repo, '--port', String(port)],
    { stdio: 'ignore' },
  );

  const deadline = Date.now() + 30_000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try {
      up = (await fetch(url)).ok;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  if (!up) {
    server.kill();
    throw new Error('the web server never came up');
  }

  return {
    url,
    repo,
    stop: async () => {
      server.kill();
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
