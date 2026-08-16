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
 *
 * Asserts the picker, which holds only while nothing is remembered for that
 * host: a successful `addAgent` saves the choice as a default, and the next
 * zero-agent session on the same host auto-adds it and lands in the chat.
 * Every launch gets a throwaway profile, so the first session per host in a
 * test is always the picker — a *second* one on the same host is not, and has
 * to be driven by hand (see "remembers the agent choice" in app.spec.ts).
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
 * Add an agent, choosing what will run through the Radix select.
 *
 * One choice, not two. The picker's list is flat — a runtime that needs a model
 * contributes one entry per model its host can reach, one that does not
 * contributes a single entry — so options are addressed by `data-runtime` and
 * `data-model` rather than by the encoded `data-value`, which is the picker's
 * own business.
 *
 * The options render into a portal, so they are addressed from the page root
 * rather than from within the trigger.
 */
export async function addAgent(page: Page, runtimeId: string, model?: string): Promise<void> {
  await page.click('[data-testid=runtime-trigger]');

  if (model === undefined) {
    await page.click(`[data-testid=runtime-option][data-runtime="${runtimeId}"]`);
  } else {
    /*
     * Prefer the listed entry, fall back to typing.
     *
     * Both branches are real: `/v1/models` is optional in the OpenAI-compatible
     * shape, so a host that cannot list what it serves offers only the "another
     * model…" entry — the escape hatch that makes a closed list honest, and the
     * only thing exercising it.
     *
     * The wait is because the list arrives a round trip after the picker opens:
     * without it this races the host's answer and would take the typed branch on
     * a fast machine and the listed one on a slow one.
     */
    const listed = page.locator(
      `[data-testid=runtime-option][data-runtime="${runtimeId}"][data-model="${model}"]`,
    );
    try {
      await listed.waitFor({ state: 'visible', timeout: 15_000 });
    } catch {
      // Not offered — the typed entry below is the route.
    }

    if ((await listed.count()) > 0) {
      await listed.click();
    } else {
      await page.click(`[data-testid=runtime-option][data-runtime="${runtimeId}"][data-typed=true]`);
      const field = page.locator('[data-testid=model-id]');
      await expect(field).toBeVisible();
      await field.fill(model);
    }
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

/**
 * The runtime ids the agent host advertised, read from the open select.
 *
 * Deduplicated, because one runtime now contributes one entry per model it can
 * reach — the question this answers is still "which runtimes did the handshake
 * report", and that must not change with how many models happen to be pulled.
 */
export async function runtimeOptions(page: Page): Promise<string[]> {
  await page.click('[data-testid=runtime-trigger]');
  const values = await page
    .locator('[data-testid=runtime-option]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-runtime') ?? ''));
  await page.keyboard.press('Escape');
  return [...new Set(values)];
}
