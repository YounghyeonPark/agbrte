/**
 * The gap between clicking a session and seeing it (DESIGN.md §3.3, §15 Phase 1).
 *
 * Opening a session that is not loaded makes its host rebuild it from the event
 * log. Until that lands `active` is still whatever it was — so the pane kept
 * showing the dashboard, or the session somebody had just navigated away from,
 * and a click on a large session looked like a click that had missed. Nothing
 * anywhere said work was happening.
 *
 * ## Why an answer is stalled rather than waited on
 *
 * A test session on this machine opens in milliseconds, which is exactly the
 * case the delayed reveal is built to *hide*. Waiting for a naturally slow open
 * would mean building a session with a log long enough to be slow, on a machine
 * whose speed decides whether the test passes — a timing test dressed as a
 * feature test.
 *
 * So `sessions.snapshot` is held open deliberately. In the wild the slow half is
 * `resume`, which rebuilds an unloaded session from its log; both are awaited
 * inside the same window, and the renderer state under test is identical
 * whichever of them is taking the time. Stalling the snapshot is simply the one
 * that does not require arranging for a session the host has never loaded.
 */

import { expect, test } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';
import { addAgent, createSession, hostGroup } from './actions.js';

/**
 * A second session on a host that already has a remembered default.
 *
 * `createSession` ends by asserting the picker, and on the second session there
 * is no picker to assert: the first successful add taught this host a default,
 * and a zero-agent session here is now seated automatically before the form's
 * successor can be shown. That is the behaviour the settings pane exists to make
 * visible; here it is simply in the way.
 */
async function anotherSession(page: import('@playwright/test').Page, title: string): Promise<void> {
  const group = hostGroup(page);
  await group.locator('[data-testid=new-session]').click();
  await group.locator('[data-testid=new-title]').fill(title);
  const folder = group.locator('[data-testid=new-folder]');
  if ((await folder.count()) > 0) await folder.fill('');
  await group.locator('[data-testid=new-submit]').click();
  // Landed, whichever way it got there.
  await expect(page.locator(`[data-testid=session][data-title="${title}"]`)).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Make `sessions.resume` take as long as the test needs.
 *
 * Wrapped in main rather than stubbed in the page: `contextBridge` hands the
 * renderer a frozen API, so a stub installed there would be a stub of nothing.
 * The real handler still runs — this only delays the answer, so what the test
 * exercises afterwards is a genuinely resumed session.
 */
async function stallOpen(agbrte: LaunchedApp, ms: number): Promise<void> {
  await agbrte.app.evaluate(async ({ ipcMain }, wait) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('agbrte:sessions.snapshot');
    if (original === undefined) throw new Error('no sessions.snapshot handler to wrap');

    ipcMain.removeHandler('agbrte:sessions.snapshot');
    ipcMain.handle('agbrte:sessions.snapshot', async (...args: unknown[]) => {
      await new Promise((done) => setTimeout(done, wait));
      return original(...args);
    });
  }, ms);
}

test('says it is opening, and says what is taking the time', async () => {
  const repo = await makeRepo();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    /*
     * Two, because the sidebar only lists loaded sessions while something is
     * open — with nothing active the dashboard shows them instead and the group
     * renders no rows at all. The second session is what puts the first in the
     * sidebar to be clicked.
     */
    await createSession(page, 'the one to reopen');
    await addAgent(page, 'echo');
    await anotherSession(page, 'the one that is open');

    await stallOpen(agbrte, 2_500);
    const row = page.locator('[data-testid=session][data-title="the one to reopen"]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();

    // The pane, which is the large thing that was silent.
    const opening = page.locator('[data-testid=opening]');
    await expect(opening).toBeVisible({ timeout: 10_000 });
    /*
     * And it says *what* rather than only *that*. A bare spinner leaves somebody
     * deciding whether the app has hung; naming the work — the host replaying
     * the events this session is made of — is the difference between waiting and
     * wondering.
     */
    await expect(opening).toContainText('rebuilding it from the event log');

    // The row says it too, because the row is where the click landed.
    await expect(page.locator('[data-testid=row-opening]')).toBeVisible();

    /*
     * And it goes away on its own, which is the half that would rot silently. A
     * flag set and never cleared leaves the pane saying "opening" over a session
     * that opened — and the transcript arriving underneath would look like the
     * bug rather than the fix.
     */
    await expect(page.locator('[data-testid=transcript]')).toBeVisible({ timeout: 30_000 });
    await expect(opening).toHaveCount(0);
    await expect(page.locator('[data-testid=row-opening]')).toHaveCount(0);
  } finally {
    await agbrte.close();
  }
});

test('clears the opening state when the open fails', async () => {
  /*
   * The path a `finally` exists for. A refused resume puts its reason in the
   * error banner, and if `opening` were cleared only on success the pane would
   * sit on "Opening…" underneath it — an app apparently still working on
   * something it had already given up on.
   */
  const repo = await makeRepo();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await createSession(page, 'will refuse to open');
    await addAgent(page, 'echo');
    await anotherSession(page, 'the one that is open');

    await agbrte.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agbrte:sessions.snapshot');
      ipcMain.handle('agbrte:sessions.snapshot', async () => {
        throw new Error('the host refused, for this test');
      });
    });

    await page.locator('[data-testid=session][data-title="will refuse to open"]').click();

    // The reason is on screen and the pane is not still claiming to be working.
    await expect(page.locator('[data-testid=error]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid=opening]')).toHaveCount(0);
    await expect(page.locator('[data-testid=row-opening]')).toHaveCount(0);
  } finally {
    await agbrte.close();
  }
});
