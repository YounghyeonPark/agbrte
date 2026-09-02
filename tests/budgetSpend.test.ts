/**
 * A ceiling that bounds what a session spends (DESIGN.md §6.5, §4.1, §4.3).
 *
 * §6.5 hands this to a **ModelGateway**, together with a reverse tunnel and
 * credential injection, and §15 records that the gateway is deliberately not
 * built — adding that it was worth checking against the deployment first, since
 * "if the server is what has model access there is nothing to tunnel". That
 * check comes out plainly here: this project uses no API key, so four of the
 * gateway's five jobs have nothing to do. Routing by `providerId` already
 * exists, usage is already recorded, and there is no secret to keep off a remote
 * box.
 *
 * What was missing is the fifth: **nothing compared the two.** `spent` was
 * always zero — no code anywhere incremented it — so `availableTokens` reduced
 * to `ceiling - reservedForChildren`, and a session's budget bounded only what
 * it could hand to children. A ceiling that cannot be reached by working is not
 * a ceiling, and `docs/status.md` had to say so in as many words.
 *
 * These tests are the two halves of closing that: the counter becomes real, and
 * something reads it before spending more.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { reduceEvents } from '@main/store/reduce.js';
import type {
  AgbrteEvent,
  InstanceId,
  SessionBudget,
  SessionId,
  StopReason,
} from '@shared/types/index.js';

const NOW = '2026-09-02T00:00:00.000Z';

let root: string;
let instanceId: InstanceId;
const managers: SessionManager[] = [];

/** Each turn reports a fixed, known spend, so the arithmetic is checkable. */
function manager(inputTokens = 100, outputTokens = 50): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(
    new EchoRuntime({
      script: [
        { kind: 'text', text: 'ok' },
        { kind: 'usage', inputTokens, outputTokens },
        { kind: 'stop', stop: { kind: 'end_turn' } },
      ],
    }),
    { label: 'Echo', model: 'none' },
  );
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

const budget = (tokenCeiling: number): SessionBudget => ({
  tokenCeiling,
  spent: 0,
  reservedForChildren: 0,
});

const TEXT = { content: [{ type: 'text' as const, text: 'go' }] };

/**
 * Every ceiling stop this session recorded.
 *
 * The state is not the thing to assert on, which cost three tests to learn:
 * `awaiting_input` is also where an ordinary finished turn lands, and a session
 * holding a child sits in `awaiting_children` whatever else is true. Both were
 * green against a manager that enforced nothing. The stop reason is the fact
 * that distinguishes them, and it is on the log.
 */
async function limitStops(m: SessionManager, sessionId: SessionId): Promise<StopReason[]> {
  return (await m.events(sessionId))
    .filter((e) => e.type === 'agent.stopped')
    .map((e) => ('stop' in e ? e.stop : null))
    .filter((s): s is StopReason => s !== null && s.kind === 'limit_reached');
}

async function seat(m: SessionManager, over: { budget?: SessionBudget } = {}) {
  const session = await m.createSession({
    title: 's',
    goal: 'g',
    ...(over.budget !== undefined ? { budget: over.budget } : {}),
  });
  const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  return { sessionId: session.sessionId, agentId: agent.agentId };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-spend-'));
  instanceId = (await openWorkspace(root)).instanceId;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('spent, which used to be a constant zero', () => {
  it('counts what a turn actually used', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(10_000) });

    await m.send(sessionId, agentId, TEXT);

    expect(m.get(sessionId).budget?.spent).toBe(150);
  });

  it('accumulates across turns', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(10_000) });

    await m.send(sessionId, agentId, TEXT);
    await m.send(sessionId, agentId, TEXT);

    expect(m.get(sessionId).budget?.spent).toBe(300);
  });

  it('survives a restart, because the log is where it comes from', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(10_000) });
    await m.send(sessionId, agentId, TEXT);
    m.dispose();

    /*
     * The in-memory counter and the fold have to agree. A session that enforces
     * one ceiling before a restart and another after is the drift §5.1 keeps the
     * log authoritative to avoid — and the fold is the half a restarted host
     * reads, so a figure that lived only in memory would reset every restart and
     * a long-running session would never reach its ceiling at all.
     */
    const after = manager(100, 50);
    const back = await after.resumeSession(sessionId);
    expect(back.budget?.spent).toBe(150);
  });

  it('leaves an unbudgeted session alone', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m);
    await m.send(sessionId, agentId, TEXT);
    // Absent means unbudgeted (§4.3), and counting into a budget that does not
    // exist would be inventing one.
    expect(m.get(sessionId).budget).toBeUndefined();
  });

  it('does not charge cache tokens on top of the prompt they describe', () => {
    /*
     * At the fold, because no runtime here reports a cache split — the echo
     * runtime's `usage` step has no cache fields, so driving a turn proves
     * nothing. The first version of this test did exactly that and asserted
     * `150 !== 150 + 0`, which is green against any implementation.
     *
     * The rule: cache fields are a *breakdown* of the input side — tokens served
     * from a cache or written to one are still the prompt — so adding them would
     * charge a cached turn twice and make a ceiling arbitrarily stricter for
     * callers whose provider happens to report the detail. They are priced
     * differently, which is why `usage` keeps them apart; a token count is not
     * a price.
     */
    const projection = reduceEvents('s1' as SessionId, [
      { seq: 1, at: NOW, type: 'session.created', goal: 'g', title: 's', budget: budget(10_000) },
      {
        seq: 2,
        at: NOW,
        type: 'usage',
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 900,
        cacheWriteTokens: 400,
      },
    ] as unknown as AgbrteEvent[]);

    expect(projection.budget?.spent).toBe(150);
    // The detail is still recorded — it is priced separately and the UI shows it.
    expect(projection.usage.cacheReadTokens).toBe(900);
    expect(projection.usage.cacheWriteTokens).toBe(400);
  });
});

describe('and something reads it before spending more', () => {
  it('parks rather than starting a turn it cannot pay for', async () => {
    // A ceiling one turn wide: the first turn fits, the second has nothing left.
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(150) });

    await m.send(sessionId, agentId, TEXT);
    expect(m.get(sessionId).budget?.spent).toBe(150);

    await m.send(sessionId, agentId, TEXT);

    /*
     * Checked *before* the request, because after it the tokens are gone — the
     * same argument §4.3 makes about reserving a child's ceiling at spawn, and
     * it applies more directly here where the thing bounded is the spend.
     */
    expect(m.get(sessionId).budget?.spent).toBe(150);
  });

  it('pauses for a person rather than failing, because nothing is broken', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(150) });
    await m.send(sessionId, agentId, TEXT);
    await m.send(sessionId, agentId, TEXT);

    /*
     * §4.1: a ceiling *we* configured is not a breakage. The work is incomplete
     * and nothing is wrong, and what happens next — raise it, re-scope, split,
     * or accept the work — is a human decision, which is what `awaiting_input`
     * means.
     *
     * Not `awaiting_quota`, whose contract is "resume at `resetsAt`". A ceiling
     * the user set has no window to reset, and parking there would leave a
     * session waiting forever for a reset time that does not exist. That
     * distinction is the reason `limit_reached` was split from
     * `quota_exhausted`, and this is its first producer inside the app rather
     * than from an adapter.
     *
     * The state is checked *with* the stop reason and not instead of it: an
     * ordinary finished turn also lands in `awaiting_input`, so the state alone
     * is green against a manager that enforces nothing.
     */
    expect(await limitStops(m, sessionId)).toHaveLength(1);
    expect(m.get(sessionId).state).toBe('awaiting_input');
  });

  it('says how much of what, since the remedy is a decision about size', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(150) });
    await m.send(sessionId, agentId, TEXT);
    await m.send(sessionId, agentId, TEXT);

    const stopped = (await m.events(sessionId)).filter((e) => e.type === 'agent.stopped');
    const last = stopped.at(-1);
    expect(last && 'stop' in last ? last.stop : null).toMatchObject({
      kind: 'limit_reached',
      limit: 'tokens',
    });
    // "token limit reached" alone leaves somebody to go and find out how much of
    // what, and the answer is what they need to decide the next number.
    const detail = last && 'stop' in last && last.stop.kind === 'limit_reached' ? last.stop.detail : '';
    expect(detail).toContain('150');
  });

  it('counts what children hold, not only what this session used', async () => {
    /*
     * `availableTokens` subtracts both, and it always did — what changed is that
     * only one of the two was ever non-zero. A parent that reserved most of its
     * ceiling for children and then kept working could previously spend the
     * whole ceiling again on itself.
     */
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m, { budget: budget(20_000) });
    await m.spawnChild(sessionId, {
      title: 'child',
      scope: 'a narrow part',
      outOfScope: ['everything else'],
      contract: { summaryMaxTokens: 500, artifacts: [] },
      tokenCeiling: 20_000,
    });

    await m.send(sessionId, agentId, TEXT);

    // The whole ceiling is reserved, so there is nothing left to run a turn on.
    // Asserted on the stop rather than the state, because a session holding a
    // child sits in `awaiting_children` whatever else is true of it.
    expect(m.get(sessionId).budget?.spent).toBe(0);
    expect(await limitStops(m, sessionId)).toHaveLength(1);
  });

  it('lets an unbudgeted session run without limit, as it always could', async () => {
    const m = manager(100, 50);
    const { sessionId, agentId } = await seat(m);
    await m.send(sessionId, agentId, TEXT);
    await m.send(sessionId, agentId, TEXT);
    // No ceiling means nothing to be over. §4.3 keeps absent distinct from zero
    // precisely so this stays true — and the absence of a limit stop is the way
    // to say it, since a finished turn parks in `awaiting_input` regardless.
    expect(await limitStops(m, sessionId)).toEqual([]);
  });
});
