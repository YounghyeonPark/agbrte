/**
 * The web client, driven as a browser (§17 Q13).
 *
 * Worth an e2e test rather than a unit one because the claim is that the *same
 * renderer* runs unchanged against a socket instead of Electron IPC. Only a real
 * browser loading the real bundle can show that, and the failure modes it catches
 * — a shim injected too late, a CSP that blocks the WebSocket — both present as a
 * blank page with a console error nobody reads.
 *
 * It starts its own server rather than expecting one. The first version took a
 * URL from the environment, passed against a server I had running, and failed the
 * moment it met the suite: a test that only works when someone remembered to
 * start something is not a test, and skipping instead would have been worse.
 */

import { expect, test } from '@playwright/test';
import { serveWebFixture } from './harness.js';

test('serves the app and drives a session over a socket', async ({ page }) => {
  const web = await serveWebFixture();
  const url = web.url;

  try {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto(url);
    await expect(page.locator('[data-testid=app]')).toBeVisible();

    // The host the server was started for appears, which means the socket
    // carried a real call and a real reply.
    await expect(page.locator('[data-testid=host]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid=start-guide]')).toBeVisible();

    // A round trip that writes: creating a session goes over the socket to the
    // host and comes back as a push.
    await page.locator('[data-testid=new-session]').click();
    await page.locator('[data-testid=new-title]').fill('from a browser');
    await page.locator('[data-testid=new-submit]').click();
    await expect(page.locator('[data-testid=picker]')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.locator('[data-testid=session][data-title="from a browser"]'),
    ).toBeVisible();

    // A CSP violation or a missing shim shows up here and nowhere else.
    expect(
      errors.filter((e) => /Content Security|agbrte is undefined|is not a function/i.test(e)),
    ).toEqual([]);
  } finally {
    await web.stop();
  }
});
