/**
 * The settings pane, in the real app (DESIGN.md §7, §4.1, §4.2, §14).
 *
 * `themes.test.ts` measures every palette and is where the contrast argument
 * lives. What only a running app can show is the other half: that pressing one
 * of them changes the colours a person is actually looking at, that the choice
 * is still there after a reload, and that the default is what a fresh profile
 * gets.
 *
 * The rest of the pane is settings that did not exist rather than settings that
 * moved — see the second describe.
 *
 * Asserted on **computed** colour rather than on a class or an attribute. The
 * theme is applied by setting custom properties on the root element, so a test
 * that checked `data-theme` would pass on a build where the variables were never
 * written — which is precisely the interesting way for this to break.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession } from './actions.js';

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

async function openSettings(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
  await page.click('[data-testid=show-settings]');
  await expect(page.locator('[data-testid=appearance]')).toBeVisible({ timeout: 20_000 });
}

test.describe('the palette is a choice', () => {
  test('opens on the default, and offers every theme', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await openSettings(page);

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
      await openSettings(page);
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
      await openSettings(page);

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

/**
 * The two preferences that had no control at all (DESIGN.md §7, §4.2).
 *
 * These are not moved settings; they are settings that did not exist. One
 * successful add teaches a host its default and every zero-agent session there
 * is seated before the picker can be shown — correct behaviour that nothing
 * announced and nothing could undo, so a person who tried one agent once was
 * given it forever. `machines.ts` had a `forgetMachine` from the day it was
 * written and no caller, so the ssh aliases this app offers only ever grew.
 */
test.describe('what this client remembers', () => {
  test('says nothing is remembered before anything is', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await openSettings(page);

      /*
       * Said rather than left blank. An empty settings section is
       * indistinguishable from one that is broken, and this one is explaining a
       * behaviour somebody has not met yet — the first add is about to teach it.
       */
      const none = page.locator('[data-testid=no-defaults]');
      await expect(none).toBeVisible();
      await expect(none).toContainText('remembered');
      await expect(page.locator('[data-testid=remembered-default]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

  test('lists what a host will seat, and lets it be asked again', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      // Seating an agent is what teaches the default — the same path a person
      // takes, rather than writing the storage key by hand.
      await createSession(page, 'teaches the default');
      await addAgent(page, 'echo');

      await openSettings(page);
      const row = page.locator('[data-testid=remembered-default]');
      await expect(row).toHaveCount(1);
      // Named by what it will *do*. A list of instance ids would be a settings
      // page nobody can act on.
      await expect(row).toContainText('echo');

      await row.locator('[data-testid=forget-default]').click();
      await expect(row).toHaveCount(0);
      await expect(page.locator('[data-testid=no-defaults]')).toBeVisible();

      /*
       * And the next session asks again, which is the whole claim.
       *
       * A row disappearing proves the list re-read itself; it does not prove the
       * behaviour changed. Without this a control that removed the row and left
       * the stored value would pass — and the person who pressed it would get
       * the same agent seated silently on the very next session, which is the
       * thing they were trying to stop.
       */
      await page.click('[data-testid=show-settings]');
      await createSession(page, 'asks again');
      await expect(page.locator('[data-testid=picker]')).toBeVisible({ timeout: 20_000 });
    } finally {
      await agbrte.close();
    }
  });
});
