/**
 * Reattaching to a session that exists only on disk — DESIGN.md §15's Phase 1
 * criterion, "a text-only session edits a real repo and the transcript survives
 * an app restart".
 *
 * A restart is simulated by discarding the SessionManager entirely and building
 * a new one over the same workspace root. That is stricter than reopening a
 * store: nothing in-memory can carry state across, so anything that survives
 * came out of the log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';
import type { InstanceId, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-resume-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh manager over the same workspace — i.e. the app after a restart. */
function manager(script?: EchoStep[], opts: { withEcho?: boolean } = {}) {
  const registry = new RuntimeRegistry();
  if (opts.withEcho !== false) {
    registry.register(new EchoRuntime(script ? { script } : {}), {
      label: 'Echo',
      model: 'none',
    });
  }
  return new SessionManager({ registry, workspaceRoot: root, instanceId });
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

describe('resumeSession', () => {
  it('restores the transcript, state, and usage after a restart', async () => {
    const first = manager([
      { kind: 'text', text: 'I edited the file' },
      { kind: 'usage', inputTokens: 100, outputTokens: 20 },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const created = await first.createSession({ title: 'Real work', goal: 'edit a repo' });
    const agent = await first.addAgent(created.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      systemPrompt: 'Be terse.',
      limits: { maxTurns: 7 },
    });
    await first.send(created.sessionId, agent.agentId, TEXT('go'));

    // The restart. Nothing from `first` is reachable past this line.
    const second = manager();
    const resumed = await second.resumeSession(created.sessionId);

    expect(resumed.title).toBe('Real work');
    expect(resumed.goal).toBe('edit a repo');
    expect(resumed.state).toBe('awaiting_input'); // end_turn is not `done` (§3.9)
    expect(resumed.createdAt).toBe(created.createdAt);

    const events = await second.events(created.sessionId);
    expect(events.map((e) => e.type)).toContain('agent.text');
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(1);

    const projection = await second.projection(created.sessionId);
    expect(projection.usage.inputTokens).toBe(100);
    expect(projection.usage.outputTokens).toBe(20);
  });

  it('rebuilds the spec it actually ran under, not a default-shaped lookalike', async () => {
    const first = manager();
    const created = await first.createSession({ title: 's', goal: 'g' });
    await first.addAgent(created.sessionId, {
      role: 'reviewer',
      runtimeId: 'echo',
      systemPrompt: 'You review things.',
      limits: { maxTurns: 3, tokenCeiling: 50_000 },
    });

    const resumed = await manager().resumeSession(created.sessionId);
    const agent = resumed.agents[0];

    expect(agent?.role).toBe('reviewer');
    expect(agent?.spec.runtimeId).toBe('echo');
    // The reason `systemPrompt` and `limits` are on agent.created at all: losing
    // them is a silent behavior change behind an intact-looking transcript.
    expect(agent?.spec.systemPrompt).toBe('You review things.');
    expect(agent?.spec.limits).toEqual({ maxTurns: 3, tokenCeiling: 50_000 });
  });

  it('restores an agent as idle, never as running', async () => {
    const first = manager([{ kind: 'stop', stop: { kind: 'end_turn' } }]);
    const created = await first.createSession({ title: 's', goal: 'g' });
    const agent = await first.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });
    await first.send(created.sessionId, agent.agentId, TEXT('go'));

    const resumed = await manager().resumeSession(created.sessionId);
    // A record restored as `running` shows a spinner for a turn that is gone.
    expect(resumed.agents[0]?.status).toBe('idle');
    expect(resumed.agents[0]?.resumeToken).toBeNull();
  });

  it('continues the conversation after a restart, rehydrating from the log', async () => {
    const first = manager([
      { kind: 'text', text: 'first answer' },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const created = await first.createSession({ title: 's', goal: 'g' });
    const agent = await first.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });
    await first.send(created.sessionId, agent.agentId, TEXT('first question'));

    const second = manager([
      { kind: 'text', text: 'second answer' },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    await second.resumeSession(created.sessionId);
    await second.send(created.sessionId, agent.agentId, TEXT('second question'));

    const events = await second.events(created.sessionId);
    const turns = events.filter((e) => e.type === 'user.turn');
    expect(turns).toHaveLength(2);

    // Echo reports nativeResume: false, so this went through rehydrate() — the
    // durable path, which is the one that has to work (§5.4).
    const started = events.filter((e) => e.type === 'agent.started');
    expect(started.at(-1)).toMatchObject({ resumeMode: 'rehydrated' });
  });

  it('is idempotent — resuming a loaded session returns the same record', async () => {
    const sm = manager();
    const created = await sm.createSession({ title: 's', goal: 'g' });
    const again = await sm.resumeSession(created.sessionId);
    expect(again.sessionId).toBe(created.sessionId);
    expect(sm.list()).toHaveLength(1);
  });

  it('loads the session even when an agent’s runtime is gone', async () => {
    const first = manager();
    const created = await first.createSession({ title: 's', goal: 'g' });
    await first.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });

    // The app reopens without the echo runtime registered — an uninstalled CLI,
    // a removed provider.
    const second = manager(undefined, { withEcho: false });
    const unavailable: string[] = [];
    second.on('agent-unavailable', (_s, agentId: string) => unavailable.push(agentId));

    const resumed = await second.resumeSession(created.sessionId);

    // Refusing the whole session would let one missing runtime hide an entire
    // transcript, which is the opposite of what the log is for.
    expect(resumed.title).toBe('s');
    expect(resumed.agents).toHaveLength(0);
    expect(unavailable).toHaveLength(1);
    expect((await second.events(created.sessionId)).length).toBeGreaterThan(0);
  });

  it('forwards live appends for the UI', async () => {
    const sm = manager([
      { kind: 'text', text: 'hello' },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const created = await sm.createSession({ title: 's', goal: 'g' });

    const seen: string[] = [];
    sm.on('event', (_sessionId, e: { type: string }) => seen.push(e.type));

    const agent = await sm.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });
    await sm.send(created.sessionId, agent.agentId, TEXT('go'));

    expect(seen).toContain('agent.created');
    expect(seen).toContain('user.turn');
    expect(seen).toContain('agent.text');
  });

  it('forwards appends on a resumed session too', async () => {
    const first = manager();
    const created = await first.createSession({ title: 's', goal: 'g' });

    const second = manager([{ kind: 'stop', stop: { kind: 'end_turn' } }]);
    await second.resumeSession(created.sessionId);

    const seen: string[] = [];
    second.on('event', (_s, e: { type: string }) => seen.push(e.type));

    const agent = await second.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });
    await second.send(created.sessionId, agent.agentId, TEXT('go'));

    // The hook is wired in resumeSession as well as createSession; missing it
    // there would make reopened sessions look frozen until a manual refresh.
    expect(seen).toContain('user.turn');
    expect(seen).toContain('agent.stopped');
  });
});

describe('listOnDisk', () => {
  it('finds sessions written by a previous run', async () => {
    const first = manager();
    const a = await first.createSession({ title: 'Alpha', goal: 'ga' });
    const b = await first.createSession({ title: 'Beta', goal: 'gb' });

    const found = await manager().listOnDisk();
    expect(found.map((s) => s.title).sort()).toEqual(['Alpha', 'Beta']);
    expect(found.map((s) => s.sessionId).sort()).toEqual([a.sessionId, b.sessionId].sort());
  });

  it('returns empty for a workspace with no sessions', async () => {
    expect(await manager().listOnDisk()).toEqual([]);
  });

  it('skips an unreadable entry instead of hiding every good one', async () => {
    const first = manager();
    const good = await first.createSession({ title: 'Good', goal: 'g' });

    const junk = join(workspaceLayout(root).sessionsDir, 'not-a-session');
    await mkdir(junk, { recursive: true });
    await writeFile(join(junk, 'session.json'), '{ broken', 'utf8');

    const found = await manager().listOnDisk();
    expect(found).toHaveLength(1);
    expect(found[0]?.sessionId).toBe(good.sessionId as SessionId);
  });
});

/**
 * Permission requests must outlive the process that asked (DESIGN.md §7, §16).
 *
 * The in-memory version could not survive the thing it needed to: a pending
 * request was a `resolve` closure in a `Map`, unreachable from another client and
 * dead with its process. Under a host that keeps running while clients come and
 * go, that left an agent blocked on a promise nobody could resolve.
 */
describe('durable permission requests', () => {
  const asksBash: EchoStep[] = [
    { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
    { kind: 'stop', stop: { kind: 'end_turn' } },
  ];

  it('records the request in the log before anyone answers', async () => {
    const sm = manager(asksBash);
    const created = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });

    const asked = new Promise<string>((resolve) => {
      sm.on('permission', (r: { requestId: string }) => resolve(r.requestId));
    });
    const turn = sm.send(created.sessionId, agent.agentId, TEXT('go'));
    const requestId = await asked;

    // Durable while still unanswered — that is the whole point.
    const events = await sm.events(created.sessionId);
    expect(events.some((e) => e.type === 'permission.requested')).toBe(true);

    const projection = await sm.projection(created.sessionId);
    expect(projection.pendingPermissions.map((p) => p.requestId)).toEqual([requestId]);
    expect(projection.pendingPermissions[0]?.tool).toBe('bash');

    await sm.respondPermission(requestId, { result: 'deny', reason: 'no' });
    await turn;

    // Answering removes it from the folded set, so pending is exactly
    // requested-minus-decided rather than a second source of truth.
    expect((await sm.projection(created.sessionId)).pendingPermissions).toEqual([]);
  });

  it('does not log a request for a call policy settles without asking', async () => {
    const sm = manager([
      // `read` inside the workspace is `allow` under §13's defaults.
      { kind: 'tool', tool: 'read', args: { file_path: 'a.ts' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const created = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });
    await sm.send(created.sessionId, agent.agentId, TEXT('go'));

    const events = await sm.events(created.sessionId);
    // Logging every auto-allowed call here would double the log for no gain; the
    // decision is already recorded, which is what §13 requires.
    expect(events.some((e) => e.type === 'permission.requested')).toBe(false);
    expect(events.some((e) => e.type === 'permission.decided')).toBe(true);
  });

  it('withdraws a request left outstanding by a dead process', async () => {
    const first = manager(asksBash);
    const created = await first.createSession({ title: 's', goal: 'g' });
    const agent = await first.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });

    const asked = new Promise<string>((resolve) => {
      first.on('permission', (r: { requestId: string }) => resolve(r.requestId));
    });
    void first.send(created.sessionId, agent.agentId, TEXT('go'));
    const requestId = await asked;

    // The app dies with the prompt still on screen. `first` is unreachable now.
    const second = manager(asksBash);
    // Announced as well as logged: a client attached to the resumed session is
    // showing that prompt, and a question nobody can answer any more has to come
    // off every screen rather than waiting to be pressed and refused.
    const announced: Array<Record<string, unknown>> = [];
    second.on('permission-resolved', (r: Record<string, unknown>) => announced.push(r));
    const resumed = await second.resumeSession(created.sessionId);

    // Offering it would be worse than offering nothing: the promise it was
    // waiting on is gone, so answering would silently do nothing.
    expect((await second.projection(created.sessionId)).pendingPermissions).toEqual([]);
    const events = await second.events(created.sessionId);
    expect(events.some((e) => e.type === 'permission.withdrawn')).toBe(true);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toMatchObject({ requestId, outcome: 'withdrawn' });
    // No actor: nobody decided. Naming someone would invent a decision.
    expect(announced[0]?.['actor']).toBeUndefined();

    // And the session is not left claiming it needs an answer.
    expect(resumed.state).not.toBe('awaiting_permission');
    await expect(
      second.respondPermission(requestId, { result: 'allow', scope: 'once' }),
    ).resolves.toBe('unknown');
  });

  it('lets the first answer win and tells the second what happened', async () => {
    const sm = manager(asksBash);
    const created = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(created.sessionId, { role: 'worker', runtimeId: 'echo' });

    const asked = new Promise<string>((resolve) => {
      sm.on('permission', (r: { requestId: string }) => resolve(r.requestId));
    });
    const turn = sm.send(created.sessionId, agent.agentId, TEXT('go'));
    const requestId = await asked;

    // Two devices showing the same prompt, both clicked.
    const first = await sm.respondPermission(requestId, { result: 'deny', reason: 'no' });
    const second = await sm.respondPermission(requestId, { result: 'allow', scope: 'once' });
    await turn;

    expect(first).toBe('answered');
    // Not `unknown`: the UI should say "answered on another device", not imply the
    // prompt was never real.
    expect(second).toBe('already-answered');

    // And the second answer changed nothing — one decision in the log.
    const decided = (await sm.events(created.sessionId)).filter(
      (e) => e.type === 'permission.decided',
    );
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ decision: { result: 'deny' } });
  });
});
