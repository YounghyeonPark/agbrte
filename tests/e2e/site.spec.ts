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

  test('reserves exactly the space each screenshot needs', async ({ page }) => {
    /*
     * `width` and `height` on an `<img>` exist to hold the right space before the
     * picture arrives. Three of the five were written from memory rather than
     * measured — `01-dashboard` was declared 1440x900 and is 1440x560 — so every
     * one of them jumped the page as it loaded, and two shots that should have
     * been the same height in a paired row were not.
     *
     * Asserted against the browser's own decode rather than against a file read,
     * because `naturalWidth` is the number the layout will actually use. It is
     * also the check that catches the drift nobody would look for: the shots are
     * regenerated by `shots.spec.ts`, and a changed viewport there silently makes
     * every attribute here wrong.
     */
    await page.goto(URL);
    await page.waitForLoadState('load');

    const images = page.locator('.frame img');
    const count = await images.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const got = await images.nth(i).evaluate((el) => {
        const img = el as unknown as {
          currentSrc: string;
          naturalWidth: number;
          naturalHeight: number;
          getAttribute: (name: string) => string | null;
        };
        return {
          src: img.currentSrc,
          natural: [img.naturalWidth, img.naturalHeight],
          declared: [Number(img.getAttribute('width')), Number(img.getAttribute('height'))],
        };
      });
      expect(got.declared, got.src).toEqual(got.natural);
    }
  });

  test('gives each section its own ground', async ({ page }) => {
    /*
     * Six bands, and every neighbour a different colour: that is what makes
     * scrolling read as moving between sections rather than down one long page.
     *
     * Sampled in the left gutter rather than asserted against the stylesheet,
     * because what matters is the ground a reader actually sees — a band whose
     * colour is set and then covered by something else would pass a CSS check
     * and fail the eye.
     */
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(URL);
    await page.waitForLoadState('load');

    const grounds = await page.locator('.band').evaluateAll((els) => {
      // Through `globalThis`, like `sideways` above: this file is compiled by the
      // node project, which has no browser globals, and the callback runs in the
      // page where they are the only ones there are.
      const view = globalThis as unknown as {
        getComputedStyle: (el: unknown) => { backgroundColor: string };
      };
      return els.map((el) => view.getComputedStyle(el).backgroundColor);
    });
    expect(grounds.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < grounds.length; i += 1) {
      expect(grounds[i], `band ${i} against the one above it`).not.toBe(grounds[i - 1]);
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

test.describe('without the script', () => {
  // The claim the reveal rests on, and the one it would be easiest to break.
  test.use({ javaScriptEnabled: false });

  test('shows every section rather than empty coloured bands', async ({ page }) => {
    /*
     * The hidden state is applied by the script, never by the stylesheet. Get
     * that backwards and a visitor with JavaScript off is served five empty
     * rectangles — the page having carefully arranged for its own content to be
     * invisible.
     */
    await page.goto(URL);

    /*
     * Opacity, not the absence of the attribute — and the difference is a real
     * false pass this test had.
     *
     * The first version asserted `.band[data-hidden]` was empty, which is
     * trivially true with no script: nothing had put the attribute on. Hiding
     * every `.inner` in the stylesheet, which is precisely the mistake, sailed
     * straight through it. `toBeVisible` would not have caught it either, since
     * an element at `opacity: 0` still has a box. So the claim is measured as
     * what it actually is: the content is opaque.
     */
    const opacity = await page.locator('.band .inner').evaluateAll((els) => {
      const view = globalThis as unknown as {
        getComputedStyle: (el: unknown) => { opacity: string };
      };
      return els.map((el) => view.getComputedStyle(el).opacity);
    });
    expect(opacity.length).toBeGreaterThanOrEqual(5);
    expect(opacity.every((o) => Number(o) === 1), opacity.join(',')).toBe(true);

    // And the parts that are markup rather than script: the name, the version
    // and the downloads are all there without anything running.
    await expect(page.locator('#hero h1')).toContainText('Agent Bridge Terminal');
    await expect(page.locator('.release')).toBeVisible();
    await expect(page.locator('.dl').first()).toBeVisible();
  });
});

test.describe('with motion withdrawn', () => {
  test('neither hides a section nor lights anything under the pointer', async ({ page }) => {
    /*
     * `prefers-reduced-motion` is set by people for whom motion causes symptoms,
     * and the failure mode here is worse than an unwanted animation: a reveal
     * that hides sections and then declines to un-hide them is a blank page.
     */
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Emulated on the page rather than declared with `test.use`, and before the
    // navigation: the script reads the preference once, as it runs, so setting it
    // after `goto` would test a page that had already decided.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(URL);
    await page.mouse.move(520, 420);
    await page.waitForTimeout(300);

    await expect(page.locator('.band[data-hidden]')).toHaveCount(0);
    await expect(page.locator('.lit')).toHaveCount(0);
  });
});
