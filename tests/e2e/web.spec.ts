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
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeRepo } from './harness.js';

/** A port the OS says is free, rather than one we hope is. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function reachable(url: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

test('serves the app and drives a session over a socket', async ({ page }) => {
  const repo = await makeRepo();
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;

  const server: ChildProcess = spawn(
    process.execPath,
    [resolve('dist/cli/gilmok.js'), 'web', repo, '--port', String(port)],
    { stdio: 'ignore' },
  );

  try {
    expect(await reachable(url, 30_000), 'the web server never came up').toBe(true);

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
      errors.filter((e) => /Content Security|gilmok is undefined|is not a function/i.test(e)),
    ).toEqual([]);
  } finally {
    server.kill();
    await rm(repo, { recursive: true, force: true }).catch(() => undefined);
  }
});
