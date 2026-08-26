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
    await expect(page.locator('[data-testid=welcome]')).toBeVisible();

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

/**
 * The gate, through a real socket rather than through the pure rule.
 *
 * `webAuth.test.ts` covers what `admitsFrame` decides, and runs in CI. This
 * covers the half a pure function cannot: that the decision is actually wired to
 * the socket, that nothing answers before it, and that the token travels in a
 * link the way the printed one does.
 *
 * The frame below is not invented. It is what a page on `https://example.com`
 * sent to a real host on this machine — over `ws://127.0.0.1:7717`, needing only
 * the browser's Local Network Access prompt — and got a session list back from.
 */
test('answers nothing on a socket that has not shown the token', async () => {
  const web = await serveWebFixture();

  try {
    const socketUrl = `${web.url.split('#')[0]!.replace('http://', 'ws://')}__agbrte/socket`;
    const token = web.url.split('#t=')[1]!;

    /** Send one frame, report the first reply, or say that none came. */
    const ask = async (frames: unknown[]): Promise<string> => {
      const { WebSocket } = await import('ws');
      return new Promise<string>((done) => {
        const socket = new WebSocket(socketUrl);
        const finish = (verdict: string): void => {
          clearTimeout(timer);
          try {
            socket.close();
          } catch {
            // already gone
          }
          done(verdict);
        };
        const timer = setTimeout(() => finish('silence'), 4000);
        socket.on('open', () => {
          for (const frame of frames) socket.send(JSON.stringify(frame));
        });
        socket.on('message', (raw: unknown) => finish(String(raw)));
        socket.on('close', () => finish('closed'));
        socket.on('error', () => finish('closed'));
      });
    };

    const list = { id: 1, channel: 'agbrte:sessions.list', args: [] };

    // The attack, verbatim: a valid call with no handshake in front of it.
    expect(await ask([list])).toBe('closed');
    // A wrong token is the same answer, and specifically not a different one.
    expect(await ask([{ t: 'auth', token: 'not-the-token' }, list])).toBe('closed');
    // And the real one is admitted, so this is a gate rather than a wall.
    expect(await ask([{ t: 'auth', token }])).toContain('auth-ok');
  } finally {
    await web.stop();
  }
});
