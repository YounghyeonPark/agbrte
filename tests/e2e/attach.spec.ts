/**
 * Naming a machine, then choosing a folder (DESIGN.md §6.2, §8).
 *
 * These were one form. A host was one per *workspace*, so attaching meant naming
 * a machine **and** an absolute path in the same breath — and the path was typed
 * from memory against a placeholder reading `/home/you/project`, so a machine you
 * had not used for a month could not be attached without opening a terminal to go
 * and look.
 *
 * Two things fixed that, and only the second is visible here. The machine is
 * *asked* what is on it (§6.2), which needs nothing but a POSIX shell and runs
 * before any host exists; and the form split, because a host is one per machine
 * now and a session picks its folder when it is created (§8). So this spec drives
 * both halves: **Attach** names a machine, asks it what is on it, and then opens
 * one of those folders — which is the act that starts a host — and **New
 * session** asks the same questions for a second project on a machine already
 * attached.
 *
 * The panel used to *stop* at the machine, which was right about the design and
 * a dead end on screen: pressing a button called Attach left the sidebar empty,
 * because a machine with no folder open has no host, and an empty sidebar is
 * indistinguishable from a connection that failed.
 *
 * **Stubbed in main, not in the page.** The discovery handler is replaced on
 * `ipcMain`, so everything under test is the shipping code: the store action, the
 * dropdown, the fallback field, the memory and the panels themselves.
 * `contextBridge` hands the renderer a frozen API, so a stub installed in the
 * page would be a stub of nothing.
 *
 * The `~/.ssh/config` reader is stubbed too, and not for convenience: a test that
 * let the developer's own config through would be testing whichever machines that
 * person happens to have.
 *
 * The canned answer is deliberately **long** — twenty-seven directories, the
 * shape a working machine actually produces — because a short fixture would prove
 * nothing about a control whose whole job is to hold a lot without taking the
 * panel over.
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
 * answer back while another's arrives. Every path is suffixed with the alias it
 * came from, so "whose list is on screen" is answerable.
 *
 * `unavailable` is the machine that answered and cannot be *listed* — a Windows
 * remote, a shell that is not POSIX — which is a different fact from one that
 * could not be reached, and the panels say so differently.
 */
async function stubMachines(
  app: LaunchedApp,
  opts: {
    delays?: Record<string, number>;
    fail?: string;
    unavailable?: string;
    /** A machine with directories but no Agbrte workspace among them. */
    onlyPlain?: boolean;
  } = {},
): Promise<void> {
  await app.app.evaluate(
    async ({ ipcMain }, { found, machines, delays, fail, unavailable, onlyPlain }) => {
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
        if (unavailable !== undefined) {
          return { alias, roots: [], depth: 0, candidates: [], truncated: false, partial: false, unavailable };
        }
        return {
          alias,
          ...found,
          candidates: found.candidates
            .filter((c) => onlyPlain !== true || c.kind === 'folder')
            .map((c) => ({ ...c, path: `${c.path}-${alias}` })),
        };
      });

      ipcMain.removeHandler('agbrte:hosts.addRemote');
      ipcMain.handle('agbrte:hosts.addRemote', (_e, alias: string, workspaceRoot: string) => {
        (globalThis as unknown as { __opened: string[] }).__opened ??= [];
        (globalThis as unknown as { __opened: string[] }).__opened.push(`${alias} ${workspaceRoot}`);
        return {
          instanceId: `stub:${alias}:${workspaceRoot}`,
          root: workspaceRoot,
          lineageId: 'stub-lineage',
          targetKind: 'ssh',
          label: alias,
          available: [],
          endpoints: [],
          runtimeNotes: [],
          link: 'connected',
        };
      });
    },
    {
      found: FOUND,
      machines: MACHINES,
      delays: opts.delays,
      fail: opts.fail,
      unavailable: opts.unavailable,
      onlyPlain: opts.onlyPlain,
    },
  );
}

/**
 * The folders opened, counted in main.
 *
 * What the sidebar does with them cannot be asserted here: the stub answers
 * `hosts.addRemote` but the sidebar is filled from the *real* fleet, which has
 * no such host and would need an `sshd` to get one. So this proves the half a
 * page can prove — that pressing Open folder reaches the call that connects,
 * with the path that was chosen — and `attachedMachines.test.ts` covers what
 * main does with it.
 */
const opened = async (app: LaunchedApp): Promise<string[]> =>
  app.app.evaluate(() => (globalThis as never as { __opened?: string[] }).__opened ?? []);

/** How many times the machine has been asked, counted in main. */
const asked = async (app: LaunchedApp): Promise<number> =>
  app.app.evaluate(() => (globalThis as never as { __asked: number }).__asked);

/** Open the attach panel on its remote tab. */
async function openRemote(page: Page): Promise<void> {
  await page.click('[data-testid=add-host]');
  await page.click('[data-testid=attach-remote]');
}

/** Nothing in a 300px sidebar may scroll sideways. */
async function fitsSideways(page: Page, testid: string): Promise<void> {
  /*
   * `App.tsx`'s nav already carries `overflow-x-hidden` because at 150% Windows
   * scaling a 1px rounding paints a phantom full-width scrollbar; a *real* one is
   * worse, and it arrives the moment a row cannot shrink — a text input will not
   * go below its intrinsic twenty characters, and a select trigger takes its
   * width from the longest path in it, unless both are told otherwise.
   */
  const box = await page
    .locator(`[data-testid=${testid}]`)
    .evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
  expect(box.scrollWidth, `${testid} overflows its column sideways`).toBeLessThanOrEqual(
    box.clientWidth,
  );
}

test.describe('attaching asks for a machine', () => {
  test('asks for the folder only after the machine has answered, and then connects', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte);
      const page = agbrte.window;
      await openRemote(page);

      /*
       * A machine and **Attach**, and nothing about folders yet: there is
       * nothing to choose from before the machine has answered, and a folder
       * field above a machine that may not exist invites typing a path nobody
       * can reach. Asserted by absence, because absence is the only way to keep
       * it from drifting back up the panel.
       */
      await expect(page.locator('[data-testid=attach-alias]')).toHaveValue('build-01');
      await expect(page.locator('[data-testid=attach-remote-go]')).toBeVisible();
      await expect(page.locator('[data-testid=attach-path]')).toHaveCount(0);
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toHaveCount(0);

      // Nothing has been asked of the machine yet: naming one is a decision, and
      // this panel no longer needs its folder list to do its job.
      expect(await asked(agbrte)).toBe(0);
      // …and it says what attaching does and does not do, up front.
      await expect(page.locator('[data-testid=attach-panel]')).toContainText(
        'Naming a machine installs nothing',
      );
      await fitsSideways(page, 'attach-panel');

      // Attach asks the machine one bounded, read-only question — which is the
      // check, because a panel that only wrote the name down would report success
      // for a machine nobody had spoken to.
      await page.click('[data-testid=attach-remote-go]');
      expect(await asked(agbrte)).toBe(1);

      /*
       * …and goes all the way to a host in that one press.
       *
       * Two earlier shapes were wrong in opposite directions. Stopping at the
       * machine left the sidebar empty, which is what a failed connection looks
       * like. Stopping at a folder *field* was honest and still two presses for
       * the only thing anybody wanted. So the folder is resolved — the one used
       * here last, or the first one discovery found — and opened in the same act.
       */
      await expect(page.locator('[data-testid=attach-panel]')).toBeHidden();
      expect(await opened(agbrte)).toEqual(['build-01 /home/dev/used-0-build-01']);
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('does not open a folder it only guessed at', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      // Directories, and not one of them an Agbrte workspace: the shape of a
      // home directory anywhere.
      await stubMachines(agbrte, { onlyPlain: true });
      const page = agbrte.window;
      await openRemote(page);
      await page.click('[data-testid=attach-remote-go]');

      /*
       * The panel asks instead of choosing.
       *
       * One-press attach used to take the first thing discovery ranked, and
       * discovery ranks *every* directory one level down — so attaching a
       * machine silently opened `~/Desktop` and put a session on top of
       * somebody's entire desktop. Reported from a real server. A folder counts
       * as resolved when it is one this person opened here before or one that
       * already is a workspace; a ranking is not proof.
       */
      await expect(page.locator('[data-testid=attach-panel]')).toBeVisible();
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue('');
      expect(await opened(agbrte)).toEqual([]);
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('a machine that cannot be reached is named, and not remembered', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte, { fail: 'ssh: Could not resolve hostname build-01' });
      const page = agbrte.window;
      await openRemote(page);
      await page.click('[data-testid=attach-remote-go]');

      /*
       * The failure stays **inside this panel** rather than raising the app's
       * error banner — an alarm about an action nobody took, over a field that
       * still works — and the panel stays open, because the next thing somebody
       * does is fix the name.
       */
      await expect(page.locator('[data-testid=attach-error]')).toContainText(
        'Could not reach build-01',
      );
      await expect(page.locator('[data-testid=attach-panel]')).toBeVisible();

      // And it was not remembered: a machine that has never answered is not one
      // to offer first next time.
      await page.click('[data-testid=new-session-oneshot]');
      const machines = page.locator('[data-testid=new-session-machine] option');
      await expect(machines).toHaveCount(1);
      await expect(machines.first()).toHaveText('This machine');
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('this machine needs no attaching, and says so', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await page.click('[data-testid=add-host]');
      await page.click('[data-testid=attach-local]');

      // Not a folder picker any more. The machine the app runs on is present by
      // construction, and the folder is a question the session asks.
      await expect(page.locator('[data-testid=attach-local-note]')).toContainText(
        'Choose a folder to work in when you start a session',
      );
      await expect(page.locator('[data-testid=attach-pick-folder]')).toHaveCount(0);
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });
});

test.describe('creating a session asks for a folder', () => {
  test('makes a folder of its own when asked for one', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;
      await page.click('[data-testid=new-session-oneshot]');
      await expect(page.locator('[data-testid=new-session-panel]')).toBeVisible();

      /*
       * One session, one folder — the rule this form never stated.
       *
       * It asked for *a path*, and the browser beside it offered every directory
       * on the machine, so the easy answer was whatever already existed: a real
       * session ended up holding somebody's entire `~/Desktop`, `.agbrte` and
       * all. Starting something new should not mean finding a place for it in a
       * file manager first.
       */
      await page.fill('[data-testid=new-session-path]', repo);
      await page.fill('[data-testid=new-session-folder]', 'the-parser-rewrite');

      // Shown before it happens: creating a directory is a change to a machine,
      // and one made on somebody's behalf has to be legible first.
      await expect(page.locator('[data-testid=new-session-target]')).toContainText(
        'the-parser-rewrite',
      );

      await page.click('[data-testid=new-session-open]');
      // The workspace that opened is the new folder, not the one browsed to.
      await expect(page.locator('[data-testid=new-session-opened]')).toContainText(
        'the-parser-rewrite',
      );
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('offers what is on the machine, and the field still takes anything', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte);
      const page = agbrte.window;

      // Name the machine first. That now opens a folder on it too, which this
      // test does not care about — it is here for the *other* way in, the one
      // that reaches a second project on a machine already attached.
      await openRemote(page);
      await page.click('[data-testid=attach-remote-go]');
      await expect(page.locator('[data-testid=attach-panel]')).toBeHidden();

      await page.click('[data-testid=new-session-oneshot]');
      await expect(page.locator('[data-testid=new-session-panel]')).toBeVisible();

      // This machine first, then the ones that have been named.
      const machines = page.locator('[data-testid=new-session-machine] option');
      await expect(machines).toHaveCount(2);
      await page.selectOption('[data-testid=new-session-machine]', 'build-01');

      /*
       * The kinds survive the collapse: three labelled groups inside the popup,
       * in the order discovery ranked them. A folder holding `.agbrte/` is a
       * different claim from a git repository and from one that merely exists,
       * and flattening them would throw the ranking away at the last step.
       */
      const trigger = page.locator('[data-testid=attach-workspace-trigger]');
      /*
       * Already showing the folder attaching opened, which is the point of
       * remembering one: this panel is the way to a *second* project on a
       * machine, and it opens on the first rather than on a placeholder. The
       * list behind it is unchanged and is what the rest of this asserts.
       */
      await expect(trigger).toContainText('/home/dev/used-0-build-01');
      await trigger.click();
      await expect(page.locator('[data-testid=attach-group-workspace]')).toContainText(
        'Used by Agbrte before (8)',
      );
      await expect(page.locator('[data-testid=attach-group-git]')).toContainText(
        'Git repositories (6)',
      );
      await expect(page.locator('[data-testid=attach-group-folder]')).toContainText(
        'Other folders (13)',
      );

      // Choosing fills the field, which is the control the decision is made in.
      await page.click('[data-testid=attach-candidate][data-path="/home/dev/used-0-build-01"]');
      await expect(page.locator('[data-testid=new-session-path]')).toHaveValue(
        '/home/dev/used-0-build-01',
      );
      await fitsSideways(page, 'new-session-panel');

      // A seventy-character path is the other way a row grows: once in the field
      // it fills, and again in the trigger that then has to display it.
      await trigger.click();
      await page.click(
        '[data-testid=attach-candidate][data-path="/home/dev/src/a-rather-deeply-nested/monorepo-with-a-long-name-0-build-01"]',
      );
      await fitsSideways(page, 'new-session-panel');

      // And the field is not a display: discovery is bounded on purpose, so a
      // workspace four levels down is expected to be missed and typed instead.
      await page.fill('[data-testid=new-session-path]', '/srv/typed-by-hand');
      await expect(page.locator('[data-testid=new-session-open]')).toBeEnabled();
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('a machine that answered and cannot be listed says so, and the field works', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await stubMachines(agbrte, {
        unavailable: 'that machine answered but is not running a POSIX shell',
      });
      const page = agbrte.window;
      await openRemote(page);
      await page.click('[data-testid=attach-remote-go]');
      /*
       * Reached, so remembered: the failure is about *listing*, and typing a
       * path there works. Treating it as unreachable would refuse a machine that
       * is perfectly usable.
       *
       * This is also the case the one-press attach cannot finish: there is no
       * folder to resolve, so rather than guess it stops here, on the field,
       * with the reason beside it.
       */
      await expect(page.locator('[data-testid=attach-note]')).toContainText(
        'not running a POSIX shell',
      );
      await expect(page.locator('[data-testid=attach-path]')).toHaveValue('');
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toHaveCount(0);
      await page.click('[data-testid=add-host]');
      await expect(page.locator('[data-testid=attach-panel]')).toBeHidden();

      await page.click('[data-testid=new-session-oneshot]');
      await page.selectOption('[data-testid=new-session-machine]', 'build-01');
      await expect(page.locator('[data-testid=new-session-note]')).toContainText(
        'not running a POSIX shell',
      );
      await expect(page.locator('[data-testid=attach-workspace-trigger]')).toHaveCount(0);

      // The field is what is left, and it is enough.
      await page.fill('[data-testid=new-session-path]', '/home/dev/project');
      await expect(page.locator('[data-testid=new-session-open]')).toBeEnabled();
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });

  test('opening a folder shows what is already in it before offering a new one', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const page = agbrte.window;

      // A session made the ordinary way, so the folder has something in it.
      await page.click('[data-testid=new-session-oneshot]');
      await expect(page.locator('[data-testid=new-session-panel]')).toBeVisible();
      await page.fill('[data-testid=new-session-path]', repo);
      await page.click('[data-testid=new-session-open]');
      await expect(page.locator('[data-testid=new-session-opened]')).toContainText(repo);
      await page.click('[data-testid=new-session-start]');
      await expect(page.locator('[data-testid=new-session-panel]')).toBeHidden();

      /*
       * Open the same folder again. What matters is the second step: a folder
       * somebody opened last month usually holds the session they actually want,
       * and a form that went straight from "which folder" to "what shall we call
       * the new one" would make a duplicate the easiest thing to make.
       */
      await page.click('[data-testid=new-session-oneshot]');
      await page.fill('[data-testid=new-session-path]', repo);
      await page.click('[data-testid=new-session-open]');
      await expect(page.locator('[data-testid=new-session-existing]')).toContainText(
        'already here',
      );
      await expect(page.locator('[data-testid=new-session-existing-row]').first()).toBeVisible();
      // …and the title is filled from the folder, so nobody has to type one.
      await expect(page.locator('[data-testid=new-session-title]')).not.toHaveValue('');
    } finally {
      await agbrte.close();
      await agbrte.window.context().close().catch(() => undefined);
    }
  });
});
