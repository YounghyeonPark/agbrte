/**
 * Splitting without asking, within a grant made in advance (§17 Q8, §4.3).
 *
 * §4.3 keeps splits user-approved because "a decomposition mistake made at 3am
 * is expensive". True — but the expense is in **not being able to see it**, and
 * requiring approval at 3am does not prevent the mistake, it prevents the run.
 * A long overnight session stalls at exactly the moment it most needs to
 * decompose, and stalls until morning.
 *
 * So the grant is made when the person is present, and it is a **budget rather
 * than a mode**. What these assert is that it behaves like one: it is spent, it
 * leaves the same transcript a manual approval does, and the only thing it
 * removes is the stall.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
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

const proposal = (over: Record<string, unknown> = {}) => ({
  title: 'port the parser',
  scope: 'port the parser to the new AST',
  outOfScope: ['the CLI surface'],
  contract: { summaryMaxTokens: 500, artifacts: [] },
  tokenCeiling: 10_000,
  why: 'compacted twice and the checklist is still growing',
  ...over,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-grant-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('without a grant, nothing changes', () => {
  it('still asks, which is §4.3’s default', async () => {
    const m = manager();
    const parent = await m.createSession({ title: 'overnight', goal: 'g', budget: { ...BUDGET } });
    await m.proposeSplit(parent.sessionId as SessionId, proposal());

    const after = await m.get(parent.sessionId as SessionId);
    expect(after.pendingSplits).toHaveLength(1);
    expect(after.needsAttention?.reason).toBe('split_proposed');
    expect(after.children).toHaveLength(0);
  }, 30_000);
});

describe('a grant is spent, not switched on', () => {
  it('approves within it and stops when it runs out', async () => {
    const m = manager();
    const parent = await m.createSession({
      title: 'overnight',
      goal: 'g',
      budget: { ...BUDGET },
      splitGrant: { count: 2, maxDepth: 2 },
    });
    const id = parent.sessionId as SessionId;
    expect((await m.get(id)).splitGrant).toEqual({ remaining: 2, granted: 2, maxDepth: 2 });

    await m.proposeSplit(id, proposal({ title: 'first' }));
    expect((await m.get(id)).splitGrant?.remaining).toBe(1);
    expect((await m.get(id)).children).toHaveLength(1);
    // The stall is what was removed, and the only thing that was.
    expect((await m.get(id)).needsAttention).toBeNull();
    expect((await m.get(id)).pendingSplits).toHaveLength(0);

    await m.proposeSplit(id, proposal({ title: 'second' }));
    expect((await m.get(id)).splitGrant?.remaining).toBe(0);
    expect((await m.get(id)).children).toHaveLength(2);

    // Spent. The third asks, like every split does by default.
    await m.proposeSplit(id, proposal({ title: 'third' }));
    const exhausted = await m.get(id);
    expect(exhausted.children, 'a spent grant kept spawning').toHaveLength(2);
    expect(exhausted.pendingSplits).toHaveLength(1);
    expect(exhausted.needsAttention?.reason).toBe('split_proposed');
    // "2 of 2 used" is renderable, which a mode could never be.
    expect(exhausted.splitGrant).toEqual({ remaining: 0, granted: 2, maxDepth: 2 });
  }, 60_000);

  it('leaves the transcript a manual approval would have left', async () => {
    /**
     * The property that makes this reviewable in the morning rather than
     * invisible. §4.3 logs a proposal when *proposed* rather than when approved,
     * "so the transcript shows what was suggested and declined as well as what
     * happened" — and an automatic path that skipped straight to spawning would
     * produce a child with no record of what was suggested.
     */
    const m = manager();
    const parent = await m.createSession({
      title: 'overnight',
      goal: 'g',
      budget: { ...BUDGET },
      splitGrant: { count: 1, maxDepth: 2 },
    });
    const id = parent.sessionId as SessionId;
    await m.proposeSplit(id, proposal());

    const types = (await m.events(id)).map((e) => e.type);
    expect(types).toContain('session.split_proposed');
    expect(types).toContain('session.split_decided');
    expect(types.indexOf('session.split_proposed')).toBeLessThan(
      types.indexOf('session.split_decided'),
    );
  }, 30_000);

  it('says the grant approved it, not the user', async () => {
    /**
     * §5.1's rule is that an actor records what established it, and therefore
     * what it is worth. Attributing this to the person who created the session
     * would be true in spirit and would leave the transcript unable to answer
     * "did I approve this one".
     */
    const m = manager();
    const parent = await m.createSession({
      title: 'overnight',
      goal: 'g',
      budget: { ...BUDGET },
      splitGrant: { count: 1, maxDepth: 2 },
    });
    const id = parent.sessionId as SessionId;
    await m.proposeSplit(id, proposal());

    const decided = (await m.events(id)).find((e) => e.type === 'session.split_decided');
    expect(JSON.stringify(decided)).toContain('split-grant');
  }, 30_000);
});

describe('the grant has its own depth, shallower than the ceiling', () => {
  it('asks once a split would go deeper than the person agreed to', async () => {
    /**
     * §4.3's `maxDepth` is the hard ceiling for any split at all. The grant's is
     * how deep somebody was willing to be *absent* for, which is normally
     * shallower — and reaching it means the next split asks, which is the grant
     * working rather than failing.
     */
    const m = manager();
    const parent = await m.createSession({
      title: 'overnight',
      goal: 'g',
      budget: { ...BUDGET },
      splitGrant: { count: 5, maxDepth: 1 },
    });
    const id = parent.sessionId as SessionId;

    // depth 0 → 1: within the grant.
    await m.proposeSplit(id, proposal({ title: 'child' }));
    const afterFirst = await m.get(id);
    expect(afterFirst.children).toHaveLength(1);
    expect(afterFirst.splitGrant?.remaining).toBe(4);

    // The child is at depth 1; its own split would land at 2, past the grant.
    const childId = afterFirst.children[0]!.sessionId as SessionId;
    const child = await m.get(childId);
    expect(child.tree.depth).toBe(1);
    // A child does not inherit the grant: being allowed to decompose is not the
    // same as being allowed to hand that permission down.
    expect(child.splitGrant).toBeUndefined();

    await m.proposeSplit(childId, proposal({ title: 'grandchild', tokenCeiling: 1_000 }));
    const afterSecond = await m.get(childId);
    expect(afterSecond.children).toHaveLength(0);
    expect(afterSecond.needsAttention?.reason).toBe('split_proposed');
  }, 60_000);

  it('is absent by default, so a plain session is unchanged', async () => {
    const m = manager();
    const plain = await m.createSession({ title: 't', goal: 'g' });
    expect(plain.splitGrant).toBeUndefined();
    // A grant of zero is the same as none: a count nobody can spend is a field
    // that only exists to be misread.
    const zero = await m.createSession({
      title: 't',
      goal: 'g',
      splitGrant: { count: 0, maxDepth: 3 },
    });
    expect(zero.splitGrant).toBeUndefined();
  }, 30_000);
});
