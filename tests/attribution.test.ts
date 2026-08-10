/**
 * Who did it (DESIGN.md §5.1, §7, §13).
 *
 * The log could already answer "what happened" and "which agent did it". It
 * could not answer "which *person* asked for it" — `permission.decided` recorded
 * `via: 'user'` and stopped there. With one human that is a nicety. With a host
 * several people can attach to, it is the difference between an audit trail and
 * a rumour: "the gate said yes" is not an answer to "who let it run that".
 *
 * The rule under test throughout is that **absence is meaningful**. An event with
 * no actor was caused by no person, not by a person we failed to identify.
 * Anything that blurs those two makes every line of agent output look like an
 * unattributed human action.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { accessPolicyPath, decideRole, loadAccessPolicy, AccessPolicyInvalid } from '../src/host/accessPolicy.js';
import { assertedIdentity, localIdentity } from '../src/host/identity.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AccessRole, Actor, InstanceId, AgbrteEvent } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-actor-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ASKS: EchoStep[] = [
  { kind: 'tool', tool: 'shell', args: { cmd: 'ls' } },
  { kind: 'text', text: 'done' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const QUIET: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const ALICE: Actor = { id: 'uid:1000', via: 'peer-credential', label: 'alice@box' };
const BOB: Actor = { id: 'uid:1001', via: 'peer-credential', label: 'bob@box' };

/**
 * A host two people are attached to.
 *
 * Identity is resolved from the client label, which is the production path
 * exactly: `grantRole` is handed the label and answers with an actor. Nothing
 * here reaches into the server, so what the tests exercise is what runs.
 */
function rig(script: EchoStep[] = QUIET) {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
  const people = new Map<string, Actor>([
    ['alice', ALICE],
    ['bob', BOB],
  ]);

  const server = new SessionHostServer({
    manager,
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
    grantRole: (requested, client) => ({
      role: requested,
      actor: people.get(client) ?? { id: `asserted:${client}`, via: 'asserted' },
    }),
  });

  return {
    manager,
    connect(who = 'alice', role: AccessRole = 'read-write'): HostConnection {
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      return new HostConnection({ channel: pair.main, role, client: who });
    },
  };
}

function actorsOf(events: AgbrteEvent[], type: string): Array<Actor | undefined> {
  return events.filter((e) => e.type === type).map((e) => e.actor);
}

describe('attributing what a person did', () => {
  it('names who sent a turn', async () => {
    const r = rig();
    const c = r.connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await c.send(session.sessionId, agent.agentId as never, 'hello');

    const events = await c.events(session.sessionId);
    expect(actorsOf(events, 'user.turn')).toEqual([ALICE]);
    expect(actorsOf(events, 'session.created')).toEqual([ALICE]);
    expect(actorsOf(events, 'agent.created')).toEqual([ALICE]);
  });

  it('leaves the agent’s own output unattributed', async () => {
    const r = rig();
    const c = r.connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await c.send(session.sessionId, agent.agentId as never, 'hello');

    const events = await c.events(session.sessionId);
    // Stamping the turn's sender onto everything the agent then did would read
    // as though they did it. The chain back to the turn is already in the log.
    expect(actorsOf(events, 'agent.text')).toEqual([undefined]);
    expect(events.filter((e) => e.type === 'session.state').every((e) => e.actor === undefined)).toBe(
      true,
    );
  });

  it('names who answered a permission prompt, not just that a human did', async () => {
    const r = rig(ASKS);
    const alice = r.connect();
    const session = await alice.createSession({ title: 's', goal: 'g' });
    const agent = await alice.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      policy: { rules: [{ tool: 'shell', action: 'ask' }] },
    });

    // Bob is attached to the same host and answers Alice's agent — exactly the
    // case `via: 'user'` alone could not describe.
    const bob = r.connect('bob');
    await bob.ready;

    const asked = new Promise<{ requestId: string }>((resolve) => {
      bob.on('permission', (req) => resolve(req as { requestId: string }));
    });
    const turn = alice.send(session.sessionId, agent.agentId as never, 'go');
    const request = await asked;
    await bob.respondPermission(request.requestId, { result: 'allow', scope: 'once' });
    await turn;

    const events = await alice.events(session.sessionId);
    const decided = events.filter((e) => e.type === 'permission.decided');
    expect(decided).toHaveLength(1);
    expect(decided[0]!.actor).toEqual(BOB);
    // The turn was Alice's; the decision was Bob's. One field, two answers.
    expect(actorsOf(events, 'user.turn')).toEqual([ALICE]);
  });

  it('leaves a policy decision unattributed — policy is not a person', async () => {
    const r = rig(ASKS);
    const c = r.connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      policy: { rules: [{ tool: 'shell', action: 'allow' }] },
    });
    await c.send(session.sessionId, agent.agentId as never, 'go');

    const events = await c.events(session.sessionId);
    const decided = events.filter((e) => e.type === 'permission.decided');
    expect(decided.length).toBeGreaterThan(0);
    // `via: 'policy'` with a name attached would suggest someone was consulted.
    expect(decided.every((e) => e.actor === undefined)).toBe(true);
  });

  it('credits the sender of a queued turn, not whoever is attached when it runs', async () => {
    const r = rig();
    const alice = r.connect();
    const session = await alice.createSession({ title: 's', goal: 'g' });
    const agent = await alice.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const bob = r.connect('bob');
    await bob.ready;

    // Both queued before either drains. The second runs after the first, by
    // which point the manager's idea of "the current client" has moved on —
    // which is why the actor rides on the queue entry.
    await Promise.all([
      alice.send(session.sessionId, agent.agentId as never, 'first'),
      bob.send(session.sessionId, agent.agentId as never, 'second'),
    ]);

    const events = await alice.events(session.sessionId);
    const turns = events.filter((e) => e.type === 'user.turn');
    expect(turns).toHaveLength(2);
    expect(new Set(turns.map((e) => e.actor?.id))).toEqual(new Set([ALICE.id, BOB.id]));
  });
});

describe('what a connection is worth', () => {
  it('backs a local identity with the socket mode, not a claim', () => {
    const local = localIdentity();
    // `peer-credential` is the honest label: nothing was asked, because a 0600
    // socket already refused everyone else.
    expect(local.actor.via).toBe('peer-credential');
    expect(local.actor.id).toMatch(/^uid:/);
    expect(local.ceiling).toBe('read-write');
  });

  it('caps an unverified claim at read-only', () => {
    const claimed = assertedIdentity('someone');
    // Watching harms nothing; commanding on an unchecked claim does. The cap
    // lives with the identity so a new source cannot forget to apply it.
    expect(claimed.ceiling).toBe('read-only');
    expect(decideRole(null, 'read-write', 'someone', claimed.ceiling)).toBe('read-only');
  });

  it('uses a stable id and a separate changeable label', () => {
    // One string for both would split a person into two actors across a rename.
    expect(localIdentity().actor.id).not.toBe(localIdentity().actor.label);
  });
});

describe('the access policy', () => {
  const write = async (body: unknown): Promise<void> => {
    await mkdir(workspaceLayout(root).devagents, { recursive: true });
    await writeFile(accessPolicyPath(root), JSON.stringify(body), 'utf8');
  };

  it('is absent by default and grants what was asked', async () => {
    expect(await loadAccessPolicy(root)).toBeNull();
    expect(decideRole(null, 'read-write', 'agbrte-app@desk')).toBe('read-write');
  });

  it('pins a client family to read-only', async () => {
    await write({ rules: [{ client: 'agbrte-app@phone-*', role: 'read-only' }] });
    const policy = await loadAccessPolicy(root);

    // The accident this exists for: a live run on a phone is one keystroke from
    // being driven by it.
    expect(decideRole(policy, 'read-write', 'agbrte-app@phone-14')).toBe('read-only');
    expect(decideRole(policy, 'read-write', 'agbrte-app@desk')).toBe('read-write');
  });

  it('never grants more than was asked for', async () => {
    await write({ rules: [{ client: '*', role: 'read-write' }] });
    const policy = await loadAccessPolicy(root);
    // A rule is a ceiling. A client that asked to watch is not handed a keyboard.
    expect(decideRole(policy, 'read-only', 'anything')).toBe('read-only');
  });

  it('lets a specific rule precede a broad one', async () => {
    await write({
      rules: [
        { client: 'agbrte-app@desk', role: 'read-write' },
        { client: '*', role: 'read-only' },
      ],
    });
    const policy = await loadAccessPolicy(root);
    // First match wins, so ordering replaces a priority field.
    expect(decideRole(policy, 'read-write', 'agbrte-app@desk')).toBe('read-write');
    expect(decideRole(policy, 'read-write', 'agbrte-app@laptop')).toBe('read-only');
  });

  it('refuses a malformed policy rather than falling back to unrestricted', async () => {
    await write({ rules: [{ client: 'x', role: 'read/write' }] });
    // The dangerous failure mode: a typo silently widening access. Loud is the
    // only safe direction here.
    await expect(loadAccessPolicy(root)).rejects.toThrow(AccessPolicyInvalid);
  });

  it('refuses unparseable JSON for the same reason', async () => {
    await mkdir(workspaceLayout(root).devagents, { recursive: true });
    await writeFile(accessPolicyPath(root), '{ not json', 'utf8');
    await expect(loadAccessPolicy(root)).rejects.toThrow(AccessPolicyInvalid);
  });
});

describe('interrupting', () => {
  it('records who stopped a turn, not just that it ended', async () => {
    const r = rig(ASKS);
    const c = r.connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    await c.interrupt(session.sessionId, agent.agentId as never);

    const events = await c.events(session.sessionId);
    const stopped = events.filter((e) => e.type === 'agent.interrupted');
    // Without this the transcript shows a turn that simply ends, and "the model
    // finished" reads identically to "someone pressed stop".
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.actor).toEqual(ALICE);
    expect(stopped[0]!.agentId).toBe(agent.agentId);
  });

  it('records a stop the runtime could not honour', async () => {
    const r = rig(ASKS);
    const c = r.connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await c.interrupt(session.sessionId, agent.agentId as never);

    const events = await c.events(session.sessionId);
    const stopped = events.find((e) => e.type === 'agent.interrupted');
    // `delivered` is the field that explains "I pressed stop and it kept going",
    // which is the case a transcript most needs to account for rather than hide.
    expect(stopped).toHaveProperty('delivered');
  });
});

/**
 * §15 Phase 5's proving criterion.
 *
 * > *open the same live session on a second device, answer a permission prompt
 * > there, and watch the first device show it resolved rather than keep asking.*
 *
 * DESIGN calls this "the criterion that proves the topology, because it is the
 * one the current shape cannot pass". It could not, for a specific reason: the
 * *question* was broadcast to every attached client and the *answer* was not, so
 * the device that did not answer kept a settled prompt on screen and learned
 * otherwise only by pressing a button and being told it was too late.
 */
describe('a prompt answered on one device', () => {
  it('is announced to every other client', async () => {
    const r = rig(ASKS);
    const alice = r.connect('alice');
    const bob = r.connect('bob');
    await Promise.all([alice.ready, bob.ready]);

    const session = await alice.createSession({ title: 's', goal: 'g' });
    const agent = await alice.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      policy: { rules: [{ tool: 'shell', action: 'ask' }] },
    });

    // Both see the question.
    const askedAlice = new Promise<{ requestId: string }>((done) =>
      alice.on('permission', (req) => done(req as { requestId: string })),
    );
    const askedBob = new Promise<{ requestId: string }>((done) =>
      bob.on('permission', (req) => done(req as { requestId: string })),
    );
    // Alice is the one told it is over, having not answered it herself.
    const toldAlice = new Promise<Record<string, unknown>>((done) =>
      alice.on('permission-resolved', (r) => done(r as Record<string, unknown>)),
    );

    const turn = alice.send(session.sessionId, agent.agentId as never, 'go');
    const [request] = await Promise.all([askedAlice, askedBob]);

    await bob.respondPermission(request.requestId, { result: 'allow', scope: 'once' });
    await turn;

    const resolved = await toldAlice;
    expect(resolved['requestId']).toBe(request.requestId);
    expect(resolved['outcome']).toBe('answered');
    // Who, not just that — the difference between a prompt vanishing
    // mysteriously and one that says "Bob allowed this".
    expect(resolved['actor']).toEqual(BOB);
  });
});
