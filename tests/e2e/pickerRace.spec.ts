/**
 * A hypothesis about the picker race, tested rather than waited for.
 *
 * `docs/status.md` records a failure that came back once in three full runs:
 * `[data-testid=runtime-list]` never appearing after a click that landed. The
 * saved snapshot ruled out the cause found last time — the picker had settled,
 * `modelsBusy` was false, the trigger was enabled — so whatever loses the open
 * happens *after* the models arrive.
 *
 * Waiting for it to recur costs eight minutes a throw and reproduces nothing on
 * demand. This is the other half of the rule the last investigation ended on:
 * instrument the thing rather than re-run it. The suspect is visible in the
 * code — `applyHosts` sets a **new array** on every host push, `entries` is a
 * `useMemo` over it, and the picker's whole option list is therefore rebuilt
 * several times a second under load — so this drives that condition on purpose
 * and asks whether it is enough.
 *
 * A pass here is not "no bug". It is one candidate eliminated, cheaply, and
 * written down so the next person does not spend a day on it again.
 */

import { expect, test } from '@playwright/test';
import { launch, makeRepo } from './harness.js';
import { createSession } from './actions.js';

/**
 * Push the host list at the renderer as fast as it will take it.
 *
 * The same shape a real push has — `applyHosts` receives a fresh array off the
 * wire every time — and deliberately with *identical content*, because the
 * question is whether the identity change alone is enough. A push that also
 * changed the ranking would be a different and much easier bug.
 */
async function stormHostPushes(
  agbrte: Awaited<ReturnType<typeof launch>>,
  everyMs: number,
): Promise<void> {
  await agbrte.app.evaluate(async ({ ipcMain, BrowserWindow }, ms) => {
    const handlers = (
      ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> }
    )._invokeHandlers;
    const original = handlers.get('agbrte:hosts.list');
    if (original === undefined) throw new Error('no hosts.list handler to read');
    const hosts = await original(null);

    const timer = setInterval(() => {
      for (const win of BrowserWindow.getAllWindows()) {
        // Cloned, so the renderer gets a new array and new objects — which is
        // what arrives over IPC anyway, and is the whole of the hypothesis.
        win.webContents.send('agbrte:push.hosts', JSON.parse(JSON.stringify(hosts)));
      }
    }, ms);
    (globalThis as unknown as { __storm?: NodeJS.Timeout }).__storm = timer;
  }, everyMs);
}

async function stopStorm(agbrte: Awaited<ReturnType<typeof launch>>): Promise<void> {
  await agbrte.app.evaluate(() => {
    const box = globalThis as unknown as { __storm?: NodeJS.Timeout };
    if (box.__storm !== undefined) clearInterval(box.__storm);
  });
}

test('the picker opens while the host list is being replaced under it', async () => {
  const repo = await makeRepo();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await createSession(page, 'race');

    // Every eight milliseconds is faster than any real machine pushes, and that
    // is the point: if identity churn can lose the open, this finds it in one
    // run instead of one run in three.
    await stormHostPushes(agbrte, 8);
    await page.waitForTimeout(200);

    await page.click('[data-testid=runtime-trigger]');
    await expect(page.locator('[data-testid=runtime-list]')).toBeVisible({ timeout: 15_000 });

    // And it stays open. A list that appears and is then torn out by the next
    // push is the same defect one frame later, and an assertion that only looked
    // once would miss it.
    await page.waitForTimeout(600);
    await expect(page.locator('[data-testid=runtime-list]')).toBeVisible();
    await expect(
      page.locator('[data-testid=runtime-option][data-runtime="echo"]'),
    ).toBeVisible();

    await stopStorm(agbrte);
  } finally {
    await agbrte.close();
  }
});
