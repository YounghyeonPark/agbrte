/**
 * Folders the agent may reach (DESIGN.md §17 Q24 step 6), through the real app.
 *
 * What only this can show: `agbrte grant` typed in a tab's real shell reaches
 * the window as a question — through the launcher on the shell's PATH, the
 * pane's keyed channel, the host, and the push to this window alone — and
 * grants nothing until Allow; and the palette lists, adds and takes back
 * grants on the tab's host.
 */

import { expect, test, type Page } from '@playwright/test';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launchWith, makeRepo } from './harness.js';
import { tempFixture } from './fixtureDirs.js';

const ACTIVE = '[data-testid=terminal-tab-pane][data-active=true] [data-testid=pty-screen]';

async function screen(page: Page): Promise<string> {
  return (await page.locator(ACTIVE).innerText()).replace(/\s+/g, ' ');
}

async function grants(page: Page): Promise<string[]> {
  await page.keyboard.press('Control+Shift+P');
  await page.click('[data-testid=palette-item][data-command="grants"]');
  await expect(page.locator('[data-testid=palette-item][data-command="grant:add"]')).toBeVisible();
  const ids = await page
    .locator('[data-testid=palette-item]')
    .evaluateAll((items) => items.map((i) => i.getAttribute('data-command') ?? ''));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid=palette]')).toHaveCount(0);
  return ids.filter((id) => id.startsWith('grant:remove:')).map((id) => id.slice('grant:remove:'.length));
}

test('agbrte grant asks the window, Allow grants, and the palette takes it back', async () => {
  const repo = await makeRepo();
  const outside = join(await tempFixture('agbrte-e2e-granted-'), 'notes');
  await mkdir(outside, { recursive: true });
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    expect(await grants(w)).toEqual([]);

    // Typed in the shell: a question, not a grant.
    await w.locator(ACTIVE).click();
    await w.keyboard.type(`agbrte grant "${outside}"`);
    await w.keyboard.press('Enter');
    await expect(w.locator('[data-testid=grant-dialog]')).toBeVisible({ timeout: 60_000 });
    await expect(w.locator('[data-testid=grant-path]')).toHaveText(outside);
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('asking the window');

    // Not now grants nothing.
    await w.click('[data-testid=grant-deny]');
    await expect(w.locator('[data-testid=grant-dialog]')).toHaveCount(0);
    expect(await grants(w)).toEqual([]);

    // Again, and Allow.
    await w.locator(ACTIVE).click();
    await w.keyboard.type(`agbrte grant "${outside}"`);
    await w.keyboard.press('Enter');
    await expect(w.locator('[data-testid=grant-dialog]')).toBeVisible({ timeout: 60_000 });
    await w.click('[data-testid=grant-allow]');
    await expect.poll(async () => await grants(w), { timeout: 30_000 }).toEqual([outside]);

    // Taken back from the palette.
    await w.keyboard.press('Control+Shift+P');
    await w.click('[data-testid=palette-item][data-command="grants"]');
    // By its text: a Windows path's backslashes cannot sit in an attribute selector.
    await w.locator('[data-testid=palette-item]', { hasText: `Stop letting the agent reach ${outside}` }).click();
    await expect.poll(async () => await grants(w), { timeout: 30_000 }).toEqual([]);

    // And granted from the palette, by typing the path.
    await w.keyboard.press('Control+Shift+P');
    await w.click('[data-testid=palette-item][data-command="grants"]');
    await w.click('[data-testid=palette-item][data-command="grant:add"]');
    await w.keyboard.type(outside);
    await w.keyboard.press('Enter');
    await expect.poll(async () => await grants(w), { timeout: 30_000 }).toEqual([outside]);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
