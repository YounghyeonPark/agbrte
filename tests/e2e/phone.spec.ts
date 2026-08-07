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
import { serveWebFixture } from './harness.js';

test.use({ ...devices['iPhone 14 Pro Max'] });

test('shows one pane at a time, at a readable size', async ({ page }) => {
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

    // The list owns the screen while nothing is open. The desktop's fixed 300px
    // sidebar would leave about 90px for everything else.
    const sidebar = page.locator('[data-testid=host]');
    await expect(sidebar).toBeVisible({ timeout: 20_000 });
    expect((await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(width * 0.8);

    await page.locator('[data-testid=new-session]').click();
    await page.locator('[data-testid=new-title]').fill('on a phone');
    await page.locator('[data-testid=new-submit]').click();
    await expect(page.locator('[data-testid=picker]')).toBeVisible({ timeout: 20_000 });

    // Opening a session hands it the whole screen, and there is a way back —
    // without which a phone user is stuck in the first session they open.
    await expect(page.locator('[data-testid=back-to-list]')).toBeVisible();
    await page.locator('[data-testid=back-to-list]').click();
    await expect(page.locator('[data-testid=host]')).toBeVisible();
  } finally {
    await web.stop();
  }
});
