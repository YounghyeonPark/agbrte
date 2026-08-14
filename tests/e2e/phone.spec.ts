/**
 * The same page on a phone (§10, §17 Q13).
 *
 * Its own file because Playwright will not let a describe block change the
 * browser engine, and this has to run in WebKit: the failure that made the web
 * client unusable was engine- and size-specific. Without a viewport meta tag,
 * mobile Safari lays out at 980 CSS pixels and scales the result down, so every
 * media query matches the desktop branch. A desktop browser resized to 390px does
 * **not** reproduce that — which is exactly why it shipped.
 */

import { devices, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { serveWebFixture } from './harness.js';

test.use({ ...devices['iPhone 14 Pro Max'] });

test('lays out at the device width, one pane at a time', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    await page.goto(web.url);
    await expect(page.locator('[data-testid=app]')).toBeVisible();

    // The tag itself, because everything below depends on it.
    expect(await page.locator('meta[name=viewport]').getAttribute('content')).toContain(
      'width=device-width',
    );

    const width = page.viewportSize()?.width ?? 0;
    expect(width).toBeLessThan(500);

    // The main pane owns the screen. The desktop's fixed 300px sidebar would
    // leave about 90px for everything else, so below `md` exactly one shows —
    // and the one worth showing is where the dashboard and the welcome are.
    const main = page.locator('[data-testid=welcome]');
    await expect(main).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid=host]')).toBeHidden();

    // The hosts pane is reachable, since it holds the only way to start a
    // session or attach a machine.
    await page.locator('[data-testid=show-hosts]').click();
    await expect(page.locator('[data-testid=host]')).toBeVisible();
    await expect(main).toBeHidden();
  } finally {
    await web.stop();
  }
});

test('opens a session full-screen, and comes back to the dashboard', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    // Made through the CLI: what is under test is the phone's navigation, and
    // clicking a session into existence would make it about the picker.
    execFileSync(
      process.execPath,
      [resolve('dist/cli/agbrte.js'), 'run', web.repo, '--runtime', 'echo', '--title', 'on a phone', 'go'],
      { stdio: 'ignore' },
    );

    await page.goto(web.url);
    // A session exists, so the dashboard is what is useful rather than the guide.
    await expect(page.locator('[data-testid=dashboard]')).toBeVisible({ timeout: 25_000 });
    await expect(page.locator('[data-testid=session-card]')).toHaveCount(1);

    await page.locator('[data-testid=session-card]').click();
    await expect(page.locator('[data-testid=composer-input]')).toBeVisible({ timeout: 20_000 });
    // Full screen: the list is not competing for a 390pt display.
    await expect(page.locator('[data-testid=dashboard]')).toBeHidden();

    // And there is a way back — without which a phone user is stuck in the first
    // session they open.
    await page.locator('[data-testid=back-to-list]').click();
    await expect(page.locator('[data-testid=dashboard]')).toBeVisible();
  } finally {
    await web.stop();
  }
});
