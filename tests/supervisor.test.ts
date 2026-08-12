import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pumpAgent, stateForStop, stopReasonSummary } from '@main/runtime/supervisor.js';
import { stopDisposition } from '@shared/types/index.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { SessionStore } from '@main/store/sessionStore.js';
import { openWorkspace } from '@main/store/identity.js';
import {
  newAgentId,
  newSessionId,
  type AgentSpec,
  type EventOrigin,
  type PermissionDecision,
  type RuntimeContext,
  type SessionState,
  type StopReason,
  type ToolPolicy,
} from '@shared/types/index.js';

const POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };
const ORIGIN: EventOrigin = { runtimeId: 'echo', adapterVersion: '0.0.1' };

let root: string;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-sup-'));
  const { instanceId } = await openWorkspace(root);
  store = await SessionStore.create(root, {
    sessionId: newSessionId(),
    instanceId,
    title: 'pump',
    goal: 'g',
    createdAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function agentSpec(): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'echo',
    auth: { kind: 'none' },
    toolPolicy: POLICY,
    limits: {},
    workspacePath: root,
  };
}

function context(decide: (tool: string) => PermissionDecision = () => ({ result: 'allow', scope: 'once' })): RuntimeContext {
  return {
    requestPermission: async (req) => decide(req.tool),
    reportProgress: () => undefined,
    abortSignal: new AbortController().signal,
  };
}

async function runScript(script: EchoStep[] | undefined, ctx = context()) {
  const runtime = new EchoRuntime(script ? { script } : {});
  const spec = agentSpec();
  const handle = await runtime.start(spec, ctx);
  const pumped = pumpAgent(handle, store, { origin: ORIGIN });
  await handle.send({ content: [{ type: 'text', text: 'hello' }] });
  return pumped;
}

describe('stateForStop', () => {
  const cases: Array<[StopReason, SessionState]> = [
    [{ kind: 'end_turn' }, 'awaiting_input'],
    [{ kind: 'tool_calls' }, 'working'],
    [{ kind: 'quota_exhausted', scope: 'weekly' }, 'awaiting_quota'],
    [{ kind: 'auth' }, 'awaiting_credentials'],
    [{ kind: 'rate_limited' }, 'awaiting_input'],
    [{ kind: 'unavailable' }, 'awaiting_input'],
    [{ kind: 'transport' }, 'awaiting_input'],
    [{ kind: 'context_overflow' }, 'awaiting_input'],
    [{ kind: 'limit_reached', limit: 'turns' }, 'awaiting_input'],
    [{ kind: 'refused' }, 'failed'],
    [{ kind: 'content_filtered', stage: 'output' }, 'failed'],
    [{ kind: 'max_output_tokens' }, 'failed'],
    [{ kind: 'misconfigured', detail: 'model_not_found' }, 'failed'],
  ];

  for (const [stop, expected] of cases) {
    it(`maps ${stop.kind} to ${expected}`, () => {
      expect(stateForStop(stop)).toBe(expected);
    });
  }

  /**
   * `working` means an agent is working. By the time this is asked, `pumpAgent`
   * has returned and none is.
   *
   * Five kinds were mapped to `working` on the strength of a comment saying "the
   * supervisor retries". Nothing retries — not the provider, not the runtime,
   * not the supervisor, not the session manager. `stopDisposition` returns
   * `'retry'` and its only reader turns it into `idle`. So a rate limit, a
   * dropped connection or a full context ended the turn, left the session
   * displayed as busy, raised no `needsAttention` because `working` is not in
   * the attention family, and waited for a retry that no code performs.
   *
   * On a workbench whose premise is unattended runs, that is the worst available
   * shape: a stall that reports progress. Until something does retry, these say
   * a person is needed.
   */
  it('never leaves a finished turn looking like a running one', () => {
    const ended: StopReason[] = [
      { kind: 'rate_limited' },
      { kind: 'unavailable' },
      { kind: 'transport' },
      { kind: 'context_overflow' },
      { kind: 'invalid_tool_args', detail: 'bad json' },
    ];
    for (const stop of ended) {
      expect(stateForStop(stop), `${stop.kind} leaves the session displayed as working`).not.toBe(
        'working',
      );
    }
  });

  it('asks for a person on anything that stopped and will not resume itself', () => {
    // Not `failed`: none of these is a permanent fault, and §4.1 reserves
    // failure for things that will not come back.
    for (const stop of [{ kind: 'rate_limited' }, { kind: 'transport' }] as StopReason[]) {
      expect(stateForStop(stop)).toBe('awaiting_input');
    }
  });

  it('never maps a pause condition to failed', () => {
    // The highest-cost bug in the orchestrator (§4.1).
    for (const stop of [
      { kind: 'quota_exhausted', scope: 'window' } as StopReason,
      { kind: 'auth' } as StopReason,
      { kind: 'limit_reached', limit: 'cost' } as StopReason,
    ]) {
      expect(stateForStop(stop)).not.toBe('failed');
    }
  });

  it('does not park a self-imposed ceiling in awaiting_quota', () => {
    // `awaiting_quota`'s contract is "resume at resetsAt". A `maxTurns` ceiling
    // has no reset, so a session mapped there waits forever.
    expect(stateForStop({ kind: 'limit_reached', limit: 'turns' })).not.toBe('awaiting_quota');
  });

  it('fails a permanent config fault rather than retrying it', () => {
    expect(stopDisposition({ kind: 'misconfigured', detail: 'model_not_found' })).toBe('fail');
    // The point of the distinction: `invalid_tool_args` is the retryable one.
    expect(stopDisposition({ kind: 'invalid_tool_args', detail: 'x' })).toBe('retry');
  });
});

describe('pumpAgent', () => {
  it('writes text and usage to the log and reports the stop', async () => {
    const outcome = await runScript(undefined);

    expect(outcome.stop).toEqual({ kind: 'end_turn' });
    expect(outcome.disposition).toBe('done');
    expect(outcome.nextState).toBe('awaiting_input');
    expect(outcome.eventsWritten).toBe(3); // text + usage + stopped

    const { projection } = await store.load();
    expect(projection.usage.outputTokens).toBeGreaterThan(0);
  });

  it('routes every tool call through the permission gate', async () => {
    const seen: string[] = [];
    const ctx = context((tool) => {
      seen.push(tool);
      return { result: 'allow', scope: 'once' };
    });

    await runScript(
      [
        { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
        { kind: 'stop', stop: { kind: 'end_turn' } },
      ],
      ctx,
    );

    expect(seen).toEqual(['bash']);
    const { projection } = await store.load();
    expect(projection.stats.toolCalls).toBe(1);
    expect(projection.stats.toolErrors).toBe(0);
  });

  it('records a denial as a failed tool result with the reason', async () => {
    const ctx = context(() => ({ result: 'deny', reason: 'outside workspace' }));
    await runScript(
      [
        { kind: 'tool', tool: 'write', args: { file_path: '/etc/hosts' } },
        { kind: 'stop', stop: { kind: 'end_turn' } },
      ],
      ctx,
    );

    const { projection } = await store.load();
    // A denial is a tool error the agent can adapt to, not a session failure.
    expect(projection.stats.toolErrors).toBe(1);
    expect(projection.state).not.toBe('failed');
  });

  it('pauses rather than failing on an exhausted quota', async () => {
    const outcome = await runScript([
      {
        kind: 'stop',
        stop: { kind: 'quota_exhausted', scope: 'weekly', resetsAt: '2026-08-05T00:00:00Z' },
      },
    ]);

    expect(outcome.disposition).toBe('pause');
    expect(outcome.nextState).toBe('awaiting_quota');
    expect(stopReasonSummary(outcome.stop)).toContain('2026-08-05');
  });

  it('pauses on an auth failure so a sleeping laptop costs no work', async () => {
    const outcome = await runScript([{ kind: 'stop', stop: { kind: 'auth' } }]);
    expect(outcome.disposition).toBe('pause');
    expect(outcome.nextState).toBe('awaiting_credentials');
  });

  it('treats a stream that ends without a stop event as a retryable transport failure', async () => {
    // A silently truncated turn reported as success is the worst outcome
    // available, because it looks like the work was done.
    const outcome = await runScript([{ kind: 'text', text: 'partial…' }, { kind: 'die' }]);

    expect(outcome.stop).toEqual({ kind: 'transport' });
    // Still classified retryable — that part was always true.
    expect(outcome.disposition).toBe('retry');
    // But nothing performs the retry, so the session must not sit there looking
    // like it is still going. `working` said the truncated turn was in progress.
    expect(outcome.nextState).toBe('awaiting_input');
  });

  it('marks a refusal as a genuine failure', async () => {
    const outcome = await runScript([
      { kind: 'stop', stop: { kind: 'refused', category: 'cyber' } },
    ]);
    expect(outcome.disposition).toBe('fail');
    expect(outcome.nextState).toBe('failed');
    expect(stopReasonSummary(outcome.stop)).toBe('refused (cyber)');
  });

  it('accumulates usage across several events and keeps unknown cost absorbing', async () => {
    const outcome = await runScript([
      { kind: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.01 },
      { kind: 'usage', inputTokens: 20, outputTokens: 5 },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);

    expect(outcome.usage.inputTokens).toBe(30);
    expect(outcome.usage.cost).toBe(0.01);
  });

  it('surfaces a resume token when the runtime has one', async () => {
    const runtime = new EchoRuntime({
      resumeToken: 'sess-abc',
      script: [{ kind: 'stop', stop: { kind: 'end_turn' } }],
    });
    const handle = await runtime.start(agentSpec(), context());
    const pumped = pumpAgent(handle, store, { origin: ORIGIN });
    await handle.send({ content: [{ type: 'text', text: 'x' }] });

    expect((await pumped).resumeToken).toBe('sess-abc');
  });

  it('reports null for a runtime with no native resume', async () => {
    const outcome = await runScript([{ kind: 'stop', stop: { kind: 'end_turn' } }]);
    // The durable path does not depend on this being present (§5.4).
    expect(outcome.resumeToken).toBeNull();
  });

  it('stamps provenance on every durable event', async () => {
    await runScript(undefined);
    const events = (await store.load()).projection;
    expect(events.lastSeq).toBeGreaterThan(1);

    const { store: reopened } = await SessionStore.open(root, store.sessionId);
    const meta = await reopened.readMeta();
    expect(meta.title).toBe('pump');
  });
});
