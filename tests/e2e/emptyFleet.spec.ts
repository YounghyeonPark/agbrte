/**
 * What `agbrte web` does when the folder it was given is not a workspace.
 *
 * ## It serves anyway, and the client asks
 *
 * This file used to test a terminal prompt. The prompt existed because of an
 * assumption — that `agbrte web` must attach a workspace or the client has
 * nothing to show — and the assumption was wrong. A web client served with an
 * empty fleet offers *"Point it at a folder and you are working"*, takes a path,
 * and attaches it: `hosts.add(root)` needs no native picker when the caller
 * names the folder. The panel behind `Attach host…` had been saying so all
 * along — *"This machine is always available. Choose a folder to work in when
 * you start a session."*
 *
 * So the folder is chosen where a folder is chosen, and the terminal only says
 * why the one it was handed will not do. Asking at startup was asking a second
 * time, earlier, before anything was on screen to give the question context —
 * which is what made it read as an installation step rather than a workspace.
 *
 * ## Why this is still an e2e test
 *
 * The claim is about two processes agreeing: the CLI declines to attach, and the
 * page that is then served can still get somewhere. Only running both shows it,
 * and the failure it guards against — a client served with nothing and no way
 * forward — is a blank screen rather than an error.
 */

import { tempFixture } from './fixtureDirs.js';
import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * A directory the rule refuses, per platform.
 *
 * Named rather than computed, because the point is the folder people actually
 * land in: on Windows the system directory an elevated PowerShell opens in;
 * elsewhere `/usr`, as the nearest thing nobody keeps a project in.
 */
const REFUSED = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr';

/** Start `agbrte web` from `cwd`, and hand back what it printed. */
async function serveFrom(
  cwd: string,
  port: string,
): Promise<{ out: string; stop: () => void }> {
  const home = await tempFixture('agbrte-empty-home-');
  const server = spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', '.', '--port', port, '--token', 'empty'],
    {
      cwd,
      env: { ...process.env, AGBRTE_HOME: home, AGBRTE_HOST_LINGER_MS: '4000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  server.stdout.on('data', (d: Buffer) => (out += String(d)));
  server.stderr.on('data', (d: Buffer) => (out += String(d)));
  await expect
    .poll(() => out, { timeout: 60_000, message: 'the server never printed its link' })
    .toContain(port);
  return { out, stop: () => server.kill() };
}

test('serves the client anyway when the folder it was given is a system directory', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const server = await serveFrom(REFUSED, '7931');

  try {
    // It said why, and did not stop. The remedy is deliberately absent: the
    // client about to open *is* the remedy.
    expect(server.out).toContain('belongs to the operating system');
    expect(server.out).not.toContain('or name one');

    await page.goto(`http://127.0.0.1:7931/#t=empty`);
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });

    // Nothing attached, and that is a state the client has words for rather
    // than a blank screen.
    await expect(page.locator('[data-testid=welcome]')).toBeVisible({ timeout: 20_000 });
    expect(await page.locator('[data-testid=host]').count()).toBe(0);
    await expect(page.locator('body')).toContainText('Point it at a folder');

    /*
     * And a folder named in the page actually attaches. This is the half that
     * makes serving-with-nothing defensible rather than merely tidy: without it
     * the visitor is looking at a welcome screen they cannot leave.
     */
    // Created first: this field *opens* a folder. Naming one that does not exist
    // is what the panel's separate "new folder" field is for, and pointing the
    // open field at nothing is how the first version of this test failed.
    const chosen = join(await tempFixture('agbrte-chosen-'), 'work');
    await mkdir(chosen, { recursive: true });
    await writeFile(join(chosen, 'README.md'), '# chosen in the page\n', 'utf8');
    await page.getByText('New session in a folder', { exact: false }).first().click();
    await page.waitForSelector('[data-testid=new-session-panel]', { timeout: 15_000 });
    await page.locator('[data-testid=new-session-path]').first().fill(chosen);
    await page.locator('[data-testid=new-session-open]').click();

    await expect(page.locator('[data-testid=host]')).toHaveCount(1, { timeout: 40_000 });
  } finally {
    server.stop();
  }
});

/**
 * The other refusal, reached the same way.
 *
 * `$HOME` is declined by `assertNotInstallRoot`, because `~/.agbrte` is the
 * machine's install area: a workspace rooted there writes its host record over
 * the machine's own, and that record carries the bearer token which is the whole
 * of the control channel's authentication (§6.2).
 *
 * Reproduced by pointing `AGBRTE_HOME` at the candidate's own `.agbrte` rather
 * than by using the real `$HOME` — it is the same collision, since the rule is
 * about two directories being one and not about the path being a home, and it
 * keeps the test out of the developer's actual installation.
 */
test('serves the client anyway when the folder it was given is the install directory', async () => {
  test.setTimeout(180_000);
  const collides = await tempFixture('agbrte-installroot-');
  await writeFile(join(collides, 'README.md'), '# here\n', 'utf8');

  const home = await tempFixture('unused-');
  void home;
  const server = spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', '.', '--port', '7932', '--token', 'empty'],
    {
      cwd: collides,
      env: {
        ...process.env,
        AGBRTE_HOME: join(collides, '.agbrte'),
        AGBRTE_HOST_LINGER_MS: '4000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let out = '';
  server.stdout.on('data', (d: Buffer) => (out += String(d)));
  server.stderr.on('data', (d: Buffer) => (out += String(d)));

  try {
    await expect
      .poll(() => out, { timeout: 60_000, message: 'the server never printed its link' })
      .toContain('7932');
    expect(out).toContain("this machine's Agbrte install directory");
    // The prefix that made this case unreadable, asserted absent by name.
    expect(out).not.toContain('no session host for');
  } finally {
    server.kill();
  }
});
