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
import { until } from './support/until.js';
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

/**
 * Finish a node for real, through the path a child actually takes.
 *
 * Not by writing `lastKnown`, which the first version of this did. That field is
 * the parent's **cache** — §4.3 keeps it for rendering a child that cannot be
 * reached — so faking it produces a run that looks settled to anything reading
 * the parent and is untouched on disk. Every resume test then passed against a
 * runner that could not have worked, which is how this was caught: the resume
 * test failed, and the helper was the thing that was wrong.
 *
 * `reportResult` is what a child does when it is done, and `cancelSession` is a
 * settled failure. Both write to the child's own log, which is what a restarted
 * host reads.
 */
async function settle(
  m: SessionManager,
  rootId: SessionId,
  nodeId: string,
  state: 'done' | 'failed',
): Promise<void> {
  const child = m.get(rootId).children.find((c) => c.title === nodeId);
  if (child === undefined) throw new Error(`no child for ${nodeId}`);
  if (state === 'done') await m.reportResult(child.sessionId, { summary: `${nodeId} finished` });
  else await m.cancelSession(child.sessionId);
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

    await settle(manager, rootId, 'scan', 'done');
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

  it('runs on a root with no ceiling, reserving nothing and refusing nothing', async () => {
    /*
     * The case that was impossible until §4.3 let the absence carry down, and
     * the one almost every session here is: a person working, no budget, a
     * workflow they want run. Before, `prepareChild` refused the first node and
     * the run stopped at nothing having happened, so running a workflow at all
     * meant first picking a token figure — a number chosen to satisfy the
     * mechanism rather than because anybody had an opinion about it.
     *
     * Node ceilings stay in the document. They are what the author says each
     * part is worth, and the same document run against a root that does hold a
     * grant is checked and reserved in the usual way.
     */
    const session = await manager.createSession({ title: 'review and fix', goal: 'g' });
    await manager.workflowRuns.start(session.sessionId, workflow([node('a'), node('b')]));

    expect(titles(session.sessionId)).toEqual(['a', 'b']);
    expect(manager.get(session.sessionId).budget).toBeUndefined();
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
    await settle(manager, rootId, 'scan', 'done');
    await manager.workflowRuns.advance(rootId);

    await settle(manager, rootId, 'tests', 'failed');
    await settle(manager, rootId, 'lint', 'done');
    await manager.workflowRuns.advance(rootId);

    // `report` needed the failed node and is never spawned; nothing else was
    // discarded. §4.4 named the two wrong answers, and this is neither.
    expect(titles(rootId)).toEqual(['lint', 'scan', 'tests']);
    expect(manager.workflowRuns.succeeded(rootId, wf)).toBe(false);
  });
});

describe('a run that outlives the host that started it', () => {
  /**
   * The hole §4.4 named, and the two more that were behind it.
   *
   * Which *document* a root is a run of is now on `session.created`, so a
   * restarted host knows it. Building that path found two older gaps of the same
   * kind, both unrelated to workflows and both worse: a resumed session was
   * hardcoded as a **root**, so a child could not report its result to a parent
   * it no longer knew it had; and a session's **budget** is not durable at all,
   * so a restarted session cannot reserve for a child and therefore cannot
   * split.
   *
   * The first is fixed here. The second is not — it needs an event and a fold of
   * its own, and there is no budget event to build on — so a resumed run comes
   * back knowing what it is and what has run, and cannot yet spawn the next
   * node. §4.4 says so rather than implying otherwise, and these tests assert
   * what is true rather than what was intended.
   *
   * Driven by building a second `SessionManager` over the same workspace, which
   * is what a restart actually is: the log is on disk, nothing is in memory, and
   * `resumeSession` reads both back.
   */
  async function restart(): Promise<SessionManager> {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
    return new SessionManager({ registry, workspaceRoot: root, instanceId });
  }

  /** The document on disk, which is where a resumed run reads it from. */
  async function writeDoc(wf: Workflow): Promise<void> {
    const { saveWorkflow } = await import('@main/store/workflows.js');
    const saved = await saveWorkflow(root, wf.id, wf);
    expect(saved.problems).toEqual([]);
  }

  it('carries on from the log, spawning what had not started', async () => {
    const wf = workflow([node('scan'), node('tests', ['scan']), node('lint', ['scan'])]);
    await writeDoc(wf);

    const session = await manager.createSession({
      title: wf.name,
      goal: wf.goal,
      workflow: wf.id,
      budget: { tokenCeiling: 200_000, spent: 0, reservedForChildren: 0 },
    });
    await manager.workflowRuns.start(session.sessionId, wf);
    expect(titles(session.sessionId)).toEqual(['scan']);

    /*
     * The host goes away here, with `scan` running and the rest never started.
     *
     * Nothing is settled first, deliberately. Finishing a node on the old
     * manager would have *its* roll-up spawn the next ones, and then two
     * managers would be writing one workspace — which §5.1's single-writer rule
     * forbids. The first version of this test did exactly that and failed on
     * duplicate children, which was the test's fault and not the runner's.
     */
    const after = await restart();
    await after.resumeSession(session.sessionId);
    /*
     * `resume` is not awaited by `resumeSession` — deliberately, since it spawns
     * — so this waits for the spawn rather than assuming one.
     *
     * A 100ms sleep, until it was not enough: this is the test that timed out on
     * a loaded machine, and a sleep sized for an idle one is exactly what
     * `until` exists to replace.
     *
     * The condition is `isRun`, not the child count — which the first attempt
     * used and which is **already true** before the restart, since the run had
     * spawned `scan` before the host went away. A condition that holds before
     * the thing you are waiting for is a sleep of zero wearing a poll, and it
     * failed on an idle machine rather than a busy one, which at least made it
     * obvious. `isRun` becomes true when the resumed host has read the document
     * and adopted the run, which is the fact this test is about.
     */
    await until(() => after.workflowRuns.isRun(session.sessionId));

    // The run came back: the new host knows this session is a run of that
    // document, which is what `session.created` now carries and what nothing
    // held durably before.
    expect(after.workflowRuns.isRun(session.sessionId)).toBe(true);
    expect(after.get(session.sessionId).children).toHaveLength(1);

    /*
     * Three things had to become durable before this line could pass, and two
     * of them were older bugs with nothing to do with workflows.
     *
     * The **parent link**: `resumeSession` used to hardcode every resumed
     * session as a root, so a child could not report to a parent it no longer
     * knew it had, and the parent waited forever on finished work.
     *
     * The **budget**: a resumed session had none, and `prepareChild` refuses a
     * parent with no budget — correctly — so a restarted session could not
     * split at all.
     *
     * And the **document id**, which is what this section was for.
     */
    const child = after.get(after.get(session.sessionId).children[0]!.sessionId);
    expect(child.tree.parentSessionId).toBe(session.sessionId);
    expect(after.get(session.sessionId).budget?.tokenCeiling).toBe(200_000);
    // Reserved for `scan`, restored by folding the spawn rather than remembered.
    expect(after.get(session.sessionId).budget?.reservedForChildren).toBe(5_000);

    /*
     * And it is *live*: finishing a node on the new host carries the run on.
     * The old host never knew about these two.
     */
    await settle(after, session.sessionId, 'scan', 'done');
    for (let i = 0; i < 80 && after.get(session.sessionId).children.length < 3; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(
      after
        .get(session.sessionId)
        .children.map((c) => c.title)
        .sort(),
    ).toEqual(['lint', 'scan', 'tests']);
  });

  it('does not re-spawn a node that already ran', async () => {
    /*
     * The property that makes resuming safe rather than expensive. What has run
     * is read from the children every time, so a restart is the same question
     * asked again — and `scan` is `done`, not missing.
     */
    const wf = workflow([node('scan'), node('tests', ['scan'])]);
    await writeDoc(wf);
    const session = await manager.createSession({
      title: wf.name,
      goal: wf.goal,
      workflow: wf.id,
      budget: { tokenCeiling: 200_000, spent: 0, reservedForChildren: 0 },
    });
    await manager.workflowRuns.start(session.sessionId, wf);
    await settle(manager, session.sessionId, 'scan', 'done');
    // Let the old host finish before pretending it went away: two managers
    // writing one workspace is what §5.1's single-writer rule forbids, and it is
    // how an earlier version of this file produced duplicate children.
    await manager.workflowRuns.advance(session.sessionId);
    expect(titles(session.sessionId)).toEqual(['scan', 'tests']);

    const after = await restart();
    await after.resumeSession(session.sessionId);
    /*
     * A duration, and correctly so: the claim is that the resumed run spawns
     * **nothing further**, and an absence only means something if you waited for
     * it. There is nothing to poll for when the expected outcome is that no new
     * fact appears — see the header of `support/until.ts`.
     */
    await new Promise((r) => setTimeout(r, 120));

    /*
     * Still two. The resumed run reads `scan` as **done** and `tests` as
     * running, so it has nothing to start — where a runner reading the parent's
     * cached `lastKnown` would see both as unstarted and spawn them again, each
     * with its own log and its own reservation. That is the read `nodeStates`
     * gets right, and the one this pins.
     */
    const children = after.get(session.sessionId).children;
    expect(children.map((c) => c.title).sort()).toEqual(['scan', 'tests']);
    expect(after.get(children.find((c) => c.title === 'scan')!.sessionId).state).toBe('done');
  });

  it('remembers how deep a resumed session is, not just whose child it is', async () => {
    /*
     * `maxDepth` counts from `parent.tree.depth`, so a resumed session that
     * reports the wrong depth lets a tree grow past the limit — one restart at a
     * time, which is the way nobody would notice.
     *
     * Restoring only the parent gave every resumed child depth 1 however deep it
     * was. The whole position was at the write site all along, in
     * `input.child.tree`, and only the parent was being taken out of it.
     */
    const rootId = await rootFor();
    await manager.workflowRuns.start(rootId, workflow([node('scan')]));
    const childId = manager.get(rootId).children[0]!.sessionId;

    // A grandchild, made the ordinary way a split makes one.
    const prepared = await manager.prepareChild(childId, {
      title: 'deeper',
      scope: 'a part of the part',
      outOfScope: ['everything else'],
      contract: { summaryMaxTokens: 400, artifacts: [] },
      tokenCeiling: 1_000,
    });
    const grandchild = await manager.createSession(prepared.create);
    await manager.recordChild(childId, grandchild, prepared.parentBudget, prepared.create.child!.contract!);
    expect(grandchild.tree.depth).toBe(2);

    const after = await restart();
    const resumed = await after.resumeSession(grandchild.sessionId);
    expect(resumed.tree.depth).toBe(2);
    expect(resumed.tree.parentSessionId).toBe(childId);
    expect(resumed.tree.rootSessionId).toBe(rootId);
    expect(resumed.tree.ancestry).toEqual([rootId, childId]);
  });

  it('leaves an ordinary session alone', async () => {
    // Almost every session is not a run, and one that gained a runner on resume
    // would be a session spawning children nobody asked for.
    const session = await manager.createSession({ title: 'just work', goal: 'do a thing' });
    const after = await restart();
    await after.resumeSession(session.sessionId);
    // A duration: the claim is that an ordinary session spawns nothing, and
    // nothing is not a fact to poll for.
    await new Promise((r) => setTimeout(r, 60));
    expect(after.get(session.sessionId).children).toEqual([]);
    expect(after.workflowRuns.isRun(session.sessionId)).toBe(false);
  });

  it('says nothing when the document has since been deleted', async () => {
    /*
     * A tracked file somebody removed on a branch. There is no run to drive and
     * that is not an error — the tree is on screen either way, and a resume that
     * threw would take the session down with it.
     */
    const wf = workflow([node('scan'), node('tests', ['scan'])]);
    await writeDoc(wf);
    const session = await manager.createSession({
      title: wf.name,
      goal: wf.goal,
      workflow: wf.id,
      budget: { tokenCeiling: 200_000, spent: 0, reservedForChildren: 0 },
    });
    await manager.workflowRuns.start(session.sessionId, wf);
    await rm(join(root, '.agbrte', 'templates'), { recursive: true, force: true });

    const after = await restart();
    await expect(after.resumeSession(session.sessionId)).resolves.toBeDefined();
    // A duration, for the same reason: no run starts, and an absence needs
    // waiting rather than polling.
    await new Promise((r) => setTimeout(r, 60));
    expect(after.workflowRuns.isRun(session.sessionId)).toBe(false);
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
