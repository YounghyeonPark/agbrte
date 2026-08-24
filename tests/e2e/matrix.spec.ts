/**
 * The support matrix, on screen (DESIGN.md §3.13, §15 Phase 3).
 *
 * > Results publish as a **support matrix in the app**, so choosing a runtime
 * > shows what it can actually do here.
 *
 * The unit tests prove the merge never collapses verified, declared and not-run.
 * What they cannot prove is that any of it survives the trip: report on disk →
 * host probe → IPC → store → render. This runs the real app against the real
 * report the suite wrote, so a broken join between a recorded `runtimeId` and
 * the id a registry hands out fails here rather than showing a plausible column
 * of "not run" that nobody questions.
 */

import { expect, test } from '@playwright/test';
import { serveWebFixture } from './harness.js';

test('shows what the chosen runtime has actually been proven to do', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    await page.goto(web.url);

    // Reach the picker, which is where the question is asked.
    const group = page.locator('[data-testid=host]').first();
    await group.locator('[data-testid=new-session]').click({ timeout: 25_000 });
    await group.locator('[data-testid=new-title]').fill('choosing a runtime');
    await group.locator('[data-testid=new-folder]').fill('');
    await group.locator('[data-testid=new-submit]').click();
    await expect(page.locator('[data-testid=picker]')).toBeVisible();

    await page.click('[data-testid=runtime-trigger]');
    await page.click('[data-testid=runtime-option][data-value="echo"]');

    const matrix = page.locator('[data-testid=support-matrix]');
    await expect(matrix).toBeVisible();

    // The headline counts runs, not claims.
    await expect(matrix).toContainText(/\d+ of \d+ scenarios verified/);

    await matrix.locator('summary').click();

    // A scenario the suite really ran against this adapter.
    const verified = matrix.locator('[data-testid=scenario-stream-before-send] [data-status]');
    await expect(verified).toHaveAttribute('data-status', 'verified');

    // And one nobody has written yet, which must not read as either a pass or a
    // failure. The gap being visible is the reason the catalogue carries rows
    // with no test behind them.
    const gap = matrix.locator('[data-testid=scenario-cost-accuracy] [data-status]');
    await expect(gap).not.toHaveAttribute('data-status', 'verified');
  } finally {
    await web.stop();
  }
});
