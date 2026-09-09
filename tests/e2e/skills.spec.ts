/**
 * A skill in the workspace, ticked onto a session (DESIGN.md §17 Q21, §17 Q12).
 *
 * End to end because the claim spans every process there is and each one can
 * drop it: the host reads `templates/`, `skill.list` carries the bodies, the
 * preload exposes the channel, the form offers them, and `createSession` puts
 * them in the log. Nothing below the renderer can tell whether the tick reached
 * the session — the unit tests pin the file format and the wire, and this is the
 * only thing that pins the trip.
 *
 * ## What is asserted, and why each is a decision
 *
 * **A file that could not be used is a row with its reason, not an absent row.**
 * The reason to look at this list is often that one of them is wrong, and a
 * skill silently missing from the form is a person editing a file that never
 * appears. It is offered *disabled*, because ticking it would be a control that
 * fails on press — after a session had been created, which is the expensive
 * moment to find out (§3.5).
 *
 * **The session says what it was given.** Ticking something and then finding no
 * trace of it is how a person learns not to trust the tick, so the id and the
 * description are on the session — which is also exactly what the model is shown
 * until the work calls for the body.
 *
 * **Nothing is attached that was not ticked.** §17 Q20 refused an app-level
 * registry and Q21 inherits the refusal: a directory of skills is a list to pick
 * from, never a set that applies itself.
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { hostGroup } from './actions.js';

const COMMITS = `---
description: How commit messages are written here
---

They say why, and they record what broke.
`;

/** A workspace holding one usable skill and one that cannot be used. */
async function withSkills(): Promise<string> {
  const repo = await makeRepo();
  const dir = join(repo, '.agbrte', 'templates');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'commits.skill.md'), COMMITS, 'utf8');
  // No frontmatter, so no description — which is the line the model reads before
  // loading the body, and `createSession` would refuse it.
  await writeFile(join(dir, 'bare.skill.md'), 'just some prose\n', 'utf8');
  // Neither of the other two kinds of template may appear in this list. One
  // directory holds all three and the suffix is what tells them apart.
  await writeFile(
    join(dir, 'review.workflow.json'),
    JSON.stringify({ id: 'review', name: 'r', goal: 'g', nodes: [] }),
    'utf8',
  );
  return repo;
}

test('offers the workspace its skills, and puts the ticked one on the session', async () => {
  const repo = await withSkills();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    const group = hostGroup(page);
    await group.locator('[data-testid=new-session]').click();

    const rows = page.locator('[data-testid=new-skill]');
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    // The workflow beside them is a different kind of file and is not offered
    // here — it has its own row further down the same form.
    await expect(page.locator('[data-testid=new-skill][data-id=review]')).toHaveCount(0);

    const good = page.locator('[data-testid=new-skill][data-id=commits]');
    await expect(good).toHaveAttribute('data-ok', 'yes');
    await expect(good).toContainText('How commit messages are written here');

    const bad = page.locator('[data-testid=new-skill][data-id=bare]');
    await expect(bad).toHaveAttribute('data-ok', 'no');
    // Present, disabled, and carrying the reason — the three together are what
    // make it an explanation rather than a dead control.
    await expect(bad).toContainText('no frontmatter');
    await expect(bad.locator('[data-testid=new-skill-pick]')).toBeDisabled();

    await good.locator('[data-testid=new-skill-pick]').check();
    await group.locator('[data-testid=new-title]').fill('with a skill');
    // In the workspace that holds the skills. A folder of its own would be a new
    // workspace with an empty `templates/`, which is the case the form does not
    // offer skills for at all.
    await group.locator('[data-testid=new-folder]').fill('');
    await group.locator('[data-testid=new-submit]').click();

    /*
     * The end of the trip. `Session.skills` is filled by the host at creation
     * from what `createSession` was given, so this row is the log's answer
     * rather than the form's — the form's copy died with the render that made
     * it.
     */
    const attached = page.locator('[data-testid=skills-attached]');
    await expect(attached).toBeVisible({ timeout: 20_000 });
    await expect(attached.locator('[data-testid=skill]')).toHaveCount(1);
    await expect(attached.locator('[data-testid=skill][data-id=commits]')).toContainText(
      'How commit messages are written here',
    );
  } finally {
    await agbrte.close();
  }
});

test('gives a session nothing it was not ticked for', async () => {
  const repo = await withSkills();
  const agbrte = await launch(repo);

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    const group = hostGroup(page);
    await group.locator('[data-testid=new-session]').click();
    await expect(page.locator('[data-testid=new-skill]')).toHaveCount(2, { timeout: 20_000 });

    // Ticking nothing, with a usable skill sitting right there.
    await group.locator('[data-testid=new-title]').fill('plain');
    await group.locator('[data-testid=new-folder]').fill('');
    await group.locator('[data-testid=new-submit]').click();

    /*
     * §17 Q20's refusal of an app-level registry, which Q21 inherits: a
     * directory of skills is a list to pick from and never a set that applies
     * itself. The strip renders nothing at all rather than an empty heading —
     * a row saying "no skills" on every session is how people learn to stop
     * reading a row.
     */
    await expect(page.locator('[data-testid=session-title]')).toHaveText('plain', {
      timeout: 20_000,
    });
    await expect(page.locator('[data-testid=skills-attached]')).toHaveCount(0);
  } finally {
    await agbrte.close();
  }
});
