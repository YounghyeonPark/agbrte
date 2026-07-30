/**
 * Claude Agent SDK adapter — the reference harness implementation (DESIGN.md §3.11).
 *
 * ## Why this configuration is not negotiable
 *
 * This adapter declares `permissionFidelity: 'callback'`, which asserts that
 * **every** tool call passes our gate before executing. The SDK only honors
 * that under a specific configuration, because `canUseTool` is consulted *last*
 * in its permission flow and is skipped entirely for anything approved earlier.
 * From the SDK docs: "The callback never fires for auto-approved tools."
 *
 * Three consequences, each enforced in `buildOptions` below:
 *
 *  1. **Never pass `allowedTools`.** A bare entry auto-approves that tool and
 *     our gate is silently bypassed for it — we would be claiming a gate we do
 *     not have, which §13 treats as worse than having no gate.
 *  2. **Never use `bypassPermissions` or `acceptEdits`.** Both approve calls
 *     before the callback runs.
 *  3. **Pin `settingSources: []`.** Otherwise `.claude/settings.json` in the
 *     workspace, or the user's own settings, can contribute allow rules we
 *     cannot see — the same bypass arriving from a file instead of an argument.
 *     This is also the SDK analog of the CLI's deterministic mode, and matches
 *     the §3.12 decision that reproducible transcripts are the default.
 *
 * `disallowedTools` *is* passed: deny rules are enforced ahead of everything
 * else and cannot be bypassed, so they are the one place SDK-native rules
 * strengthen rather than weaken the gate.
 *
 * If a future requirement forces `allowedTools`, this adapter must downgrade its
 * declared fidelity to `precomputed-allowlist` in the same commit, or register a
 * `PreToolUse` hook — which runs before every other step — as the real gate.
 *
 * ## Verification status
 *
 * Typechecked against @anthropic-ai/claude-agent-sdk 0.3.220. Not yet exercised
 * end to end, which needs credentials; the conformance suite (§3.13) is what
 * closes that gap.
 */

import { query, type CanUseTool, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  type AgentHandle,
  type AgentRuntime,
  type AgentSpec,
  type RuntimeCapabilities,
  type RuntimeContext,
  type RuntimeEvent,
  type StopReason,
  type ToolPolicy,
  type UserTurn,
} from '@shared/types/index.js';

export const CLAUDE_AGENT_SDK_RUNTIME_ID = 'claude-agent-sdk';
export const ADAPTER_VERSION = '0.0.1';
/** The version whose types this adapter was written against. */
export const VERIFIED_SDK_VERSION = '0.3.220';

const DEFAULT_MODEL = 'claude-opus-5';

export interface ClaudeAgentSdkOptions {
  /** Overridden in tests; defaults to the real SDK `query`. */
  queryFn?: typeof query;
  /** Reported context window. The SDK does not expose this, so it is configured. */
  contextWindow?: number;
  maxOutputTokens?: number;
}

export class ClaudeAgentSdkRuntime implements AgentRuntime {
  readonly id = CLAUDE_AGENT_SDK_RUNTIME_ID;
  readonly version = ADAPTER_VERSION;
  /** The SDK release this adapter's types were verified against (§3.12). */
  readonly toolVersion = VERIFIED_SDK_VERSION;

  constructor(private readonly opts: ClaudeAgentSdkOptions = {}) {}

  async capabilities(_spec: AgentSpec): Promise<RuntimeCapabilities> {
    return {
      // The SDK owns sessions and can resume by id — but that remains a cache,
      // never truth (§5.4).
      nativeResume: true,
      interruptible: true,
      subagents: true,
      streaming: true,
      streamingToolArgs: true,

      tools: 'native',
      parallelToolCalls: 'many',
      schemaProfile: 'json-schema-full',
      toolResultPairing: 'batched',
      // Truthful only under the configuration documented above.
      permissionFidelity: 'callback',

      contextWindow: this.opts.contextWindow ?? 1_000_000,
      maxOutputTokens: this.opts.maxOutputTokens ?? 128_000,
      serverSideCompaction: true,
      caching: 'explicit',

      reasoningControl: 'effort',
      reasoningVisible: 'summary',

      input: { image: true, audio: false, pdf: true, video: false },
      imageMaxLongEdge: 2576,

      // The SDK reports total_cost_usd per result message (§10).
      costReporting: 'per-request',
      tokenCounter: 'provider-endpoint',
      quotaModel: 'per-token-billing',
    };
  }

  async start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    return new ClaudeAgentSdkHandle(spec, ctx, null, this.opts.queryFn ?? query);
  }

  async resume(spec: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return new ClaudeAgentSdkHandle(spec, ctx, token, this.opts.queryFn ?? query);
  }
}

/**
 * Translate our policy into SDK options. Exported for testing, because the
 * assertions here are the adapter's safety contract rather than an internal
 * detail.
 */
export function buildOptions(
  spec: AgentSpec,
  ctx: RuntimeContext,
  resumeToken: string | null,
): Options {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const decision = await ctx.requestPermission({
      agentId: spec.agentId,
      tool: toolName,
      args: input,
      // The SDK documents `toolUseID` as distinct for every call in an assistant
      // message, which is exactly what a clock-based id could not guarantee.
      toolUseId: options.toolUseID,
    });

    if (decision.result === 'allow') {
      // Pass the input through explicitly: older CLI builds rejected an allow
      // result that omitted it.
      return { behavior: 'allow', updatedInput: input } satisfies PermissionResult;
    }
    // Claude sees this and may adjust its approach, which is why §13 requires a
    // reason on every denial rather than a bare refusal.
    return { behavior: 'deny', message: decision.reason } satisfies PermissionResult;
  };

  const options: Options = {
    model: spec.model?.modelId ?? DEFAULT_MODEL,
    cwd: spec.workspacePath,
    // Nothing is auto-approved, so every call reaches `canUseTool`.
    permissionMode: 'default',
    // Deterministic surface: no ambient hooks, skills, plugins, MCP servers, or
    // invisible allow rules from settings files.
    settingSources: [],
    canUseTool,
    disallowedTools: denyRulesToSdk(spec.toolPolicy),
    ...(spec.systemPrompt !== undefined ? { systemPrompt: spec.systemPrompt } : {}),
    ...(spec.limits.maxTurns !== undefined ? { maxTurns: spec.limits.maxTurns } : {}),
    ...(resumeToken !== null ? { resume: resumeToken } : {}),
  };

  // Guard rails, not documentation. If a future edit adds either of these, the
  // adapter fails loudly instead of silently losing its gate.
  if ('allowedTools' in options) {
    throw new Error('allowedTools would bypass canUseTool; declare precomputed-allowlist instead');
  }
  if (options.permissionMode !== 'default' && options.permissionMode !== 'plan') {
    throw new Error(`permissionMode "${options.permissionMode}" can auto-approve tool calls`);
  }

  return options;
}

/**
 * Canonical tool name → the SDK's own name.
 *
 * Deny rules are matched against the SDK's tool names, and our policies store
 * canonical lowercase ones. Emitting `bash` where the SDK expects `Bash` meant
 * the one non-bypassable protection matched nothing — and since it is the only
 * barrier on the paths where `canUseTool` is skipped, that mattered.
 */
const SDK_TOOL_NAMES: Readonly<Record<string, string>> = {
  bash: 'Bash',
  bashoutput: 'BashOutput',
  killshell: 'KillShell',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  notebookedit: 'NotebookEdit',
  glob: 'Glob',
  grep: 'Grep',
  web_fetch: 'WebFetch',
  webfetch: 'WebFetch',
  web_search: 'WebSearch',
  websearch: 'WebSearch',
  task: 'Task',
};

/** Our `deny` rules become SDK deny rules, the one non-bypassable rule class. */
export function denyRulesToSdk(policy: ToolPolicy): string[] {
  const out: string[] = [];
  for (const rule of policy.rules) {
    if (rule.action !== 'deny') continue;
    // An unmapped name is passed through unchanged rather than dropped: a rule
    // we cannot translate is still better sent than silently discarded.
    const name = SDK_TOOL_NAMES[rule.tool.toLowerCase()] ?? rule.tool;
    out.push(rule.match ? `${name}(${rule.match})` : name);
  }
  return [...new Set(out)];
}

class ClaudeAgentSdkHandle implements AgentHandle {
  private readonly inbox: SDKUserMessage[] = [];
  private inboxWaiter: (() => void) | null = null;
  private inboxClosed = false;
  private sessionId: string | null = null;
  /**
   * Created in the constructor, not in `send()`.
   *
   * The host subscribes to `events` before sending the first turn (stream-first,
   * so no early event is missed). An async generator body runs on its first
   * `next()`, so a lazily-created query meant `translate()` observed `q === null`
   * and returned immediately — the pump saw zero events and every turn was
   * durably logged as a transport failure. Streaming input exists precisely so
   * the query can be opened before there is anything to say.
   */
  private readonly q: Query;
  /** Memoized: an async generator can only be consumed once. */
  private stream: AsyncGenerator<RuntimeEvent> | null = null;

  constructor(
    spec: AgentSpec,
    ctx: RuntimeContext,
    private readonly resumeTokenIn: string | null,
    queryFn: typeof query,
  ) {
    this.q = queryFn({
      prompt: this.userMessageStream(),
      options: buildOptions(spec, ctx, resumeTokenIn),
    });
  }

  async send(turn: UserTurn): Promise<void> {
    this.inbox.push(toSdkUserMessage(turn));
    this.wakeInbox();
  }

  async interrupt(): Promise<void> {
    await this.q.interrupt();
  }

  async stop(_reason: string): Promise<void> {
    this.inboxClosed = true;
    this.wakeInbox();
    await this.q.return(undefined as never);
  }

  /** The SDK's session id — an optimization, never the source of truth (§5.4). */
  resumeToken(): string | null {
    return this.sessionId ?? this.resumeTokenIn;
  }

  get events(): AsyncIterable<RuntimeEvent> {
    this.stream ??= this.translate();
    return this.stream;
  }

  private async *translate(): AsyncGenerator<RuntimeEvent> {
    for await (const msg of this.q) {
      this.sessionId = sessionIdOf(msg) ?? this.sessionId;

      if (msg.type === 'assistant') {
        // An error on an assistant turn is a stop condition, not content.
        if (msg.error) {
          yield { type: 'stopped', stop: mapAssistantError(msg.error) };
          return;
        }
        for (const block of contentBlocksOf(msg.message)) {
          if (block.type === 'text' && typeof block.text === 'string') {
            yield { type: 'text', text: block.text };
          } else if (block.type === 'tool_use' && typeof block.id === 'string') {
            yield {
              type: 'tool_use',
              id: block.id,
              tool: typeof block.name === 'string' ? block.name : 'unknown',
              args: block.input ?? {},
            };
          }
        }
        continue;
      }

      if (msg.type === 'result') {
        const usage = usageOf(msg);
        if (usage) yield usage;
        yield { type: 'stopped', stop: mapResult(msg) };
        return;
      }
    }
  }

  private async *userMessageStream(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.inbox.length > 0) {
        yield this.inbox.shift() as SDKUserMessage;
      }
      if (this.inboxClosed) return;
      await new Promise<void>((r) => {
        this.inboxWaiter = r;
      });
    }
  }

  private wakeInbox(): void {
    const w = this.inboxWaiter;
    this.inboxWaiter = null;
    w?.();
  }
}

/** `SDKAssistantMessageError` maps almost one-to-one onto our taxonomy (§3.9). */
export function mapAssistantError(error: string): StopReason {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'billing_error':
      // All three mean "credentials cannot currently be used", which pauses
      // rather than fails (§4.1).
      return { kind: 'auth' };
    case 'rate_limit':
      return { kind: 'rate_limited' };
    case 'overloaded':
    case 'server_error':
      return { kind: 'unavailable' };
    case 'invalid_request':
    case 'model_not_found':
      // Permanent config faults. These were `invalid_tool_args`, whose
      // disposition is `retry` — so an unknown model id retried until the
      // attempt budget ran out instead of surfacing the typo.
      return { kind: 'misconfigured', detail: error };
    case 'max_output_tokens':
      return { kind: 'max_output_tokens' };
    default:
      return { kind: 'transport' };
  }
}

export function mapResult(msg: Extract<SDKMessage, { type: 'result' }>): StopReason {
  if (msg.subtype === 'success') return { kind: 'end_turn' };
  switch (msg.subtype) {
    case 'error_max_turns':
      return { kind: 'limit_reached', limit: 'turns', detail: msg.subtype };
    case 'error_max_budget_usd':
      return { kind: 'limit_reached', limit: 'cost', detail: msg.subtype };
    case 'error_max_structured_output_retries':
      return { kind: 'invalid_tool_args', detail: msg.subtype };
    default:
      return { kind: 'transport' };
  }
}

function usageOf(msg: Extract<SDKMessage, { type: 'result' }>): RuntimeEvent | null {
  const usage = (msg as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  if (!usage) return null;
  const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
  return {
    type: 'usage',
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    ...(typeof cost === 'number' ? { cost } : {}),
  };
}

interface LooseBlock {
  type: string;
  text?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
}

/**
 * Read content blocks structurally rather than importing the Anthropic SDK's
 * block union — the adapter needs `text` and `tool_use` and must tolerate block
 * types added later without failing to compile or dropping the whole message.
 */
function contentBlocksOf(message: unknown): LooseBlock[] {
  const content = (message as { content?: unknown }).content;
  return Array.isArray(content) ? (content as LooseBlock[]) : [];
}

function sessionIdOf(msg: SDKMessage): string | null {
  const id = (msg as { session_id?: unknown }).session_id;
  return typeof id === 'string' ? id : null;
}

function toSdkUserMessage(turn: UserTurn): SDKUserMessage {
  const text = turn.content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
    .join('\n');
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    session_id: '',
  } as SDKUserMessage;
}
