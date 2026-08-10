/**
 * Scheduling against a shared allowance (DESIGN.md §8, §3.11, §15 Phase 4).
 *
 * > eight agents scheduled independently against a single seat allowance will
 * > burn the window in minutes.
 *
 * The claim under test is narrower than "throttling", and worth stating exactly:
 * parking already handles a spent window *after* it is hit, so what this adds is
 * that the first agent to learn the window is spent stops the other seven from
 * each sending a request to discover the same thing.
 *
 * Everything else here is about **not** throttling — a local model, a credential
 * nobody has complained about, a network blip. A scheduler that slows down
 * things it has no evidence against is a bug with a reassuring name.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupFor, QuotaScheduler } from '@main/quota.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentSpec, InstanceId, StopReason } from '@shared/types/index.js';

/** A clock and a sleep that the test drives, so nothing waits on real seconds. */
function rig(start = 1_000_000) {
  let at = start;
  const slept: number[] = [];
  const scheduler = new QuotaScheduler({
    now: () => at,
    sleep: async (ms) => {
      slept.push(ms);
      at += ms;
    },
  });
  return { scheduler, slept, advance: (ms: number) => (at += ms), at: () => at };
}

const OK: StopReason = { kind: 'end_turn' };

describe('which allowance an agent draws on', () => {
  it('groups agents sharing one vendor seat', () => {
    // §3.11's whole reason for the field: agents on one seat share a throttle.
    expect(groupFor({ kind: 'vendor-cli-session', cliId: 'claude-code', quotaGroup: 'team' })).toBe(
      'cli:claude-code:team',
    );
  });

  it('groups agents sharing one key by its endpoint', () => {
    // The key itself never leaves the module that holds it (§13), so the
    // endpoint id stands in for its identity.
    expect(groupFor({ kind: 'api-key', endpointId: 'openai' })).toBe('key:openai');
  });

  it('gives a local model no group at all', () => {
    // There is no shared credential, no window, and nothing to protect.
    // Throttling an Ollama on the same machine would be pure harm.
    expect(groupFor({ kind: 'none' })).toBeNull();
  });
});

describe('doing nothing, which is the default', () => {
  it('lets an ungrouped agent straight through', async () => {
    const r = rig();
    await r.scheduler.acquire(null);
    expect(r.slept).toEqual([]);
  });

  it('lets a credential nobody has complained about straight through', async () => {
    const r = rig();
    // §17's third open question: usage from the vendor's own app is invisible to
    // us, so a bucket sized from a guessed limit would be wrong quietly. There
    // is no throttle until a provider says there should be one.
    for (let i = 0; i < 10; i += 1) await r.scheduler.acquire('key:openai');
    expect(r.slept).toEqual([]);
  });

  it('does not treat a dropped connection as evidence about the allowance', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'transport' });
    r.scheduler.observe('key:openai', { kind: 'refused' });
    await r.scheduler.acquire('key:openai');
    // Throttling a credential for a network blip would be a slowdown with a
    // confident-sounding explanation and no cause.
    expect(r.slept).toEqual([]);
  });
});

describe('one agent learning for the whole group', () => {
  it('holds every agent until the window it was told about resets', async () => {
    const r = rig();
    r.scheduler.observe('cli:claude-code:seat', {
      kind: 'quota_exhausted',
      scope: 'window',
      resetsAt: new Date(r.at() + 60_000).toISOString(),
    });

    await r.scheduler.acquire('cli:claude-code:seat');

    // This is the entire point. Without it the next seven agents each send a
    // request whose only outcome is learning what this one already knows.
    expect(r.slept).toEqual([60_000]);
  });

  it('does not hold a window nobody put a time on', async () => {
    const r = rig();
    r.scheduler.observe('cli:claude-code:seat', { kind: 'quota_exhausted', scope: 'window' });
    await r.scheduler.acquire('cli:claude-code:seat');
    // Holding until a time nobody named would block the group forever. Those
    // sessions park and wait for a person instead — §4.1's answer to exactly
    // this, and the same rule the parked-session sweeper follows.
    expect(r.slept).toEqual([]);
  });

  it('re-checks the hold after waiting, rather than assuming it is over', async () => {
    const r = rig();
    const group = 'key:openai';
    const deadline = r.at() + 10_000;
    r.scheduler.observe(group, {
      kind: 'quota_exhausted',
      scope: 'window',
      resetsAt: new Date(deadline).toISOString(),
    });

    // One agent starts waiting; another's failure extends the hold while it
    // sleeps. The fake sleep advances the clock as it is entered, so by now the
    // first wait is already spent.
    const waiting = r.scheduler.acquire(group);
    const extended = r.at() + 25_000;
    r.scheduler.observe(group, {
      kind: 'quota_exhausted',
      scope: 'window',
      resetsAt: new Date(extended).toISOString(),
    });
    await waiting;

    // Two sleeps, not one: returning after the first would send precisely the
    // request the extended hold exists to prevent.
    expect(r.slept).toHaveLength(2);
    expect(r.at()).toBeGreaterThanOrEqual(extended);
  });

  it('reports that it is waiting, so a queued turn is not silence', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', {
      kind: 'quota_exhausted',
      scope: 'window',
      resetsAt: new Date(r.at() + 30_000).toISOString(),
    });

    const waits: number[] = [];
    await r.scheduler.acquire('key:openai', (ms) => waits.push(ms));
    // A session sitting in `working` with nothing to show is indistinguishable
    // from a hung one, and §10's stall detector would flag it.
    expect(waits).toEqual([30_000]);
  });
});

describe('learning a pace from what a provider said', () => {
  it('spaces requests out after a rate limit', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'rate_limited' });

    await r.scheduler.acquire('key:openai');
    await r.scheduler.acquire('key:openai');

    // The provider said the current pace is wrong but not what the right one
    // is, so it doubles from a small start rather than guessing a number.
    expect(r.slept).toEqual([1_000]);
  });

  it('honours a retry-after before anything else', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'rate_limited', retryAfterMs: 5_000 });
    await r.scheduler.acquire('key:openai');
    expect(r.slept).toEqual([5_000]);
  });

  it('does not drop straight back to unthrottled on one success', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'rate_limited' });
    r.scheduler.observe('key:openai', OK);

    await r.scheduler.acquire('key:openai');
    await r.scheduler.acquire('key:openai');
    // One success means the spacing worked, not that it was unnecessary.
    // Clearing here would rediscover the limit immediately.
    expect(r.slept).toEqual([1_000]);
  });

  it('decays back to unthrottled once requests keep succeeding', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'rate_limited' });
    for (let i = 0; i < 3; i += 1) r.scheduler.observe('key:openai', OK);

    await r.scheduler.acquire('key:openai');
    await r.scheduler.acquire('key:openai');
    // A throttle that only ever tightens would make one bad minute permanent.
    expect(r.slept).toEqual([]);
  });

  it('keeps groups apart', async () => {
    const r = rig();
    r.scheduler.observe('key:openai', { kind: 'rate_limited', retryAfterMs: 5_000 });
    await r.scheduler.acquire('key:anthropic');
    // Two credentials are two allowances. One being unhappy says nothing about
    // the other, and slowing both would be the conflation §8 warns about.
    expect(r.slept).toEqual([]);
  });
});

describe('two sessions on one credential', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-quota-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const KEY: AgentSpec['auth'] = { kind: 'api-key', endpointId: 'shared' };

  function manager(script: EchoStep[], quota: QuotaScheduler): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0, quota });
    managers.push(m);
    return m;
  }

  async function turn(m: SessionManager, auth: AgentSpec['auth'], text: string): Promise<void> {
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo', auth });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text }] });
  }

  it('stops the second one sending once the first learns the window is spent', async () => {
    const r = rig();
    const spent: EchoStep[] = [
      {
        kind: 'stop',
        stop: {
          kind: 'quota_exhausted',
          scope: 'window',
          resetsAt: new Date(r.at() + 3_600_000).toISOString(),
        },
      },
    ];
    const m = manager(spent, r.scheduler);

    await turn(m, KEY, 'first');
    expect(r.slept).toEqual([]);

    // The second agent shares the credential, so it inherits what the first
    // one found out. Without this it sends its own request whose only outcome
    // is learning the same thing — which at eight agents is eight wasted calls
    // against an allowance that is already gone.
    await turn(m, KEY, 'second');
    expect(r.slept).toEqual([3_600_000]);
  });

  it('lets a local agent through while a shared credential is held', async () => {
    const r = rig();
    const m = manager(
      [
        {
          kind: 'stop',
          stop: {
            kind: 'quota_exhausted',
            scope: 'window',
            resetsAt: new Date(r.at() + 3_600_000).toISOString(),
          },
        },
      ],
      r.scheduler,
    );

    await turn(m, KEY, 'burns the window');

    await turn(m, { kind: 'none' }, 'a model on this machine');
    // A local model draws on nobody's allowance. Making it wait for someone
    // else's spent subscription would be a pure loss.
    expect(r.slept).toEqual([]);

    // And the hold is real, not merely unapplied: the next agent on the shared
    // credential does wait.
    await turn(m, KEY, 'shares the credential');
    expect(r.slept).toEqual([3_600_000]);
  });

  it('does not call a session queued on quota stalled', async () => {
    /**
     * Two features that look identical from outside: a session waiting for a
     * shared credential and a session whose agent has hung both sit in
     * `working` emitting nothing. Flagging the first would fire the warning on
     * something working exactly as designed, which is how a warning stops being
     * read (§10).
     */
    const r = rig();
    const m = manager([{ kind: 'stop', stop: { kind: 'end_turn' } }], r.scheduler);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo', auth: KEY });

    const live = (m as unknown as { sessions: Map<string, { waitingOnQuota: Set<string> }> }).sessions;
    (live.get(session.sessionId) as { waitingOnQuota: Set<string> }).waitingOnQuota.add(agent.agentId);
    (m as unknown as { sessions: Map<string, { session: { state: string }; lastEventAt: number }> })
      .sessions.get(session.sessionId)!.session.state = 'working';

    const sweeper = m as unknown as { sweepStalled: () => void; deps: { stallAfterMs?: number } };
    sweeper.deps.stallAfterMs = 1;
    await new Promise((res) => setTimeout(res, 5));
    sweeper.sweepStalled();

    expect((await m.get(session.sessionId)).needsAttention).toBeNull();
  });
});

describe('what it will tell you about itself', () => {
  it('reports the groups it is holding, and the ones it is not', () => {
    const r = rig();
    r.scheduler.observe('key:openai', {
      kind: 'quota_exhausted',
      scope: 'window',
      resetsAt: new Date(r.at() + 60_000).toISOString(),
    });
    r.scheduler.observe('key:local', OK);

    const status = r.scheduler.status();
    expect(status.find((s) => s.group === 'key:openai')?.heldUntil).not.toBeNull();
    expect(status.find((s) => s.group === 'key:local')?.heldUntil).toBeNull();
  });
});
