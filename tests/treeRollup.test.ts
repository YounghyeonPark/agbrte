/**
 * What a tree reports upward (DESIGN.md §4.3, §10, §15 Phase 6).
 *
 * > **`needsAttention` bubbles to the root.** A child three levels down blocked
 * > on a permission prompt must surface at the top of the dashboard, or nobody
 * > will ever find it. This is the single most important tree behavior in the UI.
 *
 * Two different things travel up and conflating them would be the bug. `lastKnown`
 * is a **cache** for rendering a tree whose children may be unreachable — §4.3
 * says it is never authoritative. `needsAttention` is a **summons**: a parent
 * sitting in `awaiting_children` looks patient, and the question underneath it
 * goes unanswered forever unless it is carried to where someone is looking.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { until } from './support/until.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type {
  InstanceId,
  Session,
  SessionBudget,
  SessionId,
  ToolPolicy,
} from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
const managers: SessionManager[] = [];

const BUDGET: SessionBudget = { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 };
const DONE: EchoStep[] = [{ kind: 'stop', stop: { kind: 'end_turn' } }];

/**
 * A policy under which the echo tool call actually reaches a human.
 *
 * §13's local defaults allow `read` outright, so an agent scripted to call it
 * finishes its turn and never blocks — which would make every test below pass
 * for the wrong reason.
 */
const ASKS: ToolPolicy = { rules: [], defaultAction: 'ask' };

function manager(script: EchoStep[] = DONE): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

const split = (title: string, ceiling = 10_000) => ({
  title,
  scope: `do ${title}`,
  outOfScope: ['everything else'],
  contract: { summaryMaxTokens: 500, artifacts: [] },
  tokenCeiling: ceiling,
});


/** Reach a live session, which is where roll-up lands. */
const liveOf = (m: SessionManager, id: string): { session: Session } =>
  (m as unknown as { sessions: Map<string, { session: Session }> }).sessions.get(id)!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-tree-'));
  instanceId = (await openWorkspace(root)).instanceId;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a parent cannot finish ahead of its children', () => {
  it('sits in awaiting_children rather than reaching done', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await m.spawnChild(parent.sessionId, split('child'));

    const agent = await m.addAgent(parent.sessionId, { role: 'lead', runtimeId: 'echo', policy: ASKS });
    await m.send(parent.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    // `end_turn` would ordinarily leave it `awaiting_input`. A dashboard saying
    // finished is the one thing nobody looks at again, so it holds instead.
    expect(m.get(parent.sessionId).state).toBe('awaiting_children');
  });

  it('settles once the children have', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));

    const worker = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    await m.send(child.sessionId, worker.agentId, { content: [{ type: 'text', text: 'go' }] });

    const lead = await m.addAgent(parent.sessionId, { role: 'lead', runtimeId: 'echo', policy: ASKS });
    await m.send(parent.sessionId, lead.agentId, { content: [{ type: 'text', text: 'go' }] });

    expect(m.get(parent.sessionId).state).toBe('awaiting_input');
  });
});

describe('a blockage travels to where someone is looking', () => {
  it('surfaces a grandchild waiting on permission at the root', async () => {
    const m = manager([{ kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } }]);
    const rootSession = await m.createSession({ title: 'the whole job', goal: 'g', budget: BUDGET });
    const mid = await m.spawnChild(rootSession.sessionId, split('middle', 50_000));
    const deep = await m.spawnChild(mid.sessionId, split('the deep one', 20_000));

    // A prompt nobody answers, three levels down.
    const agent = await m.addAgent(deep.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    void m.send(deep.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(() => liveOf(m, rootSession.sessionId).session.needsAttention?.from !== undefined);

    const at = liveOf(m, rootSession.sessionId).session.needsAttention;
    expect(at?.reason).toBe('needs_permission');
    // Named, with the way there. "Something below this needs you" is not
    // actionable on its own.
    expect(at?.from?.sessionId).toBe(deep.sessionId as SessionId);
    expect(at?.from?.path).toEqual(['middle', 'the deep one']);
  });

  it('keeps the origin rather than blaming the relay', async () => {
    const m = manager([{ kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } }]);
    const rootSession = await m.createSession({ title: 'r', goal: 'g', budget: BUDGET });
    const mid = await m.spawnChild(rootSession.sessionId, split('middle', 50_000));
    const deep = await m.spawnChild(mid.sessionId, split('deep', 20_000));

    const agent = await m.addAgent(deep.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    void m.send(deep.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(() => liveOf(m, mid.sessionId).session.needsAttention?.from !== undefined);

    // The middle session relayed it. Re-attributing to the relay would send the
    // user to a session with nothing to answer.
    expect(liveOf(m, mid.sessionId).session.needsAttention?.from?.sessionId).toBe(
      deep.sessionId as SessionId,
    );
  });

  it('prefers a session own blockage over one beneath it', async () => {
    const m = manager([{ kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } }]);
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child', 20_000));

    // Sequenced rather than raced: each prompt is waited for, so the assertion
    // is about precedence and not about which turn happened to win.
    const below = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    void m.send(child.sessionId, below.agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(() => liveOf(m, parent.sessionId).session.needsAttention?.from !== undefined);

    const here = await m.addAgent(parent.sessionId, { role: 'lead', runtimeId: 'echo', policy: ASKS });
    void m.send(parent.sessionId, here.agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(() => liveOf(m, parent.sessionId).session.state === 'awaiting_permission');

    // The thing in front of you is the thing you can answer.
    expect(liveOf(m, parent.sessionId).session.needsAttention?.from).toBeUndefined();
  });

  it('stops showing once the thing it pointed at is answered', async () => {
    const m = manager([{ kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } }]);
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child', 20_000));

    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    const turn = m.send(child.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    // Waited on the prompt itself, which is the thing this test then answers.
    // Waiting on the bubbled attention instead left a window where the summons
    // had arrived and the request had not, and the answer went to nobody.
    let pending = (await m.pendingPermissions())[0];
    const deadline = Date.now() + 2_000;
    while (pending === undefined) {
      if (Date.now() > deadline) throw new Error('no permission was ever requested');
      await new Promise((r) => setTimeout(r, 5));
      pending = (await m.pendingPermissions())[0];
    }
    expect(liveOf(m, parent.sessionId).session.needsAttention?.from).toBeDefined();

    await m.respondPermission(pending.requestId, { result: 'allow', scope: 'once' });
    await turn;

    // A summons left standing after it was answered is how the rail stops being
    // read at all.
    expect(liveOf(m, parent.sessionId).session.needsAttention?.from).toBeUndefined();
  });
});

describe('what deliberately does not travel', () => {
  it('leaves a child waiting for input on its own card', async () => {
    /**
     * Every turn ends in `awaiting_input`, so if that bubbled, a tree of any
     * size would permanently show a summons from some child or other — and a
     * rail that is always lit is a rail nobody reads, which is the only failure
     * mode that matters for a warning.
     *
     * The same reason `needs_input` is silent in the notifier and absent from
     * the inbox. Three features, one rule.
     */
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));

    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    await m.send(child.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    // True on the child, where looking at it is a choice.
    expect(m.get(child.sessionId).needsAttention?.reason).toBe('needs_input');
    expect(liveOf(m, parent.sessionId).session.needsAttention?.from).toBeUndefined();
  });
});

describe('the cached projection', () => {
  it('follows the child rather than being asked for', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));

    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    await m.send(child.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    // Cached for rendering a tree whose children may be unreachable — never
    // authoritative, which is why the child's own log stays the truth.
    const [ref] = liveOf(m, parent.sessionId).session.children;
    expect(ref?.lastKnown.state).toBe('awaiting_input');
  });
});

describe('cancelling a parent', () => {
  it('turns its children into roots instead of destroying them', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));

    await m.cancelSession(parent.sessionId);

    // Each child is self-contained and independently valuable — its own log, its
    // own budget. Destroying one takes a transcript worth reading with it.
    const adopted = m.get(child.sessionId);
    expect(adopted.tree).toMatchObject({ rootSessionId: child.sessionId, depth: 0, ancestry: [] });
    expect(adopted.tree.parentSessionId).toBeUndefined();
    expect(m.get(parent.sessionId).children).toEqual([]);
  });

  it('records the adoption on the child log', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));

    await m.cancelSession(parent.sessionId);

    // A session that used to belong to a tree should be able to say so; the edge
    // was recorded when it was made, and its removal is equally part of the
    // history.
    const events = await m.events(child.sessionId);
    expect(events.some((e) => e.type === 'session.orphaned')).toBe(true);
  });

  it('leaves the orphan runnable', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, split('child'));
    await m.cancelSession(parent.sessionId);

    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo', policy: ASKS });
    await expect(
      m.send(child.sessionId, agent.agentId, { content: [{ type: 'text', text: 'carry on' }] }),
    ).resolves.toBeUndefined();
  });
});
