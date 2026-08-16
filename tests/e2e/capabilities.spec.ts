/**
 * What a model can do, said at the moment of choosing it (DESIGN.md §3.3, §3.5).
 *
 * The incident, re-enacted: a user picked `qwen3:0.6b` — a model whose server
 * *lists* tool support and which then fails to produce a usable tool call — and
 * asked it four times to search. Nothing happened and nothing said why. §3.5's
 * rule is that a degradation nobody is told about reads as the feature being
 * broken.
 *
 * This is the only test in the suite that can prove the whole claim, because
 * every cheaper layer proves a different half: the unit tests prove the mapping
 * from a hint to words, and the host test proves a hint survives four processes.
 * Neither can show that a **real** model, described by a **real** server, has
 * its declared claim replaced on screen by a measured one. That needs the model.
 *
 * It skips loudly without one. A criterion that silently passes because its test
 * was skipped is worse than no test.
 *
 * ## What it does not assert, and why that is not a weakening
 *
 * Not *which way the probe lands*. This asserted `no tools`, on the reading that
 * `qwen3:0.6b` cannot produce a well-formed call — and measured against the live
 * server it produces one roughly one run in three, so the assertion was a coin
 * toss that failed the feature for working. A model's competence is not a fixed
 * quantity and a test that pins one is testing the weights.
 *
 * What is invariant on every run is the property the incident was actually
 * about: a *declared* claim is never dressed as a measured one, the measured
 * answer replaces it once it exists, and the screen stays internally consistent
 * — the consequence sentence appears exactly when there is a consequence. Those
 * are asserted below, and any of them breaking is the bug returning.
 */

import { expect, test } from '@playwright/test';
import { rm } from 'node:fs/promises';
import { launch, makeRepo, modelAvailable } from './harness.js';
import { createSession } from './actions.js';

/**
 * The model from the incident, deliberately.
 *
 * Its `/api/show` reports `['completion','tools','thinking']` — the server says
 * it can call tools — and a probe finds it cannot. That gap is the entire reason
 * a declared claim and a probed one are kept apart, so the test that proves the
 * feature has to be run against a model that exhibits it.
 */
const MODEL = 'qwen3:0.6b';

test.describe('choosing a model says what it can do', () => {
  test('replaces the server’s declared claim with a measured one, before it is chosen', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const page = agbrte.window;

    try {
      await createSession(page, 'Choosing a model');

      await page.click('[data-testid=runtime-trigger]');
      const option = page.locator(
        `[data-testid=runtime-option][data-runtime="agbrte-harness"][data-model="${MODEL}"]`,
      );
      // The list arrives a round trip after the picker opens.
      await option.waitFor({ state: 'visible', timeout: 20_000 });

      /*
       * Before it is chosen: the server's claim, shown *as* a claim.
       *
       * The deterministic half, and the one the incident turned on. `/api/show`
       * lists `tools` for this model, and a listing is not a demonstration — so
       * it has to reach the row wearing `declared` and the quiet tone, never the
       * plain one a probe earns. Every model row carries this claim and the
       * window: an unchecked capability has to have a word, not a blank.
       */
      const rowTools = option.locator('[data-testid=capability-badge][data-capability=tools]');
      await expect(rowTools).toHaveText('tools: declared');
      await expect(rowTools).toHaveAttribute('data-tone', 'unknown');
      await expect(
        option.locator('[data-testid=capability-badge][data-capability=context]'),
      ).toBeVisible();

      await option.click();

      /*
       * Selecting it pays for the probe, because this endpoint is free.
       *
       * The declared claim going away is the probe having landed: nothing else
       * on this path can replace it, so this waits for that rather than for a
       * particular verdict (see the header on why the verdict is not asserted).
       */
      const panel = page.locator('[data-testid=model-capabilities]');
      const panelTools = panel.locator('[data-testid=capability-badge][data-capability=tools]');
      await expect(panelTools).not.toHaveText('tools: declared', { timeout: 60_000 });

      /*
       * Whatever it found, the screen agrees with it.
       *
       * Both verdicts are named, so a third state — an `unknown` that crept back
       * in, a claim rendered with no provenance — fails here rather than
       * quietly passing one of the branches.
       */
      const verdict = (await panelTools.textContent())?.trim() ?? '';
      expect(['tools', 'no tools']).toContain(verdict);
      // Measured, and saying so: this is the sentence that separates the two
      // tiers, and losing it is how a declared claim starts passing for a fact.
      await expect(panelTools).toHaveAttribute('title', /checked by running the model once/);

      const warning = page.locator('[data-testid=capability-warning]');
      if (verdict === 'no tools') {
        await expect(panelTools).toHaveAttribute('data-tone', 'warn');
        // The consequence in words, which is the part that was missing: a badge
        // is a label, and "it can only chat" is what the user needed.
        await expect(warning).toContainText('only chat');
      } else {
        await expect(panelTools).toHaveAttribute('data-tone', 'plain');
        // And absent when it does not apply — a standing warning about a model
        // that just demonstrated the opposite is the same failure mirrored.
        await expect(warning).toHaveCount(0);
      }

      // The list row agrees with the panel — one claim, seen twice.
      await page.click('[data-testid=runtime-trigger]');
      await expect(rowTools).toHaveText(verdict);
      await page.keyboard.press('Escape');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
