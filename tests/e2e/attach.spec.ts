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
 * store action, Browse, the dropdown, the fallback field and the memory.
 * `contextBridge` hands the renderer a frozen API, so a stub installed in the
 * page would be a stub of nothing.
 *
 * The `~/.ssh/config` reader is stubbed too, and not for convenience: the search
 * fires **immediately for a name the config knows** and after a debounce for one
 * being typed, so a test that let the developer's own config through would be
 * testing whichever machines that person happens to have.
 *
 * The canned answer is deliberately **long** — twenty-seven directories, the
 * shape a working machine actually produces — because a short fixture would
 * prove nothing about a control whose whole job is to hold a lot without taking
 * the panel over.
 *
 * What this cannot prove — and the reason `discoverWorkspaces.test.ts` says the
 * same thing — is that a real `ssh` to a real machine answers in a useful time.
 * There is no `sshd` on this machine; that half is unverified here.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';

/** What a machine with a working directory of projects on it would answer. */
const FOUND = {
  // A long root, so the "Searched …" line is rendered at a realistic width. It
  // needs no wrapping utility and has none: a path breaks after its slashes, and
  // a 68-character root was measured wrapping on its own.
  roots: ['/home/dev', '/home/dev/src/a-deeply-nested-projects-and-experiments-directory-name', '/srv'],
  depth: 3,
  candidates: [
    ...Array.from({ length: 8 }, (_, i) => ({ path: `/home/dev/used-${i}`, kind: 'workspace' })),
    // Long on purpose: a trigger that takes its width from the longest path is
    // how a 300px sidebar grows a horizontal scrollbar.
    ...Array.from({ length: 6 }, (_, i) => ({
      path: `/home/dev/src/a-rather-deeply-nested/monorepo-with-a-long-name-${i}`,
      kind: 'git',
    })),
    ...Array.from({ length: 13 }, (_, i) => ({ path: `/home/dev/folder-${i}`, kind: 'folder' })),
  ],
  truncated: false,
  partial: false,
};

/** The machines the app believes are in the user's config. */
const MACHINES = ['build-01', 'slow-01', 'quick-02'];

/**
 * Replace the handlers that would need a machine on the other end.
 *
 * `delays` is per alias, in milliseconds, so one test can hold one machine's
 * answer back while another's arrives — which is the case an automatic search
 * has to survive and a button never did. Every path is suffixed with the alias
 * it came from, so "whose list is on screen" is answerable.
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
          candidates: found.candidates.map((c) => ({ ...c, path: `${c.path}-${alias}` })),
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

/**
 * Where the panel and its primary action actually are, measured in the page.
 *
 * `page.viewportSize()` is `null` for an Electron window — there is no emulated
 * viewport — so the window is asked about itself, and Attach is compared against
 * the *panel's* box: a panel that scrolls can put its button "on the page" and
 * still out of reach.
 */
async function layout(page: Page): Promise<{
  panelBottom: number;
  attachBottom: number;
  panelScroll: number;
  panelClient: number;
  panelScrollWidth: number;
  panelClientWidth: number;
  windowHeight: number;
}> {
  const panel = await page.locator('[data-testid=attach-panel]').boundingBox();
  const attach = await page.locator('[data-testid=attach-remote-go]').boundingBox();
  const inner = await page
    .locator('[data-testid=attach-panel]')
    .evaluate((el) => ({
      scroll: el.scrollHeight,
      client: el.clientHeight,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
  const windowHeight = await page.evaluate(
    () => (globalThis as unknown as { innerHeight: number }).innerHeight,
  );
  return {
    panelBottom: panel === null ? 0 : panel.y + panel.height,
    attachBottom: attach === null ? Number.POSITIVE_INFINITY : attach.y + attach.height,
    panelScroll: inner.scroll,
    panelClient: inner.client,
    panelScrollWidth: inner.scrollWidth,
    panelClientWidth: inner.clientWidth,
    windowHeight,
  };
}

/** Resize the real window, which is where a short-window claim has to be tested. */
async function resize(app: LaunchedApp, width: number, height: number): Promise<void> {
  await app.app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
  }, { width, height });
  await app.window.waitForTimeout(300);
}

/**
 * Nothing in a 300px sidebar may scroll sideways.
 *
 * `App.tsx`'s nav already carries `overflow-x-hidden` because at 150% Windows
 * scaling a 1px rounding paints a phantom full-width scrollbar; a *real* one is
 * worse, and it arrives the moment a row cannot shrink — a text input will not
 * go below its intrinsic twenty characters, and a select trigger takes its width
 * from the longest path in it, unless both are told otherwise. Asserted in every
 * state rather than once, because it is a property of each row.
 */
function fitsSideways(box: { panelScrollWidth: number; panelClientWidth: number }): void {
  expect(box.panelScrollWidth, 'the attach panel overflows its column sideways').toBeLessThanOrEqual(
    box.panelClientWidth,
  );
}

test.describe('remote workspaces are offered, not asked for', () => {
  test('rests as three fields, and hands over the list when asked', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte);
      const page = agbrte.window;
      const path = page.locator('[data-testid=attach-path]');
      const trigger = page.locator('[data-testid=attach-workspace-trigger]');
      await openRemote(page);

      /*
       * The resting state: a machine, a path with Browse beside it, and Attach.
       * The picker is a way of filling that field, not a thing to read on the
       * way past, so neither it nor its Refresh is on screen until asked for.
       * Asserted by absence so this cannot drift back.
       */
      await expect(page.locator('[data-testid=attach-alias]')).toHaveValue('build-01');
      await expect(page.locator('[data-testid=attach-browse]')).toBeVisible();
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeVisible();
      await expect(trigger).toHaveCount(0);
      await expect(page.locator('[data-testid=attach-discover]')).toHaveCount(0);
      await expect(page.locator('[data-testid=attach-found]')).toHaveCount(0);

      // …and the search ran anyway, which is what makes Browse instant.
      await expect.poll(async () => asked(agbrte)).toBe(1);

      const resting = await layout(page);
      expect(resting.attachBottom).toBeLessThanOrEqual(resting.panelBottom);
      expect(resting.panelScroll).toBeLessThanOrEqual(resting.panelClient + 1);
      fitsSideways(resting);

      /*
       * Browse shows an answer that is already there: no second connection, and
       * Refresh sits beside the control it refreshes rather than above it.
       */
      await page.click('[data-testid=attach-browse]');
      await expect(trigger).toContainText('27 found');
      await expect(page.locator('[data-testid=attach-discover]')).toContainText('Refresh');
      expect(await asked(agbrte)).toBe(1);
      await expect(page.locator('[data-testid=attach-searched]')).toContainText(
        '/home/dev/src/a-deeply-nested-projects-and-experiments-directory-name',
      );

      // Open, twenty-seven results, and Attach is still inside the panel with
      // nothing scrolling.
      const open = await layout(page);
      expect(open.attachBottom).toBeLessThanOrEqual(open.panelBottom);
      expect(open.panelScroll).toBeLessThanOrEqual(open.panelClient + 1);
      // With the dropdown, Refresh beside it, and a sixty-character path in the
      // trigger: the row that would push the button off the edge.
      fitsSideways(open);

      /*
       * And what the one remaining `overflow-y-auto` is for. At a window too
       * short for the panel the content is *reachable* rather than clipped —
       * which is the failure the two earlier structures existed to prevent, and
       * the only claim this scroll makes.
       */
      await resize(agbrte, 1180, 520);
      const squeezed = await layout(page);
      expect(squeezed.panelScroll).toBeGreaterThan(squeezed.panelClient);
      // A vertical scrollbar takes width from the column; the panel still may not
      // answer that by scrolling in the other axis too.
      fitsSideways(squeezed);
      await page.locator('[data-testid=attach-panel]').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      const scrolled = await layout(page);
      expect(scrolled.attachBottom).toBeLessThanOrEqual(scrolled.panelBottom + 1);
      await resize(agbrte, 1180, 820);

      // The kinds survive the collapse: three labelled groups inside the popup,
      // in the order discovery ranked them.
      await trigger.click();
      await expect(page.locator('[data-testid=attach-workspace-list]')).toBeVisible();
      await expect(page.locator('[data-testid=attach-group-workspace]')).toContainText(
        'Used by Agbrte before (8)',
      );
      await expect(page.locator('[data-testid=attach-group-git]')).toContainText(
        'Git repositories (6)',
      );
      await expect(page.locator('[data-testid=attach-group-folder]')).toContainText(
        'Other folders (13)',
      );

      // Choosing fills the field and folds the picker away: it has done its job,
      // and the next thing to press is Attach.
      await page.click('[data-testid=attach-candidate][data-path="/home/dev/used-0-build-01"]');
      await expect(path).toHaveValue('/home/dev/used-0-build-01');
      await expect(page.locator('[data-testid=attach-found]')).toHaveCount(0);
      await expect(trigger).toHaveCount(0);

      // A seventy-character path is the other way a row grows: once in the field
      // it fills, and again in the trigger that then has to display it.
      await page.click('[data-testid=attach-browse]');
      await trigger.click();
      await page.click(
        '[data-testid=attach-candidate][data-path="/home/dev/src/a-rather-deeply-nested/monorepo-with-a-long-name-0-build-01"]',
      );
      await expect(path).toHaveValue(
        '/home/dev/src/a-rather-deeply-nested/monorepo-with-a-long-name-0-build-01',
      );
      fitsSideways(await layout(page));
      await page.click('[data-testid=attach-browse]');
      await expect(trigger).toContainText('monorepo-with-a-long-name-0');
      fitsSideways(await layout(page));
      // Back to the resting state for what follows.
      await page.click('[data-testid=attach-browse]');
      await expect(trigger).toHaveCount(0);

      /*
       * A name being typed is not a chosen machine. Seven keystrokes must produce
       * one connection after the typing stops, not seven while it is happening.
       */
      const alias = page.locator('[data-testid=attach-alias]');
      // Selected and typed over rather than cleared first: an empty field is
      // filled back in with the config's first machine, which is the panel doing
      // its job and would make this test type into `build-01`.
      await alias.press('ControlOrMeta+a');
      await alias.pressSequentially('typed-9');
      expect(await asked(agbrte)).toBe(1);
      await expect.poll(async () => asked(agbrte), { timeout: 5_000 }).toBe(2);
      // …and leaving the field does not ask that machine a second time.
      await path.focus();
      expect(await asked(agbrte)).toBe(2);

      await alias.fill('build-01');
      // Switching machines takes the path with it: a directory on `build-01` is
      // not a directory on the machine now named, and leaving it in the field
      // would attach the wrong thing on one click.
      await expect(path).toHaveValue('');

      // The fallback is still a field, and typing wins over the picker rather
      // than being overwritten by it.
      await path.fill('/srv/typed-by-hand');
      await expect(path).toHaveValue('/srv/typed-by-hand');
      await page.click('[data-testid=attach-browse]');
      await expect(trigger).toContainText('Choose one of 27 found');
      await trigger.click();
      await page.click('[data-testid=attach-candidate][data-path="/home/dev/used-0-build-01"]');
      await expect(path).toHaveValue('/home/dev/used-0-build-01');

      await page.click('[data-testid=attach-remote-go]');
      await expect(page.locator('[data-testid=attach-panel]')).toBeHidden();

      /*
       * The second attach to a familiar machine: the machine and the path are
       * both back, so it is one click on Attach — with the panel in its resting
       * shape, because nothing needs looking for. The search still runs, since a
       * remembered path can be stale and the list is how anybody notices.
       */
      const before = await asked(agbrte);
      await openRemote(page);
      await expect(page.locator('[data-testid=attach-alias]')).toHaveValue('build-01');
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue(
        '/home/dev/used-0-build-01',
      );
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toHaveCount(0);
      await expect.poll(async () => asked(agbrte)).toBe(before + 1);
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue(
        '/home/dev/used-0-build-01',
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
      await page.click('[data-testid=attach-browse]');
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toBeVisible();

      await page.locator('[data-testid=attach-alias]').fill('slow-01');
      // Browse pressed against a machine still thinking must not be an empty box:
      // it says so where the dropdown will be.
      await expect(page.locator('[data-testid=attach-looking]')).toContainText('Looking on slow-01');

      // The user moves on while the first machine is still thinking.
      await page.locator('[data-testid=attach-alias]').fill('quick-02');
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toContainText('27 found');

      // Long enough for the abandoned machine to answer. Its list must not land
      // under the name of the machine the user is now looking at.
      await page.waitForTimeout(5_000);
      await expect(page.locator('[data-testid=attach-looking]')).toBeHidden();
      await page.click('[data-testid=attach-workspace-trigger]');
      await expect(
        page.locator('[data-testid=attach-candidate][data-path="/home/dev/used-0-quick-02"]'),
      ).toBeVisible();
      expect(
        await page.locator('[data-testid=attach-candidate][data-path*="slow-01"]').count(),
      ).toBe(0);
    } finally {
      await agbrte.close();
    }
  });

  test('a machine that could not be looked at says so without being asked', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      /*
       * An unbroken token in the message, because that is the one string here
       * that has no slashes to break after — a key fingerprint, a base64 blob,
       * whatever ssh chose to say. It is the case `wrap-anywhere` exists for, and
       * the sideways assertion below is what proves the class is doing something.
       */
      await stubMachines(agbrte, {
        fail: 'The machine refused the credentials this computer offered (SHA256:qWERTYuiopASDFghjklZXCVBNMqwertyuiopasdfghjklzxcvbnm1234567890abcd).',
      });
      const page = agbrte.window;
      await openRemote(page);

      /*
       * With the picker folded away this line has nowhere else to go, and
       * dropping it would leave somebody in front of a Browse button that opens
       * an empty box for a reason nothing on screen gives. It stays by the field,
       * and it is *not* the app's error banner: nobody pressed anything to cause
       * this search, so its failure is not an alarm.
       */
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText(
        'Could not look on build-01',
      );
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText(
        'refused the credentials',
      );
      await expect(page.locator('[data-testid=error]')).toHaveCount(0);
      fitsSideways(await layout(page));
      // No control offering an empty list, either.
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toHaveCount(0);

      // The field still works, which is the whole reason a quiet failure is
      // acceptable here.
      await page.locator('[data-testid=attach-path]').fill('/srv/app');
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();

      // And Browse still opens, with the reason repeated and Refresh reachable —
      // for the machine that was merely asleep.
      await page.click('[data-testid=attach-browse]');
      await expect(page.locator('[data-testid=attach-found]')).toContainText(
        'Could not look on build-01',
      );
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

      // Named rather than reported as an empty machine, without anybody opening
      // the picker to find out — and it says what to do instead.
      await expect(page.locator('[data-testid=attach-found-note]')).toContainText('Windows');
      await expect(page.locator('[data-testid=error]')).toHaveCount(0);
      await page.locator('[data-testid=attach-path]').fill('C:/work/app');
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeEnabled();
    } finally {
      await agbrte.close();
    }
  });
});
