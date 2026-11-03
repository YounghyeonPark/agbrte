/**
 * The app opens on a terminal, in tabs (DESIGN.md §17 Q24, step 2).
 *
 * Launched the way a person gets it — no `?ui=classic` — and driven by the keys
 * a terminal has: a tab is there without anybody asking, saying how to reach
 * the agent, the shell in it runs, the palette seats an agent without leaving
 * the tab, a second tab is seated with the agent the first one taught, and
 * closing a tab closes it.
 */

import { expect, test, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchWith, makeRepo } from './harness.js';

const ACTIVE = '[data-testid=terminal-tab-pane][data-active=true] [data-testid=pty-screen]';

async function screen(page: Page): Promise<string> {
  return (await page.locator(ACTIVE).innerText()).replace(/\s+/g, ' ');
}

async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press('Control+Shift+P');
  await expect(page.locator('[data-testid=palette]')).toBeVisible();
  await page.click(`[data-testid=palette-item][data-command="${command}"]`);
}

test('opens on a terminal tab; the palette seats an agent; new tabs inherit it', async () => {
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    // A tab without anybody asking, and the shell in it at its prompt.
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    // Above the first prompt, how to reach the agent — and that there is none yet.
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('? asks the agent once');
    await expect.poll(async () => await screen(w)).toContain('no agent in this tab yet');

    // No agent yet: asking says so, and where to choose one, instead of hanging.
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`first-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('no agent yet');

    // Seated from the palette's list of agents, without leaving the terminal:
    // through the classic view, `?` opened a chat box beside the shell.
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:echo"]');
    await expect(w.locator('[data-testid=palette]')).toHaveCount(0);
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();

    // The same tab — the same shell — now reaches the agent.
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`asked-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`echo: asked-${id}`);
    // The message stays on the screen as it was typed, prefix and all.
    expect(await screen(w)).toContain(`? asked-${id}`);

    // A new tab is a new session, seated with the agent this window remembers.
    await w.keyboard.press('Control+Shift+T');
    await expect(w.locator('[data-testid=tab]')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`second-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`echo: second-${id}`);

    // Closed, as a terminal closes a tab: the other one is still there.
    await w.keyboard.press('Control+Shift+W');
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1);
    await expect.poll(async () => await screen(w)).toContain(`echo: asked-${id}`);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

test('a tab already open when the agent is chosen in another gets it too', async () => {
  /*
   * Only new tabs were seated. The owner opened tabs, chose an agent in one,
   * and the others went on answering "no agent yet".
   */
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    // A second tab before anything is remembered: it opens with no agent.
    await w.keyboard.press('Control+Shift+T');
    await expect(w.locator('[data-testid=tab]')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain('no agent in this tab yet');

    // Chosen in the first tab.
    await w.locator('[data-testid=tab]').first().click();
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:echo"]');
    await expect(w.locator('[data-testid=palette]')).toHaveCount(0);

    // The second answers too.
    await w.locator('[data-testid=tab]').nth(1).click();
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`other-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`echo: other-${id}`);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

test('the agent is shown what was run in the tab since it last answered', async () => {
  /*
   * §17 Q23 step 4: "fix the error above" needs the error. The echo runtime
   * says back everything it was handed, so what it says is what it was shown.
   */
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('the agent sees the commands');
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:echo"]');
    await expect(w.locator('[data-testid=palette]')).toHaveCount(0);

    await w.locator(ACTIVE).click();
    await w.keyboard.type(`echo shown-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain(`shown-${id}`);
    await w.keyboard.type('?');
    await w.keyboard.type(`what-${id}`);
    await w.keyboard.press('Enter');
    // The command line and its output, inside what the agent was handed.
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`</terminal> what-${id}`);
    const said = (await screen(w)).split('echo: <terminal>')[1] ?? '';
    expect(said).toContain(`$ echo shown-${id} shown-${id}`);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

test('what the classic view held opens over the tab, and Esc gives the tab back', async () => {
  /*
   * Settings, the inbox, workflows, attaching a machine, opening a folder and
   * the agent's forms each switched the window to the classic view. Now each
   * is a sheet over the tabs or a list in the palette, and the shell under a
   * sheet is the one that was there — what was typed in it is still on screen.
   */
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);
  const folder = repo.split(/[\\/]/).pop()!;
  const sheet = (name: string) => w.locator(`[data-testid=sheet][data-sheet=${name}]`);

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    await w.locator(ACTIVE).click();
    await w.keyboard.type(`echo kept-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain(`kept-${id}`);

    // Nothing the palette offers sends the window to the classic view except
    // the session's record, which no tab draws yet.
    await w.keyboard.press('Control+Shift+P');
    const hints = await w.locator('[data-testid=palette-item]').evaluateAll((items) =>
      items.filter((i) => i.textContent?.includes('the classic view')).map((i) => i.getAttribute('data-command')),
    );
    expect(hints).toEqual(['record']);
    await w.keyboard.press('Escape');

    await palette(w, 'settings');
    await expect(sheet('settings').locator('[data-testid=settings]')).toBeVisible();
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-testid=sheet]')).toHaveCount(0);
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();
    expect(await screen(w)).toContain(`kept-${id}`);

    await palette(w, 'workflows');
    await expect(sheet('workflows')).toBeVisible();
    await w.click('[data-testid=sheet-close]');
    await expect(w.locator('[data-testid=sheet]')).toHaveCount(0);

    await palette(w, 'folder');
    await expect(sheet('folder')).toBeVisible();
    await w.keyboard.press('Escape');

    await palette(w, 'attach');
    await expect(sheet('attach')).toBeVisible();
    await w.keyboard.press('Escape');

    // The inbox is a list in the palette rather than a dropdown in a sidebar.
    await palette(w, 'inbox');
    await expect(w.locator('[data-testid=palette-item]').first()).toHaveAttribute('data-command', /^inbox:/u);
    await w.keyboard.press('Escape');
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-testid=palette]')).toHaveCount(0);

    // The picker's forms, for this tab, from the end of the agent list.
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:more"]');
    await expect(sheet('agent').locator('[data-testid=picker-scroll]')).toBeVisible();
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-testid=sheet]')).toHaveCount(0);

    // The one trip left: the record, and back to the same shell.
    await palette(w, 'record');
    await expect(w.locator('[data-testid=terminal-app]')).toBeHidden();
    await palette(w, 'terminal');
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();
    expect(await screen(w)).toContain(`kept-${id}`);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

test('a folder opened from the palette becomes a tab, not the classic view', async () => {
  /*
   * The folder form ends by making its session the store's open one, which is
   * how the classic view showed it. Over the terminal, the same ending has to
   * be a tab on that session — the shell in the folder that was chosen.
   */
  const repo = await makeRepo();
  const other = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const otherName = other.split(/[\\/]/).pop()!;

  try {
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1, { timeout: 60_000 });
    await palette(w, 'folder');
    await w.fill('[data-testid=new-session-path]', other);
    await w.fill('[data-testid=new-session-folder]', '');
    await w.click('[data-testid=new-session-open]');
    await expect(w.locator('[data-testid=new-session-opened]')).toBeVisible({ timeout: 60_000 });
    await w.click('[data-testid=new-session-start]');

    await expect(w.locator('[data-testid=sheet]')).toHaveCount(0, { timeout: 30_000 });
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();
    await expect(w.locator('[data-testid=tab]')).toHaveCount(2, { timeout: 30_000 });
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(otherName);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    await rm(other, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
