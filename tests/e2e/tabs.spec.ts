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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

test('a tab opened again on a session draws the end of its past above the new shell', async () => {
  /*
   * A tab is a session and the shell in it is not: closed and opened again —
   * or restored after a restart, which takes the same path — the pane is a new
   * shell over a session with a past, and its screen was empty. The end of the
   * log is drawn above the first prompt now (`earlier.ts`), through the same
   * Windows pseudoconsole the greeting has to get past.
   */
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    // A new session has nothing before it, and says nothing about it.
    expect(await screen(w)).not.toContain('earlier in this session');
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:echo"]');
    await w.locator(ACTIVE).click();
    await w.keyboard.type(`echo before-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain(`before-${id}`);
    await w.keyboard.type('?');
    await w.keyboard.type(`asked-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`</terminal> asked-${id}`);

    // Closed, and opened again from the palette: a new shell on the same session.
    await w.keyboard.press('Control+Shift+W');
    await expect(w.locator('[data-testid=tab]')).toHaveCount(0);
    await w.keyboard.press('Control+Shift+P');
    await w.locator('[data-testid=palette-item][data-command^="open:"]').first().click();
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1, { timeout: 30_000 });

    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain('asks the agent once');
    expect(await screen(w)).toContain('a new shell');
    /*
     * Above the screen, on Windows: what is drawn over the first prompt is
     * scrolled up past the row the pseudoconsole will repaint from (`resync`
     * in mux/session.ts), as the agent's replies are, so it is in the
     * terminal's history rather than on the rows the prompt is drawn on.
     * One turn of the wheel at a time until the fence is in view.
     */
    const box = await w.locator(ACTIVE).boundingBox();
    if (box !== null) await w.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30 && !(await screen(w)).includes('earlier in this session'); i += 1) {
      await w.mouse.wheel(0, -40);
      await w.waitForTimeout(100);
    }
    const shown = await screen(w);
    const at = (text: string): number => shown.indexOf(text);
    expect(at('earlier in this session')).toBeGreaterThanOrEqual(0);
    // The command and its output, the question as it was typed, the answer.
    expect(at(`$ echo before-${id}`)).toBeGreaterThan(at('earlier in this session'));
    expect(at(`? asked-${id}`)).toBeGreaterThan(at(`$ echo before-${id}`));
    expect(at(`</terminal> asked-${id}`)).toBeGreaterThan(at(`? asked-${id}`));
    if (process.env['AGBRTE_EARLIER_SHOT'] !== undefined)
      await w.screenshot({ path: process.env['AGBRTE_EARLIER_SHOT'] });
    // And the shell under it is at a prompt that works; typing brings the view down.
    await w.locator(ACTIVE).click();
    await w.keyboard.type(`echo after-${id}`);
    await w.keyboard.press('Enter');
    await expect
      .poll(async () => await screen(w), { timeout: 30_000 })
      .toMatch(new RegExp(`after-${id}[\\s\\S]*after-${id}`, 'u'));
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
  // Something for the record's file tree to list.
  await writeFile(join(repo, 'NOTES.md'), '# notes\n', 'utf8');
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

    // Nothing the palette offers sends the window to the classic view: the
    // session's record was the last line that did, and is a sheet now.
    await w.keyboard.press('Control+Shift+P');
    const hints = await w.locator('[data-testid=palette-item]').evaluateAll((items) =>
      items.filter((i) => i.textContent?.includes('the classic view')).map((i) => i.getAttribute('data-command')),
    );
    expect(hints).toEqual([]);
    await expect(w.locator('[data-testid=palette-item][data-command=terminal]')).toHaveCount(0);
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

    // A turn, so the record has something the terminal also showed.
    await palette(w, 'agent');
    await w.click('[data-testid=palette-item][data-command="seat:echo"]');
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`recorded-${id}`);
    await w.keyboard.press('Enter');
    // The echo agent says back what it was handed, which begins with what the
    // shell showed it (`<terminal>…`) and ends with the question.
    const answered = new RegExp(`echo: [\\s\\S]*recorded-${id}`, 'u');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toMatch(answered);

    // The record, over the tab: the same turn read back from the host's log,
    // the workspace's files beside it, and Esc back to the same shell — which
    // the classic view could not promise, and is why the record moved here.
    await palette(w, 'record');
    const record = sheet('record').locator('[data-testid=record]');
    await expect(record).toBeVisible({ timeout: 30_000 });
    await expect(record.locator('[data-testid=record-state]')).not.toBeEmpty();
    await expect(record.getByText(answered).first()).toBeVisible({ timeout: 30_000 });
    // No composer: the tab is where a message is typed.
    await expect(record.locator('textarea')).toHaveCount(0);
    await w.click('[data-testid=record-files]');
    await expect(record.getByText('NOTES.md').first()).toBeVisible({ timeout: 30_000 });
    if (process.env['AGBRTE_RECORD_SHOT'] !== undefined)
      await w.screenshot({ path: process.env['AGBRTE_RECORD_SHOT'] });
    await w.keyboard.press('Escape');
    await expect(w.locator('[data-testid=sheet]')).toHaveCount(0);
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();
    expect(await screen(w)).toMatch(answered);
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
