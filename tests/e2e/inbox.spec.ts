/**
 * The inbox, on screen (DESIGN.md §11, §15 Phase 4).
 *
 * The fold is covered by unit tests, including across a restart; the host hop is
 * covered in `sessionHost.test.ts`. What is left is the last few metres — IPC,
 * store, render — and a component nobody can open is worth exactly as much as
 * one that was never written.
 *
 * The empty state carries real weight here and is asserted deliberately. An
 * inbox is empty most of the time, so "nothing yet" is the view most people see
 * most often, and if it does not explain what *would* appear it reads as broken
 * rather than as quiet.
 */

import { expect, test } from '@playwright/test';
import { serveWebFixture } from './harness.js';

test('opens, explains itself when empty, and closes', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    await page.goto(web.url);

    const toggle = page.locator('[data-testid=inbox-toggle]');
    await expect(toggle).toBeVisible({ timeout: 25_000 });

    // Nothing notable has happened in a fresh workspace, so there is no badge.
    // A count of zero rendered as a badge would be a permanent false alarm.
    await expect(page.locator('[data-testid=inbox-badge]')).toHaveCount(0);

    await toggle.click();
    const list = page.locator('[data-testid=inbox-list]');
    await expect(list).toBeVisible();
    await expect(list).toContainText('while this was closed');

    await toggle.click();
    await expect(list).toBeHidden();
  } finally {
    await web.stop();
  }
});
