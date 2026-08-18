/**
 * When the remedy shows itself, and what it says (DESIGN.md §6.4).
 *
 * Asserted here rather than in the e2e spec because whether the panel opens end
 * to end depends on whether the machine running the suite happens to have a
 * vendor CLI installed — this one does, so it would be folded there and the
 * property would silently stop being checked. A criterion that quietly stops
 * being checked is worse than one that was never claimed.
 */

import { describe, expect, it } from 'vitest';
import { opensOnItsOwn, setupSummary } from '../src/renderer/setupRoutes.js';

describe('the setup panel', () => {
  it('opens by itself only on the dead-end screen', () => {
    // The exact state a fresh ssh host produces: no CLI detected, no model
    // reachable, and a harness that cannot run without one.
    expect(opensOnItsOwn(false, false)).toBe(true);
  });

  it('stays folded for anybody who already has something that runs', () => {
    // A CLI is enough on its own — it brings its own model.
    expect(opensOnItsOwn(true, false)).toBe(false);
    // So is a model, which is what the harness needs.
    expect(opensOnItsOwn(false, true)).toBe(false);
    expect(opensOnItsOwn(true, true)).toBe(false);
  });

  it('does not call a machine ready when the harness cannot run on it', () => {
    // The middle case, and the one worth its own sentence: usable, limited, and
    // "ready" would send somebody to a runtime that cannot start.
    expect(setupSummary('build-01', true, false)).toContain('no model server');
    expect(setupSummary('build-01', true, false)).not.toContain('ready');
    expect(setupSummary('build-01', false, false)).toContain('can run an agent yet');
    expect(setupSummary('build-01', true, true)).toContain('ready');
  });

  it('names the machine, because a refusal about the wrong one is worse than none', () => {
    for (const where of ['build-01', 'this machine']) {
      expect(setupSummary(where, false, false)).toContain(where);
    }
  });
});
