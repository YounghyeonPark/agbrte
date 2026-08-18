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
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

/**
 * The two workspace rails, on a screen with no room for three columns.
 *
 * The desktop arrangement is transcript | tree | file, and it needs about
 * 1024px to exist: the host sidebar is a fixed 300px and the viewer's floor is
 * 320. Below that the rails are **overlays and take the pane one at a time**,
 * which is the same "one pane at a time" rule the two tests above assert for the
 * session list — applied one level in.
 *
 * Asserted on painted width rather than on visibility, because a 224px column
 * squeezed against a 430pt transcript is *visible* too, and it is precisely the
 * failure this rule exists to prevent. And the overlay covers the whole session
 * column, mode toggle included: that row's job is to say what is in the main
 * pane, and a row left on screen saying `Chat` over a file would be the one
 * piece of chrome whose only job is to be right about this, wrong.
 */
test('gives the pane to one rail at a time, with no room for three columns', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    // Something to open. `makeRepo` is a bare `git init`, so without this the
    // root listing is two directories and there is no file to click.
    await writeFile(join(web.repo, 'phone.txt'), 'read on a phone\n');
    execFileSync(
      process.execPath,
      [resolve('dist/cli/agbrte.js'), 'run', web.repo, '--runtime', 'echo', '--title', 'narrow', 'go'],
      { stdio: 'ignore' },
    );

    await page.goto(web.url);
    await expect(page.locator('[data-testid=session-card]')).toBeVisible({ timeout: 25_000 });
    await page.locator('[data-testid=session-card]').click();
    await expect(page.locator('[data-testid=composer-input]')).toBeVisible({ timeout: 20_000 });

    const width = page.viewportSize()?.width ?? 0;

    // The tree takes the screen, rather than a 224px slice of it.
    await page.locator('[data-testid=toggle-files]').click();
    const tree = page.locator('[data-testid=file-browser]');
    await expect(tree).toBeVisible();
    expect(Math.abs(((await tree.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1);

    // One at a time, and the one that wins is the one just asked for by name.
    await tree.locator('[data-testid=file-tree-file][data-path="phone.txt"]').click();
    const viewer = page.locator('[data-testid=file-viewer]');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('[data-testid=file-viewer-text]')).toContainText('read on a phone');
    await expect(tree).toBeHidden();
    expect(Math.abs(((await viewer.boundingBox())?.width ?? 0) - width)).toBeLessThanOrEqual(1);

    // There is nothing to drag when a rail is the whole screen, so the handle
    // is not offered — an affordance that cannot do anything is worse than none.
    await expect(page.locator('[data-testid=file-viewer-resize]')).toBeHidden();

    // Closing the file comes back to the tree rather than to the transcript:
    // the toggle was never turned off, so nothing has to be pressed twice.
    await page.locator('[data-testid=file-viewer-close]').click();
    await expect(viewer).toHaveCount(0);
    await expect(tree).toBeVisible();

    // And hiding the tree gives the screen back to the session.
    await page.locator('[data-testid=file-browser-close]').click();
    await expect(tree).toHaveCount(0);
    await expect(page.locator('[data-testid=composer-input]')).toBeVisible();
  } finally {
    await web.stop();
  }
});
