/**
 * The echo runtime — a deterministic second implementation of `AgentRuntime`.
 *
 * This is not only a test double. DESIGN.md §16 names abstraction ossification
 * as the project's first risk, and §15 Phase 3 answers it by proving the
 * interface against deliberately different implementations. Keeping a second
 * runtime green from Phase 1 means the interface is never validated against
 * only one adapter — which is the condition under which it quietly reshapes
 * itself around that adapter.
 *
 * It also lets the supervisor, the registry's admission rules, and the store be
 * tested against every capability shape, including ones no real adapter has
 * yet: no native tools, no interruption, opaque cost, `all-or-nothing` gating.
 */

import {
  type AgentHandle,
  type AgentRuntime,
  type AgentSpec,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type StopReason,
  type UserTurn,
} from '@shared/types/index.js';

/** A scripted step the echo runtime performs when a turn is sent. */
export type EchoStep =
  | { kind: 'text'; text: string }
  /** Requests permission through `ctx.requestPermission` before "running". */
  | { kind: 'tool'; tool: string; args?: unknown; summary?: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number; cost?: number | undefined }
  | { kind: 'stop'; stop: StopReason }
  /** Ends the stream with no `stopped` event, as a dropped subprocess would. */
  | { kind: 'die' };

export interface EchoConfig {
  id?: string;
  capabilities?: Partial<RuntimeCapabilities>;
  /** Steps for each turn, in order. Falls back to echoing the user's text. */
  script?: EchoStep[];
  /** Fail `capabilities()` — exercises the registry's probe-failure path. */
  capabilitiesError?: string;
  /** Resume token to report, or null for a runtime with no native resume. */
  resumeToken?: string | null;
  /**
   * Make `resume()` throw — a moved workspace, an upgraded runtime, an expired
   * token. Rejection is ordinary, so the durable path must be exercised by it.
   */
  resumeError?: string;
  /** Records the seed the host passed, so tests can assert what was carried. */
  onSeed?: (seed: RuntimeContext['seedHistory']) => void;
}

export const DEFAULT_ECHO_CAPABILITIES: RuntimeCapabilities = {
  nativeResume: false,
  interruptible: true,
  subagents: false,
  streaming: true,
  streamingToolArgs: false,
  tools: 'native',
  parallelToolCalls: 'one',
  schemaProfile: 'strict-subset',
  toolResultPairing: 'batched',
  permissionFidelity: 'callback',
  contextWindow: 200_000,
  maxOutputTokens: 8_192,
  serverSideCompaction: false,
  caching: 'none',
  reasoningControl: 'none',
  reasoningVisible: 'none',
  input: { image: false, audio: false, pdf: false, video: false },
  costReporting: 'per-request',
  tokenCounter: 'local-estimate',
  quotaModel: 'per-token-billing',
  pricing: 'free',
};

export class EchoRuntime implements AgentRuntime {
  readonly id: string;
  readonly version = '0.0.1';
  private readonly config: EchoConfig;

  constructor(config: EchoConfig = {}) {
    this.id = config.id ?? 'echo';
    this.config = config;
  }

  async capabilities(_spec: AgentSpec): Promise<RuntimeCapabilities> {
    if (this.config.capabilitiesError) throw new Error(this.config.capabilitiesError);
    return { ...DEFAULT_ECHO_CAPABILITIES, ...this.config.capabilities };
  }

  async start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    this.config.onSeed?.(ctx.seedHistory);
    return new EchoHandle(spec, ctx, this.config);
  }

  async resume(spec: AgentSpec, _token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    if (this.config.resumeError) throw new Error(this.config.resumeError);
    return new EchoHandle(spec, ctx, this.config);
  }
}

class EchoHandle implements AgentHandle {
  private readonly queue: RuntimeEvent[] = [];
  private closed = false;
  private interrupted = false;
  private waiter: (() => void) | null = null;
  private stream: AsyncIterable<RuntimeEvent> | null = null;

  constructor(
    private readonly spec: AgentSpec,
    private readonly ctx: RuntimeContext,
    private readonly config: EchoConfig,
  ) {
    // Honor the documented cancellation channel. The host fires the abort even
    // for a runtime that declares `interruptible: false`, precisely so an
    // adapter that respects only this signal is still cancellable — a
    // well-behaved adapter therefore ends its turn here rather than hanging.
    ctx.abortSignal.addEventListener(
      'abort',
      () => {
        if (!this.closed) {
          this.interrupted = true;
          this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
          this.close();
        }
      },
      { once: true },
    );
  }

  async send(turn: UserTurn): Promise<void> {
    const steps = this.config.script ?? defaultScript(turn);

    for (const step of steps) {
      if (this.interrupted) break;

      switch (step.kind) {
        case 'text':
          this.emit({ type: 'text', text: step.text });
          break;

        case 'tool': {
          // Goes through the gate every time — this runtime declares
          // `callback` fidelity, so nothing may bypass it.
          const decision = await this.ctx.requestPermission({
            agentId: this.spec.agentId,
            tool: step.tool,
            args: step.args ?? {},
            toolUseId: `tu-${this.queue.length}`,
          });
          this.emit({
            type: 'tool_use',
            id: `tu-${this.queue.length}`,
            tool: step.tool,
            args: step.args ?? {},
          });
          this.emit({
            type: 'tool_result',
            id: `tu-${this.queue.length}`,
            ok: decision.result === 'allow',
            summary:
              decision.result === 'allow'
                ? (step.summary ?? `${step.tool} ok`)
                : `denied: ${decision.reason}`,
          });
          break;
        }

        case 'usage':
          this.emit({
            type: 'usage',
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            ...(step.cost !== undefined ? { cost: step.cost } : {}),
          });
          break;

        case 'stop':
          this.emit({ type: 'stopped', stop: step.stop });
          this.close();
          return;

        case 'die':
          // No `stopped` event: the supervisor must treat this as a transport
          // failure rather than a clean finish.
          this.close();
          return;
      }
    }

    this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    this.close();
  }

  async interrupt(): Promise<void> {
    this.interrupted = true;
    this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    this.close();
  }

  async stop(_reason: string): Promise<void> {
    this.close();
  }

  resumeToken(): string | null {
    return this.config.resumeToken ?? null;
  }

  /** Memoized: an async iterable handed out twice would race two consumers. */
  get events(): AsyncIterable<RuntimeEvent> {
    this.stream ??= {
      [Symbol.asyncIterator]: async function* (this: EchoHandle) {
        while (true) {
          while (this.queue.length > 0) {
            yield this.queue.shift() as RuntimeEvent;
          }
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

function defaultScript(turn: UserTurn): EchoStep[] {
  const text = turn.content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join(' ');
  return [
    { kind: 'text', text: `echo: ${text}` },
    { kind: 'usage', inputTokens: text.length, outputTokens: text.length + 6 },
    { kind: 'stop', stop: { kind: 'end_turn' } },
  ];
}
