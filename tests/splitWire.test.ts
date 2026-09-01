/**
 * What a cross-host split puts on the wire when there is no budget to reserve
 * (DESIGN.md §4.3, §17 Q5, protocol v28).
 *
 * §4.3 used to refuse a parent with no ceiling and now carries the absence down
 * to the child. That turned a required field into an optional one in two places
 * a *second machine* reads — `PreparedChild.parentBudget` and
 * `session.recordChild` — and CLAUDE.md's first hazard is precisely this: the
 * remote path forgetting what the local path passes. The local test for the same
 * change (`spawnChild.test.ts`) cannot see it, because there the two halves are
 * one object in one process.
 *
 * So both halves are exercised across a real `HostConnection`: the parent's host
 * decides with no budget, and the parent's host commits with none — which is the
 * pairing the protocol note leans on when it argues a v27 host can never be
 * handed the omission.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { openWorkspace } from '@main/store/identity.js';
import type { InstanceId, SessionId } from '@shared/types/index.js';

let root = '';
let instanceId: InstanceId;
let lineageId: string;
let manager: SessionManager;
const disposable: SessionManager[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-splitwire-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});
afterEach(async () => {
  for (const m of disposable.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true });
});

/**
 * One host, reachable both directly and over the protocol.
 *
 * The manager is returned as well as the connection because a split starts with
 * a proposal an agent makes, which has no command of its own — §4.3 keeps the
 * *decision* on the wire and the proposal inside the session. What is under test
 * is the two steps after it.
 */
async function connect(): Promise<{ connection: HostConnection; sent: SessionCommand[] }> {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
  manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
  disposable.push(manager);
  const server = new SessionHostServer({
    manager,
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
  });
  const pair = memoryChannelPair<SessionCommand, SessionMessage>();
  server.accept(pair.host);

  // Every frame the client sends, kept so the assertion can be about the
  // *message* rather than about a field that survived a round trip.
  const sent: SessionCommand[] = [];
  const post = pair.main.post.bind(pair.main);
  pair.main.post = (command: SessionCommand): void => {
    sent.push(command);
    post(command);
  };

  const connection = new HostConnection({ channel: pair.main });
  await connection.ready;
  return { connection, sent };
}

async function propose(sessionId: SessionId): Promise<string> {
  const proposal = await manager.proposeSplit(sessionId, {
    title: 'port the parser',
    scope: 'port the parser to the new AST, tests included',
    outOfScope: ['the CLI surface'],
    contract: { summaryMaxTokens: 500, artifacts: [] },
    tokenCeiling: 20_000,
    why: 'the parser is half the remaining work and touches nothing else',
  });
  return proposal.proposalId;
}

describe('a split decided over the wire', () => {
  it('carries the parent budget when there is one', async () => {
    const { connection } = await connect();
    const parent = await manager.createSession({
      title: 'p',
      goal: 'g',
      budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
    });
    const prepared = await connection.prepareSplit(parent.sessionId, await propose(parent.sessionId), {
      approved: true,
    });

    // The control, so the absence below is a fact about the budget rather than
    // about the field never travelling at all.
    expect(prepared?.parentBudget?.reservedForChildren).toBe(20_000);
    expect(prepared?.create.budget?.tokenCeiling).toBe(20_000);
  });

  it('omits it entirely when the parent has none', async () => {
    const { connection } = await connect();
    const parent = await manager.createSession({ title: 'p', goal: 'g' });
    const prepared = await connection.prepareSplit(parent.sessionId, await propose(parent.sessionId), {
      approved: true,
    });

    // Absent, not zero. A zero would be a ceiling nobody set, and the host on
    // the other end of this would write it onto the child.
    expect(prepared).not.toBeNull();
    expect(prepared).not.toHaveProperty('parentBudget');
    expect(prepared?.create).not.toHaveProperty('budget');
  });

  it('commits the child without inventing a budget for the parent', async () => {
    const { connection, sent } = await connect();
    const parent = await manager.createSession({ title: 'p', goal: 'g' });
    const prepared = await connection.prepareSplit(parent.sessionId, await propose(parent.sessionId), {
      approved: true,
    });
    if (prepared === null) throw new Error('the split was refused');

    const child = await connection.createSession(prepared.create);
    await connection.recordChild(parent.sessionId, child, prepared.parentBudget, prepared.contract);

    // The frame, because the protocol note's safety argument is about what a
    // v27 host would receive — and a `parentBudget: undefined` key that JSON
    // happens to drop is a different claim from one that was never set.
    const commit = sent.find((c) => c.t === 'session.recordChild');
    expect(commit).toBeDefined();
    expect(commit).not.toHaveProperty('parentBudget');

    // And the parent is left as it was: unbudgeted, with the edge written.
    expect(manager.get(parent.sessionId).budget).toBeUndefined();
    expect(manager.get(parent.sessionId).children.map((c) => c.title)).toEqual(['port the parser']);
  });
});
