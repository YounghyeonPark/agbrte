/**
 * "Set up this machine", driven through the real app (DESIGN.md §6.4, §3.8, §13).
 *
 * The screen this exists for is the one a fresh ssh host produces: three
 * accurate sentences naming three absences, and nothing to press. So what is
 * driven here is the whole path from a click to the IPC call and back —
 * the real renderer, the real preload, the real channel, the real push.
 *
 * **Stubbed in main, not in the page**, for the reason `attach.spec.ts` gives:
 * `contextBridge` hands the renderer a frozen API, so a stub installed in the
 * page would be a stub of nothing. Only the machine on the other end is
 * replaced — this checkout has no remote to install anything on, and must not
 * install anything on the developer's own.
 *
 * The stub is also what lets one property be asserted that no unit test can:
 * that a key typed into the field reaches `hosts.setUp` and **nothing else**,
 * checked by recording every argument main received on that channel.
 *
 * What this cannot show is the panel opening *by itself*, because whether it
 * does depends on whether the developer's machine happens to have Claude Code
 * installed — this one does. That rule is asserted deterministically in
 * `tests/setUpPanel.test.ts` instead; here the panel is opened by clicking the
 * control a person would click.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, makeRepo, type LaunchedApp } from './harness.js';
import { createSession } from './actions.js';

/**
 * Replace the setup handler, and record what it was given.
 *
 * `steps` go out on the real `agbrte:push.setup` channel before the call
 * resolves, so the progress list under test is fed the way production feeds it
 * rather than from a return value.
 */
async function stubSetup(
  agbrte: LaunchedApp,
  opts: { steps?: string[]; outcome?: unknown; fail?: string } = {},
): Promise<void> {
  await agbrte.app.evaluate(
    async ({ ipcMain, BrowserWindow }, { steps, outcome, fail }) => {
      const scope = globalThis as unknown as { __setup: unknown[] };
      scope.__setup = [];

      ipcMain.removeHandler('agbrte:hosts.setUp');
      ipcMain.handle('agbrte:hosts.setUp', async (_e, instanceId: string, plan: unknown) => {
        scope.__setup.push(plan);
        for (const step of steps ?? []) {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('agbrte:push.setup', { instanceId, step });
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        if (fail !== undefined) throw new Error(fail);
        return (
          outcome ?? { installed: true, redetected: true, summary: 'done', steps: steps ?? [] }
        );
      });
    },
    { steps: opts.steps, outcome: opts.outcome, fail: opts.fail },
  );
}

/** Every plan main was handed, exactly as it arrived over IPC. */
const plansSeen = async (agbrte: LaunchedApp): Promise<unknown[]> =>
  agbrte.app.evaluate(() => (globalThis as never as { __setup: unknown[] }).__setup);

/** Open the panel, whichever state this machine's own tooling left it in. */
async function openPanel(page: Page): Promise<void> {
  const panel = page.locator('[data-testid=setup-machine]');
  await expect(panel).toBeVisible();
  if ((await panel.locator('[data-testid=setup-toggle]').innerText()) === 'Show') {
    await panel.locator('[data-testid=setup-toggle]').click();
  }
  await expect(page.locator('[data-testid=setup-route-cli]')).toBeVisible();
}

test.describe('a machine with nothing on it is offered a way forward', () => {
  test('streams each step and says the half that is still yours to do', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubSetup(agbrte, {
        steps: ['checking there is room', 'installing @anthropic-ai/claude-code'],
        outcome: {
          installed: true,
          redetected: true,
          summary: 'Claude Code is installed on this machine.',
          steps: [],
          followUp: 'Open an ssh session and run `claude auth login` — this pane is local-only.',
        },
      });
      const page = agbrte.window;
      await createSession(page, 'setting up');
      await openPanel(page);

      await page.click('[data-testid=setup-route-cli]');
      await page.click('[data-testid=setup-install-claude]');

      // Every step, in order, as it arrived — not one line replaced in place.
      // Which step an install reached is the only useful thing to know when one
      // fails four minutes in.
      const steps = page.locator('[data-testid=setup-steps] li');
      await expect(steps).toHaveCount(2, { timeout: 15_000 });
      await expect(steps.nth(0)).toHaveText('checking there is room');
      await expect(steps.nth(1)).toHaveText('installing @anthropic-ai/claude-code');

      await expect(page.locator('[data-testid=setup-outcome-summary]')).toContainText(
        'Claude Code is installed',
      );
      // The honest gap, on screen rather than in a doc: an install is not a
      // sign-in, and this app cannot do the second half.
      await expect(page.locator('[data-testid=setup-followup]')).toContainText('claude auth login');

      expect(await plansSeen(agbrte)).toEqual([{ kind: 'cli', cli: 'claude-code' }]);
    } finally {
      await agbrte.close();
    }
  });

  test('repeats the installer`s own words when it fails, and claims nothing', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubSetup(agbrte, {
        steps: ['downloading Ollama v0.32.14 (about a gigabyte)'],
        fail: 'could not install Ollama on this machine — it failed while downloading: curl: (22) The requested URL returned error: 404',
      });
      const page = agbrte.window;
      await createSession(page, 'a failing install');
      await openPanel(page);

      await page.click('[data-testid=setup-route-ollama]');
      await page.click('[data-testid=setup-install-ollama]');

      // Verbatim: this is `curl` talking about a machine the reader cannot see,
      // and every attempt to paraphrase one has made it less useful.
      await expect(page.locator('[data-testid=setup-failure]')).toContainText('curl: (22)', {
        timeout: 15_000,
      });
      // And nothing claims success beside it.
      await expect(page.locator('[data-testid=setup-outcome]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

  test('sends the API key to setUp and to nothing else', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const KEY = 'sk-e2e-never-anywhere-else';

    try {
      await stubSetup(agbrte, {
        outcome: {
          installed: true,
          redetected: true,
          summary: 'Added "acme" to /home/dev/.agbrte/endpoints.json.',
          steps: [],
          followUp: 'That key now lives on this machine, which is what lets a detached run keep going.',
        },
      });
      const page = agbrte.window;
      await createSession(page, 'adding an endpoint');
      await openPanel(page);

      await page.click('[data-testid=setup-route-endpoint]');
      await page.fill('[data-testid=setup-endpoint-id]', 'acme');
      await page.fill('[data-testid=setup-endpoint-provider]', 'acme');
      await page.fill('[data-testid=setup-endpoint-url]', 'https://api.acme.test/v1');
      const field = page.locator('[data-testid=setup-endpoint-key]');
      // A password field, so a screen share or a screenshot of this panel does
      // not carry the key with it.
      await expect(field).toHaveAttribute('type', 'password');
      await field.fill(KEY);
      await page.click('[data-testid=setup-add-endpoint]');

      await expect(page.locator('[data-testid=setup-outcome-summary]')).toContainText(
        'endpoints.json',
        { timeout: 15_000 },
      );

      // It reached main exactly once, on exactly the channel meant to carry it.
      expect(await plansSeen(agbrte)).toEqual([
        {
          kind: 'endpoint',
          endpoint: { id: 'acme', provider: 'acme', baseUrl: 'https://api.acme.test/v1', apiKey: KEY },
        },
      ]);

      // Cleared from the field once it landed, so it is not sitting in a form
      // for the rest of the session — and, crucially, is nowhere in the DOM.
      await expect(field).toHaveValue('');
      expect(await page.content()).not.toContain(KEY);
      // §6.5's trade, stated where the decision was made rather than in a doc.
      await expect(page.locator('[data-testid=setup-followup]')).toContainText('detached run');
    } finally {
      await agbrte.close();
    }
  });
});
