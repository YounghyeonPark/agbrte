/**
 * The property that keeps a workflow reviewable (DESIGN.md §4.4).
 *
 * These documents are tracked and the **diff is the safety argument**: an agent
 * proposes a workflow by writing a file, a person reviews it as they review
 * code, and that is what makes an authored decomposition safe where an
 * autonomous one is not. So the thing worth pinning is not that the serializer
 * round-trips — it is that
 *
 * > changing one field changes one line,
 *
 * because a review nobody can read is not a review, and an editor that
 * re-ordered keys would produce a wall of noise for a one-word edit.
 */

import { describe, expect, it } from 'vitest';
import type { Workflow } from '../src/shared/types/index.js';
import { serializeWorkflow } from '../src/shared/workflow/serialize.js';

const node = (id: string, over: Partial<Workflow['nodes'][number]> = {}): Workflow['nodes'][number] => ({
  id,
  title: id,
  scope: `do the ${id} part`,
  outOfScope: ['everything else'],
  acceptance: ['it is done'],
  contract: { summaryMaxTokens: 800, artifacts: [] },
  tokenCeiling: 10_000,
  ...over,
});

const DOC: Workflow = {
  id: 'review',
  name: 'review and fix',
  goal: 'find what is broken on this branch',
  nodes: [node('scan'), node('tests', { needs: ['scan'] })],
};

/** Lines that differ, which is what a reviewer actually sees. */
function changedLines(before: string, after: string): number {
  const a = before.split('\n');
  const b = after.split('\n');
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if (a[i] !== b[i]) n += 1;
  return n;
}

describe('the diff a change makes', () => {
  it('is one line for a one-field edit', () => {
    const before = serializeWorkflow(DOC);
    const after = serializeWorkflow({
      ...DOC,
      nodes: [node('scan', { scope: 'list every changed file instead' }), DOC.nodes[1]!],
    });
    expect(changedLines(before, after)).toBe(1);
  });

  it('is unchanged by rebuilding the object with its keys in another order', () => {
    /*
     * The reason key order is fixed here rather than taken from the object.
     * Object key order is insertion order, so a document that went through a
     * form would come out ordered by whichever field was touched first — and two
     * people editing different fields would produce unrelated diffs of the same
     * file.
     */
    const shuffled: Workflow = {
      nodes: DOC.nodes.map((n) => ({
        tokenCeiling: n.tokenCeiling,
        contract: n.contract,
        acceptance: n.acceptance,
        outOfScope: n.outOfScope,
        scope: n.scope,
        title: n.title,
        id: n.id,
        ...(n.needs !== undefined ? { needs: n.needs } : {}),
      })),
      goal: DOC.goal,
      name: DOC.name,
      id: DOC.id,
    };
    expect(serializeWorkflow(shuffled)).toBe(serializeWorkflow(DOC));
  });

  it('is a fixed point: writing what was read changes nothing', () => {
    const once = serializeWorkflow(DOC);
    const twice = serializeWorkflow(JSON.parse(once) as Workflow);
    expect(twice).toBe(once);
  });
});

describe('what reaches the file', () => {
  it('leaves an unset field out rather than writing it empty', () => {
    // A file full of `[]` reads as a document that was configured and is not —
    // and on the next read the two states are the same object, so writing them
    // differently would make the form a fixed point of nothing.
    const text = serializeWorkflow(DOC);
    expect(text).not.toContain('"needs": []');
    expect(text).not.toContain('"pointers"');
    expect(text).not.toContain('"target"');
    expect(text).not.toContain('"budget"');
    // The node that does have one keeps it.
    expect(text).toContain('"needs": [');
  });

  it('keeps a zero, which is a value and not an absence', () => {
    // `present` treats emptiness and zero differently on purpose: a ceiling of
    // zero is a document the validator must be able to refuse, and dropping it
    // would make that node look like it simply forgot to say.
    expect(serializeWorkflow({ ...DOC, nodes: [node('a', { tokenCeiling: 0 })] })).toContain(
      '"tokenCeiling": 0',
    );
  });

  it('drops a key this version does not know, rather than carrying it', () => {
    /*
     * A hand-written field with no meaning here would otherwise survive a round
     * trip and look supported. It is not — and a document quietly carrying an
     * ignored key is one whose author believes something false about what will
     * run. The loss shows up in the diff of the same edit, which is where
     * somebody can act on it.
     */
    const withExtra = {
      ...DOC,
      retries: 3,
      nodes: [{ ...node('scan'), runIf: 'tests failed' }],
    } as unknown as Workflow;
    const text = serializeWorkflow(withExtra);
    expect(text).not.toContain('retries');
    expect(text).not.toContain('runIf');
  });

  it('ends with a newline, so the next line added is one line of diff', () => {
    expect(serializeWorkflow(DOC).endsWith('}\n')).toBe(true);
  });

  it('puts the fields in the order a reader wants them', () => {
    // Identity, then position in the graph, then the seam — scope before what is
    // excluded from it, since that is the order they are decided in.
    const keys = [...serializeWorkflow(DOC).matchAll(/^ {6}"(\w+)":/gmu)].map((m) => m[1]);
    expect(keys.slice(0, 7)).toEqual([
      'id',
      'title',
      'scope',
      'outOfScope',
      'acceptance',
      'contract',
      'tokenCeiling',
    ]);
  });
});
