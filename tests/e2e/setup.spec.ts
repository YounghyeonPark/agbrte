/**
 * "Add an agent" as one list and one button, driven through the real app
 * (DESIGN.md §6.4, §3.7, §3.8, §13).
 *
 * The screen this exists for is the one a fresh ssh host produces: three
 * accurate sentences naming three absences, and nothing to press. The first
 * answer to it was a set-up panel, which grew routes; the panel and the picker
 * and the model catalogue then sat on the same screen, three controls answering
 * one question — *what should run this session* — and asking the person to know
 * which of our mechanisms applied to them. This spec drives what replaced all
 * three: one grouped dropdown whose entries name a concrete thing that will run,
 * and one button that does whatever that entry needs.
 *
 * **Stubbed in main, not in the page**, for the reason `attach.spec.ts` gives:
 * `contextBridge` hands the renderer a frozen API, so a stub installed in the
 * page would be a stub of nothing. Only the machine on the other end is
 * replaced — this checkout has no remote to install anything on, and must not
 * install anything on the developer's own, or pull four gigabytes onto it.
 *
 * The stub is also what lets one property be asserted that no unit test can:
 * that a key typed into the field reaches `hosts.setUp` and **nothing else**,
 * checked by recording every argument main received on that channel.
 *
 * What is asserted here rather than in `tests/setUpPanel.test.ts` is only what
 * needs the real app: the order on screen, what the one button says and does,
 * and that the list can be read to the end at three window sizes. The shape of
 * the list itself is a pure function and is tested there, because whether a
 * developer's own machine happens to have Claude Code or a local Ollama changes
 * what this window shows — and a criterion that quietly stops being checked is
 * worse than one that was never claimed.
 */

import { expect, test, type Page } from '@playwright/test';
import { launch, launchWith, makeRepo, type LaunchedApp } from './harness.js';
import { createSession } from './actions.js';

/** Replace the setup handler, and record what it was given. */
async function stubSetup(
  agbrte: LaunchedApp,
  opts: { steps?: string[]; outcome?: unknown; fail?: string } = {},
): Promise<void> {
  await agbrte.app.evaluate(
    async ({ ipcMain, BrowserWindow }, { steps, outcome, fail }) => {
      const scope = globalThis as unknown as { __setup: unknown[]; __ollama?: boolean };
      scope.__setup = [];
      scope.__ollama = false;

      ipcMain.removeHandler('agbrte:hosts.setUp');
      ipcMain.handle('agbrte:hosts.setUp', async (_e, instanceId: string, plan: unknown) => {
        scope.__setup.push(plan);
        if ((plan as { kind?: string }).kind === 'ollama') {
          (globalThis as unknown as { __ollama?: boolean }).__ollama = true;
        }
        // Out on the real push channel, before the call resolves, so the
        // progress list under test is fed the way production feeds it.
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

/**
 * Replace the three calls a model pull makes, and record them.
 *
 * `hosts.models` is stubbed too, and that is not belt-and-braces: the list this
 * screen shows is a function of what the host reports, so a developer with a
 * local Ollama and one without would drive two different screens. Pinning the
 * answer makes the assertions below say the same thing on any machine.
 */
async function stubModels(
  agbrte: LaunchedApp,
  opts: { before: string[]; after: string[]; canInstall: boolean; pullFails?: string },
): Promise<void> {
  await agbrte.app.evaluate(
    async ({ ipcMain }, { before, after, canInstall, pullFails }) => {
      const scope = globalThis as unknown as { __pulls: unknown[]; __pulled: boolean };
      scope.__pulls = [];
      scope.__pulled = false;

      ipcMain.removeHandler('agbrte:hosts.models');
      ipcMain.handle('agbrte:hosts.models', async () => [
        {
          endpointId: 'local',
          models: scope.__pulled ? after : before,
          // A machine that had no model server has one the moment `setUp` puts
          // it there, which is the whole point of the route being one press:
          // the second half has to see what the first half changed.
          canInstall: canInstall || (globalThis as unknown as { __ollama?: boolean }).__ollama === true,
          runner: 'ollama',
        },
      ]);

      ipcMain.removeHandler('agbrte:hosts.installModel');
      // `(event, instanceId, endpointId, tag)` — every `hosts.*` channel names
      // the host first, and a stub that forgets it records the wrong two
      // strings and then waits forever for a pull that never matches.
      ipcMain.handle(
        'agbrte:hosts.installModel',
        async (_e, _instanceId: string, endpointId: string, tag: string) => {
          scope.__pulls.push({ endpointId, tag });
        },
      );

      // Two answers: one mid-pull, one done. Enough to prove the app waits for
      // the end rather than seating an agent on a model that is still arriving.
      let polls = 0;
      ipcMain.removeHandler('agbrte:hosts.installProgress');
      ipcMain.handle('agbrte:hosts.installProgress', async () => {
        const pull = (scope.__pulls[0] ?? null) as { endpointId: string; tag: string } | null;
        if (pull === null) return [];
        polls += 1;
        if (pullFails !== undefined) {
          return [{ ...pull, status: 'failed', completed: 0, total: 0, done: true, error: pullFails }];
        }
        const done = polls > 1;
        if (done) scope.__pulled = true;
        return [
          {
            ...pull,
            status: done ? 'success' : 'pulling',
            completed: done ? 100 : 40,
            total: 100,
            done,
          },
        ];
      });
    },
    { before: opts.before, after: opts.after, canInstall: opts.canInstall, pullFails: opts.pullFails },
  );
}

/** Record what `sessions.addAgent` was asked for, and let the real one run. */
async function recordSeating(agbrte: LaunchedApp): Promise<void> {
  await agbrte.app.evaluate(async ({ ipcMain }) => {
    const scope = globalThis as unknown as { __seated: unknown[] };
    scope.__seated = [];
    // The handler is wrapped rather than replaced: seating for real is the point
    // of the button, and a stub that returned success would assert that this
    // spec can lie to itself.
    const listeners = (ipcMain as unknown as {
      _invokeHandlers: Map<string, (...args: unknown[]) => unknown>;
    })._invokeHandlers;
    const original = listeners.get('agbrte:sessions.addAgent');
    if (original === undefined) throw new Error('no addAgent handler to wrap');
    ipcMain.removeHandler('agbrte:sessions.addAgent');
    ipcMain.handle('agbrte:sessions.addAgent', async (event, request: unknown) => {
      scope.__seated.push(request);
      return original(event, request);
    });
  });
}

const plansSeen = async (agbrte: LaunchedApp): Promise<unknown[]> =>
  agbrte.app.evaluate(() => (globalThis as never as { __setup: unknown[] }).__setup);

const pullsSeen = async (agbrte: LaunchedApp): Promise<unknown[]> =>
  agbrte.app.evaluate(() => (globalThis as never as { __pulls: unknown[] }).__pulls);

const seatingsSeen = async (agbrte: LaunchedApp): Promise<unknown[]> =>
  agbrte.app.evaluate(() => (globalThis as never as { __seated: unknown[] }).__seated);

/** Open the one list, and hand back its entries in the order the DOM holds. */
async function entries(
  page: Page,
): Promise<Array<{ value: string; group: string; plan: string; text: string }>> {
  await page.click('[data-testid=runtime-trigger]');
  await expect(page.locator('[data-testid=runtime-list]')).toBeVisible();
  return page.locator('[data-testid=runtime-option]').evaluateAll((els) =>
    els.map((el) => ({
      value: el.getAttribute('data-value') ?? '',
      group: el.getAttribute('data-group') ?? '',
      plan: el.getAttribute('data-plan') ?? '',
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
    })),
  );
}

/** Choose an entry by the value `buildEntries` gave it. */
async function choose(page: Page, value: string): Promise<void> {
  await page.click('[data-testid=runtime-trigger]');
  await page.click(`[data-testid=runtime-option][data-value="${value}"]`);
}

/** Resize the real window, which is where a short-window claim has to be tested. */
async function resize(app: LaunchedApp, width: number, height: number): Promise<void> {
  await app.app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
  await app.window.waitForTimeout(300);
}

test.describe('one list, one button', () => {
  test('offers what is ready before what has to be fetched, and says what each costs', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubModels(agbrte, { before: ['qwen2.5:7b'], after: ['qwen2.5:7b'], canInstall: true });
      const page = agbrte.window;
      await createSession(page, 'choosing');

      /*
       * Waited for, because the list grows under the screen: models arrive a
       * round trip after the picker opens, and until they do the only entry a
       * model-taking runtime has is its "another model…" escape hatch — which
       * legitimately reveals a text field. Asserting the resting shape while
       * that is still in flight would assert the loading state instead.
       */
      await expect(page.locator('[data-testid=runtime-trigger]')).toContainText('qwen2.5:7b', {
        timeout: 15_000,
      });

      /*
       * Two controls on the screen, and that is the whole of the redesign.
       *
       * It carried five before: a set-up disclosure, its route buttons, the
       * runtime select, a Browse models button and twelve Install buttons. Any
       * of them could come back without breaking a single behavioural
       * assertion, so the count is asserted directly.
       */
      const controls = await page
        .locator('[data-testid=picker] button, [data-testid=picker] input')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid') ?? ''));
      expect(controls).toEqual(['runtime-trigger', 'add-agent']);

      const list = await entries(page);
      const groups = await page
        .locator('[data-testid=runtime-group]')
        .evaluateAll((els) => els.map((el) => el.getAttribute('data-group') ?? ''));
      expect(groups).toEqual(['ready', 'install']);

      // Ready first, always: a returning user's choice must not move down the
      // list because a catalogue grew.
      const firstInstall = list.findIndex((e) => e.group === 'install');
      expect(firstInstall).toBeGreaterThan(0);
      expect(list.slice(0, firstInstall).every((e) => e.group === 'ready')).toBe(true);
      expect(list.slice(firstInstall).every((e) => e.group === 'install')).toBe(true);

      // The model the host already serves, named as `model · what runs it`.
      const ready = list.find((e) => e.value === 'agbrte-harness::local::qwen2.5:7b');
      expect(ready?.text).toContain('qwen2.5:7b · Agbrte harness');

      /*
       * The description and the size, on the row.
       *
       * These are the two facts a tag cannot carry: what the model is for, and
       * what choosing it will cost. The catalogue existed for the first and the
       * grouping exists for the second, and both have now been asked for twice.
       */
      const download = list.find((e) => e.value === 'install::model::llama3.2:3b');
      expect(download?.plan).toBe('pull');
      expect(download?.text).toContain('2.0 GB to download');
      expect(download?.text).toContain('Runs on a laptop without a discrete GPU');

      /*
       * Every route the set-up panel used to hold is still reachable, as an
       * entry. Claude Code is asserted as "present in one of its two forms"
       * because which one depends on the machine running this suite: installed
       * here, it is a ready entry; absent, it is an install entry. Demanding
       * one of them is how a criterion quietly stops being checked.
       */
      const values = list.map((e) => e.value);
      expect(values).toContain('install::endpoint');
      expect(
        values.includes('cli:claude-code') || values.includes('install::cli::claude-code'),
      ).toBe(true);

      // And the whole list can be read to the end, at the sizes that bite. The
      // popper is capped to the space it has and scrolls inside; the column
      // behind it does not scroll sideways.
      for (const [width, height] of [
        [1180, 820],
        [1180, 481],
        [720, 480],
      ] as const) {
        await page.keyboard.press('Escape');
        await resize(agbrte, width, height);
        await page.click('[data-testid=runtime-trigger]');
        const column = await page.locator('[data-testid=picker-scroll]').evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        }));
        expect(column.scrollWidth, 'the picker column overflows sideways').toBeLessThanOrEqual(
          column.clientWidth,
        );
        const last = page.locator('[data-testid=runtime-option]').last();
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeInViewport();
      }
    } finally {
      await agbrte.close();
    }
  });

  test('a model that is not there is downloaded, waited for, and then seated', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubModels(agbrte, {
        before: ['qwen2.5:7b'],
        after: ['qwen2.5:7b', 'llama3.2:3b'],
        canInstall: true,
      });
      await stubSetup(agbrte);
      await recordSeating(agbrte);
      const page = agbrte.window;
      await createSession(page, 'downloading');

      await choose(page, 'install::model::llama3.2:3b');

      // The button names the work, not the control: "Add agent" over a
      // four-minute download is a promise about duration that it breaks.
      const button = page.locator('[data-testid=add-agent]');
      await expect(button).toHaveText('Download and add agent');
      await expect(page.locator('[data-testid=entry-note]')).toContainText('2.0 GB onto');

      await button.click();

      /*
       * Waited for, rather than seated on a model that is still arriving.
       *
       * `installModel` resolves when the pull has *started* — a model is
       * gigabytes — so the honest end of this route is the host saying done.
       * Asserted as a sequence rather than as a screenshot of "100%": while the
       * host is reporting 40%, nothing has been seated; the seating arrives
       * only after. The completed line is on screen for one frame before the
       * picker is replaced by the chat, which is not something to race.
       */
      await expect(page.locator('[data-testid=setup-steps]')).toContainText(
        'pulling llama3.2:3b — 40%',
        { timeout: 20_000 },
      );
      expect(await seatingsSeen(agbrte)).toEqual([]);

      expect(await pullsSeen(agbrte)).toEqual([{ endpointId: 'local', tag: 'llama3.2:3b' }]);
      // The machine already had a model server, so nothing was installed on it.
      expect(await plansSeen(agbrte)).toEqual([]);

      // And it ends by seating the thing that was chosen, on what pulled it.
      await expect
        .poll(async () => seatingsSeen(agbrte), { timeout: 20_000 })
        .toEqual([
          expect.objectContaining({
            runtimeId: 'agbrte-harness',
            model: expect.objectContaining({ modelId: 'llama3.2:3b', endpointId: 'local' }),
          }),
        ]);
    } finally {
      await agbrte.close();
    }
  });

  test('a machine with no model server gets one first, in the same press', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      // Nothing served and nothing that takes an install: the dead-end host.
      await stubModels(agbrte, { before: [], after: ['llama3.2:3b'], canInstall: false });
      await stubSetup(agbrte, {
        steps: ['downloading Ollama v0.32.14 (about a gigabyte)', 'starting it on 127.0.0.1:11434'],
        outcome: {
          installed: true,
          redetected: true,
          summary: 'Ollama is serving on this machine.',
          steps: [],
        },
      });
      const page = agbrte.window;
      await createSession(page, 'from nothing');

      await choose(page, 'install::model::llama3.2:3b');
      // Both halves of the cost, before the click rather than after it.
      await expect(page.locator('[data-testid=add-agent]')).toHaveText(
        'Install Ollama, download and add',
      );
      await expect(page.locator('[data-testid=entry-note]')).toContainText(
        'Ollama will be installed there first',
      );

      await page.click('[data-testid=add-agent]');

      // The host's own words, in order, for the half that is an install.
      const steps = page.locator('[data-testid=setup-steps] li');
      await expect(steps.first()).toHaveText('downloading Ollama v0.32.14 (about a gigabyte)', {
        timeout: 20_000,
      });
      await expect(page.locator('[data-testid=setup-steps]')).toContainText('pulling llama3.2:3b', {
        timeout: 20_000,
      });

      expect(await plansSeen(agbrte)).toEqual([{ kind: 'ollama' }]);
      await expect
        .poll(async () => pullsSeen(agbrte), { timeout: 20_000 })
        .toEqual([{ endpointId: 'local', tag: 'llama3.2:3b' }]);
    } finally {
      await agbrte.close();
    }
  });

  test('repeats the installer`s own words when it fails, and claims nothing', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubModels(agbrte, { before: [], after: [], canInstall: false });
      await stubSetup(agbrte, {
        steps: ['downloading Ollama v0.32.14 (about a gigabyte)'],
        fail: 'could not install Ollama on this machine — it failed while downloading: curl: (22) The requested URL returned error: 404',
      });
      const page = agbrte.window;
      await createSession(page, 'a failing install');

      await choose(page, 'install::model::llama3.2:3b');
      await page.click('[data-testid=add-agent]');

      /*
       * Verbatim: this is `curl` talking about a machine the reader cannot see,
       * and every attempt to paraphrase one has made it less useful. The three
       * refusals main enforces — a read-only client, a transport that cannot
       * hold a process open, a client with no provisioner — arrive on this same
       * path, which is why it is asserted with a real message rather than a
       * synthetic one.
       */
      await expect(page.locator('[data-testid=setup-failure]')).toContainText('curl: (22)', {
        timeout: 20_000,
      });
      // And nothing claims success beside it, and nothing was pulled.
      await expect(page.locator('[data-testid=setup-outcome]')).toHaveCount(0);
      expect(await pullsSeen(agbrte)).toEqual([]);
    } finally {
      await agbrte.close();
    }
  });

  test('installs a vendor CLI, and carries its sign-in out of the pane', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubModels(agbrte, { before: [], after: [], canInstall: false });
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
      await createSession(page, 'a cli');

      /*
       * Whichever vendor CLI this developer's machine does not already have.
       *
       * Not pinned to Claude Code: on a machine that has it, it is a ready entry
       * and there is nothing to install, and a test that skipped there would be
       * one nobody runs — this checkout has Claude Code. Both CLIs take the same
       * route, so either proves it; only a machine with both installed has
       * nothing to drive here.
       */
      const list = await entries(page);
      const cli = list.find((e) => e.value.startsWith('install::cli::'));
      test.skip(cli === undefined, 'this machine already has both vendor CLIs installed');
      const which = cli!.value.replace('install::cli::', '');
      await page.click(`[data-testid=runtime-option][data-value="${cli!.value}"]`);

      await expect(page.locator('[data-testid=add-agent]')).toContainText('and add');
      await expect(page.locator('[data-testid=entry-note]')).toContainText('signing it in there');

      await page.click('[data-testid=add-agent]');

      await expect(page.locator('[data-testid=setup-followup]')).toContainText('claude auth login', {
        timeout: 20_000,
      });
      expect(await plansSeen(agbrte)).toEqual([{ kind: 'cli', cli: which }]);

      /*
       * And the sentence outlives the pane it was printed in.
       *
       * The agent is seated in the same press, which replaces this screen with
       * the chat — so a follow-up that only lived here would vanish at the
       * moment it became actionable, and an agent seated on a CLI nobody has
       * signed in cannot run. That is the exact failure this feature exists to
       * remove: no error, and still nothing that works.
       */
      await expect(page.locator('[data-testid=notice]')).toContainText('claude auth login', {
        timeout: 20_000,
      });
    } finally {
      await agbrte.close();
    }
  });

  /*
   * The one route that installs nothing, driven end to end (§3.8).
   *
   * Worth an e2e rather than a unit test because the value is in the wiring: the
   * plan is chosen in the renderer, the call crosses the preload, main asks a
   * machine, and the answer comes back as a list somebody copies into a terminal
   * on the other side of the world. A unit test on `vllmReadiness` proves the
   * sentences and none of that.
   *
   * The steps here are shaped like a real Windows answer, because the Windows
   * answer is the one with a reason attached — and `why` is the field that
   * stops a list of manual commands from reading as an unfinished feature.
   */
  test('says what a machine still needs for vLLM, without promising to install it', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubModels(agbrte, { before: [], after: [], canInstall: false });
      await agbrte.app.evaluate(async ({ ipcMain }) => {
        ipcMain.removeHandler('agbrte:hosts.serverReadiness');
        ipcMain.handle('agbrte:hosts.serverReadiness', (_e, _id: string, server: string) => {
          (globalThis as unknown as { __asked?: string }).__asked = server;
          return {
            ready: false,
            summary: 'WSL is not installed, and vLLM needs it on Windows.',
            steps: [
              {
                what: 'Install WSL, then reboot.',
                command: 'wsl --install',
                why: 'This needs administrator rights and a restart, which the app will not do to your machine on its own.',
              },
              { what: 'Inside WSL, install vLLM.', command: 'pip install vllm' },
            ],
          };
        });
      });

      const page = agbrte.window;
      await createSession(page, 'checking for vllm');
      await choose(page, 'install::vllm');

      // The label is the promise. "Install vLLM" over a list whose first item is
      // a reboot would be a promise the next screen immediately breaks.
      await expect(page.locator('[data-testid=add-agent]')).toHaveText('Check this machine');

      await page.click('[data-testid=add-agent]');
      await expect(page.locator('[data-testid=readiness-summary]')).toContainText(
        'WSL is not installed',
        { timeout: 20_000 },
      );

      const steps = page.locator('[data-testid=readiness-steps]');
      // The command, verbatim and selectable: it is going to be copied into a
      // terminal, and one that is paraphrased is one somebody retypes wrong.
      await expect(steps).toContainText('wsl --install');
      // And the answer to "why isn't this a button", where it is asked.
      await expect(steps).toContainText('administrator rights');

      expect(await agbrte.app.evaluate(() => (globalThis as { __asked?: string }).__asked)).toBe(
        'vllm',
      );
      // Nothing was installed, and nothing claimed to be: the install pane
      // belongs to a route that acts, and this one only reports.
      await expect(page.locator('[data-testid=setup-outcome]')).toHaveCount(0);
    } finally {
      await agbrte.close();
    }
  });

/*
 * Seeing the fallback order, and changing it (DESIGN.md §3.9, §13).
 *
 * The order has routed turns for a while — `nextAfter` answers it,
 * `askWithFailover` walks it, a move writes `model.endpoint_switched` with its
 * reason. What no client could do was see it or set it: `endpoints.add` was the
 * only endpoint write on the wire, so the order every turn on a machine follows
 * could be changed in exactly one way, by opening `endpoints.json` on that
 * machine. For the remote GPU box the feature exists for, that is an ssh
 * session and hand-edited JSON.
 *
 * An e2e rather than a unit test because the value is entirely in the wiring:
 * the order comes from the *agent host* (§8), crosses two processes and the
 * preload to be displayed, and the write goes back the other way and restarts
 * the host. Nothing about that is visible from either end alone.
 */
test('shows the order endpoints are tried in, and writes a new one', async () => {
  const repo = await makeRepo();
  const agbrte = await launchWith(
    {
      endpoints: {
        endpoints: [
          { id: 'gpubox', label: 'GPU box', provider: 'local', baseUrl: 'http://127.0.0.1:8000/v1' },
          { id: 'local', label: 'Ollama here', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        ],
        default: 'gpubox',
        fallback: ['gpubox', 'local'],
      },
    },
    repo,
  );

  try {
    await stubModels(agbrte, { before: [], after: [], canInstall: false });
    await agbrte.app.evaluate(async ({ ipcMain }) => {
      const scope = globalThis as unknown as { __order?: string[] };
      ipcMain.removeHandler('agbrte:hosts.setEndpointChain');
      ipcMain.handle('agbrte:hosts.setEndpointChain', (_e, _id: string, order: string[]) => {
        scope.__order = order;
        return {
          path: '/home/dev/.agbrte/endpoints.json',
          default: order[0],
          fallback: order,
          inForce: true,
        };
      });
    });

    const page = agbrte.window;
    await createSession(page, 'ordering endpoints');

    const panel = page.locator('[data-testid=endpoint-order]');
    /*
     * Present at all, which is the point. The fixture host has two endpoints; a
     * machine with one renders nothing here, because a list of one has no order
     * and a panel saying so would be a control that does nothing.
     */
    await expect(panel).toBeVisible({ timeout: 20_000 });
    /*
     * The order the *host* reports, before it is opened — and this assertion is
     * the one that would have caught what shipped broken.
     *
     * `endpointChain` was threaded through the agent host handshake, the
     * advertisement, the supervisor, the session host identity, the DTO and the
     * picker, and stopped at `sessionServer`'s hello, which copies its identity
     * field by field. Every layer type-checked; the app showed "not set" over a
     * file that named an order. Naming the first endpoint here fails if any one
     * of those hops drops it, which is what the panel existing does not.
     */
    await expect(panel.locator('summary')).toContainText('GPU box first');
    await panel.locator('summary').click();

    const rows = page.locator('[data-testid=endpoint-order-row]');
    await expect(rows).toHaveCount(2);
    const before = (await rows.allTextContents()).map((t) => t.trim());

    // Nothing is written until it is asked for: a rearrangement in progress is
    // not a sequence of host restarts.
    await expect(page.locator('[data-testid=endpoint-order-save]')).toBeDisabled();

    // The second row's "up", by name. Reaching for the last button in the list
    // finds the last row's "down", which is correctly disabled — the assertion
    // would have been about the wrong control.
    await page.click('[data-testid=endpoint-up-local]');
    const after = (await rows.allTextContents()).map((t) => t.trim());
    expect(after).not.toEqual(before);

    await page.click('[data-testid=endpoint-order-save]');
    await expect(page.locator('[data-testid=endpoint-order-outcome]')).toContainText(
      'the host restarted onto it',
      { timeout: 20_000 },
    );

    // Ids, and only ids. §13's boundary: reordering must never be a route to
    // changing what an endpoint *is*, so nothing else may be on this wire.
    const sent = await agbrte.app.evaluate(() => (globalThis as { __order?: string[] }).__order);
    expect(sent).toBeDefined();
    expect(sent?.every((id) => typeof id === 'string')).toBe(true);
    expect(sent?.length).toBe(2);
  } finally {
    await agbrte.close();
  }
});

  test('sends the API key to setUp and to nothing else', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const KEY = 'sk-e2e-never-anywhere-else';

    try {
      await stubModels(agbrte, { before: [], after: [], canInstall: false });
      await stubSetup(agbrte, {
        outcome: {
          installed: true,
          redetected: true,
          summary: 'Added "acme" to /home/dev/.agbrte/endpoints.json.',
          steps: [],
          followUp:
            'That key now lives on this machine, which is what lets a detached run keep going.',
        },
      });
      const page = agbrte.window;
      await createSession(page, 'adding an endpoint');

      await choose(page, 'install::endpoint');
      // Selecting it reveals the form rather than pretending a key is guessable.
      await expect(page.locator('[data-testid=setup-endpoint]')).toBeVisible();
      await expect(page.locator('[data-testid=add-agent]')).toHaveText('Add endpoint');

      await page.fill('[data-testid=setup-endpoint-id]', 'acme');
      await page.fill('[data-testid=setup-endpoint-provider]', 'acme');
      await page.fill('[data-testid=setup-endpoint-url]', 'https://api.acme.test/v1');
      /*
       * The form opens on a keyless local server — a vLLM or an NIM on the
       * agent's own box, which is §6.5's lowest-exposure row and what somebody
       * adding an endpoint most often has. So the warning below is not shown
       * yet: it describes a credential, and there is not one until the next line.
       */
      await expect(page.locator('[data-testid=setup-endpoint]')).not.toContainText(
        'anyone who can read your home directory',
      );
      // Which wire it speaks, which is a different question from who receives
      // it — `provider` above is §13's disclosure and this must match an adapter.
      await expect(page.locator('[data-testid=setup-endpoint-api]')).toHaveValue(
        'openai-compatible',
      );
      const field = page.locator('[data-testid=setup-endpoint-key]');
      // A password field, so a screen share or a screenshot does not carry it.
      await expect(field).toHaveAttribute('type', 'password');
      await field.fill(KEY);
      // And once there is a key, §6.5's trade appears — both halves of it,
      // because reading only one leads to the wrong choice.
      await expect(page.locator('[data-testid=setup-endpoint]')).toContainText(
        'anyone who can read your home directory',
      );
      await page.click('[data-testid=add-agent]');

      await expect(page.locator('[data-testid=setup-outcome-summary]')).toContainText(
        'endpoints.json',
        { timeout: 20_000 },
      );

      /*
       * It reached main exactly once, on exactly the channel meant to carry it.
       *
       * Compared whole rather than field by field, which is the point: a plan
       * that grew a field would otherwise pass unexamined, and this is the one
       * message in the app that carries a secret. `api` is here because the plan
       * gained it — the form can now say which adapter speaks to the endpoint,
       * so an endpoint added through the app is no longer always
       * `openai-compatible`.
       */
      expect(await plansSeen(agbrte)).toEqual([
        {
          kind: 'endpoint',
          endpoint: {
            id: 'acme',
            provider: 'acme',
            baseUrl: 'https://api.acme.test/v1',
            apiKey: KEY,
            api: 'openai-compatible',
          },
        },
      ]);

      // Cleared from the field once it landed, so it is not sitting in a form
      // for the rest of the session — and, crucially, is nowhere in the DOM.
      await expect(field).toHaveCount(0);
      expect(await page.content()).not.toContain(KEY);
      // §6.5's trade, stated where the decision was made rather than in a doc.
      await expect(page.locator('[data-testid=setup-followup]')).toContainText('detached run');
    } finally {
      await agbrte.close();
    }
  });
});
