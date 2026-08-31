/**
 * What a workflow document is refused for (DESIGN.md §4.4, §4.3).
 *
 * The property under test is that **a seam refused at spawn is refused here, in
 * the same words**. §4.3 makes an argument about `outOfScope` — that a child
 * without exclusions "reads widely to re-derive context, which is the cost the
 * split was meant to avoid" — and that argument does not become less true
 * because the seam was written in a file a week earlier. So `seamRefusal` is one
 * function with two callers, and the test below that pins them together is the
 * one that would catch a fix applied to only one.
 *
 * The other half is the graph: ids, edges and cycles are properties of the
 * document, and a workflow whose order cannot be decided must be refused while
 * somebody is editing it rather than discovered by a scheduler that has already
 * spawned half of it.
 */

import { describe, expect, it } from 'vitest';
import { seamRefusal, type SessionBudget, type Workflow } from '../src/shared/types/index.js';
import {
  declaredTotal,
  topoOrder,
  validateWorkflow,
} from '../src/shared/workflow/validate.js';

const CONTRACT = { summaryMaxTokens: 800, artifacts: [] };

const node = (id: string, over: Partial<Workflow['nodes'][number]> = {}): Workflow['nodes'][number] => ({
  id,
  title: id,
  scope: `do the ${id} part`,
  outOfScope: ['everything else'],
  acceptance: ['it is done'],
  contract: CONTRACT,
  tokenCeiling: 10_000,
  ...over,
});

const workflow = (nodes: Workflow['nodes']): Workflow => ({
  id: 'wf',
  name: 'review and fix',
  goal: 'find what is broken on this branch',
  nodes,
});

/** A budget with `n` tokens neither spent nor reserved. */
const budget = (n: number): SessionBudget => ({
  tokenCeiling: n,
  spent: 0,
  reservedForChildren: 0,
});

describe('a document that is fine', () => {
  it('has nothing to say about it', () => {
    const wf = workflow([node('scan'), node('tests', { needs: ['scan'] })]);
    expect(validateWorkflow(wf)).toEqual([]);
  });

  it('accepts a join, which is the whole reason `needs` exists', () => {
    // Two predecessors on one node. A session tree cannot express this with
    // lineage — a child has exactly one parent — which is why §4.4 keeps
    // dependency as a separate edge rather than generalising the tree.
    const wf = workflow([
      node('scan'),
      node('lint'),
      node('report', { needs: ['scan', 'lint'] }),
    ]);
    expect(validateWorkflow(wf)).toEqual([]);
    expect(topoOrder(wf.nodes).order).toEqual(['scan', 'lint', 'report']);
  });
});

describe('the seams, refused in the same words as at spawn', () => {
  /*
   * The pin. `buildBrief` and the validator both call `seamRefusal`, and the
   * reason to check the exact string rather than "some finding appeared" is
   * that the point of sharing the function is the *wording* — somebody who has
   * seen this refusal once at spawn must recognise it in a file.
   */
  it('says the same thing about an empty outOfScope as §4.3 does', () => {
    const seam = { scope: 'do a thing', outOfScope: [], contract: CONTRACT };
    const direct = seamRefusal(seam);
    expect(direct).toContain('outOfScope is required');
    expect(direct).toContain('§4.3');

    const found = validateWorkflow(workflow([node('scan', { outOfScope: [] })]));
    expect(found).toEqual([{ node: 'scan', message: direct }]);
  });

  it('refuses an empty scope and a contract with no ceiling', () => {
    const found = validateWorkflow(
      workflow([
        node('a', { scope: '   ' }),
        node('b', { contract: { summaryMaxTokens: 0, artifacts: [] } }),
      ]),
    );
    expect(found.map((f) => f.node)).toEqual(['a', 'b']);
    expect(found[0]?.message).toContain('aimless');
    expect(found[1]?.message).toContain('summaryMaxTokens');
  });

  it('reports every seam rather than the first', () => {
    // A document has many seams and one reader. Being told one problem six
    // times is the reason this returns a list instead of throwing.
    const found = validateWorkflow(
      workflow([node('a', { outOfScope: [] }), node('b', { outOfScope: [] })]),
    );
    expect(found).toHaveLength(2);
  });

  it('needs a positive ceiling, since a node is reserved before it exists', () => {
    const found = validateWorkflow(workflow([node('a', { tokenCeiling: 0 })]));
    expect(found[0]?.message).toContain('positive tokenCeiling');
  });
});

describe('the graph', () => {
  it('refuses an edge to a node that is not here', () => {
    const found = validateWorkflow(workflow([node('scan', { needs: ['typo'] })]));
    expect(found[0]).toEqual({
      node: 'scan',
      message: '"scan" needs "typo", which is not a node here',
    });
  });

  it('names the nodes in a cycle, since "there is a cycle" is not actionable', () => {
    const wf = workflow([
      node('a', { needs: ['c'] }),
      node('b', { needs: ['a'] }),
      node('c', { needs: ['b'] }),
      node('fine'),
    ]);
    const found = validateWorkflow(wf);
    const cycle = found.find((f) => f.message.includes('wait on each other'));
    expect(cycle?.message).toContain('a, b, c');
    // The node that is not in the cycle is not accused of being in it.
    expect(cycle?.message).not.toContain('fine');
  });

  it('catches a node that needs itself', () => {
    const found = validateWorkflow(workflow([node('a', { needs: ['a'] })]));
    expect(found[0]?.message).toBe('"a" needs itself');
    // And does not *also* report it as a cycle: one mistake, one line.
    expect(found.filter((f) => f.message.includes('wait on each other'))).toHaveLength(0);
  });

  it('reports a duplicate id, which would make `needs` ambiguous', () => {
    const found = validateWorkflow(workflow([node('scan'), node('scan')]));
    expect(found[0]?.message).toContain('two nodes share the id');
  });

  it('does not report a phantom cycle when an edge names nothing', () => {
    // The missing edge is the finding. Counting it in the ordering too would
    // accuse the node of a second problem it does not have.
    const found = validateWorkflow(workflow([node('a', { needs: ['ghost'] }), node('b')]));
    expect(found).toHaveLength(1);
  });
});

describe('the budget, checked whole', () => {
  it('says nothing while there is no root to check against', () => {
    // Editing: there is no run yet, so the shape is all that can be judged.
    expect(validateWorkflow(workflow([node('a'), node('b')]))).toEqual([]);
  });

  it('names the total, the shortfall and the nodes worth cutting', () => {
    /*
     * The whole argument for checking whole rather than reserving as it goes
     * (§4.4): the incremental form stops at one node, reports one number, and
     * releases what it took, leaving nothing that says what to do. Each of the
     * four facts below is one the reader needs and the incremental form cannot
     * supply.
     */
    const wf = workflow([
      node('scan', { tokenCeiling: 10_000 }),
      node('integration', { tokenCeiling: 90_000 }),
      node('report', { tokenCeiling: 20_000 }),
    ]);
    const found = validateWorkflow(wf, budget(50_000));
    const said = found[0]?.message ?? '';
    expect(said).toContain('review and fix');   // which workflow
    expect(said).toContain('120,000');          // what it needs
    expect(said).toContain('50,000');           // what there is
    expect(said).toContain('70,000');           // how short
    expect(said).toContain('integration');      // where to cut first
    // Largest first, because that is where the shortfall closes cheapest.
    expect(said.indexOf('integration')).toBeLessThan(said.indexOf('report'));
  });

  it('counts what is already reserved, not just the ceiling', () => {
    // `availableTokens` is what a sibling split already took out. A workflow
    // proposed from a session that has spawned children draws on what is left.
    const wf = workflow([node('a', { tokenCeiling: 30_000 })]);
    expect(validateWorkflow(wf, budget(50_000))).toEqual([]);
    expect(
      validateWorkflow(wf, { tokenCeiling: 50_000, spent: 0, reservedForChildren: 25_000 }),
    ).toHaveLength(1);
  });

  it('sums the declared ceilings, which is deliberately pessimistic', () => {
    // A node finishing under its ceiling releases the remainder (§4.3), so this
    // total is the worst case rather than the expected one — and being refused
    // up front beats dying halfway with six nodes done.
    expect(declaredTotal(workflow([node('a'), node('b'), node('c')]))).toBe(30_000);
  });
});

describe('the document as a whole', () => {
  it('refuses one with no goal, since every node inherits it', () => {
    const found = validateWorkflow({ ...workflow([node('a')]), goal: '  ' });
    expect(found[0]?.message).toContain('parentGoal');
  });

  it('refuses one with no nodes, and stops there', () => {
    // Nothing after this could say anything useful about an empty list.
    const found = validateWorkflow(workflow([]));
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain('decomposes nothing');
  });
});
