/**
 * Launching the real app for end-to-end tests (DESIGN.md §14).
 *
 * Everything here exists to make a launch reproducible and isolated: a
 * throwaway workspace, a throwaway Electron profile, and an environment with the
 * traps already handled.
 */

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron.exe');

export interface LaunchedApp {
  app: ElectronApplication;
  window: Page;
  /** The workspace the app opened — a real directory on disk. */
  workspace: string;
  close(): Promise<void>;
}

/**
 * Launch the built app against a given workspace.
 *
 * `userDataDir` is per-launch so tests never touch the developer's real profile,
 * and `LOOM_WORKSPACE_ROOT` pins the workspace instead of letting main fall back
 * to that profile directory.
 */
export async function launch(workspace: string): Promise<LaunchedApp> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'loom-e2e-profile-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Inherited from any Electron-based parent terminal; it would silently run
  // main as plain Node with no window at all. See scripts/launch.mjs.
  delete env['ELECTRON_RUN_AS_NODE'];
  env['LOOM_WORKSPACE_ROOT'] = workspace;

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
    workspace,
    close: async () => {
      await app.close();
      await rm(userDataDir, { recursive: true, force: true });
    },
  };
}

/** A temp directory that is a real git repository. */
export async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'loom-e2e-repo-'));
  // A real repo, because "edits a real repo" is the acceptance criterion and a
  // bare temp folder would not prove the workspace machinery works on one.
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'e2e@loom.test'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'loom e2e'], { cwd: dir });
  return dir;
}

/** Whether a local OpenAI-compatible server has the model we need. */
export async function modelAvailable(model: string): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:11434/api/tags', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? []).some((m) => m.name === model);
  } catch {
    return false;
  }
}
