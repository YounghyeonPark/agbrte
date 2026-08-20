/**
 * One session, one agent (DESIGN.md §4.2, §5.1).
 *
 * The product decision: a session is one model. Two models working together is
 * the *group* feature (§17 Q22) — separate sessions, separate logs, separate
 * bills, a bounded channel between them — not a roster inside one session.
 *
 * What is under test is not the button. Three clients reach the owner (the app,
 * the terminal, an attached browser) and a template application reaches it as
 * well, so the rule is worth nothing unless `SessionManager.addAgent` is the
 * thing that says no. And because §5.1 makes the log permanent, the rule has to
 * be about what can be *created*: sessions that already hold two seats keep
 * resuming, keep attributing their rows, and keep being sendable.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecondAgentRefused, SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { fromSession, TemplateRefused } from '@main/store/templates.js';
import { seatBeside } from './support/legacyRoster.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { SESSION_ADDAGENT_REPLACING_SINCE } from '@shared/host/sessionProtocol.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { Actor, InstanceId, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-one-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const QUIET: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const ME: Actor = { id: 'uid:1000', via: 'peer-credential', label: 'me@box' };

/** Two runtimes, so a replacement can be a genuinely different model. */
function manager(script: EchoStep[] = QUIET): SessionManager {
  const registry = new RuntimeRegistry();
  // `optional`, so a seat can carry a model id and the refusals below can be
  // about the roster rather than about the plumbing.
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'optional' });
  registry.register(new EchoRuntime({ script, id: 'echo2' }), {
    label: 'Echo 2',
    model: 'optional',
  });
  return new SessionManager({ registry, workspaceRoot: root, instanceId });
}

async function seated(sm: SessionManager): Promise<SessionId> {
  const session = await sm.createSession({ title: 's', goal: 'g' });
  await sm.addAgent(session.sessionId, {
    role: 'lead',
    runtimeId: 'echo',
    model: { providerId: 'openai-compatible', modelId: 'qwen2.5:7b' },
  });
  return session.sessionId;
}

describe('admission refuses a second seat', () => {
  it('names the agent already there, and what to do instead', async () => {
    const sm = manager();
    const sessionId = await seated(sm);

    const refused = sm.addAgent(sessionId, { role: 'worker', runtimeId: 'echo' });
    await expect(refused).rejects.toThrow(SecondAgentRefused);
    // A refusal a person cannot act on is a dead end: the incumbent by name,
    // the control that changes it, and the feature that does what they were
    // probably reaching for.
    await expect(refused).rejects.toThrow(/qwen2\.5:7b/);
    await expect(refused).rejects.toThrow(/Agent…/);
    await expect(refused).rejects.toThrow(/group/);

    // And nothing was half-added.
    expect(sm.get(sessionId).agents).toHaveLength(1);
  });

  it('refuses in the owner, not only in the client that has a button', async () => {
    // The same call the CLI and an attached browser make. There is no other
    // door: `addAgent` is where every client arrives.
    const sm = manager();
    const sessionId = await seated(sm);
    await expect(
      sm.addAgent(sessionId, { role: 'reviewer', runtimeId: 'echo2' }),
    ).rejects.toThrow(SecondAgentRefused);
  });
});

describe('changing the model', () => {
  it('retires the old seat and admits the new one, in the log', async () => {
    const sm = manager();
    const sessionId = await seated(sm);
    const before = sm.get(sessionId).agents[0]!;

    const after = await sm.addAgent(
      sessionId,
      {
        role: 'lead',
        runtimeId: 'echo2',
        model: { providerId: 'openai-compatible', modelId: 'claude-sonnet' },
        replacing: before.agentId,
      },
      ME,
    );

    const session = sm.get(sessionId);
    // Both records survive: one live, one retired. The retired seat is what
    // keeps the rows above the change attributable.
    expect(session.agents.map((a) => a.status)).toEqual(['retired', 'idle']);
    expect(session.agents.filter((a) => a.status !== 'retired')).toHaveLength(1);
    expect(after.spec.model?.modelId).toBe('claude-sonnet');

    const events = await sm.events(sessionId);
    const retired = events.find((e) => e.type === 'agent.retired');
    expect(retired).toMatchObject({
      agentId: before.agentId,
      reason: 'replaced',
      replacedBy: after.agentId,
      // §5.1: the log says who did it. A model change with no person attached
      // would read as something the machine decided.
      actor: { id: 'uid:1000' },
    });
    // Ordered: the retirement sits before the creation that caused it, so the
    // transcript reads as a change at a point in time rather than two seats
    // appearing from nowhere.
    const order = events.filter((e) => e.type === 'agent.retired' || e.type === 'agent.created');
    expect(order.map((e) => e.type)).toEqual(['agent.created', 'agent.retired', 'agent.created']);
  });

  it('leaves the session exactly as it was when the new model is refused', async () => {
    /*
     * The reason retirement happens *after* admission. A person changing model
     * to something the host cannot run must not end up with a session that has
     * no agent at all — that would be a working session destroyed by a rejected
     * form.
     */
    const sm = manager();
    const sessionId = await seated(sm);
    const before = sm.get(sessionId).agents[0]!;

    await expect(
      sm.addAgent(sessionId, {
        role: 'lead',
        runtimeId: 'not-installed',
        replacing: before.agentId,
      }),
    ).rejects.toThrow();

    const session = sm.get(sessionId);
    expect(session.agents).toHaveLength(1);
    expect(session.agents[0]!.status).toBe('idle');
    // Still sendable, which is the claim that matters.
    await sm.send(sessionId, before.agentId, TEXT('still here'));
    expect((await sm.events(sessionId)).some((e) => e.type === 'agent.retired')).toBe(false);
  });

  it('refuses a second client replacing a seat somebody else already retired', async () => {
    // Two windows on one session (§17 Q14). The loser is told, rather than
    // silently discarding the winner's choice.
    const sm = manager();
    const sessionId = await seated(sm);
    const first = sm.get(sessionId).agents[0]!;

    await sm.addAgent(sessionId, { role: 'lead', runtimeId: 'echo2', replacing: first.agentId });
    await expect(
      sm.addAgent(sessionId, { role: 'lead', runtimeId: 'echo', replacing: first.agentId }),
    ).rejects.toThrow(/already retired/);
    expect(sm.get(sessionId).agents.filter((a) => a.status !== 'retired')).toHaveLength(1);
  });

  it('refuses a turn addressed to a retired seat, and says what happened', async () => {
    const sm = manager();
    const sessionId = await seated(sm);
    const before = sm.get(sessionId).agents[0]!;
    await sm.addAgent(sessionId, { role: 'lead', runtimeId: 'echo2', replacing: before.agentId });

    await expect(sm.send(sessionId, before.agentId, TEXT('hello?'))).rejects.toThrow(
      /retired when this session's model changed/,
    );
  });
});

describe('what a restart makes of it', () => {
  it('brings a replaced seat back retired, so the cap still holds', async () => {
    const first = manager();
    const sessionId = await seated(first);
    const before = first.get(sessionId).agents[0]!;
    await first.addAgent(sessionId, { role: 'lead', runtimeId: 'echo2', replacing: before.agentId });
    first.dispose();

    const second = manager();
    const resumed = await second.resumeSession(sessionId);

    // Rebuilt from `agent.retired` rather than from memory. Without the event
    // this session would come back holding two live agents — the exact shape
    // admission refuses to create.
    expect(resumed.agents).toHaveLength(2);
    expect(resumed.agents.filter((a) => a.status === 'retired')).toHaveLength(1);
    expect(resumed.agents.filter((a) => a.status !== 'retired')).toHaveLength(1);
    expect(resumed.agents.find((a) => a.status === 'retired')?.agentId).toBe(before.agentId);

    await expect(
      second.addAgent(sessionId, { role: 'worker', runtimeId: 'echo' }),
    ).rejects.toThrow(SecondAgentRefused);
    second.dispose();
  });

  it('keeps a session that already had two seats working', async () => {
    /*
     * The compatibility claim, end to end. These sessions exist — one is on the
     * user's screen — and the rule is about what may be created from now on,
     * never about rewriting history.
     */
    const first = manager();
    const session = await first.createSession({ title: 'legacy', goal: 'g' });
    const lead = await first.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' });
    const worker = await seatBeside(first, session.sessionId, {
      role: 'worker',
      runtimeId: 'echo2',
    });
    await first.send(session.sessionId, lead.agentId, TEXT('from the lead'));
    await first.send(session.sessionId, worker.agentId, TEXT('from the worker'));
    first.dispose();

    const second = manager();
    const resumed = await second.resumeSession(session.sessionId);

    // Both seats live, both sendable, and every row still resolves to the agent
    // that wrote it.
    expect(resumed.agents).toHaveLength(2);
    expect(resumed.agents.every((a) => a.status === 'idle')).toBe(true);
    await second.send(session.sessionId, worker.agentId, TEXT('and again'));

    const events = await second.events(session.sessionId);
    const byAgent = new Set(events.filter((e) => e.type === 'user.turn').map((e) => e.agentId));
    expect(byAgent).toEqual(new Set([lead.agentId, worker.agentId]));

    // What it may not do is grow a third.
    await expect(
      second.addAgent(session.sessionId, { role: 'reviewer', runtimeId: 'echo' }),
    ).rejects.toThrow(SecondAgentRefused);
    second.dispose();
  });
});

describe('a template is a recipe for a session, so it holds one role', () => {
  it('refuses to save a roster of two, naming both', async () => {
    const sm = manager();
    const session = await sm.createSession({ title: 's', goal: 'g' });
    await sm.addAgent(session.sessionId, { role: 'lead', runtimeId: 'echo' });
    await seatBeside(sm, session.sessionId, { role: 'worker', runtimeId: 'echo2' });

    // Truncating to the first seat would hand back a recipe that reproduces
    // half of what the person was looking at, discovered weeks later.
    expect(() => fromSession(sm.get(session.sessionId), 'two')).toThrow(TemplateRefused);
    expect(() => fromSession(sm.get(session.sessionId), 'two')).toThrow(/worker/);
    sm.dispose();
  });

  it('saves the live seat from a session whose model was changed', async () => {
    const sm = manager();
    const sessionId = await seated(sm);
    const before = sm.get(sessionId).agents[0]!;
    await sm.addAgent(sessionId, {
      role: 'lead',
      runtimeId: 'echo2',
      model: { providerId: 'openai-compatible', modelId: 'claude-sonnet' },
      replacing: before.agentId,
    });

    // A retired seat is history, not configuration: a template that carried it
    // could never be applied.
    const template = fromSession(sm.get(sessionId), 'current');
    expect(template.roles).toHaveLength(1);
    expect(template.roles[0]?.model?.modelId).toBe('claude-sonnet');
    sm.dispose();
  });
});

/**
 * A host too old to replace a seat is told about, not sent the field (§4.2).
 *
 * This is the case the protocol's own version notes call out as *not* the
 * harmless one: an older host drops `replacing` and adds a second agent to a
 * session somebody was changing the model of — the exact roster the cap exists
 * to prevent, arrived at by asking for the opposite. A detached host outlives
 * the app that spawned it, so this is the ordinary state of things an hour
 * after an update rather than an edge case.
 */
describe('a host that predates changing a model in place', () => {
  it('refuses with the remedy in it, and still seats a first agent', async () => {
    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const client = new HostConnection({ channel: main, client: 'test' });
    const seen: unknown[] = [];

    host.onMessage((command) => {
      if (command.t === 'hello') {
        host.post({
          t: 'welcome',
          id: command.id,
          role: 'read-write',
          identity: {
            instanceId: 'i' as InstanceId,
            lineageId: 'l' as never,
            workspaceRoot: '/w',
            runtimes: [],
            pid: 1,
            // The newest host that predates the field, derived from the
            // constant the claim is about rather than from "one less than now".
            protocol: SESSION_ADDAGENT_REPLACING_SINCE - 1,
            minProtocol: 1,
          },
        } as unknown as SessionMessage);
        return;
      }
      seen.push(command);
      host.post({ t: 'ok', id: (command as { id: string }).id, value: {} } as SessionMessage);
    });

    await client.ready;
    await expect(
      client.addAgent('s1' as SessionId, { role: 'lead', runtimeId: 'echo', replacing: 'a1' }),
    ).rejects.toThrow(/update that host/);
    // Refused here, so nothing reached the far end to be misread.
    expect(seen).toHaveLength(0);

    // And the ordinary call is untouched: an empty session still gets its agent.
    await client.addAgent('s1' as SessionId, { role: 'lead', runtimeId: 'echo' });
    expect(seen).toHaveLength(1);
    client.disconnect();
  });
});
