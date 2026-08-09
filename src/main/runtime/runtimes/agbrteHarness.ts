/**
 * `AgbrteHarness` (DESIGN.md §3.7) — our own agent loop.
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
import { WorkspaceLeases } from '../../tools/leases.js';
import { fitContent } from '../../content/fit.js';

export const AGBRTE_HARNESS_RUNTIME_ID = 'agbrte-harness';

/**
 * The id this runtime carried when the project was called Gilmok.
 *
 * Every registry that offers the harness aliases this to the current id, because
 * `runtimeId` is written into `session.json` and the event log: a session
 * created before the rename still names it, and the log is truth (§5.4).
 */
export const RETIRED_HARNESS_RUNTIME_ID = 'gilmok-harness';

export interface AgbrteHarnessOptions {
  provider: ModelProvider;
  /**
   * Which endpoint an agent's spec resolves to.
   *
   * A function rather than a value because one host can reach several models —
   * a local Ollama and a hosted API, two GPUs with different weights — and the
   * agent names the one it wants through `model.endpointId`. Binding a single
   * endpoint at registration encoded "this server has one model", which stops
   * being true the first time it is not.
   */
  endpointFor: (endpointId?: string) => ModelEndpoint;
  tools?: ToolDefinition[];
  /**
   * The workspace's lease table (§9).
   *
   * Injected rather than created here, because it must be shared by everything
   * that writes this workspace — leases are keyed by path and scoped to the
   * workspace, and two tables would mean two agents each believing they hold the
   * same file. Defaults to a private one so a single-runtime setup and every
   * test still get arbitration rather than none.
   */
  leases?: WorkspaceLeases;
  /** Hard ceiling on provider round trips per turn. */
  maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 12;
/** Identical call repeated this many times means the loop is stuck, not working. */
const NO_PROGRESS_LIMIT = 3;

export class AgbrteHarnessRuntime implements AgentRuntime {
  readonly id = AGBRTE_HARNESS_RUNTIME_ID;
  readonly version = '0.0.1';

  constructor(private readonly opts: AgbrteHarnessOptions) {}

  get toolVersion(): string {
    return `${this.opts.provider.id}@${this.opts.provider.version}`;
  }

  async capabilities(spec: AgentSpec): Promise<RuntimeCapabilities> {
    if (!spec.model) throw new Error('AgbrteHarness requires spec.model');
    // Delegated to the provider, which probes rather than self-reports (§3.3).
    const caps = await this.opts.provider.probe(this.opts.endpointFor(spec.model.endpointId), spec.model.modelId);
    // The gate is ours regardless of what the model can do.
    return { ...caps, permissionFidelity: 'callback', subagents: false };
  }

  async start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    const caps = await this.capabilities(spec);
    return new AgbrteHarnessHandle(spec, ctx, caps, this.opts);
  }

  /** No provider-side session exists, so resume is always a rehydrated start. */
  async resume(spec: AgentSpec, _token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.start(spec, ctx);
  }
}

class AgbrteHarnessHandle implements AgentHandle {
  private readonly queue: RuntimeEvent[] = [];
  private readonly messages: ProviderMessage[] = [];
  private readonly tools: ToolDefinition[];
  private readonly leases: WorkspaceLeases;
  private closed = false;
  private waiter: (() => void) | null = null;
  private stream: AsyncIterable<RuntimeEvent> | null = null;

  constructor(
    private readonly spec: AgentSpec,
    private readonly ctx: RuntimeContext,
    private readonly caps: RuntimeCapabilities,
    private readonly opts: AgbrteHarnessOptions,
  ) {
    this.tools = opts.tools ?? DEFAULT_TOOLS;
    this.leases = opts.leases ?? new WorkspaceLeases();
    // A rehydrated seed is conversation, not tool mechanics — it replays as
    // ordinary turns (§5.4).
    for (const turn of ctx.seedHistory ?? []) {
      if (turn.role === 'user') this.messages.push({ role: 'user', content: turn.content });
      else if (turn.role === 'assistant') this.messages.push({ role: 'assistant', text: textOf(turn.content) });
      else this.messages.push({ role: 'system', text: textOf(turn.content) });
    }
  }

  async send(turn: UserTurn): Promise<void> {
    // Already fitted to this agent's declared limits by the session host, which
    // is the only process holding both the blob store and the capabilities
    // (§12.2). Doing it here meant a resizer that could not reach the bytes.
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
          endpoint: this.opts.endpointFor(this.spec.model?.endpointId),
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
        agentId: this.spec.agentId,
        leases: this.leases,
        // Only where the host actually supplied a way to send. A single-agent
        // session has neither, and the tool says so rather than reporting a
        // message nobody will ever receive.
        ...(this.ctx.sendMessage !== undefined
          ? { sendMessage: this.ctx.sendMessage.bind(this.ctx) }
          : {}),
        ...(this.ctx.peers !== undefined ? { roster: this.ctx.peers } : {}),
        ...(this.ctx.capture !== undefined ? { capture: this.ctx.capture.bind(this.ctx) } : {}),
        ...(this.ctx.proposeSplit !== undefined
          ? { proposeSplit: this.ctx.proposeSplit.bind(this.ctx) }
          : {}),
      });
      this.finishTool(call, result.ok, result.summary, result.content, result.blocks);
    } catch (err) {
      const message = (err as Error).message;
      this.finishTool(call, false, `tool threw: ${message}`, message);
    }
  }

  private finishTool(
    call: NormalizedToolCall,
    ok: boolean,
    summary: string,
    payload: string,
    blocks?: ContentBlock[],
  ): void {
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

    /**
     * Non-text a tool produced arrives as a **user** message right after the
     * tool result (§12.1).
     *
     * Not inside the tool result, because providers reliably accept images in a
     * user turn and many reject them in a tool role — a screenshot delivered
     * where the provider will not look is the same as no screenshot, except it
     * costs a request to find out.
     *
     * Fitted to this agent first, for the same reason a pasted image is: an
     * agent that cannot see images gets the described downgrade rather than a
     * request the provider rejects. The fitting is capability-only here — no
     * resizer, because the harness has no reach into the blob store (§12.2), so
     * an oversized capture becomes a named downgrade rather than a silent
     * failure.
     */
    if (blocks !== undefined && blocks.length > 0) {
      void fitContent(blocks, this.caps).then((fitted) => {
        for (const note of fitted.downgrades) {
          this.ctx.reportProgress({
            kind: 'phase',
            detail: note.detail,
            at: new Date().toISOString(),
          });
        }
        this.messages.push({ role: 'user', content: fitted.content });
      });
    }
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
      [Symbol.asyncIterator]: async function* (this: AgbrteHarnessHandle) {
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
    // Files go back when the turn ends, not when the TTL runs out. The expiry
    // exists for an agent that crashed holding something; one that merely
    // finished should not keep a sibling out of a file for another thirty
    // seconds. What it *read* is kept — `releaseHeld` explains why those are not
    // one operation.
    this.leases.releaseHeld(this.spec.agentId);
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
