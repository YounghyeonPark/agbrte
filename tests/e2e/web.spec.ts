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
  /*
   * Its own machine directory (§8), which this spec did without for too long.
   *
   * Without it the fixture uses the developer's real `~/.agbrte`: its registry
   * gains an entry per run, and the host started for the next run reopens every
   * temp workspace the previous ones left behind. That is how the session
   * assertion below started matching three elements — three runs, three
   * sessions, all still visible.
   */
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const web = await serveWebFixture({ home: await mkdtemp(join(tmpdir(), 'agbrte-web-home-')) });
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
    /*
     * Cleared, because typing a title fills this in for you.
     *
     * A name here means "a folder of its own", created beside the open one — the
     * form's intended default, and not what this test is about: it is about a
     * session in the workspace being served. The field was left alone while the
     * CLI's connector ignored the folder it was asked for, so the offer was
     * inert; once that was fixed the test began creating a sibling folder on
     * every run and putting its session there.
     */
    await page.locator('[data-testid=new-folder]').fill('');
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

/**
 * The app's own files, served by something that is not a host.
 *
 * This is what a published copy *is*: assembled the way `pages.yml` assembles the
 * site, with the bridge beside the app, no `data-agbrte-host` on the tag, and the
 * policy widened to permit a socket the visitor names.
 *
 * A helper rather than inline, because the *assembly* is as much under test as
 * the screen: a connect screen that works against a hand-built page and not
 * against what the workflow produces is broken in production only.
 */
async function servePublishedCopy(): Promise<{ origin: string; close: () => void }> {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const { join, resolve, normalize } = await import('node:path');

  const rendererDir = resolve('dist/renderer');
  const statics = createServer((req, res) => {
    void (async () => {
      const url = (req.url ?? '/').split('?')[0]!;
      // The bridge is served from beside the app, the way a published copy
      // ships it — and with no `data-agbrte-host`, which is the whole point.
      const file =
        url === '/__agbrte/bridge.js'
          ? resolve('dist/web/bridge.js')
          : join(rendererDir, normalize(url === '/' ? 'index.html' : url).replace(/^[/\\]+/u, ''));
      const body = await readFile(file).catch(() => null);
      if (body === null) return void res.writeHead(404).end('no');
      const type = file.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : file.endsWith('.js')
          ? 'text/javascript; charset=utf-8'
          : file.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'application/octet-stream';
      const text = file.endsWith('.html')
        ? String(body)
            .replace('<head>', '<head><script src="/__agbrte/bridge.js"></script>')
            // A published copy has to permit the host its user names; the served
            // page pins one origin because it knows which.
            .replace("connect-src 'self'", "connect-src 'self' ws: wss: http: https:")
        : body;
      res.writeHead(200, { 'content-type': type }).end(text);
    })();
  });
  await new Promise<void>((done) => statics.listen(0, '127.0.0.1', done));
  const port = (statics.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => statics.close() };
}

/**
 * The same bundle, served from somewhere that is not a host.
 *
 * It has to ask where the host is rather than guess at `location` and fail at a
 * socket — and then, once told, connect to a host on a different origin
 * entirely.
 */
test('asks where the host is when nothing served it one, and then connects', async ({ page }) => {
  const web = await serveWebFixture();
  const statics = await servePublishedCopy();

  try {
    await page.goto(`${statics.origin}/`);

    /*
     * At phone size first, because that is the device this screen is mostly for:
     * a phone has no terminal to read the printed link from, so it is the one
     * that has to be *told* the address by hand.
     */
    await page.setViewportSize({ width: 390, height: 844 });

    // No host, so the question rather than a broken app.
    const connect = page.locator('#agbrte-connect');
    await expect(connect).toBeVisible();
    // It introduces itself before it asks for anything. Most people who ever see
    // this screen have never heard of Agbrte and none of them has a host — a
    // page that opens with "paste your token" is a login form for a product
    // nobody has been shown.
    await expect(connect).toContainText('Coding agents that keep working');
    await expect(connect.getByRole('link', { name: 'Download' })).toBeVisible();
    await expect(connect).toContainText('Already have a host?');

    // It fits the phone it is for: nothing scrolls sideways.
    // Measured off the element, the way `dashboard.spec.ts` does: this file's
    // tsconfig has no DOM lib, and a bare `document` compiles nowhere.
    const sideways = await page.locator('body').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);

    /*
     * And the keyboard corrections are off. A phone capitalises the first letter
     * by default, so the address arrives as `Http://…` and the host is never
     * reached; autocorrect on a 64-character hex token produces a refused
     * handshake with nothing on screen to explain it. Asserted rather than
     * eyeballed, because both failures look like "it just does not connect".
     */
    for (const name of ['Host address', 'Token']) {
      const input = connect.getByLabel(name);
      await expect(input).toHaveAttribute('autocapitalize', 'none');
      await expect(input).toHaveAttribute('autocorrect', 'off');
    }
    await expect(connect.getByLabel('Host address')).toHaveAttribute('inputmode', 'url');

    // The whole printed link goes in the address field, because that is what a
    // person will paste; the token is split out of it.
    await connect.getByLabel('Host address').fill(web.url);
    await connect.getByRole('button', { name: 'Connect' }).click();

    // And the app comes up against a host on a different origin.
    await expect(page.locator('[data-testid=app]')).toBeVisible({ timeout: 20_000 });
    await expect(connect).toHaveCount(0);
  } finally {
    statics.close();
    await web.stop();
  }
});
