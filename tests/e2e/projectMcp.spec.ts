/**
 * A project's MCP server, ticked onto a session (DESIGN.md §17 Q20, §17 Q12, §13).
 *
 * End to end because the claim spans every process there is and the interesting
 * half is what does **not** cross them. A workspace file names a server; the
 * machine holds the key under a name; the host joins the two and spawns the
 * process. The renderer is in the middle of that and must never hold a value.
 *
 * ## What is asserted
 *
 * **The form asks for a key by name, and only for a server being used.** The
 * name is the whole of what a person has to find, and asking for keys belonging
 * to servers nobody ticked would be questions about nothing.
 *
 * **The key reaches the machine and not the page.** After creating, the value is
 * nowhere in the DOM — not in the field it was typed into, not in the session,
 * not in the transcript. What the transcript carries is the env *name*, which is
 * §13's rule and the one thing about this that did not change.
 *
 * **What the machine keeps is legible and removable.** Names, with a way to
 * forget one, where somebody is already being asked for keys — rather than in a
 * settings page they would have to know exists.
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, makeRepo } from './harness.js';
import { hostGroup } from './actions.js';

/** The same stdio server `tests/mcp.test.ts` and the Q20 form test both drive. */
const FIXTURE = fileURLToPath(new URL('../fixtures/mcpServer.cjs', import.meta.url));
const VALUE = 'sk-live-must-not-appear';

async function withDeclaration(): Promise<string> {
  const repo = await makeRepo();
  const dir = join(repo, '.agbrte', 'templates');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'search.mcp.json'),
    JSON.stringify({
      command: process.execPath,
      args: [FIXTURE],
      // The server wants `AGBRTE_E2E_TOKEN`; the machine is asked for
      // `SEARCH_API_KEY`. That the two differ is `envFrom` doing its one job.
      envFrom: { AGBRTE_E2E_TOKEN: 'SEARCH_API_KEY' },
    }),
    'utf8',
  );
  return repo;
}

test('asks for the key by name, spawns the server, and keeps the value off the page', async () => {
  const repo = await withDeclaration();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    const group = hostGroup(page);
    await group.locator('[data-testid=new-session]').click();

    const row = page.locator('[data-testid=new-server][data-id=search]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    // The command is shown because ticking it runs that on this machine, and an
    // id alone is not something anybody can agree to.
    await expect(row).toContainText('mcpServer.cjs');

    // Nothing is asked for until the server is being used: a key for a server
    // nobody ticked is a question about nothing.
    await expect(page.locator('[data-testid=new-server-key]')).toHaveCount(0);
    await row.locator('[data-testid=new-server-pick]').check();

    const asked = page.locator('[data-testid=new-server-key][data-name=SEARCH_API_KEY]');
    await expect(asked).toBeVisible();
    // Named, and said to be absent — "could not start" would send somebody to a
    // broken server instead of a key they simply have not stored yet.
    await expect(asked).toContainText('not on this machine yet');
    await asked.locator('[data-testid=new-server-key-value]').fill(VALUE);

    await group.locator('[data-testid=new-title]').fill('with a server');
    // In the workspace holding the declaration: a folder of its own would be a
    // new workspace declaring nothing.
    await group.locator('[data-testid=new-folder]').fill('');
    await group.locator('[data-testid=new-submit]').click();

    /*
     * The server started. `mcp-attached` is rendered from `Session.mcp`, which
     * the host fills in from what actually connected — so a tool name here is a
     * process that spoke the protocol, not a config that was accepted.
     */
    const attached = page.locator('[data-testid=mcp-attached]');
    await expect(attached).toBeVisible({ timeout: 30_000 });
    await expect(attached.locator('[data-testid=mcp-server][data-server=search]')).toContainText(
      'mcp__search__lookup',
    );

    /*
     * And the value is nowhere on the page.
     *
     * On the whole document rather than on the field, because the claim is that
     * it is *absent*: a check on the input's value would pass while the same
     * string sat in a transcript row three inches below it.
     */
    expect(await page.content()).not.toContain(VALUE);
  } finally {
    await agbrte.close();
  }
});

test('says a project declares none, where somebody would look for one', async () => {
  // A plain workspace: nothing in `templates/` at all.
  const repo = await makeRepo();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    await hostGroup(page).locator('[data-testid=new-session]').click();

    /*
     * A workspace declaring nothing rendered nothing at all, so the only way to
     * learn that a project *can* declare a server was to read the source — and
     * this is the route web search takes, since there is no search tool and an
     * MCP server for whichever vendor you use is a file rather than a decision
     * baked into this program.
     *
     * The same argument the workflow door makes: shown whether or not any
     * exist, because "there are none yet" is exactly when somebody needs it.
     */
    const none = page.locator('[data-testid=new-servers-none]');
    await expect(none).toBeVisible({ timeout: 20_000 });
    // The file to write and where, because a hint that does not say the name is
    // a hint somebody has to come back from.
    await expect(none).toContainText('.agbrte/templates/');
    await expect(none).toContainText('.mcp.json');
    // And the one thing that must not be misread: the key is not in the file.
    await expect(none).toContainText('envFrom');

    // Not both at once: a workspace that declares servers gets the list, not
    // an explanation of how to make the list it already has.
    await expect(page.locator('[data-testid=new-servers]')).toHaveCount(0);
  } finally {
    await agbrte.close();
  }
});

test('lists what the machine keeps, by name, and forgets one when asked', async () => {
  const repo = await withDeclaration();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    const group = hostGroup(page);
    await group.locator('[data-testid=new-session]').click();

    // Nothing kept yet, so nothing to list — a section saying "no keys" on
    // every machine is one people learn not to read.
    await expect(page.locator('[data-testid=machine-secrets]')).toHaveCount(0);

    const row = page.locator('[data-testid=new-server][data-id=search]');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('[data-testid=new-server-pick]').check();
    await page
      .locator('[data-testid=new-server-key][data-name=SEARCH_API_KEY]')
      .locator('[data-testid=new-server-key-value]')
      .fill(VALUE);
    await group.locator('[data-testid=new-title]').fill('first');
    await group.locator('[data-testid=new-folder]').fill('');
    await group.locator('[data-testid=new-submit]').click();
    await expect(page.locator('[data-testid=mcp-attached]')).toBeVisible({ timeout: 30_000 });

    // Second time round, the machine holds it: the name is listed and the form
    // no longer asks.
    await group.locator('[data-testid=new-session]').click();
    const kept = page.locator('[data-testid=machine-secret][data-name=SEARCH_API_KEY]');
    await expect(kept).toBeVisible({ timeout: 20_000 });
    await page.locator('[data-testid=new-server][data-id=search] [data-testid=new-server-pick]').check();
    await expect(page.locator('[data-testid=new-server-key]')).toHaveCount(0);
    // Names only, on the screen as on the wire (§13).
    expect(await page.content()).not.toContain(VALUE);

    /*
     * Forgetting one is immediate, and the declaration goes back to asking —
     * which is the whole reason `missing` is computed on the host rather than
     * remembered here: two facts that both move (§5.1).
     */
    await kept.locator('[data-testid=machine-secret-forget]').click();
    await expect(kept).toHaveCount(0, { timeout: 20_000 });
    await expect(
      page.locator('[data-testid=new-server-key][data-name=SEARCH_API_KEY]'),
    ).toBeVisible();
  } finally {
    await agbrte.close();
  }
});
