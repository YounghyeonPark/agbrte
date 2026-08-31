/**
 * Building a child's brief, and the contract its result must fit (§4.3).
 *
 * The behaviour worth testing is what the builder *refuses*. §4.3's stated reason
 * for keeping splits user-approved is that a decomposition mistake produces a
 * tree of subtly mis-scoped children which is harder to salvage than one overlong
 * session — so a brief that is silently weak is the expensive failure, and each
 * refusal here exists to make one of those loud instead.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BriefRefused,
  buildBrief,
  checkResult,
  reservableForChild,
  reserveForChild,
} from '@main/store/brief.js';
import { SessionStore } from '@main/store/sessionStore.js';
import { openWorkspace } from '@main/store/identity.js';
import { newSessionId, seamRefusal, type InstanceId, type ResultContract, type SessionBudget } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-brief-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const CONTRACT: ResultContract = {
  summaryMaxTokens: 500,
  artifacts: [{ kind: 'patch', required: true }],
};

const BUDGET: SessionBudget = {
  tokenCeiling: 50_000,
  spent: 0,
  reservedForChildren: 0,
};

/** A parent session with some history and an artifact to point at. */
async function parentStore(goal = 'ship the parser rewrite'): Promise<SessionStore> {
  const store = await SessionStore.create(root, {
    sessionId: newSessionId(),
    instanceId,
    title: 'parent',
    goal,
    createdAt: new Date('2026-07-30T00:00:00Z').toISOString(),
  });
  await store.append({ type: 'user.turn', content: [{ type: 'text', text: 'start the rewrite' }] });
  await store.append({ type: 'agent.text', text: 'I have split it into three parts.' });
  await store.append({ type: 'artifact.created', artifactId: 'a1', kind: 'design-note' });
  return store;
}

const OPTS = {
  scope: 'port the tokenizer only',
  outOfScope: ['the parser', 'the formatter'],
  contract: CONTRACT,
  acceptance: ['tokenizer tests pass'],
  budget: BUDGET,
};

describe('buildBrief', () => {
  it('carries the parent goal, the narrow scope, and the exclusions', async () => {
    const { brief } = await buildBrief(await parentStore(), OPTS);

    expect(brief.parentGoal).toBe('ship the parser rewrite');
    expect(brief.scope).toBe('port the tokenizer only');
    expect(brief.outOfScope).toEqual(['the parser', 'the formatter']);
    expect(brief.acceptance).toEqual(['tokenizer tests pass']);
  });

  it('points at the parent’s artifacts rather than inlining anything', async () => {
    const { brief } = await buildBrief(await parentStore(), OPTS);

    // A reference costs nothing until the child chooses to read it, which is the
    // cheapest possible form of context.
    expect(brief.pointers).toEqual([
      { kind: 'artifact', ref: 'a1', why: 'produced by the parent session (design-note)' },
    ]);
  });

  it('carries no verbatim history by default', async () => {
    const { brief, omittedTurns } = await buildBrief(await parentStore(), OPTS);

    // §4.3: verbatim history is "by exception, not default". Every turn carried
    // is parent context entering a child, which is the cost a split exists to
    // avoid — so the default has to be none.
    expect(brief.verbatim).toBeUndefined();
    expect(omittedTurns).toBeGreaterThan(0);
  });

  it('carries verbatim turns only when asked', async () => {
    const { brief } = await buildBrief(await parentStore(), { ...OPTS, verbatimTurns: 2 });
    expect(brief.verbatim?.length).toBeGreaterThan(0);
  });

  it('refuses an empty outOfScope', async () => {
    // The refusal that matters most. Without exclusions a child reads widely to
    // re-derive context it was never given — and only the parent knows what it
    // is keeping, so this cannot be defaulted.
    await expect(buildBrief(await parentStore(), { ...OPTS, outOfScope: [] })).rejects.toThrow(
      BriefRefused,
    );
    await expect(buildBrief(await parentStore(), { ...OPTS, outOfScope: [] })).rejects.toThrow(
      /outOfScope is required/,
    );
  });

  /*
   * The pin that makes the sharing load-bearing (§4.4).
   *
   * A workflow declares its seams in a file and refuses them with the same
   * function, so a seam wrong in a document is refused for the same reason and
   * in the same words as one wrong at spawn. Asserted as an exact string rather
   * than a pattern, because a pattern passes against a second implementation
   * that happens to contain the same phrase — and a reimplementation here is
   * precisely what would put the two paths out of step. Same shape of guarantee
   * as §13's rule that both MCP attach paths share one function.
   */
  it('refuses with the words the workflow validator uses, not merely similar ones', async () => {
    const expected = seamRefusal({ ...OPTS, outOfScope: [] });
    expect(expected).not.toBeNull();
    await expect(
      buildBrief(await parentStore(), { ...OPTS, outOfScope: [] }),
    ).rejects.toThrow(expected as string);
  });

  it('refuses an empty scope', async () => {
    await expect(buildBrief(await parentStore(), { ...OPTS, scope: '   ' })).rejects.toThrow(
      /needs a scope/,
    );
  });

  it('refuses a contract with no summary ceiling', async () => {
    await expect(
      buildBrief(await parentStore(), {
        ...OPTS,
        contract: { ...CONTRACT, summaryMaxTokens: 0 },
      }),
    ).rejects.toThrow(/summaryMaxTokens/);
  });

  it('refuses a brief that exceeds its own ceiling', async () => {
    const store = await parentStore('x'.repeat(4_000));
    // A "narrowing" larger than its ceiling is not narrowing anything, and the
    // failure should be loud at spawn rather than a child that quietly starts
    // with most of its parent's context.
    await expect(
      buildBrief(store, { ...OPTS, maxBriefTokens: 50 }),
    ).rejects.toThrow(/against a 50 ceiling/);
  });

  it('reports what it left behind', async () => {
    const { estimatedTokens, omittedTurns } = await buildBrief(await parentStore(), OPTS);
    // Visible rather than implied: a split's whole justification is the context
    // it does *not* carry.
    expect(estimatedTokens).toBeGreaterThan(0);
    expect(omittedTurns).toBeGreaterThan(0);
  });
});

describe('checkResult', () => {
  it('accepts a summary within the ceiling with its required artifacts', () => {
    const verdict = checkResult(CONTRACT, 'ported the tokenizer', [{ kind: 'patch' }]);
    expect(verdict.fits).toBe(true);
    expect(verdict.missing).toEqual([]);
  });

  it('rejects a summary over the ceiling without failing the child', () => {
    const verdict = checkResult({ ...CONTRACT, summaryMaxTokens: 5 }, 'x'.repeat(4_000), [
      { kind: 'patch' },
    ]);
    // A verdict rather than a throw: §4.3 says the child writes an artifact and
    // returns a pointer. It does not get to negotiate a larger injection, and it
    // does not get failed for trying.
    expect(verdict.fits).toBe(false);
    expect(verdict.estimatedTokens).toBeGreaterThan(5);
  });

  it('names a missing required artifact', () => {
    const verdict = checkResult(CONTRACT, 'done', []);
    expect(verdict.fits).toBe(false);
    expect(verdict.missing).toEqual(['patch']);
  });

  it('ignores an optional artifact that was not produced', () => {
    const contract: ResultContract = {
      summaryMaxTokens: 500,
      artifacts: [{ kind: 'benchmark', required: false }],
    };
    expect(checkResult(contract, 'done', []).fits).toBe(true);
  });
});

describe('budget reservation', () => {
  it('reserves a child ceiling from the parent remainder', () => {
    const { parent, child } = reserveForChild(BUDGET, 10_000);

    // Taken at spawn, not checked at spend time — that is what makes "a tree
    // cannot outspend what its root was granted" true rather than aspirational.
    expect(parent.reservedForChildren).toBe(10_000);
    expect(child.tokenCeiling).toBe(10_000);
    expect(child.spent).toBe(0);
  });

  it('refuses to reserve more than remains unreserved', () => {
    const spent: SessionBudget = { tokenCeiling: 50_000, spent: 30_000, reservedForChildren: 15_000 };
    expect(reservableForChild(spent)).toBe(5_000);
    expect(() => reserveForChild(spent, 6_000)).toThrow(/only 5000 remain/);
  });

  it('accounts for siblings already reserved', () => {
    const first = reserveForChild(BUDGET, 20_000);
    const second = reserveForChild(first.parent, 20_000);

    expect(second.parent.reservedForChildren).toBe(40_000);
    // A third child of the same size must not fit: two siblings already hold it.
    expect(() => reserveForChild(second.parent, 20_000)).toThrow(/only 10000 remain/);
  });
});
