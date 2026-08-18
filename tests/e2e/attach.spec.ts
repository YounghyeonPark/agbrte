/**
 * Attaching a remote without knowing the path (DESIGN.md §6.2).
 *
 * The panel used to ask for a machine and then an absolute path typed from
 * memory. This drives the replacement through the real app: the real renderer,
 * the real preload, the real IPC and the real `localStorage` — with only the
 * *machine* stubbed, because the one thing this checkout cannot have is a remote.
 *
 * **Stubbed in main, not in the page.** The discovery handler is replaced on
 * `ipcMain`, so everything under test is the shipping code: the trigger, the
 * store action, the grouping, the fallback field and the memory. `contextBridge`
 * hands the renderer a frozen API, so a stub installed in the page would be a
 * stub of nothing.
 *
 * The `~/.ssh/config` reader is stubbed too, and not for convenience: the search
 * fires **immediately for a name the config knows** and after a debounce for one
 * being typed, so a test that let the developer's own config through would be
 * testing whichever machines that person happens to have.
 *
 * What this cannot prove — and the reason `discoverWorkspaces.test.ts` says the
 * same thing — is that a real `ssh` to a real machine answers in a useful time.
 * There is no `sshd` on this machine; that half is unverified here.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';

/** What a machine with some history on it would have answered. */
const FOUND = {
  roots: ['/home/dev', '/home/dev/src', '/srv'],
  depth: 3,
  candidates: [
    { path: '/home/dev/agbrte', kind: 'devagents' },
    { path: '/home/dev/src/api', kind: 'git' },
    { path: '/home/dev/Documents', kind: 'folder' },
  ],
  truncated: false,
  partial: false,
};

/** The machines the app believes are in the user's config. */
const MACHINES = ['build-01', 'slow-01', 'quick-02'];

/**
 * Replace the two handlers that would need a machine on the other end.
 *
 * `delays` is per alias, in milliseconds, so one test can hold one machine's
 * answer back while another's arrives — which is the case an automatic search
 * has to survive and a button never did.
 */
async function stubMachines(
  app: LaunchedApp,
  opts: { delays?: Record<string, number>; fail?: string } = {},
): Promise<void> {
  await app.app.evaluate(
    async ({ ipcMain }, { found, machines, delays, fail }) => {
      const scope = globalThis as unknown as { __asked: number };
      scope.__asked = 0;

      ipcMain.removeHandler('agbrte:hosts.ssh');
      ipcMain.handle('agbrte:hosts.ssh', () => machines.map((alias: string) => ({ alias })));

      ipcMain.removeHandler('agbrte:hosts.discover');
      ipcMain.handle('agbrte:hosts.discover', async (_e, alias: string) => {
        scope.__asked += 1;
        const wait = delays?.[alias] ?? 0;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (fail !== undefined) throw new Error(fail);
        return {
          alias,
          ...found,
          candidates: found.candidates.map((c) => ({
            ...c,
            path: `${c.path}-${alias}`,
          })),
        };
      });

      ipcMain.removeHandler('agbrte:hosts.addRemote');
      ipcMain.handle('agbrte:hosts.addRemote', (_e, alias: string, workspaceRoot: string) => ({
        instanceId: `stub:${alias}:${workspaceRoot}`,
        workspaceRoot,
        label: alias,
        endpoints: [],
        runtimeNotes: [],
        link: 'connected',
      }));
    },
    { found: FOUND, machines: MACHINES, delays: opts.delays, fail: opts.fail },
  );
}

/** How many times the machine has been asked, counted in main. */
const asked = async (app: LaunchedApp): Promise<number> =>
  app.app.evaluate(() => (globalThis as never as { __asked: number }).__asked);

/** Open the attach panel on its remote tab. */
async function openRemote(page: Page): Promise<void> {
  await page.click('[data-testid=add-host]');
  await page.click('[data-testid=attach-remote]');
}

test.describe('remote workspaces are offered, not asked for', () => {
  test('looks on its own, lists what it found, and remembers what worked', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte);
      const page = agbrte.window;
      await openRemote(page);

      /*
       * Nothing was pressed. Choosing "Remote" settles on the first configured
       * machine, and that is a chosen machine, so the search runs — the step this
       * change removes.
       */
      await expect(page.locator('[data-testid=attach-found]')).toBeVisible();

      /*
       * The list scrolls; the controls do not.
       *
       * A machine with two dozen folders made this panel taller than the
       * sidebar, and the column it sits in does not scroll — so the overflow
       * ran off the bottom of the window, taking the Attach button with it.
       * Asserting the *button* is reachable is the property; the scrollbox is
       * how it is kept.
       */
      const list = page.locator('[data-testid=attach-found-list]');
      await expect(list).toBeVisible();
      // `page.viewportSize()` is null for an Electron window, so the height
      // comes from the page itself rather than from Playwright's idea of it.
      // `globalThis` rather than `window`: this file is typechecked by the node
      // project, which has no DOM lib, and the expression runs in the page.
      const height = await page.evaluate(
        () => (globalThis as unknown as { innerHeight: number }).innerHeight,
      );
      const panelBox = await page.locator('[data-testid=attach-panel]').boundingBox();
      expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(height + 1);
      // And everything in it is reachable by scrolling the panel — which is
      // what was lost: the button ran off the window with nothing to scroll.
      const go = page.locator('[data-testid=attach-remote-go]');
      await go.scrollIntoViewIfNeeded();
      await expect(go).toBeInViewport();
      await expect(page.locator('[data-testid=attach-group-devagents]')).toContainText(
        '/home/dev/agbrte-build-01',
      );
      await expect(page.locator('[data-testid=attach-group-git]')).toContainText('/home/dev/src/api');
      await expect(page.locator('[data-testid=attach-group-folder] summary')).toContainText(
        'Other folders (1)',
      );
      // What was searched, beside the results: the difference between "nothing is
      // there" and "this is broken".
      await expect(page.locator('[data-testid=attach-searched]')).toContainText('/home/dev/src');
      // The button is a retry now, not the way in.
      await expect(page.locator('[data-testid=attach-discover]')).toContainText('Look again');
      expect(await asked(agbrte)).toBe(1);

      /*
       * A name being typed is not a chosen machine. Six keystrokes must produce
       * one connection after the typing stops, not six while it is happening.
       */
      const alias = page.locator('[data-testid=attach-alias]');
      await alias.fill('');
      await alias.pressSequentially('typed-9');
      expect(await asked(agbrte)).toBe(1);
      await expect.poll(async () => asked(agbrte), { timeout: 5_000 }).toBe(2);
      // …and leaving the field does not ask that machine a second time.
      await page.locator('[data-testid=attach-path]').focus();
      expect(await asked(agbrte)).toBe(2);

      // Back to a configured machine, and pick from what it offered.
      await alias.fill('build-01');
      const used = page.locator('[data-testid=attach-group-devagents]');
      await expect(used).toContainText('/home/dev/agbrte-build-01');
      await used.locator('[data-testid=attach-candidate]').first().click();
      const path = page.locator('[data-testid=attach-path]');
      await expect(path).toHaveValue('/home/dev/agbrte-build-01');

      // The fallback is still a field: discovery is bounded on purpose, so a
      // workspace it did not reach has to be typeable.
      await path.fill('/srv/typed-by-hand');
      await expect(path).toHaveValue('/srv/typed-by-hand');
      await used.locator('[data-testid=attach-candidate]').first().click();

      await page.click('[data-testid=attach-remote-go]');
      await expect(page.locator('[data-testid=attach-panel]')).toBeHidden();

      /*
       * The second attach to a familiar machine: the machine and the path are
       * both back, so it is one click on Attach. The search still runs — a
       * remembered path can be stale, and the list is how anybody notices — but
       * it does not overwrite the field.
       */
      const before = await asked(agbrte);
      await openRemote(page);
      await expect(page.locator('[data-testid=attach-alias]')).toHaveValue('build-01');
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue(
        '/home/dev/agbrte-build-01',
      );
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();
      await expect.poll(async () => asked(agbrte)).toBe(before + 1);
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue(
        '/home/dev/agbrte-build-01',
      );
    } finally {
      await agbrte.close();
    }
  });

  test('says which machine it is looking on, and lets the last one win', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte, { delays: { 'slow-01': 4_000 } });
      const page = agbrte.window;
      await openRemote(page);
      await expect(page.locator('[data-testid=attach-found]')).toBeVisible();

      /*
       * The list scrolls; the controls do not.
       *
       * A machine with two dozen folders made this panel taller than the
       * sidebar, and the column it sits in does not scroll — so the overflow
       * ran off the bottom of the window, taking the Attach button with it.
       * Asserting the *button* is reachable is the property; the scrollbox is
       * how it is kept.
       */
      const list = page.locator('[data-testid=attach-found-list]');
      await expect(list).toBeVisible();
      // `page.viewportSize()` is null for an Electron window, so the height
      // comes from the page itself rather than from Playwright's idea of it.
      // `globalThis` rather than `window`: this file is typechecked by the node
      // project, which has no DOM lib, and the expression runs in the page.
      const height = await page.evaluate(
        () => (globalThis as unknown as { innerHeight: number }).innerHeight,
      );
      const panelBox = await page.locator('[data-testid=attach-panel]').boundingBox();
      expect(panelBox!.y + panelBox!.height).toBeLessThanOrEqual(height + 1);
      // And everything in it is reachable by scrolling the panel — which is
      // what was lost: the button ran off the window with nothing to scroll.
      const go = page.locator('[data-testid=attach-remote-go]');
      await go.scrollIntoViewIfNeeded();
      await expect(go).toBeInViewport();

      await page.locator('[data-testid=attach-alias]').fill('slow-01');
      // A still panel for as long as a bounded command can take reads as a hang.
      await expect(page.locator('[data-testid=attach-looking]')).toContainText(
        'Looking on slow-01',
      );

      // The user moves on while the first machine is still thinking.
      await page.locator('[data-testid=attach-alias]').fill('quick-02');
      await expect(page.locator('[data-testid=attach-group-devagents]')).toContainText(
        '/home/dev/agbrte-quick-02',
      );

      // Long enough for the abandoned machine to answer. Its list must not land
      // under the name of the machine the user is now looking at.
      await page.waitForTimeout(5_000);
      await expect(page.locator('[data-testid=attach-found]')).not.toContainText('slow-01');
      await expect(page.locator('[data-testid=attach-looking]')).toBeHidden();
      await expect(page.locator('[data-testid=attach-group-devagents]')).toContainText(
        '/home/dev/agbrte-quick-02',
      );
    } finally {
      await agbrte.close();
    }
  });

  test('a machine that cannot be reached says so in the panel, not in the banner', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte, {
        fail: 'The machine refused the credentials this computer offered.',
      });
      const page = agbrte.window;
      await openRemote(page);

      /*
       * Nobody pressed anything to cause this search, so its failure must not
       * throw a red banner across the window — that is an alarm about an action
       * the user did not take.
       */
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText(
        'Could not look on build-01',
      );
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText(
        'refused the credentials',
      );
      await expect(page.locator('[data-testid=error]')).toHaveCount(0);

      // The field still works, which is the whole reason a quiet failure is
      // acceptable here.
      await page.locator('[data-testid=attach-path]').fill('/srv/app');
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();

      // And the button is the retry, for the machine that was merely asleep.
      const before = await asked(agbrte);
      await page.click('[data-testid=attach-discover]');
      await expect.poll(async () => asked(agbrte)).toBe(before + 1);
      await expect(page.locator('[data-testid=error]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

  test('a machine that cannot be listed is named, and the field still works', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await agbrte.app.evaluate(async ({ ipcMain }) => {
        ipcMain.removeHandler('agbrte:hosts.discover');
        ipcMain.handle('agbrte:hosts.discover', (_e, alias: string) => ({
          alias,
          roots: [],
          depth: 3,
          candidates: [],
          truncated: false,
          partial: false,
          unavailable: `${alias} is a Windows machine, and looking around one is not built yet — attaching still works, so type the workspace path below`,
        }));
      });

      const page = agbrte.window;
      await openRemote(page);
      await page.locator('[data-testid=attach-alias]').fill('winbox');
      await page.click('[data-testid=attach-discover]');

      // Named rather than reported as an empty machine, and it says what to do
      // instead — the manual path, which is still there and still attaches.
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText('Windows');
      await expect(page.locator('[data-testid=error]')).toHaveCount(0);
      await page.locator('[data-testid=attach-path]').fill('C:/work/app');
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();
    } finally {
      await agbrte.close();
    }
  });
});
