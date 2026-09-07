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
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession, openSession } from './actions.js';

test.describe('a session gets a folder of its own', () => {
  test('makes one beside the folder this host has open', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;
    /** The sibling this test creates, removed with the workspace it sat beside. */
    let made: string | null = null;

    try {
      await createSession(page, 'in the workspace');
      await addAgent(page, 'echo');

      /*
       * From the host row, which is where most sessions are made.
       *
       * One session, one folder (§8) held everywhere except here: this form
       * only ever created a session *in the workspace already open*, because
       * that is what a host row is about. A real session therefore ended up on
       * top of somebody's `~/Desktop` — the folder the machine had been attached
       * to — with no way to ask for anything else without leaving the panel.
       */
      /*
       * A name of this run's own.
       *
       * The folder is a *sibling* of the workspace, and this suite's workspaces
       * live in `os.tmpdir()` — so a fixed name is one directory shared by every
       * run on this machine, which is exactly what the first version of this
       * test did: three repeats produced three, four, then five sessions in it.
       * Real use has the same shape and is fine, because a person's projects
       * directory is theirs; a test's parent is everybody's.
       */
      const folder = `parser-rewrite-${Date.now().toString(36)}`;
      made = join(repo, '..', folder);

      const host = page.locator('[data-testid=host]').first();
      await host.locator('[data-testid=new-session]').click();
      await host.locator('[data-testid=new-title]').fill('its own place');

      /*
       * Filled by typing the title, which is the part that matters.
       *
       * An *optional* folder field left the default where it had always been —
       * another session in whatever folder this host has open — so a machine
       * attached to `~/Desktop` kept putting sessions on somebody's desktop and
       * the field read as a feature nobody needed. A rule that is offered is not
       * a rule.
       */
      await expect(host.locator('[data-testid=new-folder]')).toHaveValue('its-own-place');

      // Overwritten here only because this suite's workspaces are siblings in
      // `os.tmpdir()`, which every run on this machine shares.
      await host.locator('[data-testid=new-folder]').fill(folder);

      // A sibling of the open folder, not a child: nesting one workspace inside
      // another puts a session's store inside somebody's project.
      await expect(host.locator('[data-testid=new-folder-target]')).toContainText(folder);
      await expect(host.locator('[data-testid=new-folder-target]')).not.toContainText(
        `${repo.split(/[\/]/).pop()!}/${folder}`,
      );

      await host.locator('[data-testid=new-submit]').click();

      /*
       * Still one row, because a row is a **machine** (§8) — and now two folders
       * under it, which is what the header counts and what each session says.
       *
       * This asserted a second row, from the shape the sidebar had while it was
       * drawn per workspace: a folder of one's own then looked like a second
       * machine with the same name, which is exactly the confusion that made the
       * grouping change.
       */
      await expect(page.locator('[data-testid=host]')).toHaveCount(1);
      await expect(page.locator('[data-testid=host]')).toContainText('2 folders');
      const row = page.locator('[data-testid=session][data-title="its own place"]');
      await expect(row).toBeVisible();
      // The folder is said on the session, which is the only place it can be
      // said once the row is the machine.
      await expect(row.locator('[data-testid=session-folder]')).toHaveText(folder);
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
      if (made !== null) {
        await rm(made, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
      }
    }
  });

  test('still puts one in this workspace when the folder is cleared', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;

    try {
      await createSession(page, 'first');
      await addAgent(page, 'echo');

      const host = page.locator('[data-testid=host]').first();
      await host.locator('[data-testid=new-session]').click();
      await host.locator('[data-testid=new-title]').fill('alongside');
      // Emptying the field is how somebody says "in this workspace", which is a
      // real thing to want: several sessions on one project is ordinary.
      await host.locator('[data-testid=new-folder]').fill('');
      await expect(host.locator('[data-testid=new-folder-target]')).toContainText(repo);
      await host.locator('[data-testid=new-submit]').click();

      // One host, two sessions — no folder was made.
      await expect(page.locator('[data-testid=host]')).toHaveCount(1);
      await expect(page.locator('[data-testid=session][data-title="alongside"]')).toBeVisible();
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });

  /**
   * The field says where, and a full path is where.
   *
   * The default — beside the folder this host has open — is right, and it used
   * to be the only answer available: a leading separator was stripped, so a
   * typed absolute path came back rooted under a directory nobody had named.
   * Nothing was created here, so the assertion is on the line under the field,
   * which is the promise the form makes before anything happens on a machine.
   *
   * Both fields are labelled now, and that is the other half of what this is
   * about: filled from the title, the folder box was a second copy of the box
   * above it with nothing saying it was the folder.
   */
  test('takes a full path as written, and says which box is which', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;

    try {
      const host = page.locator('[data-testid=host]').first();
      await host.locator('[data-testid=new-session]').click();
      await host.locator('[data-testid=new-title]').fill('somewhere else');

      // Which box is the folder, in the form itself.
      await expect(host.getByText('folder for it', { exact: false })).toBeVisible();

      // Auto-filled from the title, and then changed — the thing the form is
      // for. Not submitted: no directory is created by this test.
      await expect(host.locator('[data-testid=new-folder]')).toHaveValue('somewhere-else');
      const full = process.platform === 'win32' ? 'D:\\srv\\picked' : '/srv/picked';
      await host.locator('[data-testid=new-folder]').fill(full);

      await expect(host.locator('[data-testid=new-folder-target]')).toHaveText(
        `will create ${full}`,
      );
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });
});

test.describe('renaming a session from the sidebar', () => {
  test('renames the one that is open and the one that is not', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;

    try {
      await createSession(page, 'untitled work');
      await addAgent(page, 'echo');

      /*
       * Its own control, hidden until the row is hovered.
       *
       * Double-click was the first shape and it did not survive contact: a row
       * is a button that opens the session, and the two clicks a double-click
       * is made of opened the very session being renamed — which for a row that
       * is only on disk means starting a host to rename it.
       */
      const row = page.locator('[data-testid=session][data-title="untitled work"]').locator('..');
      await row.hover();
      await row.locator('[data-testid=session-rename-start]').click();
      await page.fill('[data-testid=session-rename]', 'the parser rewrite');
      await page.keyboard.press('Enter');
      await expect(
        page.locator('[data-testid=session][data-title="the parser rewrite"]'),
      ).toBeVisible();

      /*
       * And the case that makes this worth having: a session nobody has opened.
       *
       * A folder full of last month's work is exactly the list somebody wants to
       * tidy, and opening each row to do it would start a host per row. The
       * second session here is created and then left alone; the app is restarted
       * so it comes back as a row on disk rather than a loaded one.
       */
      const host = page.locator('[data-testid=host]').first();
      await host.locator('[data-testid=new-session]').click();
      await host.locator('[data-testid=new-title]').fill('also untitled');
      await host.locator('[data-testid=new-folder]').fill('');
      await host.locator('[data-testid=new-submit]').click();
      await expect(page.locator('[data-testid=session-title]')).toHaveText('also untitled');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });

  test('renames a session this window never opened', async () => {
    const repo = await makeRepo();
    const first = await launch(repo);
    try {
      await createSession(first.window, 'made earlier');
      await addAgent(first.window, 'echo');
    } finally {
      await first.close();
    }

    // A second window over the same folder: the session is on disk and nothing
    // here has opened it, which is the state most of a sidebar is in.
    const agbrte = await launch(repo);
    const page = agbrte.window;
    try {
      const row = page
        .locator('[data-testid=session][data-title="made earlier"]')
        .locator('..');
      await expect(row).toBeVisible({ timeout: 25_000 });
      await row.hover();
      await row.locator('[data-testid=session-rename-start]').click();
      await page.fill('[data-testid=session-rename]', 'renamed without opening');
      await page.keyboard.press('Enter');

      await expect(
        page.locator('[data-testid=session][data-title="renamed without opening"]'),
      ).toBeVisible();
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });
});

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
      // In this workspace: a group is about two sessions reaching each other,
      // and putting the second one in a folder of its own is a different test.
      await host.locator('[data-testid=new-folder]').fill('');
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

/*
 * Grouping from the rail, which is where somebody looking at several sessions
 * already is (DESIGN.md §17 Q22, §7, §3.5).
 *
 * Before this, a group was made from *inside* an open session: open one, find
 * the group panel, pick a second from a dropdown, repeat. The sessions being
 * grouped are all sitting in the sidebar together, and that is where the
 * gesture belongs.
 *
 * Three ways in and one place they arrive: modifier-click for a mouse,
 * right-click for the menu habit, and a long press for touch — because §7 puts
 * this app on a phone and the first two do not exist there. A feature reachable
 * only through a pointer half the clients do not have is §3.5's shape.
 *
 * **Rows are addressed by title, never by index.** The rail re-sorts as
 * sessions change — `byAttentionThenRecency` — so `nth(0)` is a different
 * session before and after almost anything. An index-based first draft of this
 * test clicked the same row twice, toggled it back off, and reported a
 * selection of two where three were expected: the assertion was wrong about the
 * app rather than the app being wrong.
 */
test('groups sessions picked in the rail, and ungroups them again', async () => {
  const agbrte = await launch(await makeRepo());

  try {
    const page = agbrte.window;
    for (const title of ['alpha', 'beta', 'gamma']) await createSession(page, title);
    await page.waitForSelector('[data-testid=session]', { timeout: 30_000 });

    const row = (title: string) =>
      page.locator(`[data-testid=host] [data-testid=session][data-title="${title}"]`);
    const bar = page.locator('[data-testid=selection-bar]');
    // Nothing until something is picked: the rail is navigation first, and a
    // bar over an empty selection is a control with no subject.
    await expect(bar).toHaveCount(0);

    /*
     * The touch way in, and the one that had to be built rather than borrowed.
     * A press that selects must not also open — a phone has no second button to
     * mean "not that" with, so the click it generates is swallowed once.
     */
    await row('alpha').dispatchEvent('pointerdown', { pointerType: 'touch', button: 0 });
    await page.waitForTimeout(700);
    await row('alpha').dispatchEvent('pointerup', { pointerType: 'touch', button: 0 });
    await expect(bar).toContainText('1 selected');
    /*
     * And the press did not *also* open what it picked.
     *
     * Asserted as "the open session is still the one that was open", not as
     * "nothing is open": `createSession` leaves its session open, so a check for
     * an empty pane would pass whatever this gesture did.
     */
    await expect(page.locator('[data-testid=session-title]')).toHaveText('gamma');

    // Ctrl or cmd adds one; shift takes the range and *keeps* what was picked,
    // which is the half that differs from a file manager. See `pick`.
    await row('beta').click({ modifiers: ['ControlOrMeta'] });
    await expect(bar).toContainText('2 selected');
    await row('gamma').click({ modifiers: ['Shift'] });
    await expect(bar).toContainText('3 selected');

    // A new group needs a name, and there is nowhere to ask for one but here:
    // the renderer has no `window.prompt` under Electron.
    await page.click('[data-testid=group-selected]');
    await page.fill('[data-testid=group-name]', 'the sweep');
    await page.click('[data-testid=group-confirm]');

    const tags = page.locator('[data-testid=host] [data-testid=session-group]');
    await expect(tags).toHaveCount(3, { timeout: 20_000 });
    // One command carried the whole set. Grouping them one at a time could stop
    // halfway and leave a group whose other half never joined — which is why the
    // wire takes a list, and why this asserts on all three rather than on one.
    for (const text of await tags.allTextContents()) expect(text).toContain('the sweep');

    /*
     * Right-click picks the row it lands on when that row is not already in the
     * selection — the one thing a context menu must never get wrong is acting on
     * a set the pointer is not over.
     */
    await row('beta').click({ button: 'right' });
    await expect(bar).toContainText('1 selected');
    // With a group in the selection the bar offers to join it by name, rather
    // than asking for a name that would quietly rename what already exists.
    await expect(bar).toContainText('Add to the sweep');

    await page.click('[data-testid=ungroup-selected]');
    await expect(tags).toHaveCount(2, { timeout: 20_000 });

    /*
     * And a mouse held on a row still opens it.
     *
     * Holding a button for half a second is not a gesture anybody performs on
     * purpose with a mouse, and is one people perform by accident constantly.
     * It also made this suite flaky: under parallel load the gap between
     * `pointerdown` and `click` can pass the threshold, so a test that meant to
     * open a session picked it instead.
     */
    // `delay` rather than a hand-driven down/up pair: the rail re-sorts after
    // the ungroup above, and coordinates taken before that settles land on
    // whichever row moved into them.
    await row('alpha').click({ delay: 700 });
    await expect(page.locator('[data-testid=session-title]')).toHaveText('alpha', {
      timeout: 15_000,
    });
    // Opening clears what was picked, so the bar goes rather than going stale.
    await expect(bar).toHaveCount(0);
  } finally {
    await agbrte.close();
  }
});
