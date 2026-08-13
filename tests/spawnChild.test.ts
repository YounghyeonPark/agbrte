/**
 * Splitting a session into children (DESIGN.md §4.3, §15 Phase 6).
 *
 * > A child's ceiling is **reserved from the parent's remaining budget at
 * > spawn**, so a tree cannot spend more than its root was granted.
 *
 * The vocabulary and the helpers already existed — `TreePosition`, `ChildRef`,
 * `SessionBrief`, `buildBrief`, `reserveForChild`, and a reducer that folds five
 * child events. What did not exist was anything that spawned a child. This is
 * that, and most of it is refusals: §4.3 keeps splits user-approved because "a
 * decomposition mistake made autonomously produces a tree of subtly mis-scoped
 * children that is harder to salvage than a single overlong session", and the
 * same reasoning makes a refused spawn cheaper than a wrong one.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, SplitRefused, type SpawnChildInput } from '@main/sessionManager.js';
import { BriefRefused } from '@main/store/brief.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { InstanceId, SessionBudget, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
const managers: SessionManager[] = [];

const BUDGET: SessionBudget = { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 };

function manager(): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
    label: 'Echo',
    model: 'none',
  });
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

function split(over: Partial<SpawnChildInput> = {}): SpawnChildInput {
  return {
    title: 'port the parser',
    scope: 'port the parser to the new AST, tests included',
    outOfScope: ['the CLI surface', 'anything under docs/'],
    contract: { summaryMaxTokens: 500, artifacts: [] },
    tokenCeiling: 20_000,
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-split-'));
  instanceId = (await openWorkspace(root)).instanceId;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('what a child gets', () => {
  it('sits under its parent, carrying the ancestry', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'the whole job', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split());

    expect(child.tree).toMatchObject({
      rootSessionId: parent.sessionId,
      parentSessionId: parent.sessionId,
      depth: 1,
      ancestry: [parent.sessionId],
    });
  });

  it('records the edge on both logs', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split());

    // Either log alone reconstructs the relationship, which is what makes a
    // child in another workspace self-contained rather than a dangling
    // reference (§4.3).
    const parentEvents = await m.events(parent.sessionId);
    const childEvents = await m.events(child.sessionId);
    expect(parentEvents.some((e) => e.type === 'session.spawned_child')).toBe(true);
    expect(childEvents.some((e) => e.type === 'session.brief_received')).toBe(true);
  });

  it('keeps the brief in the child log, not as an opening prompt', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'the whole job', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split());

    const brief = (await m.events(child.sessionId)).find((e) => e.type === 'session.brief_received');
    // Durable, so a child resumed in three weeks still knows why it exists.
    expect(JSON.stringify(brief)).toContain('the whole job');
    expect(JSON.stringify(brief)).toContain('anything under docs/');
  });

  it('carries no parent transcript by default', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const agent = await m.addAgent(parent.sessionId, { role: 'lead', runtimeId: 'echo' });
    await m.send(parent.sessionId, agent.agentId, {
      content: [{ type: 'text', text: 'a long parent discussion nobody should inherit' }],
    });

    const child = await m.spawnChild(parent.sessionId, split());
    const brief = (await m.events(child.sessionId)).find((e) => e.type === 'session.brief_received');

    // Every verbatim turn is parent context entering a child, which is the cost
    // the split exists to avoid. §4.3: "by exception, not default".
    expect(JSON.stringify(brief)).not.toContain('nobody should inherit');
  });
});

describe('the budget', () => {
  it('reserves the child ceiling out of the parent at spawn', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split({ tokenCeiling: 20_000 }));

    // Taken now, not checked when the child spends. By then the money is gone
    // and the check is a report.
    expect(m.get(parent.sessionId).budget?.reservedForChildren).toBe(20_000);
    expect(child.budget?.tokenCeiling).toBe(20_000);
  });

  it('lets siblings reduce what the next child can take', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await m.spawnChild(parent.sessionId, split({ tokenCeiling: 60_000 }));
    await m.spawnChild(parent.sessionId, split({ tokenCeiling: 30_000 }));

    // This is what makes "a tree cannot outspend what its root was granted" true
    // rather than aspirational.
    await expect(m.spawnChild(parent.sessionId, split({ tokenCeiling: 20_000 }))).rejects.toThrow(
      BriefRefused,
    );
  });

  it('refuses to split a session that has no ceiling of its own', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g' });
    // Inventing one would put a number nobody agreed to at the root of a
    // subtree, and every descendant would inherit it.
    await expect(m.spawnChild(parent.sessionId, split())).rejects.toThrow(SplitRefused);
  });
});

describe('limits, because trees explode', () => {
  it('stops at maxDepth', async () => {
    const m = manager();
    let current = await m.createSession({ title: 'root', goal: 'g', budget: BUDGET });

    for (let i = 0; i < 3; i += 1) {
      current = await m.spawnChild(current.sessionId, split({ tokenCeiling: 1_000 }));
    }
    expect(current.tree.depth).toBe(3);

    // §4.3: "deeper trees are unmanageable and almost always signal bad
    // decomposition, not deep work".
    await expect(m.spawnChild(current.sessionId, split({ tokenCeiling: 100 }))).rejects.toThrow(
      /maxDepth/,
    );
  });

  it('stops at maxChildrenPerSession', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    for (let i = 0; i < 8; i += 1) {
      await m.spawnChild(parent.sessionId, split({ tokenCeiling: 1_000 }));
    }
    // The limit that keeps a tree node reviewable by a human.
    await expect(m.spawnChild(parent.sessionId, split({ tokenCeiling: 1_000 }))).rejects.toThrow(
      /reviewable by a human/,
    );
  });

  it('refuses before it spends anything', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    for (let i = 0; i < 8; i += 1) {
      await m.spawnChild(parent.sessionId, split({ tokenCeiling: 1_000 }));
    }
    const before = m.get(parent.sessionId).budget?.reservedForChildren;

    await expect(m.spawnChild(parent.sessionId, split({ tokenCeiling: 5_000 }))).rejects.toThrow();

    // A refused split must not leave a reservation behind, or a parent loses
    // budget to children that were never created.
    expect(m.get(parent.sessionId).budget?.reservedForChildren).toBe(before);
    expect(m.get(parent.sessionId).children).toHaveLength(8);
  });
});

describe('what the brief refuses on its own', () => {
  it('will not split without exclusions', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    // Only the parent knows what it is keeping. Without it the child reads
    // widely to re-derive context it was never given.
    await expect(m.spawnChild(parent.sessionId, split({ outOfScope: [] }))).rejects.toThrow(
      BriefRefused,
    );
  });

  it('will not split without a summary ceiling', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    // The failure being prevented: a child returns its transcript, the parent's
    // context explodes, and the original problem is reproduced one level up.
    await expect(
      m.spawnChild(parent.sessionId, split({ contract: { summaryMaxTokens: 0, artifacts: [] } })),
    ).rejects.toThrow(BriefRefused);
  });

  it('leaves the parent untouched when it refuses', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await expect(m.spawnChild(parent.sessionId, split({ outOfScope: [] }))).rejects.toThrow();

    expect(m.get(parent.sessionId).children).toEqual([]);
    expect(m.get(parent.sessionId).budget?.reservedForChildren).toBe(0);
  });
});

describe('a child is a session', () => {
  it('runs its own agents and owns its own log', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split());

    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(child.sessionId, agent.agentId, { content: [{ type: 'text', text: 'work' }] });

    // Independently resumable, which is the whole reason this costs a log.
    const childEvents = await m.events(child.sessionId);
    expect(childEvents.some((e) => e.type === 'user.turn')).toBe(true);
    // And none of it landed on the parent.
    const parentEvents = await m.events(parent.sessionId);
    expect(parentEvents.some((e) => e.type === 'user.turn')).toBe(false);
  });

  it('is listed on its parent for rendering, with a cached projection', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split());

    const [ref] = m.get(parent.sessionId).children;
    // §4.3: cached for rendering when the child is unreachable, never
    // authoritative.
    expect(ref).toMatchObject({
      sessionId: child.sessionId as SessionId,
      title: 'port the parser',
      lastKnown: { state: 'planning' },
    });
  });
});

describe('a child that claims to be somewhere else (§4.3, §15 Phase 6)', () => {
  /**
   * A child on another machine, which this manager cannot make (§4.3, §17 Q5).
   *
   * This used to refuse, and the refusal was right while it lasted: `spawnChild`
   * created through `this.createSession` — one manager, one workspace, one host
   * — so a `target` naming another machine set a field and changed nothing. The
   * record said `ssh` while the agent ran locally.
   *
   * It is the fleet that spawns across hosts now: it prepares on the parent's,
   * creates on the target's, and commits back. Reached *here*, both halves are
   * on one machine — so a target is a label on a session this manager owns, and
   * the honest behaviour is to make it rather than to refuse something that is
   * no longer impossible.
   */
  it('makes the child here, because a manager is one host', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });

    const child = await m.spawnChild(parent.sessionId, {
      ...split(),
      target: { kind: 'ssh', alias: 'build-box', host: 'build-box', useSystemConfig: true },
    });

    // Created, and on this instance — the routing decision belongs a layer up,
    // and `fleet.test.ts` is where it is driven.
    expect(child.instanceId).toBe(parent.instanceId);
    expect(child.tree.parentSessionId).toBe(parent.sessionId);
  });

  it('still spawns a child that names the host it is actually on', async () => {
    // Passing the parent's own target is not a request to go anywhere, and must
    // keep working — it is what `proposeSplit` does when it carries one.
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });

    const child = await m.spawnChild(parent.sessionId, { ...split(), target: { kind: 'local' } });
    expect(child.target.kind).toBe('local');
  });

  it('puts the child on the parent’s host when no target is named', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });

    const child = await m.spawnChild(parent.sessionId, split());
    // The `ChildRef` a parent holds must name a host that can actually be
    // routed to, or roll-up asks a machine that never had the session.
    expect(child.instanceId).toBe(parent.instanceId);
  });
});
