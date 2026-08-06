/**
 * `GilmokHarness` (DESIGN.md §3.7) — our own agent loop.
 *
 * The second branch of the runtime layer. A `ModelProvider` answers one request;
 * everything a harness would supply, we supply here:
 *
 *  - the canonical tool suite (`src/main/tools`)
 *  - the permission gate, ahead of every execution
 *  - context assembly, stable-prefix-first
 *  - loop control: turn caps, tool-call caps, no-progress detection
 *
 * This branch is *stronger* than the wrapped-harness branch on gating: the gate
 * is ours, not delegated to a third party's hook semantics that we can only hope
 * match our policy. It reports `permissionFidelity: 'callback'` and means it —
 * `runTool` is unreachable without a decision.
 *
 * It reports `nativeResume: false`, which is fine: the durable resume path never
 * depended on it (§5.4).
 */

import {
  type AgentHandle,
  type AgentRuntime,
  type AgentSpec,
  type ContentBlock,
  type DegradedTool,
  type ModelEndpoint,
  type ModelProvider,
  type NormalizedToolCall,
  type ProviderMessage,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type SchemaProfile,
  type StopReason,
  type UserTurn,
} from '@shared/types/index.js';
import { DEFAULT_TOOLS, toolByName, type ToolDefinition } from '../../tools/index.js';

export const GILMOK_HARNESS_RUNTIME_ID = 'gilmok-harness';

export interface GilmokHarnessOptions {
  provider: ModelProvider;
  endpoint: ModelEndpoint;
  tools?: ToolDefinition[];
  /** Hard ceiling on provider round trips per turn. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 12;
/** Identical call repeated this many times means the loop is stuck, not working. */
const NO_PROGRESS_LIMIT = 3;

export class GilmokHarnessRuntime implements AgentRuntime {
  readonly id = GILMOK_HARNESS_RUNTIME_ID;
  readonly version = '0.0.1';

  constructor(private readonly opts: GilmokHarnessOptions) {}

  get toolVersion(): string {
    return `${this.opts.provider.id}@${this.opts.provider.version}`;
  }

  async capabilities(spec: AgentSpec): Promise<RuntimeCapabilities> {
    if (!spec.model) throw new Error('GilmokHarness requires spec.model');
    // Delegated to the provider, which probes rather than self-reports (§3.3).
    const caps = await this.opts.provider.probe(this.opts.endpoint, spec.model.modelId);
    // The gate is ours regardless of what the model can do.
    return { ...caps, permissionFidelity: 'callback', subagents: false };
  }

  async start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    const caps = await this.capabilities(spec);
    return new GilmokHarnessHandle(spec, ctx, caps, this.opts);
  }

  /** No provider-side session exists, so resume is always a rehydrated start. */
  async resume(spec: AgentSpec, _token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.start(spec, ctx);
  }
}

class GilmokHarnessHandle implements AgentHandle {
  private readonly queue: RuntimeEvent[] = [];
  private readonly messages: ProviderMessage[] = [];
  private readonly tools: ToolDefinition[];
  private closed = false;
  private waiter: (() => void) | null = null;
  private stream: AsyncIterable<RuntimeEvent> | null = null;

  constructor(
    private readonly spec: AgentSpec,
    private readonly ctx: RuntimeContext,
    private readonly caps: RuntimeCapabilities,
    private readonly opts: GilmokHarnessOptions,
  ) {
    this.tools = opts.tools ?? DEFAULT_TOOLS;
    // A rehydrated seed is conversation, not tool mechanics — it replays as
    // ordinary turns (§5.4).
    for (const turn of ctx.seedHistory ?? []) {
      if (turn.role === 'user') this.messages.push({ role: 'user', content: turn.content });
      else if (turn.role === 'assistant') this.messages.push({ role: 'assistant', text: textOf(turn.content) });
      else this.messages.push({ role: 'system', text: textOf(turn.content) });
    }
  }

  async send(turn: UserTurn): Promise<void> {
    this.messages.push({ role: 'user', content: turn.content });
    try {
      await this.loop();
    } catch (err) {
      this.emit({ type: 'stopped', stop: classifyError(err) });
      this.close();
    }
  }

  private async loop(): Promise<void> {
    const maxIterations = this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const declared = this.declaredTools();
    const recent: string[] = [];

    for (let i = 0; i < maxIterations; i += 1) {
      if (this.ctx.abortSignal.aborted) {
        this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
        return this.close();
      }

      const result = await this.opts.provider.invoke(
        {
          endpoint: this.opts.endpoint,
          modelId: this.spec.model?.modelId ?? '',
          messages: this.messages,
          maxOutputTokens: this.caps.maxOutputTokens,
          ...(this.spec.systemPrompt !== undefined ? { system: this.spec.systemPrompt } : {}),
          ...(declared.length > 0 ? { tools: declared } : {}),
          ...(this.spec.reasoning !== undefined ? { reasoning: this.spec.reasoning } : {}),
        },
        { signal: this.ctx.abortSignal },
      );

      this.emit({
        type: 'usage',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(this.caps.pricing === 'free' ? { cost: 0 } : {}),
      });

      const text = textOf(result.content);
      if (text.length > 0) this.emit({ type: 'text', text });

      if (result.toolCalls.length === 0) {
        this.emit({ type: 'stopped', stop: result.stop });
        return this.close();
      }

      this.messages.push({ role: 'assistant', ...(text ? { text } : {}), toolCalls: result.toolCalls });

      // No-progress detection: an identical call repeated is a stuck loop, and
      // letting it run to the iteration cap wastes the whole budget (§3.7).
      const fingerprint = result.toolCalls.map((c) => `${c.name}:${JSON.stringify(c.args)}`).join('|');
      recent.push(fingerprint);
      if (recent.filter((f) => f === fingerprint).length >= NO_PROGRESS_LIMIT) {
        this.messages.push({
          role: 'system',
          text: 'You have repeated the same tool call several times without progress. Change approach or answer directly.',
        });
      }

      for (const call of result.toolCalls) {
        await this.runTool(call);
      }
    }

    // A configured ceiling, not a provider fault (§3.9). Reporting this as a
    // spent quota parked the session in `awaiting_quota` waiting on a window
    // that would never reset.
    this.emit({
      type: 'stopped',
      stop: { kind: 'limit_reached', limit: 'turns', detail: `${maxIterations} iterations` },
    });
    this.close();
  }

  /** Unreachable without a decision. That is what `callback` fidelity means. */
  private async runTool(call: NormalizedToolCall): Promise<void> {
    this.emit({ type: 'tool_use', id: call.id, tool: call.name, args: call.args });

    const decision = await this.ctx.requestPermission({
      agentId: this.spec.agentId,
      tool: call.name,
      args: call.args,
      toolUseId: call.id,
    });

    if (decision.result === 'deny') {
      this.finishTool(call, false, `denied: ${decision.reason}`, decision.reason);
      return;
    }

    const tool = toolByName(this.tools, call.name);
    if (!tool) {
      this.finishTool(call, false, `no such tool: ${call.name}`, `Unknown tool ${call.name}.`);
      return;
    }

    try {
      const result = await tool.run((call.args ?? {}) as Record<string, unknown>, {
        workspaceRoot: this.spec.workspacePath,
        signal: this.ctx.abortSignal,
      });
      this.finishTool(call, result.ok, result.summary, result.content);
    } catch (err) {
      const message = (err as Error).message;
      this.finishTool(call, false, `tool threw: ${message}`, message);
    }
  }

  private finishTool(call: NormalizedToolCall, ok: boolean, summary: string, payload: string): void {
    this.emit({ type: 'tool_result', id: call.id, ok, summary });
    // The model must see the outcome, including a denial and its reason, so it
    // can adapt instead of retrying blindly (§13).
    this.messages.push({
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      result: payload,
      ...(ok ? {} : { isError: true }),
    });
  }

  private declaredTools(): DegradedTool[] {
    if (this.caps.tools === 'none') return [];
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      schema: degradeSchema(t.schema, this.caps.schemaProfile),
    }));
  }

  async interrupt(): Promise<void> {
    this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    this.close();
  }

  async stop(_reason: string): Promise<void> {
    this.close();
  }

  /** No provider-side session to resume (§3.7). */
  resumeToken(): string | null {
    return null;
  }

  get events(): AsyncIterable<RuntimeEvent> {
    this.stream ??= {
      [Symbol.asyncIterator]: async function* (this: GilmokHarnessHandle) {
        while (true) {
          while (this.queue.length > 0) yield this.queue.shift() as RuntimeEvent;
          if (this.closed) return;
          await new Promise<void>((r) => {
            this.waiter = r;
          });
        }
      }.bind(this),
    };
    return this.stream;
  }

  private emit(ev: RuntimeEvent): void {
    this.queue.push(ev);
    this.wake();
  }

  private close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}

/**
 * Minimal schema degradation (§3.5).
 *
 * `flat-only` drops nested object properties rather than flattening them to
 * dotted paths — the full degrader belongs in its own tested module; this keeps
 * the harness honest about the profile the provider actually probed.
 */
export function degradeSchema(schema: object, profile: SchemaProfile): object {
  if (profile === 'json-schema-full' || profile === 'strict-subset') return schema;

  const s = schema as { type?: string; properties?: Record<string, { type?: string }>; required?: string[] };
  if (s.type !== 'object' || !s.properties) return schema;

  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(s.properties)) {
    if (value.type !== 'object' && value.type !== 'array') flat[key] = value;
  }
  return {
    type: 'object',
    properties: flat,
    required: (s.required ?? []).filter((r) => r in flat),
    additionalProperties: false,
  };
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function classifyError(err: unknown): StopReason {
  const message = err instanceof Error ? err.message : String(err);
  if (/abort/i.test(message)) return { kind: 'end_turn' };
  if (/\b429\b|rate.?limit/i.test(message)) return { kind: 'rate_limited' };
  if (/\b401\b|\b403\b|unauthor/i.test(message)) return { kind: 'auth' };
  if (/\b5\d\d\b|ECONNREFUSED|fetch failed/i.test(message)) return { kind: 'unavailable' };
  return { kind: 'transport' };
}
