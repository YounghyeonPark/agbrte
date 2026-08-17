/**
 * What the new-session form holds while somebody types an MCP server, and how
 * that becomes a `McpServerConfig` (DESIGN.md §17 Q20).
 *
 * Separate from `McpServers.tsx` because these are the parts worth testing
 * without a browser: an id the host would refuse, a command line split into
 * argv, and — the one that matters — the rule that an env *value* is a
 * credential and leaves this module only inside the config that crosses
 * `session.create`. Nothing here returns one for display, and nothing here
 * builds a string a log or a title attribute could pick up.
 *
 * ## The draft is strings, the config is structure
 *
 * A form field is text; `McpServerConfig.args` is `string[]`. Converting at the
 * boundary rather than storing argv per keystroke means the person can type
 * `--server` and delete it again without the form inventing an empty argument,
 * and it puts the quoting rule in one function with a test beside it.
 */

import type { McpServerConfig } from '../shared/types/index.js';

/** One row of the form. `env` is a list rather than a record so a half-typed key does not collide. */
export interface McpDraft {
  /** Becomes `mcp__<id>__<tool>`, so the host's allow-list applies (see `draftProblem`). */
  id: string;
  command: string;
  /** The rest of the command line, as typed. Split by `splitArgs`. */
  args: string;
  env: Array<{ key: string; value: string }>;
}

export function emptyDraft(): McpDraft {
  return { id: '', command: '', args: '', env: [] };
}

/**
 * The same allow-list `SessionManager.createSession` enforces.
 *
 * Duplicated deliberately, and the manager stays the authority: this exists so
 * the person is told while the field is in front of them rather than after a
 * round trip that also created nothing. A renderer check is never the boundary
 * — three clients reach `session.create` and only one of them is this form.
 */
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Split a typed command line into argv, honouring double quotes.
 *
 * Quotes are here because the common case on Windows is a path with a space in
 * it, and a splitter that only knew whitespace would turn one argument into
 * three and produce a spawn failure whose message names half a path. Single
 * quotes are deliberately *not* special: a Windows path can contain an
 * apostrophe, and treating one as a quote would be this function corrupting an
 * argument it was asked to preserve.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      // An empty `""` is a real, intentional argument — record that something
      // was typed here so it survives to argv.
      started = true;
    } else if (!quoted && /\s/.test(ch)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/**
 * Why this row cannot be sent, or `null`.
 *
 * `others` is the rest of the form, because "two servers named the same" is a
 * property of the set rather than of the row — and the host refuses the whole
 * create for it, so catching it here saves a session that never got made.
 */
export function draftProblem(draft: McpDraft, others: McpDraft[]): string | null {
  const id = draft.id.trim();
  if (id === '' && draft.command.trim() === '' && draft.env.length === 0) return null;
  if (id === '') return 'this server needs a name — it becomes part of its tool names';
  if (!ID.test(id)) {
    return `"${id}" — lowercase letters, digits, - and _ only, because the name becomes part of tool names the policy matches on`;
  }
  if (others.some((o) => o !== draft && o.id.trim() === id)) {
    return `two servers named "${id}" — names must be unique in a session`;
  }
  if (draft.command.trim() === '') return `"${id}" needs a command to run`;
  // A nameless variable cannot be exported, and an env row with a value and no
  // key is almost always a credential typed into the wrong box.
  if (draft.env.some((e) => e.key.trim() === '' && e.value !== '')) {
    return `"${id}" has an environment value with no name`;
  }
  return null;
}

/** The first thing wrong with the form, or `null` when it is ready to send. */
export function firstProblem(drafts: McpDraft[]): string | null {
  for (const draft of drafts) {
    const problem = draftProblem(draft, drafts);
    if (problem !== null) return problem;
  }
  return null;
}

/**
 * The configs to attach, dropping rows nobody filled in.
 *
 * An untouched row is not an error — pressing "add a server" and changing your
 * mind is ordinary — so it contributes nothing rather than refusing the create.
 * `env` is omitted entirely when empty rather than sent as `{}`, which keeps
 * `mcp.attached`'s `envKeys` absent instead of an empty array claiming a server
 * was given an environment it was not.
 */
export function toConfigs(drafts: McpDraft[]): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  for (const draft of drafts) {
    const id = draft.id.trim();
    const command = draft.command.trim();
    if (id === '' || command === '') continue;
    const args = splitArgs(draft.args);
    const env: Record<string, string> = {};
    for (const entry of draft.env) {
      const key = entry.key.trim();
      if (key !== '') env[key] = entry.value;
    }
    configs.push({
      id,
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  }
  return configs;
}
