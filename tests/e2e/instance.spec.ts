/**
 * Launching the app while it is already running (`main.ts`, §3.3).
 *
 * There was no single-instance lock, and it was found the way a person finds
 * it: on an Ubuntu machine whose window never appeared, a second launch fifteen
 * seconds later produced a second complete app, exactly as invisible as the
 * first. The lock turns that second launch into a message to the first — and
 * the first *shows* its window in answer, so the reflex of launching again
 * rescues a hidden app instead of doubling it.
 *
 * ## Why the window is hidden first
 *
 * Because that is the case this exists for, and because without it the test
 * could not fail on the part that matters. A second launch against a window that
 * is already on screen proves the second process quit; it says nothing about
 * whether the first one did anything. Hidden first, the only way it comes back
 * is the `second-instance` handler.
 *
 * Visibility is read from `BrowserWindow.isVisible()` in main, never from the
 * page. The harness records why: a hidden Electron window keeps compositing, so
 * Playwright reports the page's elements as visible whether or not the window
 * is on screen at all.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { ELECTRON, launch, makeRepo, ROOT } from './harness.js';
import { recordExit, recordProcess } from './fixtureDirs.js';

test('a second launch brings the first window forward instead of starting another app', async () => {
  const repo = await makeRepo();
  const agbrte = await launch(repo);
  let second: ReturnType<typeof spawn> | undefined;

  try {
    const profile = await agbrte.app.evaluate(({ app }) => app.getPath('userData'));

    // Counted in the first app, so the assertion is about it having *heard* the
    // second launch, not only about the second one having gone away.
    await agbrte.app.evaluate(({ app, BrowserWindow }) => {
      const g = globalThis as unknown as { secondLaunches: number };
      g.secondLaunches = 0;
      app.on('second-instance', () => {
        g.secondLaunches += 1;
      });
      for (const win of BrowserWindow.getAllWindows()) win.hide();
    });
    expect(
      await agbrte.app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((w) => w.isVisible()),
      ),
    ).toBe(false);

    /*
     * The same profile, which is what makes it the same app. The rest of the
     * environment mirrors the harness — its own machine directory, the test
     * workspace — so that if the lock ever stops working, the second app this
     * test failed to prevent attaches to throwaway folders and not to the
     * developer's real ones.
     */
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    delete env['ELECTRON_RUN_AS_NODE'];
    env['AGBRTE_HOME'] = join(profile, 'machine');
    env['AGBRTE_WORKSPACE_ROOT'] = repo;
    env['AGBRTE_HOST_LINGER_MS'] = '3000';

    second = spawn(ELECTRON, [join(ROOT, 'dist/main/main.js'), `--user-data-dir=${profile}`], {
      env,
      cwd: ROOT,
      stdio: 'ignore',
    });
    await recordProcess(second.pid, 'instance.spec › the second launch');

    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('the second launch was still running after 30s — no lock')),
        30_000,
      );
      second?.once('exit', (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    await recordExit(second.pid);
    expect(code).toBe(0);

    // The first app heard it, still has one window, and that window is back.
    await expect
      .poll(() =>
        agbrte.app.evaluate(
          () => (globalThis as unknown as { secondLaunches: number }).secondLaunches,
        ),
      )
      .toBe(1);
    const windows = await agbrte.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((w) => w.isVisible()),
    );
    expect(windows).toEqual([true]);
  } finally {
    if (second !== undefined && second.exitCode === null) second.kill();
    await agbrte.close();
  }
});
