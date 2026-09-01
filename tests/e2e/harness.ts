/**
 * Launching the real app for end-to-end tests (DESIGN.md §14).
 *
 * Everything here exists to make a launch reproducible and isolated: a
 * throwaway workspace, a throwaway Electron profile, and an environment with the
 * traps already handled.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer as netCreateServer } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, join, resolve } from 'node:path';
import { recordFixture, recordProcess, tempFixture } from './fixtureDirs.js';

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
  const userDataDir = await tempFixture('agbrte-e2e-profile-');

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
   * Its own machine directory, per launch (§8).
   *
   * `~/.agbrte` holds what is true of a *machine*: the host record, the machine
   * id, and the list of workspaces its host has been asked to serve. All three
   * are global by design — which means a spec using the real one would start a
   * host that reopens every workspace every other spec ever made, and the app
   * would come up attached to folders this test knows nothing about.
   *
   * Per launch rather than per suite, because a machine host is *shared* by
   * construction: two specs sharing this directory would share one host, and
   * the second would inherit the first's workspaces on screen.
   */
  env['AGBRTE_HOME'] = join(userDataDir, 'machine');
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

  // Recorded before the first window, because the failure this guards against
  // is an app that came up and then had to be abandoned — and a launch that
  // never reaches `firstWindow` has left a process behind exactly the same way.
  await recordProcess(app.process().pid);

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
export async function makeRepo(at?: string): Promise<string> {
  // `at` names the directory instead of letting `mkdtemp` do it, because the
  // folder's **basename is on screen** — the session header shows it, and the
  // sidebar lists it. That does not matter to an assertion and matters entirely
  // to a screenshot, where `agbrte-e2e-repo-5Y5Z4U` tells a reader they are
  // looking at somebody's test fixture rather than at the product.
  const dir = at ?? (await tempFixture('agbrte-e2e-repo-'));
  await mkdir(dir, { recursive: true });
  /*
   * Recorded, because almost nobody removes one of these.
   *
   * About fifty call sites across the specs ask for a repo and go on to test
   * something else; a `finally` at each of them is fifty edits and one omission
   * away from being wrong again. One line here covers every caller, including
   * the ones written next year. `fixtureDirs.ts` says what happens to the list.
   */
  await recordFixture(dir);
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
 * A `agbrte web` server on a free port, with its own throwaway workspace **and
 * its own machine directory**.
 *
 * Shared because the phone spec needs the same thing in a different file:
 * Playwright will not let a describe block change the browser engine, so
 * WebKit-at-phone-size has to live on its own.
 *
 * `home` and `repo` exist for a caller that needs to *name* one — a spec that
 * pins a path, or one that inspects the directory afterwards. Neither is how
 * isolation is obtained any more; that is the default now, for reasons written
 * where the spawn is.
 */
export async function serveWebFixture(opts: { home?: string; repo?: string } = {}): Promise<{
  url: string;
  repo: string;
  /** Run the CLI against *this* server's host. See the implementation. */
  run: (...args: string[]) => void;
  stop: () => Promise<void>;
}> {
  const repo = await makeRepo(opts.repo);
  const port = await new Promise<number>((done, fail) => {
    const probe = netCreateServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const chosen = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(chosen));
    });
  });
  /*
   * A pinned token, because the server now mints one per run and prints it in a
   * link this fixture never reads — it spawns the CLI with `stdio: 'ignore'`.
   * Fixed rather than parsed out of stdout: the value is not what any of these
   * specs are about, and a fixture that scrapes a log is a fixture that breaks
   * when somebody rewords a line.
   */
  const token = 'e2e-fixture-token';
  const url = `http://127.0.0.1:${port}/#t=${token}`;
  /*
   * Its own machine directory, always — the way `launch` does (§8).
   *
   * This used to be optional, on the reasoning that "the specs that only need a
   * page served are already passing against the shared one". That was wrong in
   * both halves. Nine of the twelve callers took the default, so nine fixtures
   * per run ran against the developer's real `~/.agbrte`: the host they started
   * was the developer's own, reading their endpoints and reopening what they had
   * attached. And it *wrote* there. After every full run the real
   * `workspaces.json` named a fixture repo that teardown had already deleted —
   * a different one each time, so this was reproducing rather than left over
   * from something once.
   *
   * A suite that edits the machine record of the machine it is run on has no
   * business being opt-out. It also breaks §8's one-host-per-machine rule in the
   * direction CLAUDE.md warns about: every one of those fixtures shared a socket
   * named from one `machineId`, with a three-second linger between them.
   *
   * Honest about what this does not claim: it is *not* established that this is
   * why two of six full runs failed. Three candidate mechanisms were measured
   * and all three refuted — see the commit. This is fixed because it is wrong,
   * not because it is proven guilty.
   */
  const home = opts.home ?? (await tempFixture('agbrte-web-home-'));
  const server = spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', repo, '--port', String(port), '--token', token],
    {
      // Kept, not discarded. `stdio: 'ignore'` is what made the last
      // investigation cost a day: the CLI died on a busy port with a stack
      // trace that went nowhere, and all this fixture could say was that the
      // server never came up — naming neither the port nor the cause. Whatever
      // it printed is now part of the failure.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGBRTE_HOME: home,
        // The same three seconds `launch` uses, for the same reason and from the
        // same observation: the host is detached, so killing the web server it
        // came up for leaves it running on the production default of minutes.
        // Four runs of the shots spec left four hosts holding four temp
        // workspaces, which is how this was noticed rather than reasoned out.
        AGBRTE_HOST_LINGER_MS: '3000',
      },
    },
  );

  let said = '';
  server.stdout.on('data', (d: Buffer) => (said += String(d)));
  server.stderr.on('data', (d: Buffer) => (said += String(d)));
  /** Why the process is gone, when it is — the other half of a silent failure. */
  let exit: string | null = null;
  server.on('exit', (code, signal) => {
    exit = signal === null ? `exited with code ${String(code)}` : `killed by ${signal}`;
  });

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
    /*
     * The output decides what happened, not the exit status.
     *
     * This used to say "still running, so it never finished listening" whenever
     * the process was alive — an inference, and the first real failure it caught
     * contradicted it: the server had printed its link, which `serveWeb` only
     * does *after* `listen` resolves. So it was up, listening, and unreachable
     * from this process for thirty seconds, which is a different problem from
     * the one that sentence named and would have sent the next reader the wrong
     * way. The link is the evidence, so the link is what is reported.
     */
    const listened = said.includes(String(port));
    throw new Error(
      `the web server on port ${port} was never reachable` +
        `${
          listened
            ? ' — it printed its link, so it did listen and the poll could not reach it'
            : exit === null
              ? ' — it is still running and never printed a link'
              : ` — it ${exit}`
        }` +
        `${said.trim() === '' ? ' and printed nothing' : `:\n${said.trim()}`}`,
    );
  }

  return {
    url,
    repo,
    /**
     * Run the CLI against *this* server's host, with its workspace and its
     * machine directory already filled in.
     *
     * Five specs made a session by spawning `agbrte run` themselves, and all
     * five left the environment off. That worked for exactly as long as this
     * fixture shared the developer's real `~/.agbrte` — the page and the
     * out-of-band `run` landed on one host by accident of both defaulting to it
     * — and all five broke together the moment it stopped. The failure was not
     * five mistakes; it was one fact that was nobody's job to carry.
     *
     * So it is not the caller's to remember. Same argument §8 makes about the
     * machine directory generally: one that has to be passed by hand at every
     * call site is one that eventually is not.
     */
    run: (...args: string[]): void => {
      try {
        execFileSync(process.execPath, [resolve('dist/cli/agbrte.js'), ...args], {
          // Captured for the same reason the server's output now is: a CLI that
          // failed silently is a test failure that names the exit code and
          // nothing else.
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, AGBRTE_HOME: home },
        });
      } catch (err) {
        const said = [
          (err as { stdout?: Buffer }).stdout?.toString() ?? '',
          (err as { stderr?: Buffer }).stderr?.toString() ?? '',
        ]
          .join('')
          .trim();
        throw new Error(
          `agbrte ${args.join(' ')} failed${said === '' ? ' and printed nothing' : `:\n${said}`}`,
        );
      }
    },
    stop: async () => {
      server.kill();
      await rm(repo, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
