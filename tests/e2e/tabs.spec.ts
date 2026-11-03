/**
 * The app opens on a terminal, in tabs (DESIGN.md §17 Q24, step 2).
 *
 * Launched the way a person gets it — no `?ui=classic` — and driven by the keys
 * a terminal has: a tab is there without anybody asking, the shell in it runs,
 * the palette reaches what a tab cannot do yet (seating an agent, in the
 * classic view) and comes back, a second tab is seated with the agent the first
 * one taught, and closing a tab closes it.
 */

import { expect, test, type Page } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launchWith, makeRepo } from './harness.js';
import { addAgent } from './actions.js';

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

    // No agent yet: asking says so, and where to choose one, instead of hanging.
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`first-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('no agent yet');

    // Seated through the palette, in the classic view, and back.
    await palette(w, 'agent');
    await expect(w.locator('[data-testid=app]')).toBeVisible();
    await addAgent(w, 'echo');
    await palette(w, 'terminal');
    await expect(w.locator('[data-testid=terminal-app]')).toBeVisible();

    // The same tab — the same shell — now reaches the agent.
    await w.locator(ACTIVE).click();
    await w.keyboard.type('?');
    await w.keyboard.type(`asked-${id}`);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(`echo: asked-${id}`);

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
