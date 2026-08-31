/**
 * The workflow documents, on screen (DESIGN.md §4.4).
 *
 * End to end because the claim spans four processes and every one of them can
 * drop it: the host reads the files, `workflow.list` carries them, the preload
 * exposes the channel, and the pane renders them. §4.4's Phase 9 is built
 * view-first precisely so this is checkable before a runner exists — a picture
 * of the document is how anyone tells whether the format is right.
 *
 * Three things are asserted and each is a decision rather than a detail.
 *
 * **A broken document is a row carrying its reasons**, not an absent row and not
 * a pane that failed. The reason to look at this list is often that one of them
 * is wrong, and `validateWorkflow` returns a list rather than throwing for the
 * same reason: a document has many seams and one reader.
 *
 * **Every finding, not the first.** Being told one problem six times is the
 * failure the list shape exists to avoid.
 *
 * **The absolute path is not on screen**, because it is not on the wire (§5.4b).
 * A client may be a phone, where the host's path names nothing.
 */

import { expect, test } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveWebFixture } from './harness.js';

/** A node with everything a seam needs, so a test can break one thing at a time. */
const node = (id: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: id,
  scope: `do the ${id} part`,
  outOfScope: ['everything else'],
  acceptance: ['it is done'],
  contract: { summaryMaxTokens: 800, artifacts: [] },
  tokenCeiling: 10_000,
  ...over,
});

async function writeWorkflows(repo: string): Promise<void> {
  const dir = join(repo, '.agbrte', 'templates');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'review.workflow.json'),
    JSON.stringify({
      id: 'review',
      name: 'review and fix',
      goal: 'find what is broken on this branch',
      // A join — two predecessors on one node — which is the shape a session
      // tree cannot express with lineage and the reason `needs` exists.
      nodes: [
        node('scan'),
        node('tests', { needs: ['scan'] }),
        node('lint', { needs: ['scan'] }),
        node('report', { needs: ['tests', 'lint'] }),
      ],
    }),
    'utf8',
  );
  await writeFile(
    join(dir, 'halfwritten.workflow.json'),
    JSON.stringify({
      id: 'halfwritten',
      name: 'half written',
      goal: '',
      nodes: [node('a', { outOfScope: [], needs: ['ghost'] })],
    }),
    'utf8',
  );
  // A session template beside them, which must not appear in this list. One
  // directory holds both kinds and the suffix is what tells them apart.
  await writeFile(join(dir, 'a-session.json'), JSON.stringify({ id: 'x', name: 'not a workflow' }), 'utf8');
}

test('lists the documents in the workspace, with what is wrong with them', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    await writeWorkflows(web.repo);
    await page.goto(web.url);
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });

    await page.locator('[data-testid=show-workflows]').click();
    await expect(page.locator('[data-testid=workflows]')).toBeVisible({ timeout: 20_000 });

    // Both documents, and not the session template sitting beside them.
    await expect(page.locator('[data-testid=workflow-row]')).toHaveCount(2, { timeout: 20_000 });
    await expect(page.locator('[data-testid=workflow-row][data-id=review]')).toContainText(
      'review and fix',
    );
    await expect(page.locator('[data-testid=workflow-row][data-id=review]')).toContainText(
      '4 nodes',
    );

    // The good one carries no findings; the broken one is marked, not hidden.
    await expect(page.locator('[data-testid=workflow-row][data-id=review]')).toHaveAttribute(
      'data-ok',
      'yes',
    );
    const broken = page.locator('[data-testid=workflow-row][data-id=halfwritten]');
    await expect(broken).toHaveAttribute('data-ok', 'no');

    /*
     * Every finding. Three things are wrong with that document — no goal, an
     * edge to a node that is not there, and an empty `outOfScope` — and a pane
     * that showed the first would be the "one problem six times" shape the list
     * return type exists to avoid.
     */
    await expect(broken.locator('li')).toHaveCount(3);
    await expect(broken).toContainText('parentGoal');
    await expect(broken).toContainText('not a node here');
    await expect(broken).toContainText('outOfScope is required');

    /*
     * The path each document was *read from* is not on screen, because it is
     * not on the wire (§5.4b) — a client may be a phone, where the host's
     * `.agbrte/templates/review.workflow.json` names nothing.
     *
     * Scoped to the rows, and the first version of this was not: it asserted
     * the whole pane never says "templates", which failed against correct code
     * on the pane's own sentence explaining where workflows live. The
     * workspace root above it is `HostInfo.root` and is meant to be there —
     * a person has to see which folder this is.
     */
    await expect(page.locator('[data-testid=workflow-row]').first()).not.toContainText(
      '.workflow.json',
    );
    await expect(page.locator('[data-testid=workflow-row]').last()).not.toContainText(
      '.workflow.json',
    );

    /*
     * The shape, drawn. Folded until asked for — four workflows would otherwise
     * make this pane a page of pictures — so the disclosure is opened here.
     *
     * The edges are the reason this is drawn at all: a **join**, two
     * predecessors meeting at one node, is the thing a session tree cannot
     * express with lineage and the whole reason `needs` is a separate edge
     * (§4.4). A rendering that could not draw a line would show four boxes and
     * hide the one fact worth seeing.
     */
    const review = page.locator('[data-testid=workflow-row][data-id=review]');
    await review.locator('[data-testid=workflow-shape] summary').click();
    const graph = review.locator('[data-testid=workflow-graph]');
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute('data-nodes', '4');
    await expect(graph.locator('[data-testid=workflow-node]')).toHaveCount(4);
    // scan→tests, scan→lint, tests→report, lint→report — the last two are the join.
    await expect(graph.locator('[data-testid=workflow-edge]')).toHaveCount(4);
    await expect(
      graph.locator('[data-testid=workflow-edge][data-from=tests][data-to=report]'),
    ).toHaveCount(1);
    await expect(
      graph.locator('[data-testid=workflow-edge][data-from=lint][data-to=report]'),
    ).toHaveCount(1);

    // The broken document's bad node is marked in its picture too, so the
    // drawing and the findings list cannot disagree about which node is wrong.
    await broken.locator('[data-testid=workflow-shape] summary').click();
    await expect(
      broken.locator('[data-testid=workflow-node][data-id=a][data-ok=no]'),
    ).toHaveCount(1);
  } finally {
    await web.stop();
  }
});

test('says a workspace has none, which is different from being unable to ask', async ({ page }) => {
  const web = await serveWebFixture();

  try {
    await page.goto(web.url);
    await page.waitForSelector('[data-testid=app]', { timeout: 30_000 });
    await page.locator('[data-testid=show-workflows]').click();

    // "None here yet" and not the too-old sentence: this host can answer, and
    // the answer is that there are none. Rendering one as the other would claim
    // something nothing established (§3.3).
    await expect(page.locator('[data-testid=workflows-empty]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid=workflows-unsupported]')).toHaveCount(0);
    await expect(page.locator('[data-testid=workflow-row]')).toHaveCount(0);
  } finally {
    await web.stop();
  }
});
