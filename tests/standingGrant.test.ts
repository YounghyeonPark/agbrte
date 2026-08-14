/**
 * Running without asking, within a grant made in advance (§17 Q19, §13).
 *
 * Answering every prompt is the point until it is the obstacle: a long
 * unattended run stops at the first `bash`, which is §13 working and also the
 * reason people reach for a global "don't ask me". The grant is the shape
 * §17 Q8 arrived at for auto-splitting — **per session, never a setting** —
 * and what these assert is the same property set: it is granted when the
 * person is present, it leaves a complete audit trail, and the only thing it
 * removes is the question.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { Actor, InstanceId, PermissionRequest, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
const managers: SessionManager[] = [];

/** `bash` falls through to `defaultAction: 'ask'` — the §13 default. */
const bashTool: EchoStep[] = [
  { kind: 'tool', tool: 'bash', args: { command: 'npm test' } },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const ALICE: Actor = { id: 'uid:1000', via: 'peer-credential', label: 'Alice' };

function manager(script: EchoStep[] = bashTool): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-standing-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('without a grant, nothing changes', () => {
  it('still parks on the first ask, which is §13 working', async () => {
    const m = manager();
    const session = await m.createSession({ title: 'plain', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const asked = new Promise<PermissionRequest>((resolve) => m.once('permission', resolve));
    const turn = m.send(session.sessionId, agent.agentId, TEXT('go'));
    const request = await asked;

    expect(m.get(session.sessionId).state).toBe('awaiting_permission');
    await m.respondPermission(request.requestId, { result: 'deny', reason: 'not tonight' });
    await turn;
  }, 30_000);

  it('is absent by default, and false is stored as no grant at all', async () => {
    // Like a splitGrant of zero: a field nobody can act on only exists to be
    // misread.
    const m = manager();
    const plain = await m.createSession({ title: 't', goal: 'g' });
    expect(plain.standingGrant).toBeUndefined();

    const declined = await m.createSession({ title: 't', goal: 'g', standingGrant: false });
    expect(declined.standingGrant).toBeUndefined();
    const types = (await m.events(declined.sessionId)).map((e) => e.type);
    expect(types).not.toContain('permission.standing_grant');
  }, 30_000);
});

describe('the grant removes the question, not the account of it', () => {
  it('settles an ask without a prompt and still writes permission.decided', async () => {
    const m = manager();
    const session = await m.createSession(
      { title: 'overnight', goal: 'g', standingGrant: true },
      ALICE,
    );

    let prompted = false;
    m.on('permission', () => {
      prompted = true;
    });

    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    // The stall is what was removed, and the only thing that was.
    expect(prompted).toBe(false);
    expect(m.pendingPermissions()).toHaveLength(0);
    expect(m.get(session.sessionId).state).toBe('awaiting_input');

    const events = await m.events(session.sessionId);
    const decided = events.find((e) => e.type === 'permission.decided');
    expect(decided).toBeDefined();
    if (decided?.type !== 'permission.decided') throw new Error('unreachable');
    expect(decided.via).toBe('standing-grant');
    expect(decided.decision).toEqual({ result: 'allow', scope: 'once' });
    // §5.1: the decision is the grant's, not the person's. An envelope that
    // credited Alice could not answer "did I approve this one".
    expect(decided.actor).toBeUndefined();

    // No human was reached, so nothing was `requested` — same as a
    // policy-settled call, and for the same reason.
    expect(events.map((e) => e.type)).not.toContain('permission.requested');
  }, 30_000);

  it('records the grant itself as an event, saying when and by whom', async () => {
    const m = manager();
    const session = await m.createSession(
      { title: 'overnight', goal: 'g', standingGrant: true },
      ALICE,
    );

    expect(session.standingGrant?.grantedBy).toEqual(ALICE);

    const events = await m.events(session.sessionId);
    const grant = events.find((e) => e.type === 'permission.standing_grant');
    if (grant?.type !== 'permission.standing_grant') throw new Error('no grant event');
    expect(grant.actor).toEqual(ALICE);
    // The grant carries the policy it was granted beside: the session's
    // effective policy is not otherwise durable, and a grant restored without
    // it would be the permissive half of the decision surviving alone.
    expect(grant.policy.defaultAction).toBe('ask');
    expect(grant.policy.rules.length).toBeGreaterThan(0);

    // The gate was relaxed *before* anything it settled: the transcript reads
    // in the order the authority was established.
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));
    const types = (await m.events(session.sessionId)).map((e) => e.type);
    expect(types.indexOf('permission.standing_grant')).toBeLessThan(
      types.indexOf('permission.decided'),
    );
  }, 30_000);

  it('does not touch a policy deny — a refusal is not a question', async () => {
    const m = manager();
    const session = await m.createSession(
      {
        title: 'overnight',
        goal: 'g',
        standingGrant: true,
        policy: { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
      },
      ALICE,
    );
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    const events = await m.events(session.sessionId);
    const decided = events.find((e) => e.type === 'permission.decided');
    if (decided?.type !== 'permission.decided') throw new Error('no decision logged');
    expect(decided.via).toBe('policy');
    expect(decided.decision.result).toBe('deny');
    expect((await m.projection(session.sessionId)).stats.toolErrors).toBe(1);
  }, 30_000);

  it('does not touch the escalation guard either', async () => {
    // §13: deny, non-overridable — by any policy scope, and by this grant.
    const m = manager([
      { kind: 'tool', tool: 'bash', args: { command: 'sudo rm -rf /' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const session = await m.createSession(
      { title: 'overnight', goal: 'g', standingGrant: true },
      ALICE,
    );
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    const decided = (await m.events(session.sessionId)).find(
      (e) => e.type === 'permission.decided',
    );
    if (decided?.type !== 'permission.decided') throw new Error('no decision logged');
    expect(decided.via).toBe('escalation-guard');
    expect(decided.decision.result).toBe('deny');
  }, 30_000);
});

describe('the grant does not descend', () => {
  it('leaves a child asking again, like any new session', async () => {
    /**
     * A child session is its own session (§4.3). Inheriting would make one
     * decision at the root silently govern work the person granting it had
     * not seen.
     */
    const m = manager();
    const parent = await m.createSession(
      {
        title: 'overnight',
        goal: 'g',
        standingGrant: true,
        budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
      },
      ALICE,
    );

    const child = await m.spawnChild(parent.sessionId, {
      title: 'child',
      scope: 'do the narrow thing',
      outOfScope: ['everything else'],
      contract: { summaryMaxTokens: 500, artifacts: [] },
      tokenCeiling: 10_000,
    });

    expect(child.standingGrant).toBeUndefined();

    // Not only the field: the child's gate actually asks.
    const agent = await m.addAgent(child.sessionId, { role: 'worker', runtimeId: 'echo' });
    const asked = new Promise<PermissionRequest>((resolve) => m.once('permission', resolve));
    const turn = m.send(child.sessionId, agent.agentId, TEXT('go'));
    const request = await asked;

    expect(m.get(child.sessionId).state).toBe('awaiting_permission');
    await m.respondPermission(request.requestId, { result: 'deny', reason: 'ask your parent' });
    await turn;
  }, 60_000);
});

describe('the grant survives a restart, because the session does', () => {
  it('is restored from the log and keeps settling asks', async () => {
    // The person said yes once, for this session, and a restart is still this
    // session. Losing the grant here would re-arm the gate mid-run — the
    // overnight stall it exists to remove, brought back by a host restart.
    const first = manager();
    const created = await first.createSession(
      { title: 'overnight', goal: 'g', standingGrant: true },
      ALICE,
    );
    const sessionId = created.sessionId as SessionId;
    await first.addAgent(sessionId, { role: 'worker', runtimeId: 'echo' });

    // The restart: nothing in-memory carries over.
    const second = manager();
    const resumed = await second.resumeSession(sessionId);

    expect(resumed.standingGrant?.grantedBy).toEqual(ALICE);
    expect(resumed.standingGrant?.grantedAt).toBeTruthy();

    let prompted = false;
    second.on('permission', () => {
      prompted = true;
    });
    const agentId = resumed.agents[0]!.agentId;
    await second.send(sessionId, agentId, TEXT('go again'));

    expect(prompted).toBe(false);
    const decided = (await second.events(sessionId)).filter(
      (e) => e.type === 'permission.decided',
    );
    expect(decided.length).toBeGreaterThan(0);
    expect(decided.every((e) => e.type === 'permission.decided' && e.via === 'standing-grant')).toBe(
      true,
    );
  }, 60_000);

  it('restores the pair — the rules the gate was relaxed beside, not the defaults', async () => {
    /**
     * The session's effective policy is not otherwise durable, and losing it
     * used to be fail-closed: a `deny` degraded to `ask` and a person got
     * asked. A restored grant answers asks unattended, so restoring the grant
     * onto rebuilt defaults would convert every lost refusal into a silent
     * yes. The grant event carries the policy so the two survive together.
     */
    const script: EchoStep[] = [
      { kind: 'tool', tool: 'bash', args: { command: 'npm test' } },
      { kind: 'tool', tool: 'web_fetch', args: { url: 'https://example.test/' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ];
    const first = manager(script);
    const created = await first.createSession(
      {
        title: 'overnight',
        goal: 'g',
        standingGrant: true,
        // The person tightened bash on purpose; everything else falls to ask.
        policy: { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
      },
      ALICE,
    );
    const sessionId = created.sessionId as SessionId;
    await first.addAgent(sessionId, { role: 'worker', runtimeId: 'echo' });

    const second = manager(script);
    const resumed = await second.resumeSession(sessionId);

    let prompted = false;
    second.on('permission', () => {
      prompted = true;
    });
    await second.send(sessionId, resumed.agents[0]!.agentId, TEXT('go'));

    expect(prompted).toBe(false);
    const decided = (await second.events(sessionId)).filter(
      (e) => e.type === 'permission.decided',
    );
    // The refusal survived the restart as a refusal…
    const bash = decided.find((e) => e.type === 'permission.decided' && e.tool === 'bash');
    if (bash?.type !== 'permission.decided') throw new Error('bash decision missing');
    expect(bash.via).toBe('policy');
    expect(bash.decision.result).toBe('deny');
    // …and the question was still settled by the grant, not by a person.
    const fetch = decided.find((e) => e.type === 'permission.decided' && e.tool === 'web_fetch');
    if (fetch?.type !== 'permission.decided') throw new Error('web_fetch decision missing');
    expect(fetch.via).toBe('standing-grant');
    expect(fetch.decision.result).toBe('allow');
  }, 60_000);

  it('survives via a checkpoint too, not only a full replay', async () => {
    // Checkpoints are interval-driven, so the other restart tests exercise
    // full replay. This one pins the v3 checkpoint path: a checkpoint cut
    // after the grant must carry it, or resuming from one would silently
    // re-arm the gate that the log says was relaxed.
    const first = manager();
    const created = await first.createSession(
      { title: 'overnight', goal: 'g', standingGrant: true },
      ALICE,
    );
    const sessionId = created.sessionId as SessionId;
    await first.addAgent(sessionId, { role: 'worker', runtimeId: 'echo' });
    await (
      first as unknown as {
        sessions: Map<string, { store: { checkpoint(): Promise<unknown> } }>;
      }
    ).sessions
      .get(sessionId)!
      .store.checkpoint();

    const second = manager();
    const resumed = await second.resumeSession(sessionId);
    expect(resumed.standingGrant?.grantedBy).toEqual(ALICE);

    let prompted = false;
    second.on('permission', () => {
      prompted = true;
    });
    await second.send(sessionId, resumed.agents[0]!.agentId, TEXT('go'));
    expect(prompted).toBe(false);
  }, 60_000);
});
