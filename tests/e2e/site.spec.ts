/**
 * The landing page, in a browser (`docs/index.html`).
 *
 * Not an Electron test and the only spec here that is not. It uses the plain
 * `page` fixture against `file://`, because what is under test is a static page
 * and standing up a server to serve it would be testing the server.
 *
 * ## Why it exists at all
 *
 * The page was published with the glow behind its headline painted on a
 * pseudo-element inset `-6rem` at each side. On a desktop that is invisible and
 * correct. On a 390px phone it made the **whole document scroll sideways by 76
 * pixels** — on a page whose argument is that the app works from a phone.
 *
 * It is also a defect that cannot be found by walking the DOM for wide elements,
 * which is the obvious check and the one that was tried first: a pseudo-element
 * has no element to measure, so every `getBoundingClientRect` came back inside
 * the viewport while the document scrolled. The only thing that sees it is
 * `scrollWidth` against `clientWidth`, which is what this asserts.
 *
 * ## And the contract with the deploy
 *
 * `pages.yml` replaces two marked regions in this file with the real release.
 * A page that lost a marker would deploy green and quietly keep advertising
 * whatever was baked in last time — `scripts/site-release.mjs` throws rather
 * than allow that, and this is the half of the check that lives with the page.
 */

import { expect, test } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const PAGE = resolve(process.cwd(), 'docs/index.html');
const URL = pathToFileURL(PAGE).href;

/**
 * What the document scrolls past its own viewport, horizontally.
 *
 * Reached through `globalThis` rather than a bare `document`, because this file
 * is compiled by the node project and the callback runs in the page — the same
 * arrangement `screen.spec.ts` uses for an image's `naturalWidth`. Adding the
 * `dom` lib to make it read better would tell every other spec in the suite that
 * a browser's globals exist in the main process, which they do not.
 */
type Root = { documentElement: { scrollWidth: number; clientWidth: number } };
async function sideways(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    const root = (globalThis as unknown as { document: Root }).document.documentElement;
    return root.scrollWidth - root.clientWidth;
  });
}

test.describe('the landing page', () => {
  test('does not scroll sideways on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(URL);
    // After the images, since a picture that has not loaded has no width to
    // overflow with and would make this pass on an empty page.
    await page.waitForLoadState('load');

    expect(await sideways(page)).toBe(0);

    /*
     * And the effect that caused it is still there. Asserting only the absence
     * of overflow would be satisfied by deleting the glow, which is a fix that
     * passes the test and loses the feature.
     */
    const hero = page.locator('#hero');
    await expect(hero).toBeVisible();
    await expect(hero).toHaveCSS('position', 'relative');
  });

  test('does not scroll sideways on a narrow laptop either', async ({ page }) => {
    // 1024 is where the two-column hero row is about to fold, which is the width
    // a grid gets wrong when a `minmax` floor is larger than its share.
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.goto(URL);
    await page.waitForLoadState('load');

    expect(await sideways(page)).toBe(0);
  });

  test('holds the two regions the deploy replaces', async () => {
    /*
     * Read as text rather than through the DOM, because comments are what the
     * deploy searches for and a browser would not hand them back the same way.
     * Order matters as much as presence: `site-release.mjs` refuses a pair whose
     * end comes before its beginning, and this is where that would be introduced.
     */
    const html = await readFile(PAGE, 'utf8');
    for (const name of ['RELEASE', 'DOWNLOADS']) {
      const from = html.indexOf(`<!-- ${name}:BEGIN -->`);
      const to = html.indexOf(`<!-- ${name}:END -->`);
      expect(from, `${name}:BEGIN`).toBeGreaterThan(-1);
      expect(to, `${name}:END`).toBeGreaterThan(from);
    }
  });

  test('every download offered is a link with a file behind it', async ({ page }) => {
    await page.goto(URL);

    const tiles = page.locator('.dl');
    const count = await tiles.count();
    // The hand-written fallback in the repository has three; a deployed page has
    // one per published artifact. Either way, none of them may be decoration.
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const tile = tiles.nth(i);
      await expect(tile).toHaveAttribute('href', /^https:\/\/github\.com\//u);
      // A platform the script can mark, and a filename a person can recognise
      // in their downloads folder.
      await expect(tile).toHaveAttribute('data-os', /^(windows|mac|linux)$/u);
      await expect(tile.locator('.file')).not.toBeEmpty();
    }
  });

  test('opens a screenshot and closes it again', async ({ page }) => {
    await page.goto(URL);
    await page.waitForLoadState('load');

    const dialog = page.locator('#lightbox');
    await expect(dialog).toBeHidden();

    await page.locator('.frame').first().click();
    await expect(dialog).toBeVisible();
    // The picture, not an empty frame: `src` is set from the button rather than
    // left to whatever the markup shipped with.
    await expect(page.locator('#lb-img')).toHaveAttribute('src', /shots\/.+\.png$/u);
    await expect(page.locator('#lb-caption')).not.toBeEmpty();

    // Escape, which is the browser's to handle and the reason this is a real
    // `<dialog>` rather than a div with four listeners.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});
