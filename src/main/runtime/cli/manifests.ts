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
 * **Partial exception, recorded rather than promoted.** The unauthenticated
 * path below *was* read off a real `claude` 2.1.233 on 2026-08-17: the composed
 * argv was run with no credential and with a deliberately invalid
 * `ANTHROPIC_API_KEY`, and `--help`, `--version` and `--resume` were checked on
 * the same build. `verified` stays `false` anyway, because a turn that reaches
 * the model was never run — doing so spends somebody's allowance — so the
 * assistant/tool_use/tool_result shapes and the denial wording remain
 * documentation. Half a manifest checked is not a verified manifest, and the
 * picker must not say otherwise.
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
 * Claude Code's own name for why a request failed → our taxonomy (§3.9).
 *
 * **This is a structured field, not a sentence.** Both places Claude Code
 * reports a failing request — the `system/api_retry` record and the synthetic
 * `assistant` record that ends the turn — carry the category in `error`, and
 * its values are documented as a closed list (headless docs, "Handle API
 * retries": `authentication_failed`, `oauth_org_not_allowed`, `billing_error`,
 * `rate_limit`, `overloaded`, `invalid_request`, `model_not_found`,
 * `server_error`, `max_output_tokens`, `unknown`). Nothing here matches on the
 * prose beside it, which for the unauthenticated case reads "Not logged in ·
 * Please run /login" and is the vendor's to reword whenever they like.
 *
 * The three that mean *this credential cannot be used right now* all map to
 * `auth`, which pauses rather than fails (§3.9, §4.1) — but they need different
 * things done about them, so each carries its own `detail`. Sending someone to
 * `claude auth login` over a billing problem would be confidently wrong advice.
 *
 * An unknown category is deliberately absent rather than mapped: the list is
 * the vendor's and may grow, and inventing a stop for a word we have never seen
 * is how a new failure kind arrives disguised as an old one.
 */
const CLAUDE_ERRORS: Readonly<Record<string, StopReason>> = {
  authentication_failed: {
    kind: 'auth',
    detail:
      'Claude Code is not logged in, or its saved login was rejected — run `claude auth login` ' +
      'in a terminal on the machine this agent runs on',
  },
  oauth_org_not_allowed: {
    kind: 'auth',
    detail:
      'this Claude account’s organization does not permit this use — run `claude auth login` on ' +
      'the machine this agent runs on to sign in as an account that does, or ask an admin',
  },
  billing_error: {
    kind: 'auth',
    detail:
      'Claude Code is logged in but the account cannot be billed — logging in again will not fix ' +
      'it; check the plan or billing details for that account',
  },
  rate_limit: { kind: 'rate_limited' },
  overloaded: { kind: 'unavailable' },
  server_error: { kind: 'unavailable' },
  invalid_request: { kind: 'misconfigured', detail: 'claude rejected the request as invalid' },
  model_not_found: { kind: 'misconfigured', detail: 'claude does not know that model id' },
  max_output_tokens: { kind: 'max_output_tokens' },
};

/**
 * The error category on any record that carries one, or `null`.
 *
 * `hasOwn` rather than a bare lookup, because `error` is not always a category:
 * `system/plugin_install` puts a free-text failure *message* in the same field
 * name, and an arbitrary string indexing an object literal reaches
 * `Object.prototype` — `error: "constructor"` would otherwise answer with a
 * truthy value that is not a `StopReason` at all.
 */
function claudeError(record: Record<string, unknown>): StopReason | null {
  const category = record['error'];
  if (typeof category !== 'string' || !Object.hasOwn(CLAUDE_ERRORS, category)) return null;
  return CLAUDE_ERRORS[category] ?? null;
}

/**
 * Claude Code's `--output-format stream-json`.
 *
 * The reader is stateful because a denial only becomes recognizable when a tool
 * result is paired with the `tool_use` that preceded it: the result carries an
 * id and an error, and the id is the only thing that says which tool it was.
 */
function claudeReader(): CliReader {
  const pending = new Map<string, { tool: string; args: unknown }>();
  /**
   * The last failure category this run reported, for the `result` record.
   *
   * Needed because the `result` record does **not** repeat it: an unauthenticated
   * run ends with `is_error: true`, `terminal_reason: "api_error"` and — the trap
   * this whole path exists for — `subtype: "success"`. Read on its own it is a
   * clean finish, which is how "Not logged in · Please run /login" reached the
   * transcript as ordinary agent text with the session sitting in
   * `awaiting_input`. Verified against claude 2.1.233 (2026-08-17).
   */
  let lastError: StopReason | null = null;

  return (raw: unknown): CliRecord[] => {
    const record = raw as Record<string, unknown>;
    const out: CliRecord[] = [];

    const sessionId = record['session_id'];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      out.push({ kind: 'session', sessionId });
    }

    // On `system/api_retry` and on the synthetic `assistant` record that carries
    // `is_api_error_message: true` — the same field name on both, so one read
    // covers both. A hint rather than an end: nine of these are routinely
    // followed by a tenth attempt that works.
    const failure = claudeError(record);
    if (failure !== null) {
      lastError = failure;
      out.push({ kind: 'stop_hint', stop: failure });
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
        out.push({ kind: 'end', stop: claudeStop(record, lastError) });
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
 *
 * **A structured replacement exists and has not been taken.** A real `claude`
 * 2.1.233 `result` record carries `permission_denials: []`, which on a run with
 * refusals is presumably the list this function is guessing at. It is left
 * alone because nothing here has seen it non-empty — writing the reader for a
 * shape nobody has observed is the mistake this file's header is about — and
 * because it arrives with the *result*, at the end of the run, so adopting it
 * changes when a denial is noticed rather than only how. Worth doing against a
 * real denial; not worth doing from a guess.
 */
function looksDenied(summary: string): boolean {
  return /permission|not allowed|requested permissions|denied|blocked by/i.test(summary);
}

/**
 * What the `result` record means, given what the run reported along the way.
 *
 * **`subtype` is checked after `is_error`, and that order is the fix.** A run
 * that never reached the model still ends `subtype: "success"` with
 * `is_error: true` and `terminal_reason: "api_error"` (observed twice against
 * claude 2.1.233: no credential at all, and a rejected API key). Reading
 * `subtype` first — which this did — reported an unauthenticated run as
 * `end_turn`, so §3.13's standing rule was broken in its own file: a turn that
 * did nothing was reported as a finished one.
 *
 * `lastError` is what turns that into something actionable. The category is not
 * on this record, so without it the best available answer is `transport` —
 * retryable, and retrying an unauthenticated CLI ten more times helps nobody.
 */
function claudeStop(record: Record<string, unknown>, lastError: StopReason | null): StopReason {
  switch (record['subtype']) {
    case 'error_max_turns':
      return { kind: 'limit_reached', limit: 'turns', detail: 'error_max_turns' };
    case 'error_max_budget_usd':
      return { kind: 'limit_reached', limit: 'cost', detail: 'error_max_budget_usd' };
    case 'error_max_structured_output_retries':
      return { kind: 'invalid_tool_args', detail: 'error_max_structured_output_retries' };
  }

  if (record['is_error'] === true || record['terminal_reason'] === 'api_error') {
    // Retryable rather than finished when nothing said why: an errored result we
    // cannot classify is still an errored result, and `end_turn` would move the
    // session on as though the work were done.
    return lastError ?? { kind: 'transport' };
  }

  if (record['subtype'] === 'success') return { kind: 'end_turn' };
  return { kind: 'transport' };
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
