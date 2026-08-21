/**
 * The **packaged** app starting its own CLI (DESIGN.md §7, §8.1).
 *
 * ## Why this cannot be a unit test, or an ordinary e2e one
 *
 * The terminal pane can run `agbrte attach --session <id>` against the session
 * on screen, and in an installed app every piece of that lives somewhere a
 * source checkout does not: the CLI bundle is inside `app.asar`, the session
 * host is `asarUnpack`ed beside it, and the only interpreter on the machine is
 * `electron.exe` — which runs a script solely under `ELECTRON_RUN_AS_NODE`, the
 * same trick the host itself is started with. Every other test in this suite
 * runs from `dist/`, where all three of those facts are different and none of
 * them is exercised.
 *
 * So this is the guard for a set of things that are true only after packaging,
 * and each of which would break the pane silently:
 *
 *  - `dist/cli/**` staying in `files` (it is not `asarUnpack`ed, and does not
 *    need to be: a script inside the archive runs fine under
 *    `ELECTRON_RUN_AS_NODE`, measured rather than assumed — see
 *    `agbrteCliCandidates`),
 *  - the sibling lookup from the host bundle finding it across the
 *    `app.asar` / `app.asar.unpacked` split,
 *  - and, on Windows, the shell relay in `programs.ts`, without which a
 *    GUI-subsystem binary in a pseudoconsole produces no output and reads no
 *    input.
 *
 * ## It skips rather than fails when there is no package
 *
 * `npm run dist:dir` is minutes and a download; making the ordinary suite depend
 * on it would mean nobody runs the ordinary suite. Absent an artifact for this
 * platform, this says so and skips — the same rule the installed-CLI test above
 * follows for a machine with no Claude Code.
 *
 * **Only the Windows path has been exercised.** The other two are where
 * electron-builder puts them; if either is wrong the test skips rather than
 * failing, which is the honest failure mode for a path nobody has run.
 */

import { _electron as electron, expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT, makeRepo } from './harness.js';
import { addAgent, createSession } from './actions.js';

const PACKAGED: Record<string, string> = {
  win32: 'release/win-unpacked/Agbrte.exe',
  darwin: 'release/mac/Agbrte.app/Contents/MacOS/Agbrte',
  linux: 'release/linux-unpacked/agbrte',
};

test('a packaged app starts its own CLI on the session in the pane', async () => {
  const app = resolve(ROOT, PACKAGED[process.platform] ?? 'release/nothing-here');
  test.skip(
    !existsSync(app),
    `no packaged app at ${app} — run \`npm run dist:dir\` to build one`,
  );

  const repo = await makeRepo();
  const userDataDir = await mkdtemp(join(tmpdir(), 'agbrte-packaged-profile-'));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  // Inherited from an Electron-based parent terminal; it would run the packaged
  // app as plain Node with no window (see `harness.ts`).
  delete env['ELECTRON_RUN_AS_NODE'];
  env['AGBRTE_WORKSPACE_ROOT'] = repo;
  env['AGBRTE_HOST_LINGER_MS'] = '3000';
  // Its own machine directory, for `harness.ts`'s reason: `~/.agbrte` is global
  // to a machine, and a packaged app pointed at the real one would start a host
  // that reopens the developer's workspaces (§8).
  env['AGBRTE_HOME'] = join(userDataDir, 'machine');

  // No script argument: a packaged app is its own entry point, which is the
  // whole difference being tested.
  const launched = await electron.launch({
    executablePath: app,
    args: [`--user-data-dir=${userDataDir}`],
    env,
  });
  const window = await launched.firstWindow();
  await window.waitForSelector('[data-testid=app]');

  try {
    await createSession(window, 'Packaged');
    // A seat with no vendor binary, which is the case the CLI option exists for.
    await addAgent(window, 'echo');
    await window.click('[data-testid=show-shell][data-choice="agbrte"]');

    const pane = window.locator('[data-testid=pty-terminal]');
    await expect(pane.locator('[data-testid=pty-running]')).toHaveText('Agbrte CLI', {
      timeout: 30_000,
    });

    // The host's own answer about what it started: the packaged runtime, and the
    // CLI bundle from inside the archive. Not a wrapper, and not a guess made in
    // the renderer.
    const where = window.locator('[data-testid=pty-where]');
    await expect(where).toContainText('agbrte.js', { timeout: 30_000 });

    const screen = async (): Promise<string> =>
      (await window.locator('[data-testid=pty-screen]').innerText()).replace(/\s+/g, ' ');

    await expect
      .poll(screen, {
        timeout: 90_000,
        message: 'the packaged app never got its own CLI attached to the session',
      })
      .toMatch(/type to send/);

    // And it is a client rather than a picture of one: a turn typed here runs.
    const marker = `packaged-${Date.now().toString(36)}`;
    await pane.click();
    await window.keyboard.type(marker);
    await window.keyboard.press('Enter');
    await expect
      .poll(screen, {
        timeout: 60_000,
        message: 'the turn sent from the packaged pane never produced a reply',
      })
      .toContain('echo:');
  } finally {
    await launched.close();
    // The pane's program stands in the workspace, and Windows will not remove a
    // directory somebody is standing in until they have gone. See shell.spec.ts.
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
