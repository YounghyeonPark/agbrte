/**
 * The dashboard (§10, §15 Phase 4).
 *
 * Driven in a browser because the claim is about what a person can see at a
 * glance across several sessions, and that is a rendering fact. Sessions are
 * created through the CLI rather than by clicking: the creation flow has its own
 * coverage, and clicking three of them through the UI made this test about the
 * picker instead of the dashboard.
 */

import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { serveWebFixture } from './harness.js';

test('shows every session, with what needs a human first', async ({ page }) => {
  const web = await serveWebFixture();
  const titles = ['fix the parser', 'update the README', 'investigate the flake'];

  try {
    for (const title of titles) {
      execFileSync(
        process.execPath,
        [resolve('dist/cli/agbrte.js'), 'run', web.repo, '--runtime', 'echo', '--title', title, `work on ${title}`],
        { stdio: 'ignore' },
      );
    }

    await page.goto(web.url);
    await expect(page.locator('[data-testid=dashboard]')).toBeVisible({ timeout: 25_000 });

    // Every one of them, without opening anything. That is the whole point:
    // before this, "what is running" meant clicking through a list.
    const cards = page.locator('[data-testid=session-card]');
    await expect(cards).toHaveCount(titles.length);
    for (const title of titles) {
      await expect(page.locator(`[data-testid=session-card][data-title="${title}"]`)).toBeVisible();
    }

    // A finished turn leaves the session waiting on a person, so all three are
    // under Needs you — separated rather than merely sorted near the top.
    await expect(page.locator('[data-testid=needs-you]')).toBeVisible();
    await expect(page.locator('[data-testid=needs-you] [data-testid=session-card]')).toHaveCount(3);

    // With one host attached the badge would be the same string on every card,
    // so it is not drawn at all.
    await expect(page.locator('[data-testid=card-host]')).toHaveCount(0);

    // And a card opens its session.
    await page.locator(`[data-testid=session-card][data-title="fix the parser"]`).click();
    await expect(page.locator('[data-testid=composer-input]')).toBeVisible({ timeout: 20_000 });
  } finally {
    await web.stop();
  }
});
