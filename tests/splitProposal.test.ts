/**
 * Proposing a split, and handing a result back (DESIGN.md §4.3, §15 Phase 6).
 *
 * > The parent agent proposes via a `propose_split` tool and **the user
 * > approves.** Automatic splitting is policy-gated and off by default.
 *
 * > The failure mode to prevent: a child returns its transcript, the parent's
 * > context explodes, and you have reproduced the original problem one level up.
 *
 * Both halves of the same idea — a person decides what gets decomposed, and a
 * child's answer enters the parent at a size somebody agreed to. Neither is
 * about capability; both are about not letting a tree spend attention and
 * context without being asked.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { proposeSplitTool } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import type { InstanceId, Session, SessionBudget } from '@shared/types/index.js';

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

const proposal = (over: Record<string, unknown> = {}) => ({
  title: 'port the parser',
  scope: 'port the parser to the new AST',
  outOfScope: ['the CLI surface'],
  contract: { summaryMaxTokens: 500, artifacts: [] },
  tokenCeiling: 20_000,
  why: 'this session has compacted twice and the checklist is still growing',
  ...over,
});

const liveOf = (m: SessionManager, id: string): { session: Session } =>
  (m as unknown as { sessions: Map<string, { session: Session }> }).sessions.get(id)!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-prop-'));
  instanceId = (await openWorkspace(root)).instanceId;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('proposing', () => {
  it('creates nothing on its own', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await m.proposeSplit(session.sessionId, proposal());

    // §4.3: automatic splitting is off by default, because a decomposition
    // mistake made autonomously produces a tree that is harder to salvage than
    // one overlong session.
    expect(m.get(session.sessionId).children).toEqual([]);
    expect(m.get(session.sessionId).budget?.reservedForChildren).toBe(0);
  });

  it('asks, and keeps asking until answered', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    await m.proposeSplit(session.sessionId, proposal());

    expect(m.get(session.sessionId).needsAttention?.reason).toBe('split_proposed');

    // A pending proposal outlives the states underneath it: the session goes on
    // being `awaiting_input` between turns, and a question that disappeared the
    // moment anything else happened would never be answered.
    const agent = await m.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'meanwhile' }] });
    expect(m.get(session.sessionId).needsAttention?.reason).toBe('split_proposed');
  });

  it('surfaces from a child at the root', async () => {
    const m = manager();
    const rootSession = await m.createSession({ title: 'r', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(rootSession.sessionId, {
      title: 'child',
      scope: 'do the thing',
      outOfScope: ['everything else'],
      contract: { summaryMaxTokens: 500, artifacts: [] },
      tokenCeiling: 40_000,
    });

    await m.proposeSplit(child.sessionId, proposal({ tokenCeiling: 5_000 }));

    // A proposal three levels down is as easy to lose as a permission prompt.
    const at = liveOf(m, rootSession.sessionId).session.needsAttention;
    expect(at?.reason).toBe('split_proposed');
    expect(at?.from?.path).toEqual(['child']);
  });

  it('records what was suggested, whether or not it happened', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const p = await m.proposeSplit(session.sessionId, proposal());
    await m.respondSplit(session.sessionId, p.proposalId, { approved: false, reason: 'wrong seam' });

    const events = await m.events(session.sessionId);
    // A record of only the approved splits hides every decomposition the user
    // thought was wrong, which is the more interesting half when a session goes
    // badly.
    expect(events.some((e) => e.type === 'session.split_proposed')).toBe(true);
    expect(JSON.stringify(events)).toContain('wrong seam');
    expect(m.get(session.sessionId).children).toEqual([]);
  });
});

describe('approving', () => {
  it('spawns the child that was described', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const p = await m.proposeSplit(session.sessionId, proposal());

    const child = await m.respondSplit(session.sessionId, p.proposalId, { approved: true });

    expect(child?.title).toBe('port the parser');
    expect(m.get(session.sessionId).budget?.reservedForChildren).toBe(20_000);
    expect(m.get(session.sessionId).needsAttention?.reason).not.toBe('split_proposed');
  });

  it('does not leave the question hanging when the spawn is refused', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    // More than the parent has.
    const p = await m.proposeSplit(session.sessionId, proposal({ tokenCeiling: 500_000 }));

    await expect(m.respondSplit(session.sessionId, p.proposalId, { approved: true })).rejects.toThrow();

    // Cleared before the spawn is attempted: a proposal left pending after it
    // was answered asks the same question forever.
    expect(m.get(session.sessionId).needsAttention?.reason).not.toBe('split_proposed');
  });

  it('refuses to answer a proposal twice', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const p = await m.proposeSplit(session.sessionId, proposal());
    await m.respondSplit(session.sessionId, p.proposalId, { approved: false });

    await expect(
      m.respondSplit(session.sessionId, p.proposalId, { approved: true }),
    ).rejects.toThrow(/no pending split/);
  });
});

describe('the tool an agent calls', () => {
  it('asks rather than splitting', async () => {
    const proposed: unknown[] = [];
    const result = await proposeSplitTool.run(
      {
        title: 'port the parser',
        scope: 'port it',
        out_of_scope: ['the CLI'],
        why: 'compacted twice and still growing',
        token_ceiling: 20_000,
      },
      {
        workspaceRoot: '/tmp/ws',
        signal: new AbortController().signal,
        agentId: 'a' as never,
        leases: new WorkspaceLeases(),
        proposeSplit: (p) => proposed.push(p),
      },
    );

    expect(result.ok).toBe(true);
    expect(proposed).toHaveLength(1);
    // Nothing is created by calling it. §4.3 keeps approval with a person.
    expect(result.content).toMatch(/A person decides/);
  });

  it('refuses a proposal that cannot say what it leaves behind', async () => {
    const result = await proposeSplitTool.run(
      {
        title: 't',
        scope: 's',
        out_of_scope: [],
        why: 'w',
        token_ceiling: 1_000,
      },
      {
        workspaceRoot: '/tmp/ws',
        signal: new AbortController().signal,
        agentId: 'a' as never,
        leases: new WorkspaceLeases(),
        proposeSplit: () => undefined,
      },
    );

    // The field that stops a child re-deriving the parent's context. A proposal
    // that cannot name its exclusions has not thought about the seam.
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/out_of_scope/);
  });
});

describe('the result coming back', () => {
  async function withChild(m: SessionManager, summaryMaxTokens = 500) {
    const parent = await m.createSession({ title: 'p', goal: 'g', budget: BUDGET });
    const child = await m.spawnChild(parent.sessionId, {
      title: 'child',
      scope: 'do the thing',
      outOfScope: ['everything else'],
      contract: { summaryMaxTokens, artifacts: [] },
      tokenCeiling: 20_000,
    });
    return { parent, child };
  }

  it('lands a bounded summary on the parent, not on the child', async () => {
    const m = manager();
    const { parent, child } = await withChild(m);

    await m.reportResult(child.sessionId, { summary: 'renamed nine call sites; tests pass' });

    const parentEvents = await m.events(parent.sessionId);
    const result = parentEvents.find((e) => e.type === 'session.child_result');
    // It lands where it is for. The child's transcript already holds the detail.
    expect(JSON.stringify(result)).toContain('renamed nine call sites');
    expect(m.get(child.sessionId).state).toBe('done');
  });

  it('stores an oversized result and passes a pointer instead', async () => {
    const m = manager();
    const { parent, child } = await withChild(m, 50);
    const huge = 'x'.repeat(20_000);

    const outcome = await m.reportResult(child.sessionId, { summary: huge });

    // §4.3's failure mode, prevented: the child does not get to negotiate a
    // larger injection into its parent's context.
    expect(outcome.truncated).toBe(true);
    const result = (await m.events(parent.sessionId)).find((e) => e.type === 'session.child_result');
    expect(JSON.stringify(result).length).toBeLessThan(2_000);
    expect(JSON.stringify(result)).toContain('exceeds the agreed ceiling');
  });

  it('keeps the work rather than failing the child for being verbose', async () => {
    const m = manager();
    const { child } = await withChild(m, 50);

    await m.reportResult(child.sessionId, { summary: 'y'.repeat(20_000) });

    // Work done well and described at length should not be thrown away for the
    // length. `checkResult` returns a verdict rather than throwing for exactly
    // this reason.
    expect(m.get(child.sessionId).state).toBe('done');
    const events = await m.events(child.sessionId);
    expect(events.some((e) => e.type === 'artifact.created')).toBe(true);
  });

  it('refuses from a session with nobody to report to', async () => {
    const m = manager();
    const alone = await m.createSession({ title: 'root', goal: 'g', budget: BUDGET });
    await expect(m.reportResult(alone.sessionId, { summary: 'done' })).rejects.toThrow(/no parent/);
  });

  it('lets the parent settle once its child has reported', async () => {
    const m = manager();
    const { parent, child } = await withChild(m);

    const lead = await m.addAgent(parent.sessionId, { role: 'lead', runtimeId: 'echo' });
    await m.send(parent.sessionId, lead.agentId, { content: [{ type: 'text', text: 'go' }] });
    // Held, because a descendant is still live.
    expect(m.get(parent.sessionId).state).toBe('awaiting_children');

    await m.reportResult(child.sessionId, { summary: 'finished' });
    await m.send(parent.sessionId, lead.agentId, { content: [{ type: 'text', text: 'and now' }] });
    expect(m.get(parent.sessionId).state).toBe('awaiting_input');
  });
});
