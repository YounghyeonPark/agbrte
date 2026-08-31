/**
 * Where a workflow's nodes go when it is drawn (DESIGN.md §4.4).
 *
 * Pure, so it can be checked in shapes nobody's screen is in — the same reason
 * `setupRoutes.ts` keeps the picker's ordering out of its component. The
 * property that matters is not where a box lands in pixels but that **every
 * arrow points the same way**: a node is strictly to the right of everything it
 * waits on, which is what makes a join legible and a picture worth drawing.
 *
 * That is the longest path and not the shortest, and the difference is the whole
 * of the algorithm. It is asserted here because a shortest-path layout draws a
 * *plausible* graph with one edge running backwards, which is the kind of wrong
 * that survives a glance.
 */

import { describe, expect, it } from 'vitest';
import type { WorkflowNode } from '../src/shared/types/index.js';
import { layoutWorkflow, NODE_WIDTH } from '../src/shared/workflow/layout.js';

const node = (id: string, needs?: string[]): WorkflowNode => ({
  id,
  title: id,
  scope: `do ${id}`,
  outOfScope: ['everything else'],
  acceptance: ['done'],
  contract: { summaryMaxTokens: 800, artifacts: [] },
  tokenCeiling: 10_000,
  ...(needs !== undefined ? { needs } : {}),
});

/** Column index, which is the only part of a position with meaning. */
const columns = (nodes: WorkflowNode[]): Record<string, number> =>
  Object.fromEntries((layoutWorkflow(nodes)?.nodes ?? []).map((p) => [p.id, p.level]));

describe('columns', () => {
  it('puts a chain in order', () => {
    expect(columns([node('a'), node('b', ['a']), node('c', ['b'])])).toEqual({ a: 0, b: 1, c: 2 });
  });

  it('starts everything with no predecessor at the left', () => {
    expect(columns([node('a'), node('b'), node('c', ['a', 'b'])])).toEqual({ a: 0, b: 0, c: 1 });
  });

  /*
   * The join, and the reason this is longest-path.
   *
   * `report` needs `tests` and `lint`; `lint` needs nothing while `tests` is two
   * deep. A shortest-path column would put `report` at 1, beside `tests` and to
   * the *left* of its own predecessor — an arrow pointing backwards in a picture
   * whose whole job is to show which way the work flows.
   */
  it('puts a node after its furthest predecessor, not its nearest', () => {
    const laid = columns([
      node('scan'),
      node('tests', ['scan']),
      node('lint'),
      node('report', ['tests', 'lint']),
    ]);
    expect(laid).toEqual({ scan: 0, tests: 1, lint: 0, report: 2 });
  });

  it('never places a node left of something it waits on', () => {
    // The invariant, stated directly rather than through one example. A layout
    // that satisfies this can be read; one that does not cannot.
    const nodes = [
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
      node('e', ['a', 'd']),
      node('f'),
      node('g', ['f', 'e']),
    ];
    const at = columns(nodes);
    for (const n of nodes) {
      for (const dep of n.needs ?? []) {
        expect(at[n.id]).toBeGreaterThan(at[dep] as number);
      }
    }
  });
});

describe('what is not drawn', () => {
  it('has no picture for a cycle, since there is no order to draw', () => {
    // `validateWorkflow` already names the nodes involved, which is the more
    // useful form of the same fact. Drawing most of it would suggest the rest
    // is merely offscreen.
    expect(layoutWorkflow([node('a', ['c']), node('b', ['a']), node('c', ['b'])])).toBeNull();
  });

  it('has no picture for a node that waits on itself', () => {
    expect(columns([node('a', ['a'])])).toEqual({ a: 0 });
    // The self-edge is dropped rather than drawn as a loop: it is its own
    // finding, and a curl on one box is not what somebody needs told.
    expect(layoutWorkflow([node('a', ['a'])])?.edges).toEqual([]);
  });

  it('ignores an edge to a node that is not here', () => {
    // A dangling `needs` is reported by the validator. Letting it shift a
    // column would report it twice, in two vocabularies.
    expect(columns([node('a', ['ghost']), node('b', ['a'])])).toEqual({ a: 0, b: 1 });
    expect(layoutWorkflow([node('a', ['ghost'])])?.edges).toEqual([]);
  });

  it('draws nothing for an empty document', () => {
    expect(layoutWorkflow([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});

describe('the drawing itself', () => {
  it('routes one edge per real dependency, naming both ends', () => {
    const laid = layoutWorkflow([node('a'), node('b'), node('c', ['a', 'b'])]);
    expect(laid?.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(['a->c', 'b->c']);
    // Every path starts and ends somewhere: an edge whose `d` is empty would
    // render as nothing at all and look like a missing dependency.
    for (const edge of laid?.edges ?? []) expect(edge.d).toMatch(/^M [\d.]+ [\d.]+ C /);
  });

  it('is wide enough for its last column and tall enough for its longest', () => {
    const laid = layoutWorkflow([node('a'), node('b'), node('c', ['a'])]);
    const right = Math.max(...(laid?.nodes ?? []).map((n) => n.x + NODE_WIDTH));
    expect(laid?.width).toBeGreaterThanOrEqual(right);
    // Two nodes share column 0, so the drawing is two rows tall.
    expect((laid?.nodes ?? []).filter((n) => n.level === 0)).toHaveLength(2);
  });

  it('orders a column the way the document lists it, and nothing else moves', () => {
    // The one part of the picture a person controls. Reordering the file
    // reorders the column; no other coordinate changes.
    const forward = layoutWorkflow([node('a'), node('b'), node('z', ['a'])]);
    const swapped = layoutWorkflow([node('b'), node('a'), node('z', ['a'])]);
    const yOf = (l: typeof forward, id: string): number =>
      (l?.nodes ?? []).find((n) => n.id === id)?.y ?? -1;
    expect(yOf(forward, 'a')).toBeLessThan(yOf(forward, 'b'));
    expect(yOf(swapped, 'b')).toBeLessThan(yOf(swapped, 'a'));
    expect(yOf(forward, 'z')).toBe(yOf(swapped, 'z'));
  });
});
