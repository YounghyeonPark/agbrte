/**
 * Choosing a palette, in the real app (DESIGN.md §4.1, §14).
 *
 * `themes.test.ts` measures every palette and is where the contrast argument
 * lives. What only a running app can show is the other half: that pressing one
 * of them changes the colours a person is actually looking at, that the choice
 * is still there after a reload, and that the default is what a fresh profile
 * gets.
 *
 * Asserted on **computed** colour rather than on a class or an attribute. The
 * theme is applied by setting custom properties on the root element, so a test
 * that checked `data-theme` would pass on a build where the variables were never
 * written — which is precisely the interesting way for this to break.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo } from './harness.js';

/** What the window is actually painted, as the browser resolved it. */
async function groundOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const view = globalThis as unknown as {
      document: { body: unknown };
      getComputedStyle: (el: unknown) => { backgroundColor: string };
    };
    return view.getComputedStyle(view.document.body).backgroundColor;
  });
}

async function openAbout(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
  await page.click('[data-testid=show-about]');
  await expect(page.locator('[data-testid=appearance]')).toBeVisible({ timeout: 20_000 });
}

test.describe('the palette is a choice', () => {
  test('opens on the default, and offers every theme', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await openAbout(page);

      // A fresh profile has stored nothing, so this is the default arriving from
      // `themeById`'s fallback rather than from anything remembered.
      await expect(page.locator('[data-theme-id=warm]')).toHaveAttribute('aria-pressed', 'true');
      // More than one, or the feature is a label.
      expect(await page.locator('[data-testid=theme-option]').count()).toBeGreaterThan(2);
    } finally {
      await agbrte.close();
    }
  });

  test('changes what is painted, and keeps it across a reload', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await openAbout(page);
      const before = await groundOf(page);

      await page.click('[data-theme-id=midnight]');
      /*
       * The ground actually moved. `toHaveAttribute` on the pressed state would
       * pass on a build that set `data-theme` and wrote no variables — a theme
       * picker that marks a choice and paints nothing.
       */
      await expect.poll(() => groundOf(page)).not.toBe(before);
      await expect(page.locator('[data-theme-id=midnight]')).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      const after = await groundOf(page);

      /*
       * And it survives. The choice is a *client* preference in `localStorage`,
       * so the thing that proves it is a reload rather than a navigation — and
       * it has to be applied before the first paint, which is why `startTheme`
       * runs in `main.tsx` rather than in an effect.
       */
      await page.reload();
      await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
      expect(await groundOf(page)).toBe(after);
    } finally {
      await agbrte.close();
    }
  });

  test('every theme paints a different ground from every other', async () => {
    /*
     * Four entries that look distinct in a list and resolve to the same colour
     * would be a picker that does nothing three times out of four, and nothing
     * in the unit tests can see it: they check each palette against *itself*.
     */
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await openAbout(page);

      const ids = await page
        .locator('[data-testid=theme-option]')
        .evaluateAll((els) =>
          els.map((el) => (el as unknown as { dataset: { themeId: string } }).dataset.themeId),
        );

      const grounds = new Set<string>();
      for (const id of ids) {
        await page.click(`[data-theme-id=${id}]`);
        await expect(page.locator(`[data-theme-id=${id}]`)).toHaveAttribute('aria-pressed', 'true');
        grounds.add(await groundOf(page));
      }
      expect(grounds.size, `${ids.length} themes painted ${grounds.size} grounds`).toBe(ids.length);
    } finally {
      await agbrte.close();
    }
  });
});
