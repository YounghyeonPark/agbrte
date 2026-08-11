/**
 * Screenshots of the real UI, for looking at it.
 *
 * Not an assertion suite — it asserts almost nothing on purpose. Design work
 * done by reading JSX is design work done blind, and this project has spent
 * enough of this session on things that were correct in source and wrong in
 * fact. These run the real web client against real sessions and write PNGs.
 *
 * Kept out of the default run by its `@shots` tag, because writing files is not
 * a test result and a suite that always writes 300 KB of images teaches people
 * to ignore its output.
 *
 *   npx playwright test shots --grep @shots
 */

import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { serveWebFixture } from './harness.js';

const OUT = resolve('.shots');

/** Sessions with the variety a dashboard actually has to render. */
const TITLES = [
  'fix the parser',
  'update the README',
  'investigate the flake in detachedHost',
  'a title that is quite a lot longer than the others, to see what the card does with it',
];

test.describe('@shots', () => {
  test('captures the app at the sizes people use it', async ({ page }) => {
    test.setTimeout(180_000);
    await mkdir(OUT, { recursive: true });
    const web = await serveWebFixture();

    try {
      for (const title of TITLES) {
        execFileSync(
          process.execPath,
          [
            resolve('dist/cli/agbrte.js'),
            'run',
            web.repo,
            '--runtime',
            'echo',
            '--title',
            title,
            `work on ${title}`,
          ],
          { stdio: 'ignore' },
        );
      }

      // Desktop first, which is where the app is mostly used.
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(web.url);
      await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/01-dashboard.png` });

      // A session opened: the transcript, the roster, the composer.
      const card = page.locator('[data-testid=session-card]').first();
      if (await card.isVisible()) {
        await card.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: `${OUT}/02-session.png` });
      }

      // The phone shape, which §12 and the CSS both take seriously.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(web.url);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${OUT}/03-phone.png` });
    } finally {
      await web.stop();
    }
  });
});
