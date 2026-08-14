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

import { addCost, costOf, formatCost, type Cost } from '@shared/cost.js';
import {
  type AgentHandle,
  type AgentRuntime,
  type AgentSpec,
  type ContentBlock,
  type DegradedTool,
  type ModelEndpoint,
  type ModelProvider,
  type NormalizedToolCall,
  type NormalizedTurn,
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
// The **same** estimator the budget is denominated in. A second opinion about
// what a token is would let the harness ask for a size the owner measures
// differently, which is a disagreement nothing would report.
import { estimateTokens } from '../../store/rehydrate.js';

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
/**
 * Fractions of the context window: compact once this full, down to this much.
 *
 * The gap between them is what stops a session compacting on every turn. A high
 * water mark alone would sit just under the line and re-summarize continuously,
 * paying for it each time and losing a little more detail each time.
 */
const COMPACT_AT = 0.75;
const COMPACT_TO = 0.5;
/** Identical call repeated this many times means the loop is stuck, not working. */
const NO_PROGRESS_LIMIT = 3;

/*
 * No default system prompt — deliberately, and against instinct.
 *
 * `systemPrompt` is threaded through the seat, the projection, the event and the
 * spec, and nothing ever sets it, so an agent added through the UI runs with a
 * tool list and no statement of where it is. That looks like an oversight, and
 * it explains a real defect: roughly one live turn in ten, a 7B model answered
 * "create hello.txt" with *"as an AI, I don't have direct access to local file
 * systems"* and stopped.
 *
 * A default was written and measured over twenty live runs against
 * `qwen2.5:7b`. It made things **much** worse — nine runs broken instead of
 * two or three, and the failures changed kind: instead of declining politely,
 * the model left its function-calling path altogether and typed calls as prose
 * (`)(((write {"file_path":"hello.txt"…})))`), opened ```sh fences, and emitted
 * plain gibberish. Prose in the system slot pulls a small model toward
 * answering in prose.
 *
 * So the field stays empty by default. Whoever tries this next: measure over at
 * least twenty runs before believing it, because the version that felt most
 * obviously correct is the one that broke it.
 */

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
    /*
     * The runtime's suite plus whatever the *session* carries (§17 Q20).
     *
     * Session tools arrive as closures over connections the host owns — MCP
     * servers, today — and are wrapped rather than re-typed: `ToolContext`
     * carries leases and workspace paths a remote tool has no claim to, so
     * the wrapper hands over only the arguments and the abort signal. They
     * enter `this.tools` and nothing else, which means `runTool`'s gate and
     * `declaredTools()`'s schema degradation apply to them exactly as to the
     * built-ins — a session tool is a tool, not a side door.
     */
    const injected: ToolDefinition[] = (ctx.sessionTools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.schema,
      run: async (args, toolCtx) => {
        const result = await tool.run(args, toolCtx.signal);
        return { ok: result.ok, summary: result.summary, content: result.content };
      },
    }));
    this.tools = [...(opts.tools ?? DEFAULT_TOOLS), ...injected];
    this.leases = opts.leases ?? new WorkspaceLeases();
    // A rehydrated seed is conversation, not tool mechanics — it replays as
    // ordinary turns (§5.4).
    this.replaceHistory(ctx.seedHistory ?? []);
  }

  /** Turns in, provider messages out. Used by the seed and by compaction. */
  private replaceHistory(turns: readonly NormalizedTurn[]): void {
    this.messages.length = 0;
    for (const turn of turns) {
      if (turn.role === 'user') this.messages.push({ role: 'user', content: turn.content });
      else if (turn.role === 'assistant')
        this.messages.push({ role: 'assistant', text: textOf(turn.content) });
      else this.messages.push({ role: 'system', text: textOf(turn.content) });
    }
  }

  /** Rough size of the history as it stands, in the same units as the budget. */
  private historyTokens(): number {
    let total = 0;
    for (const message of this.messages) {
      if (message.role === 'user') total += estimateTokens(textOf(message.content));
      else if (message.role === 'assistant') total += estimateTokens(message.text ?? '');
      else if (message.role === 'system') total += estimateTokens(message.text);
      else total += estimateTokens(message.result);
    }
    return total;
  }

  /**
   * Compact before a turn, if the window is filling (§3.7).
   *
   * **Between turns and never inside one.** A turn in progress holds an
   * assistant message with tool calls and the results answering them, and every
   * provider requires those to stay paired. `rehydrate()` returns ordinary
   * conversation, so compacting mid-loop would replace half of a pair with prose
   * and the next request would be rejected — a break far from its cause. Context
   * grows across turns anyway; growing past a window inside one is a turn that
   * has already gone wrong.
   *
   * Declining is normal. `compact` is absent on adapters that run their own loop
   * and returns `null` when the log holds nothing worth carrying, and in both
   * cases the history stands. What is *not* silent is running out: the provider
   * refuses, `classifyError` reports `context_overflow`, and §4.1 surfaces it as
   * needing a person.
   */
  private async compactIfNeeded(): Promise<void> {
    if (this.ctx.compact === undefined) return;

    const window = this.caps.contextWindow;
    // A provider that will not say how big its window is cannot be measured
    // against one. Guessing a number here would compact sessions that had no
    // need to, and the cost of that is a model that forgets for no reason.
    if (window <= 0) return;
    if (this.historyTokens() < window * COMPACT_AT) return;

    const compacted = await this.ctx.compact(Math.floor(window * COMPACT_TO));
    if (compacted === null) return;

    this.replaceHistory(compacted.turns);
  }

  async send(turn: UserTurn): Promise<void> {
    // Already fitted to this agent's declared limits by the session host, which
    // is the only process holding both the blob store and the capabilities
    // (§12.2). Doing it here meant a resizer that could not reach the bytes.
    this.messages.push({ role: 'user', content: turn.content });
    try {
      await this.compactIfNeeded();
      await this.loop();
    } catch (err) {
      this.emit({ type: 'stopped', stop: classifyError(err) });
      this.close();
    }
  }

  private async loop(): Promise<void> {
    /**
     * The user's ceiling wins over the adapter's own.
     *
     * `spec.limits` was stored, logged, projected and rehydrated, and read by
     * nothing — `maxTurns` in particular was accepted by `addAgent`, written to
     * the transcript, and then ignored in favour of this adapter's default. A
     * limit that is recorded and not enforced is worse than no limit: it is a
     * promise in the log.
     */
    const maxIterations = Math.min(
      this.spec.limits.maxTurns ?? Number.POSITIVE_INFINITY,
      this.opts.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    );
    const startedAt = Date.now();
    let toolCalls = 0;
    let tokens = 0;
    let spent: Cost = 0;
    const declared = this.declaredTools();
    const recent: string[] = [];

    for (let i = 0; i < maxIterations; i += 1) {
      if (this.ctx.abortSignal.aborted) {
        this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
        return this.close();
      }

      // Checked before the request rather than after it: a wall clock exists to
      // bound spending, and noticing you are over it *having just paid for
      // another turn* is noticing too late.
      const elapsed = Date.now() - startedAt;
      if (this.spec.limits.wallClockMs !== undefined && elapsed >= this.spec.limits.wallClockMs) {
        return this.stopAtLimit('wallclock', `${Math.round(elapsed / 1000)}s elapsed`);
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

      /**
       * A cost on every turn, including `'unknown'` (§10).
       *
       * This used to emit a cost only when the model was free, so everything
       * else arrived with the field absent — and absent is a third state that
       * anything summing usage has to guess about. `'unknown'` says the thing
       * §10 requires out loud: a cost exists and we cannot see it, which is not
       * the same as zero and not the same as missing.
       */
      /*
       * Emitted before the answer, which is the order it was produced in. A
       * transcript that showed the conclusion above the working-out would read
       * as though the model justified itself afterwards.
       */
      if (result.reasoning !== undefined) {
        this.emit({ type: 'reasoning', text: result.reasoning });
      }

      this.emit({
        type: 'usage',
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        ...(result.usage.cacheReadTokens !== undefined
          ? { cacheReadTokens: result.usage.cacheReadTokens }
          : {}),
        ...(result.usage.cacheWriteTokens !== undefined
          ? { cacheWriteTokens: result.usage.cacheWriteTokens }
          : {}),
        cost: costOf(result.usage, this.caps),
      });

      tokens += result.usage.inputTokens + result.usage.outputTokens;
      spent = addCost(spent, costOf(result.usage, this.caps));

      if (this.spec.limits.tokenCeiling !== undefined && tokens >= this.spec.limits.tokenCeiling) {
        return this.stopAtLimit('tokens', `${tokens} tokens`);
      }
      /**
       * An unobservable cost cannot breach a ceiling.
       *
       * `'unknown'` means a cost exists and we cannot see it (§10), so comparing
       * it to a number would either stop a session that may be well under
       * budget or let one run that is well over. The honest behaviour is to
       * enforce nothing and let the turn and token ceilings do the bounding —
       * which is exactly why §10 pairs the third fidelity with those caps.
       */
      if (
        this.spec.limits.costCeiling !== undefined &&
        spent !== 'unknown' &&
        spent >= this.spec.limits.costCeiling
      ) {
        return this.stopAtLimit('cost', formatCost(spent));
      }

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
        if (
          this.spec.limits.maxToolCalls !== undefined &&
          toolCalls >= this.spec.limits.maxToolCalls
        ) {
          return this.stopAtLimit('tool_calls', `${toolCalls} tool calls`);
        }
        toolCalls += 1;
        await this.runTool(call);
      }
    }

    this.stopAtLimit('turns', `${maxIterations} iterations`);
  }

  /**
   * A configured ceiling, not a provider fault (§3.9).
   *
   * Reporting these as a spent quota parked the session in `awaiting_quota`
   * whose contract is "resume at `resetsAt`". Nothing here resets — the user
   * chose the number — so the work pauses for a person instead.
   */
  private stopAtLimit(
    limit: 'turns' | 'tool_calls' | 'tokens' | 'cost' | 'wallclock',
    detail: string,
  ): void {
    this.emit({ type: 'stopped', stop: { kind: 'limit_reached', limit, detail } });
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
      await this.finishTool(call, result.ok, result.summary, result.content, result.blocks);
    } catch (err) {
      const message = (err as Error).message;
      await this.finishTool(call, false, `tool threw: ${message}`, message);
    }
  }

  private async finishTool(
    call: NormalizedToolCall,
    ok: boolean,
    summary: string,
    payload: string,
    blocks?: ContentBlock[],
  ): Promise<void> {
    /*
     * The hashes travel with the result so the transcript can show what the
     * model was shown. Blocks without bytes — text the tool chose to send as a
     * block — have nothing to point at and are skipped.
     */
    const blobs = (blocks ?? []).flatMap((b) => ('sha256' in b ? [b.sha256 as string] : []));
    this.emit({
      type: 'tool_result',
      id: call.id,
      ok,
      summary,
      ...(blobs.length > 0 ? { blobs } : {}),
    });
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
      /**
       * Awaited, so the image is in `messages` before the next request is built.
       *
       * This was `void fitContent(...).then(...)` — fire and forget — and it
       * worked, by microtask ordering rather than by construction: the loop
       * awaits `runTool`, which drained the queued push just in time. That holds
       * only while the fitting awaits nothing real, and §12.2 says this call
       * *should* eventually be given a resizer. The day it is, the screenshot
       * lands after the request that was meant to carry it, and the agent looks
       * at its own output one turn late — a bug that would read as a model
       * ignoring an image.
       */
      const fitted = await fitContent(blocks, this.caps);
      for (const note of fitted.downgrades) {
        this.ctx.reportProgress({
          kind: 'phase',
          detail: note.detail,
          at: new Date().toISOString(),
        });
      }
      this.messages.push({ role: 'user', content: fitted.content });
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
