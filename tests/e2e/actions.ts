/**
 * UI actions shared by the e2e specs.
 *
 * Selectors live here and nowhere else. They target `data-testid`, never a
 * styling class: Tailwind utilities change whenever the design does, and a test
 * that selects on a layout class fails on a purely visual edit and reports it as
 * a regression.
 */

import { expect, type Page } from '@playwright/test';

/**
 * Create a session on a host, addressed by its badge label.
 *
 * Sessions belong to a host now, so there is no global "new session" — the
 * button lives in that host's group.
 */
export async function createSession(page: Page, title: string, host?: string): Promise<void> {
  const group = hostGroup(page, host);
  await group.locator('[data-testid=new-session]').click();
  await group.locator('[data-testid=new-title]').fill(title);
  await group.locator('[data-testid=new-submit]').click();
  await expect(page.locator('[data-testid=picker]')).toBeVisible();
}

/** A host's sidebar group. Defaults to the only one when there is just one. */
export function hostGroup(page: Page, label?: string) {
  return label === undefined
    ? page.locator('[data-testid=host]').first()
    : page.locator(`[data-testid=host][data-label="${label}"]`);
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

export async function openSession(page: Page, title: string, host?: string): Promise<void> {
  const scope = host === undefined ? page : hostGroup(page, host);
  await scope.locator(`[data-testid=session][data-title="${title}"]`).click();
}

/** Badge labels of every attached host, in sidebar order. */
export async function attachedHosts(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid=host]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-label') ?? ''));
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
