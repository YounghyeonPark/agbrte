/**
 * UI actions shared by the e2e specs.
 *
 * Selectors live here and nowhere else. They target `data-testid`, never a
 * styling class: Tailwind utilities change whenever the design does, and a test
 * that selects on a layout class fails on a purely visual edit and reports it as
 * a regression.
 */

import { expect, type Page } from '@playwright/test';

export async function createSession(page: Page, title: string, goal?: string): Promise<void> {
  await page.fill('[data-testid=new-title]', title);
  if (goal !== undefined) await page.fill('[data-testid=new-goal]', goal);
  await page.click('[data-testid=new-submit]');
  await expect(page.locator('[data-testid=picker]')).toBeVisible();
}

/**
 * Add an agent, choosing a runtime through the Radix select.
 *
 * The options render into a portal, so they are addressed from the page root
 * rather than from within the trigger.
 */
export async function addAgent(page: Page, runtimeId: string, model?: string): Promise<void> {
  await page.click('[data-testid=runtime-trigger]');
  await page.click(`[data-testid=runtime-option][data-value="${runtimeId}"]`);

  if (model !== undefined) {
    await expect(page.locator('[data-testid=model-id]')).toBeVisible();
    await page.fill('[data-testid=model-id]', model);
  }

  await page.click('[data-testid=add-agent]');
  await expect(page.locator('[data-testid=composer-input]')).toBeVisible();
}

export async function send(page: Page, text: string): Promise<void> {
  await page.fill('[data-testid=composer-input]', text);
  await page.click('[data-testid=composer-send]');
}

export async function openSession(page: Page, title: string): Promise<void> {
  await page.click(`[data-testid=session][data-title="${title}"]`);
}

/** The runtime ids the agent host advertised, read from the open select. */
export async function runtimeOptions(page: Page): Promise<string[]> {
  await page.click('[data-testid=runtime-trigger]');
  const values = await page.locator('[data-testid=runtime-option]').evaluateAll((nodes) =>
    nodes.map((n) => n.getAttribute('data-value') ?? ''),
  );
  await page.keyboard.press('Escape');
  return values;
}
