/**
 * Sessions in a group, messaging each other (DESIGN.md §4.2, §4.3, §13, §17 Q22).
 *
 * The feature is one sentence — *a session that needs help can ask a sibling* —
 * and every interesting thing about it is a bound. So this file is mostly bounds:
 *
 *  - the hop ceiling **travels across the session boundary**, because a ceiling
 *    that reset there would make "put them in a group and ping-pong" the
 *    documented way around it;
 *  - a message carries words and never authority, so a recipient's `deny` stands
 *    against a sender holding a standing grant (§13);
 *  - what a message may carry is capped and refused above the cap, because free
 *    chat between sessions reintroduces the context explosion §4.3's briefs and
 *    result contracts exist to prevent;
 *  - the exchange is in **both** logs, one recording the attempt and one the
 *    arrival, which is §4.3's parent/child rule in its second application;
 *  - and a group does not span machines, refused by name rather than half-made.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './support/until.js';
import { AttachRefused, Fleet, type FleetRuntime } from '@main/fleet.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { messagePeerTool, type ToolContext } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import {
  PEER_MESSAGE_MAX_CHARS,
  type AgentId,
  type InstanceId,
  type OutboundPeerMessage,
  type PeerDelivery,
  type PeerMessage,
  type SessionId,
} from '@shared/types/index.js';

// ------------------------------------------------------------------- the tool

function toolCtx(
  over: Partial<ToolContext> = {},
  answer: PeerDelivery = { accepted: true },
): ToolContext & { sent: OutboundPeerMessage[] } {
  const sent: OutboundPeerMessage[] = [];
  return {
    sent,
    workspaceRoot: '/tmp/ws',
    signal: new AbortController().signal,
    agentId: 'lead' as AgentId,
    leases: new WorkspaceLeases(),
    sendPeerMessage: async (m: OutboundPeerMessage) => {
      sent.push(m);
      return answer;
    },
    groupPeers: [{ sessionId: 'sess-b', title: 'the API work' }],
    ...over,
  } as ToolContext & { sent: OutboundPeerMessage[] };
}

describe('the message_peer tool', () => {
  it('sends short text to a session in the group', async () => {
    const ctx = toolCtx();
    const result = await messagePeerTool.run(
      { to: 'sess-b', kind: 'question', text: 'does your schema still have `user_id`?' },
      ctx,
    );

    expect(result.ok).toBe(true);
    // Exactly three fields. `fromSessionId`, `fromAgentId` and `hops` are the
    // owner's to stamp: an adapter that could name its own sender could forge
    // attribution, and one that could set `hops` could reset the ceiling.
    expect(Object.keys(ctx.sent[0] ?? {}).sort()).toEqual(['kind', 'text', 'toSessionId']);
    // Returns on the postmark, never on the reply (§4.2: sending never waits).
    expect(result.content).toMatch(/carry on with yours/);
  });

  it('says there is no group rather than pretending to send', async () => {
    const { sendPeerMessage, ...rest } = toolCtx();
    void sendPeerMessage;
    const result = await messagePeerTool.run(
      { to: 'sess-b', kind: 'task', text: 'x' },
      rest as ToolContext,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not in a group/);
  });

  it('refuses an address outside the group, and says who is in it', async () => {
    const ctx = toolCtx();
    const result = await messagePeerTool.run({ to: 'stranger', kind: 'task', text: 'x' }, ctx);
    // Refused rather than dropped, like `message`'s unknown agent: a message to
    // an id nobody holds would look sent, and the sender would wait forever.
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('the API work');
    expect(ctx.sent).toEqual([]);
  });

  it('refuses an oversized message instead of truncating it, and names the cap', async () => {
    const ctx = toolCtx();
    const result = await messagePeerTool.run(
      { to: 'sess-b', kind: 'report', text: 'x'.repeat(PEER_MESSAGE_MAX_CHARS + 1) },
      ctx,
    );
    // §4.3 keeps context narrow with briefs in and summaries out, both by
    // reference. A chat channel that could carry anything reintroduces the
    // explosion sideways — so the answer is an artifact and a pointer, and the
    // sender is told while it still has the context to shorten.
    expect(result.ok).toBe(false);
    expect(result.summary).toContain(String(PEER_MESSAGE_MAX_CHARS));
    expect(result.summary).toMatch(/artifact/);
    expect(ctx.sent).toEqual([]);
  });

  it('passes the owner’s refusal through to the model verbatim', async () => {
    const ctx = toolCtx({}, { accepted: false, reason: 'that session is done — it is finished' });
    const result = await messagePeerTool.run({ to: 'sess-b', kind: 'task', text: 'x' }, ctx);
    // The owner knows things the tool cannot: whether the target has finished,
    // whether the exchange is past its ceiling. Reporting success anyway would
    // be the "looks sent" failure with an extra layer on top.
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('it is finished');
  });
});

// --------------------------------------------------------- groups and delivery

describe('grouping sessions on one host', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  const QUIET: EchoStep[] = [{ kind: 'stop', stop: { kind: 'end_turn' } }];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-group-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function manager(script: EchoStep[] = QUIET): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  /** Reach the private delivery, which a runtime would otherwise have to drive. */
  const deliver = (
    m: SessionManager,
    fromSessionId: string,
    fromAgentId: AgentId,
    message: OutboundPeerMessage,
  ): Promise<PeerDelivery> =>
    (
      m as unknown as {
        deliverPeer: (
          live: unknown,
          from: AgentId,
          m: OutboundPeerMessage,
        ) => Promise<PeerDelivery>;
        sessions: Map<string, unknown>;
      }
    ).deliverPeer(
      (m as unknown as { sessions: Map<string, unknown> }).sessions.get(fromSessionId),
      fromAgentId,
      message,
    );

  async function two(
    m: SessionManager,
  ): Promise<{ a: SessionId; b: SessionId; aLead: AgentId; bLead: AgentId }> {
    const a = await m.createSession({ title: 'the parser', goal: 'g' });
    const b = await m.createSession({ title: 'the API work', goal: 'g' });
    const aLead = (await m.addAgent(a.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    const bLead = (await m.addAgent(b.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    await m.groupSessions([a.sessionId, b.sessionId], 'the migration');
    return { a: a.sessionId, b: b.sessionId, aLead, bLead };
  }

  it('gives both sessions one group id, recorded in each log', async () => {
    const m = manager();
    const { a, b } = await two(m);

    const groupA = m.get(a).group;
    expect(groupA).toBeDefined();
    // One fact per session, in that session's own log — not an adjacency list
    // that has to be written N times and can disagree with itself.
    expect(m.get(b).group?.groupId).toBe(groupA?.groupId);
    for (const id of [a, b]) {
      const joined = (await m.events(id)).filter((e) => e.type === 'session.joined_group');
      expect(joined).toHaveLength(1);
    }
    expect(m.groupPeers(a).map((s) => s.sessionId)).toEqual([b]);
  });

  it('refuses a session it does not have, and writes nothing at all', async () => {
    const m = manager();
    const a = await m.createSession({ title: 'here', goal: 'g' });

    await expect(
      m.groupSessions([a.sessionId, '0192-not-here' as SessionId], 'mixed'),
    ).rejects.toThrow(/not built|same-host|on this host/);

    // Resolved before anything is written, like a refused split: a set half in a
    // group would leave sessions addressing members that never joined.
    expect(m.get(a.sessionId).group).toBeUndefined();
    expect((await m.events(a.sessionId)).some((e) => e.type === 'session.joined_group')).toBe(false);
  });

  it('keeps the group across a restart, and lets it be left', async () => {
    const first = manager();
    const { a, b } = await two(first);
    const groupId = first.get(a).group?.groupId;
    first.dispose();

    // A restart is still the same session (§17 Q19's reasoning for the standing
    // grant, §17 Q21's for skills). A resumed session that had forgotten its
    // group would refuse a reply to the sibling that had just asked it.
    const second = manager();
    const resumed = await second.resumeSession(a);
    expect(resumed.group?.groupId).toBe(groupId);

    await second.resumeSession(b);
    await second.ungroupSession(a);
    expect(second.get(a).group).toBeUndefined();
    expect((await second.events(a)).some((e) => e.type === 'session.left_group')).toBe(true);
    // And a third fold agrees with the second: leaving is durable too.
    const third = manager();
    expect((await third.resumeSession(a)).group).toBeUndefined();
  });

  it('writes the attempt on the sender and the arrival on the recipient, and wakes it', async () => {
    const m = manager();
    const { a, b, aLead } = await two(m);

    const delivery = await deliver(m, a, aLead, {
      toSessionId: b,
      kind: 'question',
      text: 'does the parser still emit `user_id`?',
    });
    expect(delivery.accepted).toBe(true);

    await until(async () => (await m.events(b)).some((e) => e.type === 'user.turn'));

    const sent = (await m.events(a)).find((e) => e.type === 'session.peer_message_sent');
    const received = (await m.events(b)).find((e) => e.type === 'session.peer_message_received');
    // Both, because two sessions are two logs — possibly two workspaces — and
    // §5.1's bargain is that a log is readable alone. Neither could be derived
    // from the other.
    expect((sent as unknown as { delivered: boolean }).delivered).toBe(true);
    expect((received as unknown as { message: PeerMessage }).message).toMatchObject({
      fromSessionId: a,
      fromAgentId: aLead,
      toSessionId: b,
      hops: 1,
    });

    // Woken, not merely told — and the turn carries the sender's identity so the
    // recipient's transcript does not show work arriving from nowhere.
    const turn = (await m.events(b)).find((e) => e.type === 'user.turn');
    expect(JSON.stringify(turn)).toContain('user_id');
    expect(JSON.stringify(turn)).toContain(a);
    // Nobody pressed anything (§5.1: an absent actor means no person acted).
    expect((turn as unknown as { actor?: unknown }).actor).toBeUndefined();
  });

  it('records a refused message on the sender only', async () => {
    const m = manager();
    const a = await m.createSession({ title: 'a', goal: 'g' });
    const b = await m.createSession({ title: 'b', goal: 'g' });
    const aLead = (await m.addAgent(a.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    await m.addAgent(b.sessionId, { role: 'lead', runtimeId: 'echo' });
    // Two groups, not one.
    await m.groupSessions([a.sessionId], 'mine');
    await m.groupSessions([b.sessionId], 'theirs');

    const refused = await deliver(m, a.sessionId, aLead, {
      toSessionId: b.sessionId,
      kind: 'task',
      text: 'do this for me',
    });
    expect(refused.accepted).toBe(false);
    expect(refused.reason).toMatch(/not in your group/);

    // Still logged, on the sender: what a group *tried* to say is the
    // interesting part when it misbehaves (§4.2).
    const attempt = (await m.events(a.sessionId)).find(
      (e) => e.type === 'session.peer_message_sent',
    );
    expect((attempt as unknown as { delivered: boolean }).delivered).toBe(false);
    // And nothing on the recipient: it never learned of it, so its log must not
    // claim otherwise.
    expect(
      (await m.events(b.sessionId)).some((e) => e.type === 'session.peer_message_received'),
    ).toBe(false);
    expect((await m.events(b.sessionId)).some((e) => e.type === 'user.turn')).toBe(false);
  });

  it('refuses a finished session and accepts a paused one', async () => {
    const m = manager();
    const { a, b, aLead } = await two(m);

    // Paused is not failed (§4.1). A message to a session waiting on a person or
    // on quota is queued and runs when it wakes; turning that into a refusal
    // would treat a pause as a failure in the one place it is easiest to.
    await (
      m as unknown as {
        setState: (live: unknown, to: string, reason?: string) => Promise<void>;
        sessions: Map<string, unknown>;
      }
    ).setState(
      (m as unknown as { sessions: Map<string, unknown> }).sessions.get(b),
      'awaiting_quota',
      'test',
    );
    expect((await deliver(m, a, aLead, { toSessionId: b, kind: 'task', text: 'ping' })).accepted).toBe(
      true,
    );

    await m.cancelSession(b);
    const after = await deliver(m, a, aLead, { toSessionId: b, kind: 'task', text: 'ping again' });
    expect(after.accepted).toBe(false);
    expect(after.reason).toMatch(/cancelled|finished/);
  });

  it('enforces the size cap in the owner as well as in the tool', async () => {
    const m = manager();
    const { a, b, aLead } = await two(m);

    // Defence in depth, and not decoration: the tool is one caller and this is
    // the owner of the log. A cap enforced only where the model is asked
    // politely is not a cap (§13).
    const refused = await deliver(m, a, aLead, {
      toSessionId: b,
      kind: 'report',
      text: 'x'.repeat(PEER_MESSAGE_MAX_CHARS + 1),
    });
    expect(refused.accepted).toBe(false);
    expect(refused.reason).toContain(String(PEER_MESSAGE_MAX_CHARS));
    expect(
      (await m.events(b)).some((e) => e.type === 'session.peer_message_received'),
    ).toBe(false);
  });

  // ------------------------------------------------------------ the hop ceiling

  it('carries the hop count across the session boundary and stops at the ceiling', async () => {
    const m = manager();
    const { a, b, aLead, bLead } = await two(m);

    const ping = (i: number): Promise<PeerDelivery> =>
      i % 2 === 0
        ? deliver(m, a, aLead, { toSessionId: b, kind: 'question', text: 'and?' })
        : deliver(m, b, bLead, { toSessionId: a, kind: 'answer', text: 'and?' });

    // Eight hops without a person is §4.2's ceiling, and two *sessions* talking
    // in circles is the same conversation with two bills. A count that restarted
    // at each boundary would make a group the documented way around it.
    const accepted: boolean[] = [];
    for (let i = 0; i < 9; i += 1) accepted.push((await ping(i)).accepted);

    expect(accepted.slice(0, 8).every(Boolean)).toBe(true);
    expect(accepted[8]).toBe(false);

    const refusals = (await m.events(a)).filter(
      (e) =>
        e.type === 'session.peer_message_sent' &&
        /hops without a person/.test(String((e as unknown as { refusedBecause?: string }).refusedBecause)),
    );
    // Recorded, so a group that keeps hitting the ceiling is visible rather than
    // merely slow.
    expect(refusals.length).toBeGreaterThan(0);

    // A human in the loop is exactly what the ceiling is waiting for.
    await m.send(a, aLead, { content: [{ type: 'text', text: 'carry on' }] }, {
      id: 'me',
      via: 'peer-credential',
    });
    expect((await ping(0)).accepted).toBe(true);

    // Let the turns this started finish before the fixture is torn down: on
    // Windows, removing a directory under an open log handle fails the test for
    // a reason unrelated to what it checked.
    await until(() => [a, b].every((id) => m.get(id).state !== 'working'));
  });

  // ------------------------------------------------- permission never widens

  it('does not lend the sender’s standing grant to the recipient', async () => {
    // The sender answers every `ask` without a prompt; the recipient denies
    // `bash` outright. §13: "a message must not become a way to have work done
    // under someone else's grant".
    const m = manager([
      { kind: 'tool', tool: 'bash', args: { command: 'ls -la' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const a = await m.createSession({ title: 'trusted', goal: 'g', standingGrant: true });
    const b = await m.createSession({
      title: 'careful',
      goal: 'g',
      policy: { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
    });
    const aLead = (await m.addAgent(a.sessionId, { role: 'lead', runtimeId: 'echo' })).agentId;
    await m.addAgent(b.sessionId, { role: 'lead', runtimeId: 'echo' });
    await m.groupSessions([a.sessionId, b.sessionId], 'mixed trust');

    await deliver(m, a.sessionId, aLead, {
      toSessionId: b.sessionId,
      kind: 'task',
      text: 'please list the files',
    });

    await until(async () =>
      (await m.events(b.sessionId)).some((e) => e.type === 'permission.decided'),
    );

    const decisions = (await m.events(b.sessionId)).filter((e) => e.type === 'permission.decided');
    expect(decisions).not.toHaveLength(0);
    for (const d of decisions) {
      const decided = d as unknown as { decision: { result: string }; via: string };
      expect(decided.decision.result).toBe('deny');
      // Not merely denied — denied *by the recipient's own policy*. A
      // `standing-grant` line here would be the widening this test exists for.
      expect(decided.via).toBe('policy');
    }
    // And nothing about the grant travelled either: it is a fact about a session,
    // not about a conversation.
    expect(m.get(b.sessionId).standingGrant).toBeUndefined();
    expect(
      (await m.events(b.sessionId)).some((e) => e.type === 'permission.standing_grant'),
    ).toBe(false);

    await until(() => m.get(b.sessionId).state !== 'working');
  });
});

// ------------------------------------------------------------ across machines

describe('a group does not span machines', () => {
  let roots: string[] = [];
  const fleets: Fleet[] = [];
  const managers: SessionManager[] = [];

  const RUNTIMES: FleetRuntime[] = [{ id: 'echo', label: 'Echo', version: '0.0.1', model: 'none' }];

  beforeEach(() => {
    roots = [];
  });
  afterEach(async () => {
    for (const f of fleets.splice(0)) await f.detachAll();
    for (const m of managers.splice(0)) m.dispose();
    for (const root of roots) {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  /** Two real hosts over two real workspaces, reached through a real connection. */
  function makeFleet(): Fleet {
    const hosts = new Map<string, SessionHostServer>();
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      connect: async ({ workspaceRoot }) => {
        let server = hosts.get(workspaceRoot);
        if (server === undefined) {
          const identity = await openWorkspace(workspaceRoot);
          const registry = new RuntimeRegistry();
          registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
            label: 'Echo',
            model: 'none',
          });
          const manager = new SessionManager({
            registry,
            workspaceRoot,
            instanceId: identity.instanceId,
          });
          managers.push(manager);
          server = new SessionHostServer({
            manager,
            identity: {
              instanceId: identity.instanceId,
              lineageId: identity.lineageId,
              workspaceRoot,
              runtimes: ['echo'],
            },
          });
          hosts.set(workspaceRoot, server);
        }
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    fleets.push(fleet);
    return fleet;
  }

  const local = (workspaceRoot: string) => ({ target: { kind: 'local' } as const, workspaceRoot });

  async function root(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-groupfleet-'));
    roots.push(dir);
    return dir;
  }

  it('refuses a group spanning two hosts, and names them', async () => {
    const fleet = makeFleet();
    const one = await root();
    const two = await root();
    const hostA = await fleet.attach(local(one));
    const hostB = await fleet.attach(local(two));

    const here = await fleet.createSession(hostA.instanceId, { title: 'here', goal: 'g' });
    const there = await fleet.createSession(hostB.instanceId, { title: 'there', goal: 'g' });

    /*
     * Refused rather than half-made, and rather than quietly grouped on the
     * first host. §16's oldest recorded failure is a target that was recorded
     * and not enforced, and a group whose members cannot reach each other would
     * be exactly that failure wearing a new field. Naming the machines is the
     * useful act — the fleet is the only layer that knows them by the names the
     * user chose.
     */
    await expect(fleet.group([here.sessionId, there.sessionId], 'across')).rejects.toBeInstanceOf(
      AttachRefused,
    );
    await expect(fleet.group([here.sessionId, there.sessionId], 'across')).rejects.toThrow(
      /machines/,
    );

    // Nothing was written on either side.
    expect((await fleet.get(here.sessionId)).group).toBeUndefined();
    expect((await fleet.get(there.sessionId)).group).toBeUndefined();
  });

  it('groups sessions that are on one host, through the same call', async () => {
    const fleet = makeFleet();
    const one = await root();
    const host = await fleet.attach(local(one));

    const a = await fleet.createSession(host.instanceId, { title: 'a', goal: 'g' });
    const b = await fleet.createSession(host.instanceId, { title: 'b', goal: 'g' });

    const grouped = await fleet.group([a.sessionId, b.sessionId], 'the migration');
    expect(grouped).toHaveLength(2);
    expect(grouped[0]?.group?.name).toBe('the migration');
    expect(grouped[0]?.group?.groupId).toBe(grouped[1]?.group?.groupId);

    const left = await fleet.ungroup(a.sessionId);
    expect(left.group).toBeUndefined();
  });
});
