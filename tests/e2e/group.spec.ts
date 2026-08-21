/**
 * Which group a session is in, where a person is looking for it (§17 Q22).
 *
 * A group is a set of sessions that can reach each other, and until now the
 * only place it appeared was inside the session that was already open — folded,
 * at that. So the answer to "which of these belong together" was: open them one
 * at a time and remember. The sidebar is where that question is actually asked,
 * because the sidebar is the list of everything.
 *
 * Two halves, and the second is the one with a trap in it. A session that is
 * *open* knows its group from the log it folded. A session sitting on disk,
 * never opened in this window, knows nothing — and folding every log on the
 * machine to label a row would be a page load per sidebar. So the host copies
 * the group into `session.json` as a hint (§6.4's sense) and reports it with the
 * on-disk list. This spec drives the panel that changes it and reads the rows
 * that show it, which is the only place the two halves meet.
 */

import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession, openSession } from './actions.js';

test.describe('a session says which group it is in', () => {
  test('labels both sessions in the sidebar, and stops when one leaves', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;

    try {
      await createSession(page, 'the parser');
      await addAgent(page, 'echo');

      // The second one by hand: with a choice remembered for this host the
      // picker no longer shows, which is exactly the assertion `createSession`
      // makes (see its own note, and `app.spec.ts`).
      const host = page.locator('[data-testid=host]').first();
      await host.locator('[data-testid=new-session]').click();
      await host.locator('[data-testid=new-title]').fill('the API work');
      await host.locator('[data-testid=new-submit]').click();
      await expect(page.locator('[data-testid=session-title]')).toHaveText('the API work');

      // Nothing is grouped yet, and the sidebar says nothing rather than
      // "ungrouped": a row with a label saying it has none is noise on every
      // row in an app where most sessions are in no group at all.
      await expect(page.locator('[data-testid=session-group]')).toHaveCount(0);

      /*
       * Opened rather than toggled.
       *
       * The panel lives inside the composer's box, folded, because a group is a
       * handful of lines in a session that may run for days — and the `<details>`
       * is the same element across a session switch, so a blind second click
       * *closes* the fold the first one opened. Asking first is the difference
       * between driving the UI and hoping about it.
       */
      const fold = page.locator('[data-testid=group]');
      const openFold = async (): Promise<void> => {
        if ((await fold.getAttribute('open')) === null) await fold.locator('summary').click();
        await expect(fold).toHaveAttribute('open', '');
      };
      await openFold();
      await page.selectOption('[data-testid=group-pick]', { label: 'the parser' });
      await page.fill('[data-testid=group-name]', 'the migration');
      await page.click('[data-testid=group-add]');

      /*
       * Both rows, not one.
       *
       * The session that pressed the button is open and learns its group from
       * its own state; the other one is a row in the sidebar that this window
       * may never have opened. They arrive by different routes and the point of
       * the feature is that a person cannot tell.
       */
      const labels = page.locator('[data-testid=session-group]');
      await expect(labels).toHaveCount(2);
      await expect(labels.first()).toHaveAttribute('data-group', 'the migration');

      // And leaving takes the label with it, or the sidebar keeps advertising a
      // group that is no longer true until somebody opens the session to find
      // out.
      await openSession(page, 'the API work');
      // The pane has to have switched before the fold is touched: for a beat
      // after the click the *previous* session's panel is still mounted, and a
      // summary clicked then opens the one that is going away.
      await expect(page.locator('[data-testid=session-title]')).toHaveText('the API work');
      await openFold();
      await expect(page.locator('[data-testid=group-leave]')).toBeVisible();
      await page.click('[data-testid=group-leave]');
      await expect(page.locator('[data-testid=session-group]')).toHaveCount(1);
    } finally {
      await agbrte.close();
      // Retried the way `shell.spec.ts` does: a host outlives the window that
      // closed it, and a temp directory it still holds answers EBUSY.
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });
});
