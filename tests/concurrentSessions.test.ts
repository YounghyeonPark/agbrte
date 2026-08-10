/**
 * Phase 4's first criterion, run rather than assumed (DESIGN.md §15).
 *
 * > *Done when:* ten concurrent sessions across three workspaces, three models,
 * > and two auth modes are legible at a glance …
 *
 * "Legible at a glance" is a UI property and not testable here. What is testable
 * is everything the glance depends on: ten turns genuinely in flight at once,
 * across three hosts, every one completing, and every session's record ending up
 * describing itself and not its neighbour.
 *
 * That last one is the reason to write this. Ten sessions interleaving through
 * one manager is exactly where a shared buffer, a misfiled event or an off-by-one
 * in a queue shows up — and none of the existing tests run more than one turn at
 * a time.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentId, InstanceId, SessionId } from '@shared/types/index.js';

const roots: string[] = [];
const managers: SessionManager[] = [];

beforeEach(() => {
  roots.length = 0;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  for (const root of roots) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A reply that echoes the turn back, so a session can be caught reading another's. */
const script = (): EchoStep[] => [
  { kind: 'text', text: 'working' },
  { kind: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.001 },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

async function workspace(): Promise<{ manager: SessionManager; instanceId: InstanceId }> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-concurrent-'));
  roots.push(root);
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: script() }), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId: identity.instanceId });
  managers.push(manager);
  return { manager, instanceId: identity.instanceId };
}

describe('ten sessions at once, across three workspaces', () => {
  it('runs them all and finishes them all', async () => {
    const hosts = await Promise.all([workspace(), workspace(), workspace()]);

    // Ten sessions spread over three workspaces, started before any of them is
    // sent to — so the turns genuinely overlap rather than queueing behind each
    // other's setup.
    const made = await Promise.all(
      Array.from({ length: 10 }, async (_unused, i) => {
        const host = hosts[i % hosts.length]!;
        const session = await host.manager.createSession({ title: `s${i}`, goal: `goal ${i}` });
        const agent = await host.manager.addAgent(session.sessionId, {
          role: 'worker',
          runtimeId: 'echo',
        });
        return { manager: host.manager, sessionId: session.sessionId, agentId: agent.agentId, i };
      }),
    );

    await Promise.all(
      made.map(({ manager, sessionId, agentId, i }) =>
        manager.send(sessionId as SessionId, agentId as AgentId, {
          content: [{ type: 'text', text: `turn for session ${i}` }],
        }),
      ),
    );

    for (const { manager, sessionId } of made) {
      expect((await manager.get(sessionId as SessionId)).state).toBe('awaiting_input');
    }
  }, 60_000);

  it('gives every session its own transcript, not its neighbour’s', async () => {
    /**
     * The assertion the rest exists for. Ten turns interleaving through one
     * manager is where a shared buffer or a misfiled event would show, and it
     * would show as a line appearing in the wrong session — which reads as a
     * model saying something strange rather than as a routing bug.
     */
    const host = await workspace();

    const made = await Promise.all(
      Array.from({ length: 10 }, async (_unused, i) => {
        const session = await host.manager.createSession({ title: `s${i}`, goal: 'g' });
        const agent = await host.manager.addAgent(session.sessionId, {
          role: 'worker',
          runtimeId: 'echo',
        });
        return { sessionId: session.sessionId, agentId: agent.agentId, i };
      }),
    );

    await Promise.all(
      made.map(({ sessionId, agentId, i }) =>
        host.manager.send(sessionId as SessionId, agentId as AgentId, {
          content: [{ type: 'text', text: `unique marker ${i}` }],
        }),
      ),
    );

    for (const { sessionId, i } of made) {
      const events = await host.manager.events(sessionId as SessionId);
      const text = JSON.stringify(events);

      expect(text).toContain(`unique marker ${i}`);
      // And nobody else's. A session carrying two markers is the bug.
      for (const other of made) {
        if (other.i !== i) expect(text).not.toContain(`unique marker ${other.i}`);
      }
    }
  }, 60_000);

  it('accounts for each session separately', async () => {
    // Usage is per agent (§10) and ten concurrent turns is where a shared
    // accumulator would show up as one session billed for all of them.
    const host = await workspace();

    const made = await Promise.all(
      Array.from({ length: 10 }, async (_unused, i) => {
        const session = await host.manager.createSession({ title: `s${i}`, goal: 'g' });
        const agent = await host.manager.addAgent(session.sessionId, {
          role: 'worker',
          runtimeId: 'echo',
        });
        return { sessionId: session.sessionId, agentId: agent.agentId };
      }),
    );

    await Promise.all(
      made.map(({ sessionId, agentId }) =>
        host.manager.send(sessionId as SessionId, agentId as AgentId, {
          content: [{ type: 'text', text: 'go' }],
        }),
      ),
    );

    for (const { sessionId } of made) {
      const session = await host.manager.get(sessionId as SessionId);
      expect(session.agents[0]?.usage.inputTokens).toBe(10);
      expect(session.agents[0]?.usage.outputTokens).toBe(5);
    }
  }, 60_000);
});
