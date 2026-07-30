/**
 * Tier-3 behavior: the durable resume path, provenance, and capability
 * enforcement at call sites.
 *
 * Each test here corresponds to a review finding where the type said one thing
 * and the running code did another.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoConfig } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { InstanceId, NormalizedTurn, RuntimeCapabilities } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-resume-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function build(config: EchoConfig = {}, caps?: Partial<RuntimeCapabilities>) {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ ...config, ...(caps ? { capabilities: caps } : {}) }), {
    label: 'Echo',
    requiresModel: false,
  });
  return new SessionManager({ registry, workspaceRoot: root, instanceId });
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

async function twoTurns(sm: SessionManager) {
  const session = await sm.createSession({ title: 's', goal: 'the goal' });
  const agent = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  await sm.send(session.sessionId, agent.agentId, TEXT('first'));
  await sm.send(session.sessionId, agent.agentId, TEXT('second'));
  return { session, agent };
}

describe('durable resume (§5.4)', () => {
  it('rehydrates on the second turn when the runtime has no native resume', async () => {
    const seeds: Array<NormalizedTurn[] | undefined> = [];
    const sm = build({ onSeed: (s) => seeds.push(s) });

    const { session } = await twoTurns(sm);

    const events = await sm.events(session.sessionId);
    const modes = events
      .filter((e) => e.type === 'agent.started')
      .map((e) => ('resumeMode' in e ? e.resumeMode : null));

    // Previously both turns logged 'fresh' and the agent silently forgot
    // everything — gating on token presence instead of the capability.
    expect(modes).toEqual(['fresh', 'rehydrated']);
    expect(seeds[0]).toBeUndefined();
    expect(seeds[1]?.[0]?.role).toBe('system');
  });

  it('carries the goal and prior turn into the rehydrated seed', async () => {
    const seeds: Array<NormalizedTurn[] | undefined> = [];
    const sm = build({ onSeed: (s) => seeds.push(s) });
    await twoTurns(sm);

    const flat = (seeds[1] ?? [])
      .flatMap((t) => t.content)
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n');

    expect(flat).toContain('the goal');
    expect(flat).toContain('first');
  });

  it('records how far through the log a rehydrated seed reaches', async () => {
    const sm = build();
    const { session } = await twoTurns(sm);

    const events = await sm.events(session.sessionId);
    const started = events.filter((e) => e.type === 'agent.started').at(-1);
    expect(started && 'seededThroughSeq' in started && started.seededThroughSeq).toBeGreaterThan(1);
  });

  it('uses native resume when the runtime declares it and holds a token', async () => {
    const sm = build({ resumeToken: 'tok-1' }, { nativeResume: true });
    const { session } = await twoTurns(sm);

    const events = await sm.events(session.sessionId);
    const modes = events
      .filter((e) => e.type === 'agent.started')
      .map((e) => ('resumeMode' in e ? e.resumeMode : null));
    expect(modes).toEqual(['fresh', 'native']);
  });

  it('falls through to the durable path when native resume is rejected', async () => {
    const rejections: unknown[] = [];
    const sm = build(
      { resumeToken: 'tok-1', resumeError: 'session expired' },
      { nativeResume: true },
    );
    sm.on('resume-rejected', (...args) => rejections.push(args));

    const { session } = await twoTurns(sm);

    // A rejected token is ordinary — a moved workspace, an upgraded runtime.
    expect(rejections).toHaveLength(1);
    const events = await sm.events(session.sessionId);
    const modes = events
      .filter((e) => e.type === 'agent.started')
      .map((e) => ('resumeMode' in e ? e.resumeMode : null));
    expect(modes).toEqual(['fresh', 'rehydrated']);
  });
});

describe('provenance (§5.1)', () => {
  it('stamps the adapter version rather than "unknown"', async () => {
    const sm = build();
    const { session } = await twoTurns(sm);

    const events = await sm.events(session.sessionId);
    const stamped = events.filter((e) => e.origin !== undefined);
    expect(stamped.length).toBeGreaterThan(0);
    for (const ev of stamped) {
      expect(ev.origin?.adapterVersion).toBe('0.0.1');
      expect(ev.origin?.adapterVersion).not.toBe('unknown');
    }
  });

  it('logs agent.created so a reloaded log resolves an agentId', async () => {
    const sm = build(undefined, { permissionFidelity: 'precomputed-allowlist' });
    const session = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(session.sessionId, {
      role: 'reviewer',
      runtimeId: 'echo',
      isolation: 'worktree',
    });

    const projection = await sm.projection(session.sessionId);
    const resolved = projection.agents.find((a) => a.agentId === agent.agentId);

    // Every permission decision names an agentId; this is what makes that
    // identifier meaningful after a restart (§13).
    expect(resolved).toMatchObject({
      role: 'reviewer',
      runtimeId: 'echo',
      isolation: 'worktree',
      permissionFidelity: 'precomputed-allowlist',
    });
  });
});

describe('capability enforcement at call sites (§3.3)', () => {
  it('does not interrupt a runtime that declares it cannot be interrupted', async () => {
    const degraded: unknown[] = [];
    const sm = build(
      { script: [{ kind: 'text', text: 'working' }] },
      { interruptible: false },
    );
    sm.on('degraded', (...args) => degraded.push(args));

    const session = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    // A script with no `stop` step: the turn only ends if something cancels it.
    const turn = sm.send(session.sessionId, agent.agentId, TEXT('go'));
    await sm.interrupt(session.sessionId, agent.agentId);

    // Declared and then ignored was the bug; the refusal is now reported.
    expect(degraded).toHaveLength(1);
    expect(String(degraded[0])).toContain('not interruptible');

    // And the turn still ends — the abort signal fires regardless of the
    // capability, so a runtime honoring only that channel remains cancellable.
    await expect(turn).resolves.toBeUndefined();
  });

  it('interrupts a runtime that declares it can be', async () => {
    const degraded: unknown[] = [];
    const sm = build({ script: [{ kind: 'text', text: 'working' }] }, { interruptible: true });
    sm.on('degraded', (...args) => degraded.push(args));

    const session = await sm.createSession({ title: 's', goal: 'g' });
    const agent = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const turn = sm.send(session.sessionId, agent.agentId, TEXT('go'));
    await sm.interrupt(session.sessionId, agent.agentId);
    await turn;

    expect(degraded).toHaveLength(0);
  });
});
