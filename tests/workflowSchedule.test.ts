/**
 * What a workflow run does next, and what it does when a node fails
 * (DESIGN.md §4.4, §4.3).
 *
 * The scheduler is pure because §5.1 refuses a second source of truth: it is
 * handed the document and what the children are doing *now*, and answers. So
 * resume is not a feature — a host that restarts mid-run reads its children's
 * states out of the log, asks again, and carries on — and that is checkable
 * here without a host, a model, or a run.
 *
 * The failure policy is the question §4.4 left open, and these tests are where
 * the answer is stated: **a failed node stops what depended on it and nothing
 * else.** §4.4 named the two wrong answers; this is the third, and it needs no
 * new field, because the dependency the author already wrote down is exactly the
 * statement of what a node cannot do without.
 */

import { describe, expect, it } from 'vitest';
import type { Workflow, WorkflowNode } from '../src/shared/types/index.js';
import { nextStep, runSucceeded, type NodeState } from '../src/shared/workflow/schedule.js';

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

/** scan → tests, scan → lint, then both into report. */
const DIAMOND: Workflow = {
  id: 'review',
  name: 'review and fix',
  goal: 'find what is broken',
  nodes: [node('scan'), node('tests', ['scan']), node('lint', ['scan']), node('report', ['tests', 'lint'])],
};

const at = (nodes: Record<string, NodeState>): { nodes: Record<string, NodeState> } => ({ nodes });
const ids = (list: WorkflowNode[]): string[] => list.map((n) => n.id).sort();

describe('what to start next', () => {
  it('starts everything with no predecessor, at the beginning', () => {
    const step = nextStep(DIAMOND, at({}));
    expect(ids(step.ready)).toEqual(['scan']);
    expect(step.finished).toBe(false);
  });

  it('starts both branches when their one predecessor is done', () => {
    // The fan-out. Nothing serialises `tests` and `lint` — the document does not
    // say they are ordered, so the runner must not invent an order.
    expect(ids(nextStep(DIAMOND, at({ scan: 'done' })).ready)).toEqual(['lint', 'tests']);
  });

  it('waits for every predecessor of a join, not the first', () => {
    // The join is the shape `needs` exists for. Starting `report` when only
    // `tests` is done would hand it a brief with half its pointers.
    expect(ids(nextStep(DIAMOND, at({ scan: 'done', tests: 'done', lint: 'running' })).ready)).toEqual(
      [],
    );
    expect(ids(nextStep(DIAMOND, at({ scan: 'done', tests: 'done', lint: 'done' })).ready)).toEqual([
      'report',
    ]);
  });

  it('starts nothing while a node it needs is still going', () => {
    expect(ids(nextStep(DIAMOND, at({ scan: 'running' })).ready)).toEqual([]);
    expect(nextStep(DIAMOND, at({ scan: 'running' })).finished).toBe(false);
  });

  it('is finished when everything has run', () => {
    const done = at({ scan: 'done', tests: 'done', lint: 'done', report: 'done' });
    expect(nextStep(DIAMOND, done).finished).toBe(true);
    expect(runSucceeded(DIAMOND, done)).toBe(true);
  });
});

describe('when a node fails', () => {
  /*
   * §4.4's open question, answered. It named two defaults and rejected both:
   * stopping the whole graph throws away branches that have nothing to do with
   * the failure, and carrying on starts a node whose predecessor produced
   * nothing for it to read. Following the edges is neither.
   */
  it('stops what depended on it', () => {
    const step = nextStep(DIAMOND, at({ scan: 'done', tests: 'failed', lint: 'done' }));
    expect(ids(step.blocked)).toEqual(['report']);
    expect(ids(step.ready)).toEqual([]);
  });

  it('leaves a branch that did not depend on it alone', () => {
    // `lint` needs only `scan`. A failure in `tests` says nothing about it, and
    // a runner that stopped it would be discarding work for no stated reason.
    const step = nextStep(DIAMOND, at({ scan: 'done', tests: 'failed' }));
    expect(ids(step.ready)).toEqual(['lint']);
    expect(ids(step.blocked)).toEqual(['report']);
  });

  it('follows the failure all the way down, not one step', () => {
    /*
     * A node whose immediate predecessor is *blocked* rather than failed would
     * otherwise sit in `unstarted` forever — pending on screen, waiting for
     * something that will never run. A graph that has quietly stopped is the
     * worst of the three outcomes, because nothing says so.
     */
    const chain: Workflow = {
      ...DIAMOND,
      nodes: [node('a'), node('b', ['a']), node('c', ['b']), node('d', ['c']), node('spare')],
    };
    const step = nextStep(chain, at({ a: 'failed' }));
    expect(ids(step.blocked)).toEqual(['b', 'c', 'd']);
    expect(ids(step.ready)).toEqual(['spare']);
  });

  it('is finished once the stranded nodes are all it has left', () => {
    const step = nextStep(DIAMOND, at({ scan: 'done', tests: 'failed', lint: 'done' }));
    expect(step.finished).toBe(true);
  });

  it('does not call the run a success because most of it worked', () => {
    /*
     * §4.3's "a failed child does not fail its parent" is about a *parent
     * choosing* — retry, re-scope, abandon. A scheduler chooses nothing, so
     * reporting success on three of four nodes would be the report making a
     * decision the person never made.
     */
    const run = at({ scan: 'done', tests: 'failed', lint: 'done' });
    expect(runSucceeded(DIAMOND, run)).toBe(false);
  });
});

describe('a run that comes back after a restart', () => {
  it('carries on from what the children say, with nothing remembered', () => {
    /*
     * The reason this is pure. §5.1 refuses a second source of truth, so the
     * scheduler holds no idea of which nodes have run — it is handed the states
     * and answers. Resume is therefore not a feature: the same call on the same
     * facts gives the same answer, whoever is asking and however many hosts have
     * restarted in between.
     */
    const half = at({ scan: 'done', tests: 'done' });
    expect(nextStep(DIAMOND, half)).toEqual(nextStep(DIAMOND, half));
    expect(ids(nextStep(DIAMOND, half).ready)).toEqual(['lint']);
  });

  it('does not restart something already running', () => {
    // The state a host meets when it reconnects to children it left going.
    expect(ids(nextStep(DIAMOND, at({ scan: 'done', tests: 'running', lint: 'running' })).ready)).toEqual(
      [],
    );
  });
});

describe('edges the validator already refuses', () => {
  it('ignores a `needs` naming a node that is not here', () => {
    // Its own finding, and a document carrying one never reaches a run — but a
    // scheduler that waited on it would hang rather than fail, which is worse
    // than either.
    const odd: Workflow = { ...DIAMOND, nodes: [node('a', ['ghost'])] };
    expect(ids(nextStep(odd, at({})).ready)).toEqual(['a']);
  });
});
