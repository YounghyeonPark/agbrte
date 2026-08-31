/**
 * A workflow run, against a real `SessionManager` (DESIGN.md §4.4, §4.3).
 *
 * The scheduler's rules are checked in `workflowSchedule.test.ts`, purely. What
 * is checked here is the half that can only be wrong in the wiring: that a run
 * is **an ordinary session tree** — children of the root, spawned through the
 * same `prepareChild` an approved split uses, with the same budget reservation —
 * and that the one exemption §4.4 grants is as narrow as it says.
 *
 * The echo runtime, so this exercises the spawning and not a model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { TREE_LIMITS, type InstanceId, type SessionId, type Workflow, type WorkflowNode } from '@shared/types/index.js';

let root = '';
let instanceId: InstanceId;
let manager: SessionManager;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-wfrun-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
  manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const node = (id: string, needs?: string[], over: Partial<WorkflowNode> = {}): WorkflowNode => ({
  id,
  title: id,
  scope: `do the ${id} part`,
  outOfScope: ['everything else'],
  acceptance: ['it is done'],
  contract: { summaryMaxTokens: 800, artifacts: [] },
  tokenCeiling: 5_000,
  ...(needs !== undefined ? { needs } : {}),
  ...over,
});

const workflow = (nodes: WorkflowNode[]): Workflow => ({
  id: 'review',
  name: 'review and fix',
  goal: 'find what is broken on this branch',
  nodes,
});

/** A root with a budget, which is what a run needs to reserve from. */
async function rootFor(tokenCeiling = 200_000): Promise<SessionId> {
  const session = await manager.createSession({
    title: 'review and fix',
    goal: 'find what is broken on this branch',
    budget: { tokenCeiling, spent: 0, reservedForChildren: 0 },
  });
  return session.sessionId;
}

/** Pretend a node finished, the way its own session settling would. */
function settle(rootId: SessionId, nodeId: string, state: 'done' | 'failed'): void {
  const child = manager.get(rootId).children.find((c) => c.title === nodeId);
  if (child === undefined) throw new Error(`no child for ${nodeId}`);
  child.lastKnown = { ...child.lastKnown, state };
}

const titles = (rootId: SessionId): string[] =>
  manager
    .get(rootId)
    .children.map((c) => c.title)
    .sort();

describe('a run is an ordinary session tree', () => {
  it('spawns only what is ready, as children of the root', async () => {
    const rootId = await rootFor();
    await manager.workflowRuns.start(
      rootId,
      workflow([node('scan'), node('tests', ['scan']), node('report', ['tests'])]),
    );

    // One child, not three: `tests` and `report` are waiting on predecessors,
    // and spawning them now would reserve budget for work that cannot start.
    expect(titles(rootId)).toEqual(['scan']);
    for (const child of manager.get(rootId).children) {
      expect(child.contract.summaryMaxTokens).toBe(800);
    }
  });

  it('carries on as each node finishes', async () => {
    const rootId = await rootFor();
    const wf = workflow([node('scan'), node('tests', ['scan']), node('lint', ['scan'])]);
    await manager.workflowRuns.start(rootId, wf);

    settle(rootId, 'scan', 'done');
    await manager.workflowRuns.advance(rootId);
    // Both branches at once. Nothing in the document orders them, so a runner
    // that serialised them would be inventing a constraint.
    expect(titles(rootId)).toEqual(['lint', 'scan', 'tests']);
  });

  it('reserves from the root at spawn, so a tree cannot outspend its root', async () => {
    /*
     * §4.3's reservation-at-spawn, arriving through the runner unchanged: "by
     * then the money is gone and the check is a report". Two nodes at 5,000 are
     * 10,000 off a 200,000 root the moment they exist, not when they spend.
     */
    const rootId = await rootFor(200_000);
    await manager.workflowRuns.start(rootId, workflow([node('a'), node('b')]));
    expect(manager.get(rootId).budget?.reservedForChildren).toBe(10_000);
  });

  it('refuses to start what the root cannot pay for', async () => {
    // The whole-graph check runs before this in `validateWorkflow`; this is the
    // per-spawn reservation refusing underneath it, which is the guarantee that
    // holds even if a caller skipped the check.
    const rootId = await rootFor(6_000);
    await expect(
      manager.workflowRuns.start(rootId, workflow([node('a'), node('b')])),
    ).rejects.toThrow(/reserve/);
    // The first one was created; the second was refused before it existed, so
    // nothing half-made is left behind (§4.3: "a refused split leaves nothing").
    expect(titles(rootId)).toEqual(['a']);
  });
});

describe('when a node fails', () => {
  it('stops what depended on it and leaves the rest alone', async () => {
    const rootId = await rootFor();
    const wf = workflow([
      node('scan'),
      node('tests', ['scan']),
      node('lint', ['scan']),
      node('report', ['tests', 'lint']),
    ]);
    await manager.workflowRuns.start(rootId, wf);
    settle(rootId, 'scan', 'done');
    await manager.workflowRuns.advance(rootId);

    settle(rootId, 'tests', 'failed');
    settle(rootId, 'lint', 'done');
    await manager.workflowRuns.advance(rootId);

    // `report` needed the failed node and is never spawned; nothing else was
    // discarded. §4.4 named the two wrong answers, and this is neither.
    expect(titles(rootId)).toEqual(['lint', 'scan', 'tests']);
    expect(manager.workflowRuns.succeeded(rootId, wf)).toBe(false);
  });
});

describe('the exemption §4.4 grants, and its edges', () => {
  it('spawns more declared nodes than maxChildrenPerSession allows', async () => {
    /*
     * The limit says "keeps a tree node reviewable by a human", which is a
     * readability rule — and a workflow's review happened in a diff before
     * anything ran. `maxOpenDescendants` still bounds the cost, which is what
     * was measuring the real thing all along.
     */
    const many = Array.from({ length: TREE_LIMITS.maxChildrenPerSession + 3 }, (_, i) =>
      node(`n${i}`),
    );
    const rootId = await rootFor();
    await manager.workflowRuns.start(rootId, workflow(many));
    expect(manager.get(rootId).children).toHaveLength(TREE_LIMITS.maxChildrenPerSession + 3);
  });

  it('does not lift the limit for anything else', async () => {
    /*
     * The narrowness is the point. An exemption that leaked past the declared
     * nodes would hand every workflow node an unreviewed budget for eight more —
     * which is exactly the unreviewed decomposition the limit exists for.
     */
    const rootId = await rootFor();
    await manager.workflowRuns.start(
      rootId,
      workflow(Array.from({ length: TREE_LIMITS.maxChildrenPerSession }, (_, i) => node(`n${i}`))),
    );
    await expect(
      manager.prepareChild(rootId, {
        title: 'by hand',
        scope: 'something else',
        outOfScope: ['the rest'],
        contract: { summaryMaxTokens: 500, artifacts: [] },
        tokenCeiling: 1_000,
      }),
    ).rejects.toThrow(/reviewable by a human/);
  });

  it('lifts nothing but that limit', async () => {
    // Not depth, not the budget. A flag that quietly widened either would be the
    // kind of exemption nobody could reason about.
    const rootId = await rootFor(1_000);
    await expect(manager.workflowRuns.start(rootId, workflow([node('a')]))).rejects.toThrow(
      /reserve/,
    );
  });
});
