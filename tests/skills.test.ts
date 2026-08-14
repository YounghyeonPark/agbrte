/**
 * Skills injected into a session (§17 Q21) — §17.1's "progressive instruction
 * loading", built on Q20's session-tool channel.
 *
 * The properties under test: a skill is session state recorded whole in the
 * log; it surfaces as a `skill__<id>` tool whose call returns the body; the
 * load is allowed by an explicit, inspectable rule a `deny` still outranks;
 * and — the half MCP deliberately does not have — it survives a restart,
 * because a skill is pure data and the log is the truth.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { AgbrteHarnessRuntime } from '@main/runtime/runtimes/agbrteHarness.js';
import { openWorkspace } from '@main/store/identity.js';
import type {
  InstanceId,
  ModelEndpoint,
  ModelProvider,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
  SessionId,
  SkillConfig,
} from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
const managers: SessionManager[] = [];

const SKILL: SkillConfig = {
  id: 'review',
  description: 'How this repo reviews a diff',
  instructions: 'Read the diff twice. Check §13 first. Never approve your own change.',
};

const ENDPOINT: ModelEndpoint = {
  endpointId: 'test',
  providerId: 'stub',
  auth: { kind: 'none' },
  locality: 'app-local',
  dataHandling: { provider: 'stub' },
};

const CAPS: RuntimeCapabilities = {
  nativeResume: false,
  interruptible: true,
  subagents: false,
  streaming: false,
  streamingToolArgs: false,
  tools: 'native',
  parallelToolCalls: 'one',
  schemaProfile: 'json-schema-full',
  toolResultPairing: 'batched',
  permissionFidelity: 'callback',
  contextWindow: 32_768,
  maxOutputTokens: 2_048,
  serverSideCompaction: false,
  caching: 'none',
  reasoningControl: 'none',
  reasoningVisible: 'none',
  input: { image: false, audio: false, pdf: false, video: false },
  pricing: 'free',
  costReporting: 'per-request',
  tokenCounter: 'local-estimate',
  quotaModel: 'per-token-billing',
};

class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly version = '0.0.1';
  readonly requests: ProviderRequest[] = [];
  private index = 0;

  constructor(private readonly script: Array<Partial<ProviderResult>>) {}

  async listModels() {
    return [{ modelId: 'stub-model' }];
  }
  async probe(): Promise<RuntimeCapabilities> {
    return CAPS;
  }
  async invoke(req: ProviderRequest): Promise<ProviderResult> {
    this.requests.push(req);
    const step = this.script[Math.min(this.index, this.script.length - 1)];
    this.index += 1;
    return {
      content: [],
      toolCalls: [],
      stop: { kind: 'end_turn' },
      usage: { inputTokens: 10, outputTokens: 5 },
      raw: {},
      ...step,
    };
  }
}

function manager(provider: StubProvider): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new AgbrteHarnessRuntime({ provider, endpointFor: () => ENDPOINT }), {
    label: 'Harness',
    model: 'required',
  });
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const LOAD_SKILL: Partial<ProviderResult> = {
  toolCalls: [{ id: 'call-1', name: 'skill__review', args: {} }],
  stop: { kind: 'tool_calls' },
};

async function addWorker(m: SessionManager, sessionId: string) {
  return m.addAgent(sessionId as SessionId, {
    role: 'worker',
    runtimeId: 'agbrte-harness',
    model: { providerId: 'stub', modelId: 'stub-model' },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-skills-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('a skill is session state, loaded on demand', () => {
  it('is recorded whole, declared to the model, and loads without a prompt', async () => {
    const provider = new StubProvider([LOAD_SKILL, {}]);
    const m = manager(provider);
    const session = await m.createSession({ title: 's', goal: 'g', skills: [SKILL] });

    expect(session.skills).toEqual([{ id: 'review', description: SKILL.description }]);
    const attached = (await m.events(session.sessionId)).find((e) => e.type === 'skill.attached');
    if (attached?.type !== 'skill.attached') throw new Error('no attach event');
    expect(attached.instructions).toBe(SKILL.instructions);

    const agent = await addWorker(m, session.sessionId);
    let prompted = false;
    m.on('permission', () => {
      prompted = true;
    });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    // Declared with the description — the discovery half of progressive loading.
    const declared = provider.requests[0]?.tools?.find((t) => t.name === 'skill__review');
    expect(declared?.description).toContain(SKILL.description);

    // Loaded by an explicit allow rule, not a prompt and not a bypass: the
    // decision is still written, via 'policy', naming the rule.
    expect(prompted).toBe(false);
    const events = await m.events(session.sessionId);
    const decided = events.find((e) => e.type === 'permission.decided');
    if (decided?.type !== 'permission.decided') throw new Error('no decision');
    expect(decided.via).toBe('policy');
    expect(decided.rule).toEqual({ tool: 'skill__review', action: 'allow' });
    const result = events.find((e) => e.type === 'agent.tool_result');
    if (result?.type !== 'agent.tool_result') throw new Error('no result');
    expect(result.ok).toBe(true);
  }, 30_000);

  it('is still outranked by a deny, because the rule is a rule', async () => {
    // deny → ask → allow (§13): the injected allow cannot defeat a policy
    // that names the skill as forbidden.
    const provider = new StubProvider([LOAD_SKILL, {}]);
    const m = manager(provider);
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      skills: [SKILL],
      policy: {
        defaultAction: 'ask',
        rules: [{ tool: 'skill__review', action: 'deny' }],
      },
    });
    const agent = await addWorker(m, session.sessionId);
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    const decided = (await m.events(session.sessionId)).find(
      (e) => e.type === 'permission.decided',
    );
    if (decided?.type !== 'permission.decided') throw new Error('no decision');
    expect(decided.decision.result).toBe('deny');
  }, 30_000);

  it('survives a restart, unlike an MCP server, because the log holds all of it', async () => {
    const first = manager(new StubProvider([{}]));
    const created = await first.createSession({ title: 's', goal: 'g', skills: [SKILL] });
    await addWorker(first, created.sessionId);

    const provider = new StubProvider([LOAD_SKILL, {}]);
    const second = manager(provider);
    const resumed = await second.resumeSession(created.sessionId as SessionId);

    expect(resumed.skills).toEqual([{ id: 'review', description: SKILL.description }]);
    let prompted = false;
    second.on('permission', () => {
      prompted = true;
    });
    await second.send(created.sessionId as SessionId, resumed.agents[0]!.agentId, TEXT('go'));

    expect(prompted).toBe(false);
    const result = (await second.events(created.sessionId as SessionId)).find(
      (e) => e.type === 'agent.tool_result' && e.ok,
    );
    expect(result, 'the skill did not load after the restart').toBeDefined();
  }, 30_000);

  it('refuses an oversized body rather than truncating it', async () => {
    const m = manager(new StubProvider([{}]));
    await expect(
      m.createSession({
        title: 's',
        goal: 'g',
        skills: [{ ...SKILL, instructions: 'x'.repeat(9_000) }],
      }),
    ).rejects.toThrow(/8,000/);
  }, 30_000);

  it('refuses an id that cannot become a tool name', async () => {
    const m = manager(new StubProvider([{}]));
    await expect(
      m.createSession({ title: 's', goal: 'g', skills: [{ ...SKILL, id: 'Not OK' }] }),
    ).rejects.toThrow(/lowercase/);
  }, 30_000);
});
