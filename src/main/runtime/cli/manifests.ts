/**
 * Manifests for the two installed CLIs §15 Phase 3 names (DESIGN.md §3.12).
 *
 * These describe protocols that belong to their vendors. Every flag and field
 * here comes from published documentation, and neither has been run against an
 * installed build — both carry `verified: false`, which is why that field is
 * data rather than a comment. The adapter itself is proven end to end against a
 * real subprocess; what a conformance run against a real `claude` or `gemini`
 * adds is confirmation that these particular strings are still the right ones.
 *
 * The two are deliberately unequal, and that is the point of having two. Claude
 * Code can resume, can be handed an allowlist, and reports cost — so it earns
 * `precomputed-allowlist` and the full deny-ask-resume flow. Gemini CLI's
 * allowlist syntax and resume semantics are not documented well enough to
 * compile a policy into, so it declares `all-or-nothing`, which the registry
 * already refuses to run in a shared workspace (§9). The honest declaration
 * routes it into the existing safety check with no new code.
 */

import type { CliAgentManifest, CliReader, CliRecord } from './manifest.js';
import type { RuntimeCapabilities, StopReason } from '@shared/types/index.js';

type Caps = Omit<RuntimeCapabilities, 'permissionFidelity'>;

/** Canonical (lowercase) → the CLI's own capitalization. */
const CLAUDE_TOOL_NAMES: Readonly<Record<string, string>> = {
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
  web_search: 'WebSearch',
  task: 'Task',
};

const CLAUDE_CAPS: Caps = {
  nativeResume: true,
  // No interrupt channel exists in headless mode; killing the process is all
  // there is, and calling that "interruptible" would promise a clean stop.
  interruptible: false,
  subagents: true,
  streaming: true,
  streamingToolArgs: false,

  tools: 'native',
  parallelToolCalls: 'many',
  schemaProfile: 'json-schema-full',
  toolResultPairing: 'batched',

  contextWindow: 200_000,
  maxOutputTokens: 64_000,
  serverSideCompaction: true,
  caching: 'automatic',

  reasoningControl: 'none',
  reasoningVisible: 'none',

  input: { image: true, audio: false, pdf: true, video: false },

  // The CLI reports `total_cost_usd`, but under a subscription login that number
  // is what the run *would* have cost, not what was billed.
  costReporting: 'per-request',
  tokenCounter: 'provider-endpoint',
  pricing: 'opaque',
  // Under `vendor-cli-session` this is a resetting allowance, which is what
  // makes `quota_exhausted` park rather than fail (§4.1).
  quotaModel: 'windowed-allowance',
};

/**
 * Claude Code's `--output-format stream-json`.
 *
 * The reader is stateful because a denial only becomes recognizable when a tool
 * result is paired with the `tool_use` that preceded it: the result carries an
 * id and an error, and the id is the only thing that says which tool it was.
 */
function claudeReader(): CliReader {
  const pending = new Map<string, { tool: string; args: unknown }>();

  return (raw: unknown): CliRecord[] => {
    const record = raw as Record<string, unknown>;
    const out: CliRecord[] = [];

    const sessionId = record['session_id'];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      out.push({ kind: 'session', sessionId });
    }

    switch (record['type']) {
      case 'assistant': {
        const message = record['message'] as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks as Array<Record<string, unknown>>) {
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            out.push({ kind: 'event', event: { type: 'text', text: block['text'] } });
          } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
            const tool = typeof block['name'] === 'string' ? block['name'] : 'unknown';
            const args = block['input'] ?? {};
            pending.set(block['id'], { tool, args });
            out.push({ kind: 'event', event: { type: 'tool_use', id: block['id'], tool, args } });
          }
        }
        return out;
      }

      case 'user': {
        const message = record['message'] as { content?: unknown } | undefined;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        for (const block of blocks as Array<Record<string, unknown>>) {
          if (block['type'] !== 'tool_result') continue;
          const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : '';
          const summary = textOf(block['content']);
          const failed = block['is_error'] === true;
          out.push({ kind: 'event', event: { type: 'tool_result', id, ok: !failed, summary } });

          const call = pending.get(id);
          if (failed && call !== undefined && looksDenied(summary)) {
            out.push({ kind: 'denied', tool: call.tool, args: call.args, toolUseId: id });
          }
          pending.delete(id);
        }
        return out;
      }

      case 'result': {
        const usage = record['usage'] as { input_tokens?: number; output_tokens?: number } | undefined;
        if (usage !== undefined) {
          const cost = record['total_cost_usd'];
          out.push({
            kind: 'event',
            event: {
              type: 'usage',
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              ...(typeof cost === 'number' ? { cost } : {}),
            },
          });
        }
        out.push({ kind: 'end', stop: claudeStop(record) });
        return out;
      }

      default:
        // `system/init`, `system/api_retry`, partial-message deltas. The session
        // id above is taken from all of them; nothing else here needs them, and
        // an unrecognized type must never end a turn.
        return out;
    }
  };
}

/**
 * Whether a failed tool result is a refusal by the CLI's own allowlist.
 *
 * The fragile line in this file, and the reason it is a named function: the
 * wording is the vendor's and will change. Getting it wrong in the permissive
 * direction costs a spurious prompt; getting it wrong the other way means the
 * user is never asked and the agent simply appears to have given up. Broad
 * enough to survive rephrasing, narrow enough not to catch a tool that failed
 * on its own merits.
 */
function looksDenied(summary: string): boolean {
  return /permission|not allowed|requested permissions|denied|blocked by/i.test(summary);
}

function claudeStop(record: Record<string, unknown>): StopReason {
  if (record['subtype'] === 'success') return { kind: 'end_turn' };
  switch (record['subtype']) {
    case 'error_max_turns':
      return { kind: 'limit_reached', limit: 'turns', detail: 'error_max_turns' };
    case 'error_max_budget_usd':
      return { kind: 'limit_reached', limit: 'cost', detail: 'error_max_budget_usd' };
    case 'error_during_execution':
      return { kind: 'transport' };
    default:
      return { kind: 'transport' };
  }
}

export const CLAUDE_CODE_MANIFEST: CliAgentManifest = {
  cliId: 'claude-code',
  label: 'Claude Code (installed CLI)',
  detect: {
    binary: 'claude',
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
  },
  invoke: {
    promptMode: 'argv',
    baseArgs: ['-p', '--output-format', 'stream-json', '--verbose'],
    modelArgs: (modelId) => ['--model', modelId],
    resumeArgs: (token) => ['--resume', token],
    allowArgs: (rules) => ['--allowedTools', rules.join(',')],
    denyArgs: (rules) => ['--disallowedTools', rules.join(',')],
    // Deny-by-default, never the abort-on-unallowed baseline: a denial lets the
    // agent adapt and keep working, and aborting loses the turn (§3.12).
    permissionModeArgs: ['--permission-mode', 'dontAsk'],
    // Skips hooks, skills, plugins, MCP servers, and CLAUDE.md discovery — and
    // also OAuth and keychain reads, which is why the adapter suppresses it
    // under `vendor-cli-session`.
    deterministicArgs: ['--bare'],
  },
  toolNames: CLAUDE_TOOL_NAMES,
  parse: { framing: 'ndjson', reader: claudeReader },
  permissionFidelity: 'precomputed-allowlist',
  needsPty: false,
  capabilities: CLAUDE_CAPS,
  verified: false,
};

// ------------------------------------------------------------------ gemini-cli

const GEMINI_CAPS: Caps = {
  // No documented resume, so no `resumeArgs` — and the adapter refuses to let a
  // manifest declare a resume it cannot perform.
  nativeResume: false,
  interruptible: false,
  subagents: false,
  streaming: true,
  streamingToolArgs: false,

  tools: 'native',
  parallelToolCalls: 'one',
  schemaProfile: 'json-schema-full',
  toolResultPairing: 'batched',

  contextWindow: 1_000_000,
  maxOutputTokens: 64_000,
  serverSideCompaction: false,
  caching: 'none',

  reasoningControl: 'none',
  reasoningVisible: 'none',

  input: { image: true, audio: true, pdf: true, video: true },

  costReporting: 'none',
  tokenCounter: 'none',
  pricing: 'opaque',
  quotaModel: 'windowed-allowance',
};

function geminiReader(): CliReader {
  return (raw: unknown): CliRecord[] => {
    const record = raw as Record<string, unknown>;
    const out: CliRecord[] = [];

    if (record['type'] === 'content' && typeof record['content'] === 'string') {
      out.push({ kind: 'event', event: { type: 'text', text: record['content'] } });
      return out;
    }
    if (record['type'] === 'error') {
      out.push({ kind: 'end', stop: { kind: 'transport' } });
      return out;
    }
    if (record['type'] === 'result') {
      out.push({ kind: 'end', stop: { kind: 'end_turn' } });
    }
    return out;
  };
}

/**
 * Gemini CLI, declared at the fidelity its documentation actually supports.
 *
 * No allowlist compilation and no resume means the only expressible grant is a
 * blanket one, which is exactly what `all-or-nothing` means. The registry then
 * refuses to admit it into a shared workspace (§9), so the sandbox becomes the
 * boundary — without a line of new enforcement code. Declaring
 * `precomputed-allowlist` here to make it feel more capable would have been the
 * one failure §13 calls worse than having no gate: claiming one we do not have.
 */
export const GEMINI_CLI_MANIFEST: CliAgentManifest = {
  cliId: 'gemini-cli',
  label: 'Gemini CLI (installed, unverified manifest)',
  detect: {
    binary: 'gemini',
    versionArgs: ['--version'],
    versionPattern: /(\d+\.\d+\.\d+)/,
  },
  invoke: {
    promptMode: 'argv',
    baseArgs: ['-p', '--output-format', 'stream-json'],
  },
  toolNames: {},
  parse: { framing: 'ndjson', reader: geminiReader },
  permissionFidelity: 'all-or-nothing',
  needsPty: false,
  capabilities: GEMINI_CAPS,
  verified: false,
};

export const CLI_MANIFESTS: readonly CliAgentManifest[] = [
  CLAUDE_CODE_MANIFEST,
  GEMINI_CLI_MANIFEST,
];

/** Tool-result content is a string on some records and blocks on others. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as Record<string, unknown>;
      return typeof block['text'] === 'string' ? block['text'] : '';
    })
    .join('')
    .trim();
}
