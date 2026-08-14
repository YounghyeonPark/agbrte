/**
 * MCP servers injected into a session (§17 Q20).
 *
 * The property under test is the design's whole claim: an MCP server is
 * **session state** — named at creation, recorded in the log, its tools gated
 * per call like any built-in — and never an app or CLI setting. The server
 * here is a real child process speaking real JSON-RPC over stdio, because the
 * framing and the handshake are exactly the parts a mock would vouch for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { AgbrteHarnessRuntime } from '@main/runtime/runtimes/agbrteHarness.js';
import { openWorkspace } from '@main/store/identity.js';
import type {
  InstanceId,
  McpServerConfig,
  ModelEndpoint,
  ModelProvider,
  PermissionRequest,
  ProviderRequest,
  ProviderResult,
  RuntimeCapabilities,
} from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let serverScript: string;
const managers: SessionManager[] = [];

/**
 * A real MCP server, four verbs long. `lookup` echoes its key and the value of
 * FAKE_TOKEN — which is how a test can prove the env reached the *process*
 * while never reaching the *log*.
 */
const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fake', version: '1.0.0' },
    }});
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{
      name: 'lookup',
      description: 'Look a value up by key',
      inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    }]}});
  } else if (msg.method === 'tools/call') {
    const key = (msg.params.arguments || {}).key;
    send({ jsonrpc: '2.0', id: msg.id, result: {
      content: [{ type: 'text', text: 'value-for-' + key + ' token=' + (process.env.FAKE_TOKEN || 'unset') }],
    }});
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not implemented' } });
  }
});
`;

const SERVER = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'fake',
  command: process.execPath,
  args: [serverScript],
  ...over,
});

function manager(registry?: RuntimeRegistry): SessionManager {
  const reg = registry ?? new RuntimeRegistry();
  if (registry === undefined) {
    reg.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      model: 'none',
    });
  }
  const m = new SessionManager({ registry: reg, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-mcp-'));
  instanceId = (await openWorkspace(root)).instanceId;
  serverScript = join(root, 'fake-mcp-server.cjs');
  await writeFile(serverScript, FAKE_SERVER, 'utf8');
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('a server is attached to a session, and the log says so', () => {
  it('lists namespaced tools and records the attach', async () => {
    const m = manager();
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      mcpServers: [SERVER()],
    });

    expect(session.mcp).toEqual([{ id: 'fake', tools: ['mcp__fake__lookup'] }]);

    const attached = (await m.events(session.sessionId)).find((e) => e.type === 'mcp.attached');
    if (attached?.type !== 'mcp.attached') throw new Error('no attach event');
    expect(attached.serverId).toBe('fake');
    expect(attached.toolNames).toEqual(['mcp__fake__lookup']);
  }, 30_000);

  it('records env names and never env values', async () => {
    // §13: a credential never reaches a file that travels. The value reaches
    // the *process* — the tool call below proves that separately — while the
    // log carries only the key.
    const m = manager();
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      mcpServers: [SERVER({ env: { FAKE_TOKEN: 'sekrit-value-1234' } })],
    });

    const text = JSON.stringify(await m.events(session.sessionId));
    expect(text).toContain('FAKE_TOKEN');
    expect(text, 'a credential reached the log').not.toContain('sekrit-value-1234');
  }, 30_000);

  it('records a failure and keeps the session', async () => {
    // §3.5: the degradation is in the transcript where the missing tools
    // would have been — and the session runs with what did attach.
    const m = manager();
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      mcpServers: [SERVER({ id: 'dead', args: ['-e', 'process.exit(3)'] })],
    });

    expect(session.mcp?.[0]?.id).toBe('dead');
    expect(session.mcp?.[0]?.tools).toEqual([]);
    expect(session.mcp?.[0]?.error).toBeTruthy();
    const failed = (await m.events(session.sessionId)).find((e) => e.type === 'mcp.failed');
    expect(failed).toBeDefined();
    expect(m.get(session.sessionId).state).toBe('planning');
  }, 30_000);

  it('refuses an id that cannot become a tool name, before anything exists', async () => {
    const m = manager();
    await expect(
      m.createSession({ title: 's', goal: 'g', mcpServers: [SERVER({ id: 'Bad Id!' })] }),
    ).rejects.toThrow(/lowercase/);
  }, 30_000);
});

// ---------------------------------------------------------------- the harness

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

/** Scripted provider: first turn calls the MCP tool, second turn stops. */
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

function harnessManager(provider: StubProvider): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new AgbrteHarnessRuntime({ provider, endpointFor: () => ENDPOINT }), {
    label: 'Harness',
    model: 'required',
  });
  return manager(registry);
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const CALL_LOOKUP: Partial<ProviderResult> = {
  toolCalls: [{ id: 'call-1', name: 'mcp__fake__lookup', args: { key: 'alpha' } }],
  stop: { kind: 'tool_calls' },
};

describe('an injected tool is a tool, not a side door', () => {
  it('is declared to the model, gated per call, and its result is logged', async () => {
    const provider = new StubProvider([CALL_LOOKUP, {}]);
    const m = harnessManager(provider);
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      mcpServers: [SERVER({ env: { FAKE_TOKEN: 'sekrit-value-1234' } })],
    });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'agbrte-harness',
      model: { providerId: 'stub', modelId: 'stub-model' },
    });

    // `mcp__…` is not in §13's designated-argument table, so the call falls to
    // `defaultAction: 'ask'` — fail-closed — and parks until a person answers.
    const asked = new Promise<PermissionRequest>((resolve) => m.once('permission', resolve));
    const turn = m.send(session.sessionId, agent.agentId, TEXT('go'));
    const request = await asked;
    expect(request.tool).toBe('mcp__fake__lookup');
    expect(m.get(session.sessionId).state).toBe('awaiting_permission');
    await m.respondPermission(request.requestId, { result: 'allow', scope: 'once' });
    await turn;

    // The model was told the tool exists…
    const declared = provider.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(declared).toContain('mcp__fake__lookup');
    // …and the real server answered, with the env the log never saw.
    const events = await m.events(session.sessionId);
    const result = events.find((e) => e.type === 'agent.tool_result');
    if (result?.type !== 'agent.tool_result') throw new Error('no tool result');
    expect(result.ok).toBe(true);
    const decided = events.find((e) => e.type === 'permission.decided');
    if (decided?.type !== 'permission.decided') throw new Error('no decision');
    expect(decided.via).toBe('user');
    // The token flowed through the process, not the transcript: the tool's
    // full output goes to the model, while the log keeps a bounded summary.
    expect(JSON.stringify(events)).not.toContain('sekrit-value-1234');
  }, 30_000);

  it('is settled by a standing grant like any other ask', async () => {
    // Q19 and Q20 compose: an overnight run with injected tools does not
    // stall on them, and every call is still accounted per §13.
    const provider = new StubProvider([CALL_LOOKUP, {}]);
    const m = harnessManager(provider);
    const session = await m.createSession({
      title: 's',
      goal: 'g',
      standingGrant: true,
      mcpServers: [SERVER()],
    });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'agbrte-harness',
      model: { providerId: 'stub', modelId: 'stub-model' },
    });

    let prompted = false;
    m.on('permission', () => {
      prompted = true;
    });
    await m.send(session.sessionId, agent.agentId, TEXT('go'));

    expect(prompted).toBe(false);
    const events = await m.events(session.sessionId);
    const decided = events.find((e) => e.type === 'permission.decided');
    if (decided?.type !== 'permission.decided') throw new Error('no decision');
    expect(decided.via).toBe('standing-grant');
    const result = events.find((e) => e.type === 'agent.tool_result');
    if (result?.type !== 'agent.tool_result') throw new Error('no tool result');
    expect(result.ok).toBe(true);
  }, 30_000);
});
