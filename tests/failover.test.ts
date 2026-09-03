/**
 * Moving a turn to another endpoint when one will not take it (§3.9, §3.3, §13).
 *
 * §3.9 says this "comes nearly free", and the reason is worth restating because
 * it is what makes the test cheap too: the conversation is reconstructed from
 * our own log rather than held as provider state, so nothing has to be migrated
 * — the next endpoint is simply asked the same thing. No GPU box is needed to
 * check that, only two stubs that answer differently.
 *
 * What is expensive to get wrong is *when* it moves. Every stop reason that is
 * not in the list is one where moving is worse than stopping, and most of them
 * fail in a way that looks like the fallback working: a `misconfigured` request
 * retried elsewhere spends a second endpoint's turn on the same doomed call, and
 * a `limit_reached` moved is a budget the user set being ignored.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgbrteHarnessRuntime } from '@main/runtime/runtimes/agbrteHarness.js';
import { couldMoveEndpoint, moveReason } from '@main/runtime/failover.js';
import type {
  AgentSpec,
  ModelEndpoint,
  ModelProvider,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeEvent,
  StopReason,
} from '@shared/types/index.js';

const CAPS = {
  tools: 'native',
  schemaProfile: 'json-schema-full',
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  pricing: 'free',
  permissionFidelity: 'callback',
} as unknown as RuntimeCapabilities;

const answer = (text: string, stop: StopReason = { kind: 'end_turn' }): ProviderResult => ({
  content: [{ type: 'text', text }],
  toolCalls: [],
  stop,
  usage: { inputTokens: 1, outputTokens: 1 },
  raw: null,
});

const endpoint = (id: string): ModelEndpoint => ({
  endpointId: id,
  providerId: 'openai-compatible',
  baseUrl: `http://${id}/v1`,
  auth: { kind: 'none' },
  locality: 'target-local',
  dataHandling: { provider: id },
});

/** A provider whose answer depends on which endpoint it was asked through. */
function providerOver(
  byEndpoint: Record<string, ProviderResult>,
  caps: Record<string, RuntimeCapabilities> = {},
): { provider: ModelProvider; asked: string[] } {
  const asked: string[] = [];
  const provider: ModelProvider = {
    id: 'stub',
    version: '1',
    listModels: () => Promise.resolve([]),
    probe: (e) => {
      const found = caps[e.endpointId] ?? CAPS;
      return Promise.resolve(found);
    },
    invoke: (req: ProviderRequest) => {
      asked.push(req.endpoint.endpointId);
      const found = byEndpoint[req.endpoint.endpointId];
      if (found === undefined) throw new Error(`no scripted answer for ${req.endpoint.endpointId}`);
      return Promise.resolve(found);
    },
  };
  return { provider, asked };
}

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-failover-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function spec(endpointId: string): AgentSpec {
  return {
    agentId: 'a1' as AgentSpec['agentId'],
    role: 'worker',
    runtimeId: 'agbrte-harness',
    auth: { kind: 'none' },
    toolPolicy: { rules: [], default: 'deny' } as unknown as AgentSpec['toolPolicy'],
    limits: {},
    workspacePath: root,
    model: { providerId: 'openai-compatible', modelId: 'm', endpointId },
  } as unknown as AgentSpec;
}

const ctx = (): RuntimeContext =>
  ({
    abortSignal: new AbortController().signal,
    requestPermission: () => Promise.resolve({ decision: 'allow' }),
  }) as unknown as RuntimeContext;

/** Drive one turn and collect everything the handle emitted. */
async function turn(
  provider: ModelProvider,
  from: string,
  chain: Record<string, string>,
): Promise<RuntimeEvent[]> {
  const runtime = new AgbrteHarnessRuntime({
    provider,
    endpointFor: (id) => endpoint(id ?? from),
    nextEndpoint: (id) => chain[id],
    tools: [],
  });
  const handle = await runtime.start(spec(from), ctx());
  await handle.send({ content: [{ type: 'text', text: 'go' }] });

  const seen: RuntimeEvent[] = [];
  for await (const ev of handle.events) {
    seen.push(ev);
    if (ev.type === 'stopped') break;
  }
  return seen;
}

describe('which failures are worth moving', () => {
  it('moves on the four §3.9 names', () => {
    for (const stop of [
      { kind: 'refused' },
      { kind: 'unavailable' },
      { kind: 'rate_limited' },
      { kind: 'quota_exhausted', scope: 'daily' },
    ] as StopReason[]) {
      expect(couldMoveEndpoint(stop)).toBe(true);
    }
  });

  it('stays put on everything else, and each for its own reason', () => {
    /*
     * The list that matters more than the one above. `misconfigured` is
     * permanent, so retrying elsewhere spends a second endpoint on the same
     * doomed request — which is the failure it was split out of
     * `invalid_tool_args` to stop. `limit_reached` is a ceiling *we* set:
     * nothing about the endpoint is wrong and moving ignores a decision the
     * user made. The rest are not failures at all.
     */
    for (const stop of [
      { kind: 'end_turn' },
      { kind: 'tool_calls' },
      { kind: 'max_output_tokens' },
      { kind: 'context_overflow' },
      { kind: 'content_filtered', stage: 'output' },
      { kind: 'invalid_tool_args', detail: 'x' },
      { kind: 'limit_reached', limit: 'tokens' },
      { kind: 'misconfigured', detail: 'unknown model' },
    ] as StopReason[]) {
      expect(couldMoveEndpoint(stop)).toBe(false);
    }
  });

  it('does not move on a missing credential, which would change the recipient', () => {
    /*
     * The judgement call, and it is excluded. A missing key is a configuration
     * fault whose remedy is a command somebody types; moving the turn to an
     * endpoint that happens to have one would answer that by quietly sending the
     * work — and the code in it — to a different vendor, which is exactly the
     * unannounced change of recipient §13 forbids.
     */
    expect(couldMoveEndpoint({ kind: 'auth' } as StopReason)).toBe(false);
  });

  it('says why, in words that explain the discontinuity', () => {
    const said = moveReason({ kind: 'unavailable' } as StopReason, 'gpubox', 'local');
    expect(said).toContain('gpubox');
    expect(said).toContain('local');
    // A row naming only the destination invites the question this answers.
    expect(said).toContain('did not answer');
  });
});

describe('a turn that moves', () => {
  it('asks the next endpoint and returns its answer', async () => {
    const { provider, asked } = providerOver({
      gpubox: answer('', { kind: 'unavailable' }),
      local: answer('done here'),
    });

    const seen = await turn(provider, 'gpubox', { gpubox: 'local' });

    expect(asked).toEqual(['gpubox', 'local']);
    expect(seen.find((e) => e.type === 'text')).toMatchObject({ text: 'done here' });
    // The turn ends on the second endpoint's stop, not the first's.
    expect(seen.find((e) => e.type === 'stopped')).toMatchObject({ stop: { kind: 'end_turn' } });
  });

  it('records the move, because nothing else explains the change', async () => {
    const { provider } = providerOver({
      gpubox: answer('', { kind: 'quota_exhausted', scope: 'daily' } as StopReason),
      local: answer('carried on'),
    });

    const seen = await turn(provider, 'gpubox', { gpubox: 'local' });

    const moved = seen.find((e) => e.type === 'endpoint_switched');
    expect(moved).toMatchObject({ from: 'gpubox', to: 'local' });
    expect(moved && 'reason' in moved ? moved.reason : '').toContain('allowance');
  });

  it('bills the turn to the endpoint that answered, not to the seat', async () => {
    const { provider } = providerOver({
      gpubox: answer('', { kind: 'unavailable' }),
      local: answer('carried on'),
    });

    const seen = await turn(provider, 'gpubox', { gpubox: 'local' });

    /*
     * The only durable account of *where a turn went* (§13).
     *
     * `endpoint_switched` records moves and not returns, and it cannot record
     * returns: every turn starts where the seat was pointed, so a session whose
     * GPU box is refusing bounces between two providers turn by turn and emits
     * one `switched` row for each move down and nothing on the way back. A
     * reader could see "moved to the hosted API" once and had no way to learn
     * whether the next four turns went back — or that the fifth did not.
     *
     * Reading the seat instead would have been the easy version and is exactly
     * wrong: `gpubox` is the one endpoint this turn did not reach.
     */
    expect(seen.find((e) => e.type === 'usage')).toMatchObject({ endpointId: 'local' });
  });

  it('names the seat on a turn that never had to move', async () => {
    // The ordinary case, and it must be recorded too — a field present only on
    // the interesting turns would make "no endpoint" and "the usual endpoint"
    // the same absence.
    const { provider } = providerOver({ gpubox: answer('fine') });
    const seen = await turn(provider, 'gpubox', {});
    expect(seen.find((e) => e.type === 'usage')).toMatchObject({ endpointId: 'gpubox' });
  });

  it('walks the whole chain rather than one step', async () => {
    const { provider, asked } = providerOver({
      gpubox: answer('', { kind: 'unavailable' }),
      nim: answer('', { kind: 'unavailable' }),
      local: answer('third time'),
    });

    const seen = await turn(provider, 'gpubox', { gpubox: 'nim', nim: 'local' });

    expect(asked).toEqual(['gpubox', 'nim', 'local']);
    expect(seen.filter((e) => e.type === 'endpoint_switched')).toHaveLength(2);
  });

  it('stops at the end of the chain with the last failure, not a made-up one', async () => {
    const { provider, asked } = providerOver({
      gpubox: answer('', { kind: 'unavailable' }),
      local: answer('', { kind: 'unavailable' }),
    });

    const seen = await turn(provider, 'gpubox', { gpubox: 'local' });

    expect(asked).toEqual(['gpubox', 'local']);
    // The honest answer is the failure that actually happened last.
    expect(seen.find((e) => e.type === 'stopped')).toMatchObject({ stop: { kind: 'unavailable' } });
  });
});

describe('a turn that does not move', () => {
  it('leaves a chain alone when the stop is not worth moving', async () => {
    const { provider, asked } = providerOver({
      gpubox: answer('', { kind: 'misconfigured', detail: 'unknown model' } as StopReason),
      local: answer('never asked'),
    });

    await turn(provider, 'gpubox', { gpubox: 'local' });

    // One request, because retrying a permanent fault elsewhere spends a second
    // endpoint on the same doomed call.
    expect(asked).toEqual(['gpubox']);
  });

  it('does nothing on a machine that declared no chain', async () => {
    const { provider, asked } = providerOver({ gpubox: answer('', { kind: 'unavailable' }) });
    // Which is most machines: one model server, nowhere to fall back to, and
    // that is the ordinary case rather than a misconfiguration.
    await turn(provider, 'gpubox', {});
    expect(asked).toEqual(['gpubox']);
  });

  it('refuses a next endpoint that cannot do what this seat is doing', async () => {
    /*
     * §3.3 exists because "the capability spread across these is enormous" — two
     * servers speak the same wire and differ on tools. Moving a session that is
     * mid-tool-loop onto one that cannot call tools produces a model quietly
     * ignoring instructions, which §3.5 names as the failure that reads like the
     * feature being broken. The original stop is the honest answer instead.
     */
    const { provider, asked } = providerOver(
      {
        gpubox: answer('', { kind: 'unavailable' }),
        local: answer('should not be asked'),
      },
      { local: { ...CAPS, tools: 'none' } as RuntimeCapabilities },
    );

    const runtime = new AgbrteHarnessRuntime({
      provider,
      endpointFor: (id) => endpoint(id ?? 'gpubox'),
      nextEndpoint: (id) => ({ gpubox: 'local' })[id],
      // A tool declared, so the seat is one that needs them.
      tools: [
        {
          name: 'read',
          description: 'read a file',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          run: () => Promise.resolve({ ok: true, summary: 'x' }),
        } as never,
      ],
    });
    const handle = await runtime.start(spec('gpubox'), ctx());
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    for await (const ev of handle.events) if (ev.type === 'stopped') break;

    expect(asked).toEqual(['gpubox']);
  });
});
