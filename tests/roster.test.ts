/**
 * Showing a roster honestly (DESIGN.md §4.2, §13, §15 Phase 6).
 *
 * > **Fidelity is displayed per agent** — a `AgbrteHarness` agent and a
 * > wrapped-CLI agent do not enforce identical policy, and the UI must never
 * > imply they do.
 *
 * That is a safety rule, not a decoration. §4.2's payoff is a heterogeneous
 * roster — a frontier lead, cheap workers, a reviewer on a different provider —
 * and those agents are gated *differently*. One has every call checked before it
 * runs; another only has an allowlist compiled before it started. A transcript
 * that shows their work in one undifferentiated stream tells the reader they are
 * the same, which is the specific thing §13 forbids.
 */

import { describe, expect, it } from 'vitest';
import { agentLabel } from '../src/renderer/attribution.js';
import type { AgentRecord, PermissionFidelity } from '@shared/types/index.js';

function agent(over: {
  agentId: string;
  role?: string;
  fidelity?: PermissionFidelity;
  model?: string;
  status?: AgentRecord['status'];
}): AgentRecord {
  return {
    agentId: over.agentId,
    role: over.role ?? 'worker',
    spec: {
      agentId: over.agentId,
      role: over.role ?? 'worker',
      runtimeId: 'echo',
      auth: { kind: 'none' },
      toolPolicy: { rules: [], defaultAction: 'ask' },
      limits: {},
      ...(over.model !== undefined
        ? { model: { providerId: 'openai-compatible', modelId: over.model } }
        : {}),
    },
    resolvedCapabilities: { permissionFidelity: over.fidelity ?? 'callback' },
    status: over.status ?? 'idle',
    isolation: 'shared',
    resumeToken: null,
    lastEventSeq: 0,
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
  } as unknown as AgentRecord;
}

describe('labelling a row with the agent that produced it', () => {
  it('says nothing when there is only one agent', () => {
    // Every row would carry an identical label, which is noise that teaches
    // people to stop reading labels that do mean something.
    expect(agentLabel([agent({ agentId: 'a' })], 'a')).toBeNull();
  });

  it('names the agent once a roster exists', () => {
    const roster = [agent({ agentId: 'a', role: 'lead' }), agent({ agentId: 'b', role: 'reviewer' })];
    expect(agentLabel(roster, 'b')).toBe('reviewer');
  });

  it('says nothing for an event nobody is attributed with', () => {
    // Session-level events — created, state changes — belong to the session
    // rather than to an agent, and inventing an owner for them would put a name
    // on something nobody did.
    const roster = [agent({ agentId: 'a' }), agent({ agentId: 'b' })];
    expect(agentLabel(roster, undefined)).toBeNull();
  });

  it('says nothing for an agent no longer in the roster', () => {
    // A log outlives the agents in it. Guessing would be worse than silence.
    expect(agentLabel([agent({ agentId: 'a' }), agent({ agentId: 'b' })], 'gone')).toBeNull();
  });
});

describe('a session whose model was changed', () => {
  /**
   * One live seat and one retired one (§4.2). This is exactly the transcript
   * that cannot be read without labels — the rows above the change came from a
   * different model — so counting only *live* seats would silence the labels on
   * the one case that needs them.
   */
  const changed = [
    agent({ agentId: 'a', role: 'lead', model: 'qwen2.5:7b', status: 'retired' }),
    agent({ agentId: 'b', role: 'lead', model: 'claude-sonnet' }),
  ];

  it('still labels rows, including the retired seat’s', () => {
    expect(agentLabel(changed, 'a')).toBe('qwen2.5:7b');
    expect(agentLabel(changed, 'b')).toBe('claude-sonnet');
  });

  it('labels by model where the roles are identical', () => {
    // Both seats are `lead`, so a role would put the same word on both sides of
    // the change and explain nothing.
    expect(new Set(changed.map((a) => a.role)).size).toBe(1);
    expect(agentLabel(changed, 'a')).not.toBe(agentLabel(changed, 'b'));
  });
});
