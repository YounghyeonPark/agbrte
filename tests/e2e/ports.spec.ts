/**
 * The ports row, folded (DESIGN.md §6.8, §12.1).
 *
 * §6.8 is a real feature: bring a dev server running on a remote machine to a
 * local port so it can be opened, captured and annotated, plus host-owned
 * preview servers that outlive a turn — which exists because a CLI harness reaps
 * whatever its run started. None of that is in question here.
 *
 * What was wrong was that it was **permanently expanded at the top of every
 * remote session**, above the roster and the transcript, whether or not the
 * session had anything to do with a web server — and on a shared build box it
 * listed six detected ports, most of them somebody else's services. So it now
 * works the way `Files` and the Chat/Terminal toggle already work in that pane,
 * and this spec pins the part that would otherwise drift back: **folded is the
 * default**, and nothing of it is on screen until asked for.
 *
 * ## Why the host is doctored
 *
 * The row is remote-only, deliberately — a local dev server is already on
 * `localhost`, and a button that does nothing visible teaches people the feature
 * does nothing. This checkout has no remote machine, so the only way to drive
 * the screen that has this row is to make the app believe its host is one:
 * `hosts.list` is wrapped in main and the same doctored list is sent on the real
 * push channel. Same technique as `setup.spec.ts` and for the same reason —
 * `contextBridge` hands the renderer a frozen API, so a stub installed in the
 * page would be a stub of nothing.
 *
 * Nothing here presses `Forward` or `Start`: those would open an ssh tunnel to a
 * machine that does not exist. What is asserted is the fold, the reveal, what
 * the revealed row still contains, that it is remembered per session, and that
 * it fits.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';
import { addAgent, createSession, hostGroup } from './actions.js';

/** Make the app believe its host is an ssh one, on both paths it learns from. */
async function pretendRemote(agbrte: LaunchedApp): Promise<void> {
  await agbrte.app.evaluate(async ({ ipcMain, BrowserWindow }) => {
    const handlers = (
      ipcMain as unknown as {
        _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
      }
    )._invokeHandlers;
    const original = handlers.get('agbrte:hosts.list');
    if (original === undefined) throw new Error('no hosts.list handler to wrap');

    const doctor = async (event: unknown): Promise<unknown> => {
      const hosts = (await original(event)) as Array<Record<string, unknown>>;
      // Only the two fields the renderer branches on. Everything else is the
      // real host's own answer, so the rest of the screen is unchanged.
      return hosts.map((h) => ({ ...h, targetKind: 'ssh', label: 'build-01' }));
    };

    ipcMain.removeHandler('agbrte:hosts.list');
    ipcMain.handle('agbrte:hosts.list', doctor);

    // And on the push, because that is the other way the list arrives — a real
    // push would otherwise put `local` back in the middle of a test.
    const listed = await doctor(null);
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('agbrte:push.hosts', listed);
    }
  });
}

const portsRow = (page: Page) => page.locator('[data-testid=ports-row]');
const portsToggle = (page: Page) => page.locator('[data-testid=toggle-ports]');

async function resize(app: LaunchedApp, width: number, height: number): Promise<void> {
  await app.app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await app.window.waitForTimeout(300);
}

test.describe('ports are there when asked for', () => {
  test('a local session is not offered them at all', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await createSession(page, 'local work');
      await addAgent(page, 'echo');

      /*
       * The rule that has always governed this row, now in the control as well
       * as in the row: a local dev server is already on `localhost` at a port
       * the person chose, so forwarding it is a button that does nothing
       * visible — and a control that does nothing teaches people the feature
       * does nothing.
       */
      await expect(portsToggle(page)).toHaveCount(0);
      await expect(portsRow(page)).toHaveCount(0);
      // The other controls in that row are untouched.
      await expect(page.locator('[data-testid=toggle-files]')).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });

  test('a remote session offers them, folded, and keeps everything they do', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await createSession(page, 'web work');
      await addAgent(page, 'echo');

      // Folded on arrival: the assertion this change exists for.
      await expect(portsToggle(page)).toBeVisible();
      await expect(portsToggle(page)).toHaveAttribute('aria-pressed', 'false');
      await expect(portsRow(page)).toHaveCount(0);
      /*
       * And nothing is announced while it is folded.
       *
       * No count and no dot: the number available for free is the count of
       * *detected* ports, which is the noise the fold exists to remove — other
       * people's services on a machine this session happens to share.
       */
      await expect(portsToggle(page)).toHaveText('Ports');
      await expect(page.locator('[data-testid=detected-port]')).toHaveCount(0);

      await portsToggle(page).click();
      await expect(portsRow(page)).toBeVisible();
      await expect(portsToggle(page)).toHaveAttribute('aria-pressed', 'true');

      // Everything it did before is still in it: the port field and Forward,
      // and the host-owned dev server with its command and Start (§6.8, §3.12).
      await expect(page.locator('[data-testid=forward-port]')).toHaveValue('3000');
      await expect(page.locator('[data-testid=forward-go]')).toBeVisible();
      await expect(page.locator('[data-testid=server-command]')).toHaveValue('npm run dev');
      await expect(page.locator('[data-testid=server-start]')).toBeVisible();

      // It fits, at the sizes that bite: the row wraps rather than scrolling the
      // column sideways or pushing the composer off the bottom.
      for (const [width, height] of [
        [1180, 820],
        [1180, 481],
        [720, 480],
      ] as const) {
        await resize(agbrte, width, height);
        const box = await portsRow(page).evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(box.scrollWidth, 'the ports row overflows sideways').toBeLessThanOrEqual(
          box.clientWidth,
        );
        // The transcript is the only child allowed to give up height, so the
        // thing you type into stays on screen with this open.
        await expect(page.locator('[data-testid=composer-input]')).toBeInViewport();
      }

      await resize(agbrte, 1180, 820);
      await portsToggle(page).click();
      await expect(portsRow(page)).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

  test('remembers which session was doing web work', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await pretendRemote(agbrte);
      await createSession(page, 'the web one');
      await addAgent(page, 'echo');
      await portsToggle(page).click();
      await expect(portsRow(page)).toBeVisible();

      /*
       * Per session, not per window.
       *
       * Somebody doing web work should not reopen this every turn; somebody
       * whose *next* session has nothing to do with ports should not inherit
       * the fold from the one before it. Both halves are asserted, because a
       * single global flag would pass the first and fail the second.
       */
      /*
       * The second one is created by hand rather than through `createSession`.
       *
       * A successful `addAgent` saves the choice as this host's default, so the
       * next zero-agent session auto-adds it and lands straight in the chat —
       * there is no picker to wait for, and the helper asserts one.
       */
      const group = hostGroup(page);
      await group.locator('[data-testid=new-session]').click();
      await group.locator('[data-testid=new-title]').fill('the other one');
      // The same workspace on purpose: this is about two sessions on one host
      // and which of them a forwarded port belongs to.
      await group.locator('[data-testid=new-folder]').fill('');
      await group.locator('[data-testid=new-submit]').click();
      await expect(page.locator('[data-testid=composer-input]')).toBeVisible({ timeout: 30_000 });

      await expect(portsRow(page)).toHaveCount(0);
      await expect(portsToggle(page)).toHaveAttribute('aria-pressed', 'false');

      await page.click('[data-testid=session][data-title="the web one"]');
      await expect(portsRow(page)).toBeVisible({ timeout: 15_000 });
    } finally {
      await agbrte.close();
    }
  });
});
