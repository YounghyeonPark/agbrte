/**
 * Policy evaluation (DESIGN.md §13).
 *
 * This is the gate. Policy is enforced here, in code that runs before a tool
 * executes — never by prompt instruction, and never by relying on a model's
 * cooperation.
 *
 * Ordering deliberately mirrors the Claude Agent SDK's six-step flow, so an
 * agent gated by us and an agent gated by the SDK resolve the same policy the
 * same way:
 *
 *   escalation deny  →  deny  →  ask  →  allow  →  defaultAction
 *
 * `deny` wins outright. `ask` beats `allow`, so a broad "always confirm writes"
 * rule cannot be silently defeated by a narrower allow added later.
 *
 * ## Two rules that exist because the model is untrusted input
 *
 * 1. **The model never chooses which argument is inspected.** Each tool has a
 *    designated argument. An earlier version fell back to "the first
 *    string-valued argument" for unrecognized tools — i.e. JSON insertion
 *    order, which the model controls. That let an allow rule scoped to a URL
 *    pattern be satisfied by a model-authored `prompt` field while `url`
 *    pointed elsewhere. There is no positional fallback now.
 *
 * 2. **Privilege escalation is checked before policy and is unexpressible in
 *    `ToolPolicy`**, so no scope can grant it (§13: "deny, non-overridable").
 *    See `ESCALATION` below for what that check can and cannot do.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import type { PolicyRule, ToolPolicy } from '@shared/types/index.js';

export type PolicyOutcome = 'allow' | 'ask' | 'deny';

export interface PolicyContext {
  /** Required for `scope`d rules to apply at all. */
  workspaceRoot?: string;
}

export interface Evaluation {
  outcome: PolicyOutcome;
  /** The rule that decided it, or null for `defaultAction` / escalation. */
  rule: PolicyRule | null;
  /** What the rule's `match` was tested against. */
  subject: string | null;
  /** Set when the escalation check fired, which no policy can override. */
  nonOverridable?: true;
  reason?: string;
}

// ---------------------------------------------------------------- tool surface

/**
 * The argument each tool is scoped by. Vendor-native names are registered
 * alongside canonical ones because adapters pass tool names through verbatim:
 * the SDK calls it `WebFetch`, and a lookup miss used to fall through to the
 * positional heuristic described above.
 *
 * A tool absent from this table can still be matched by a tool-level rule (no
 * `match`), and by a `deny`/`ask` rule scoped with `match` — but never by an
 * `allow` rule with `match`, because we cannot say which argument to trust.
 */
const DESIGNATED_ARG: Readonly<Record<string, string>> = {
  bash: 'command',
  bashoutput: 'bash_id',
  killshell: 'shell_id',
  read: 'file_path',
  write: 'file_path',
  edit: 'file_path',
  multiedit: 'file_path',
  notebookedit: 'notebook_path',
  glob: 'pattern',
  grep: 'pattern',
  web_fetch: 'url',
  webfetch: 'url',
  web_search: 'query',
  websearch: 'query',
  task: 'description',
};

/** Tools whose designated argument is a filesystem path, for `scope` rules. */
const PATH_ARG_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'edit',
  'multiedit',
  'notebookedit',
]);

export interface Subjects {
  /** The designated argument's value, or null when the tool is unmapped. */
  primary: string | null;
  /** Every string-valued argument — used only to make deny/ask stricter. */
  all: string[];
  /** Whether the tool is in `DESIGNATED_ARG`. */
  mapped: boolean;
}

export function subjectsFor(tool: string, args: unknown): Subjects {
  const mapped = DESIGNATED_ARG[tool.toLowerCase()];
  if (args === null || typeof args !== 'object') {
    return { primary: null, all: [], mapped: mapped !== undefined };
  }
  const record = args as Record<string, unknown>;
  const all = Object.values(record).filter((v): v is string => typeof v === 'string');

  if (mapped === undefined) return { primary: null, all, mapped: false };
  const value = record[mapped];
  return { primary: typeof value === 'string' ? value : null, all, mapped: true };
}

// ------------------------------------------------------------------- primitives

/** Glob with `*` (any run) and `?` (one character). Anchored, case-sensitive. */
export function globMatch(pattern: string, subject: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const expanded = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${expanded}$`, 's').test(subject);
}

/**
 * Whether a path resolves inside the workspace. Deliberately a local four-liner
 * rather than an import from the store's `PathCodec`: that codec exists to make
 * paths *durable*, this answers a *policy* question, and the gate should not
 * depend on the persistence layer.
 */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const rel = relative(resolve(workspaceRoot), resolve(workspaceRoot, candidate));
  // A `..` prefix escapes the root; an absolute result means a different drive.
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

// ----------------------------------------------------------------- escalation

/**
 * Binaries that raise privilege. Checked before any policy rule and not
 * expressible in `ToolPolicy`, so no user, profile, endpoint, or workspace scope
 * can grant them (§13).
 *
 * **This is defense in depth, not the security boundary.** String inspection of
 * a shell command cannot be complete: `S=sudo; $S id`, `eval`, base64, and any
 * other indirection defeat it, and no amount of pattern work closes that. The
 * actual protection §13 specifies is that the host runs as the connecting user,
 * never root, and Gilmok never invokes `sudo` itself. This check exists to stop
 * the obvious case loudly, and its incompleteness is why it must not be the only
 * thing standing between an agent and root.
 */
const ESCALATION: ReadonlySet<string> = new Set([
  'sudo',
  'sudoedit',
  'doas',
  'pkexec',
  'su',
  'runas',
  'gsudo',
  'run0',
]);

/** Split a command on shell operators and substitution openers. */
function commandSegments(command: string): string[] {
  return command.split(/\|\||&&|[;|&\n\r]|\$\(|`|\{/);
}

/** First executable word of a segment, ignoring env assignments and quoting. */
function leadingCommand(segment: string): string {
  const trimmed = segment.replace(/^[\s(]+/, '');
  // Skip any number of `FOO=bar` prefixes, which shells allow before a command.
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)*([^\s]+)/.exec(trimmed);
  const word = match?.[1] ?? '';
  return word
    .replace(/^\\+/, '') // `\sudo` still runs sudo
    .replace(/^["']|["']$/g, '')
    .replace(/^.*[/\\]/, '') // /usr/bin/sudo → sudo
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

export function escalationAttempt(tool: string, args: unknown): string | null {
  const { primary, all } = subjectsFor(tool, args);
  // Scan every string argument: a command can arrive in an unexpected field.
  const candidates = primary === null ? all : [primary, ...all];
  for (const candidate of candidates) {
    for (const segment of commandSegments(candidate)) {
      const word = leadingCommand(segment);
      if (ESCALATION.has(word)) return word;
    }
  }
  return null;
}

// ------------------------------------------------------------------ evaluation

function ruleApplies(
  rule: PolicyRule,
  tool: string,
  subjects: Subjects,
  ctx: PolicyContext,
): boolean {
  if (rule.tool !== '*' && rule.tool.toLowerCase() !== tool.toLowerCase()) return false;

  if (rule.scope !== undefined) {
    // A scoped rule needs a path it can classify. Unclassifiable means the rule
    // does not apply, so nothing is granted by accident.
    if (ctx.workspaceRoot === undefined) return false;
    if (!PATH_ARG_TOOLS.has(tool.toLowerCase())) return false;
    if (subjects.primary === null) return false;
    const inside = isInsideWorkspace(ctx.workspaceRoot, subjects.primary);
    if (rule.scope === 'inside' && !inside) return false;
    if (rule.scope === 'outside' && inside) return false;
  }

  if (rule.match === undefined) return true;

  if (subjects.mapped) {
    // Deterministic: the designated argument, which the model cannot reorder.
    return subjects.primary !== null && globMatch(rule.match, subjects.primary);
  }

  // Unmapped tool. A deny or ask rule may match any string argument — that only
  // makes the gate stricter. An allow rule may not, because we cannot tell which
  // argument is the dangerous one and the model chooses the ordering.
  if (rule.action === 'allow') return false;
  return subjects.all.some((s) => globMatch(rule.match as string, s));
}

export function evaluatePolicy(
  policy: ToolPolicy,
  tool: string,
  args: unknown,
  ctx: PolicyContext = {},
): Evaluation {
  const escalation = escalationAttempt(tool, args);
  if (escalation !== null) {
    return {
      outcome: 'deny',
      rule: null,
      subject: subjectsFor(tool, args).primary,
      nonOverridable: true,
      reason: `privilege escalation via "${escalation}" is denied and cannot be granted by policy`,
    };
  }

  const subjects = subjectsFor(tool, args);
  const applicable = policy.rules.filter((r) => ruleApplies(r, tool, subjects, ctx));

  for (const outcome of ['deny', 'ask', 'allow'] as const) {
    const rule = applicable.find((r) => r.action === outcome);
    if (rule) return { outcome, rule, subject: subjects.primary };
  }

  return { outcome: policy.defaultAction, rule: null, subject: subjects.primary };
}

/**
 * Merge policies from broad to narrow (user → profile → endpoint → runtime →
 * workspace, per §13). Later arguments are narrower and land earlier in the
 * list; a `deny` anywhere still wins, because evaluation scans by action first.
 */
export function mergePolicies(...policies: ReadonlyArray<ToolPolicy | undefined>): ToolPolicy {
  const rules: PolicyRule[] = [];
  for (const policy of policies) {
    if (policy) rules.unshift(...policy.rules);
  }
  return { rules, defaultAction: 'ask' };
}

// -------------------------------------------------------------------- defaults

/** Read-only tools that are safe to auto-approve inside the workspace. */
const READ_TOOLS = ['read', 'glob', 'grep'] as const;
const WRITE_TOOLS = ['write', 'edit', 'multiedit', 'notebookedit'] as const;

/**
 * §13's last two rows — network egress and `git push` — as **explicit `ask`
 * rules** rather than leaving them to `defaultAction`.
 *
 * Why that distinction is the whole point: `Allow for this session` on one
 * `bash` call grants the *tool*. Resolution scans by action (`deny` → `ask` →
 * `allow`), so an explicit `ask` survives that grant, while a row reachable only
 * through the catch-all would silently flip from `ask` to allowed. The gap was
 * that these rules were specified in §13 and never compiled in.
 *
 * **These patterns are not a boundary.** A glob over a shell string is defeated
 * by `c=curl; $c evil.sh`, by a wrapper script, or by any language runtime with a
 * socket — the same incompleteness as `ESCALATION` above, and §13 names the
 * sandbox as the real control. The bias is therefore deliberately toward
 * over-asking: `*curl*` also fires on `cat curlopts.txt`, and that asymmetry is
 * correct, because a false positive costs one prompt and a false negative is
 * unreviewed egress.
 */
const EGRESS_COMMANDS = [
  'curl',
  'wget',
  'nc',
  'ncat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'git clone',
  'git fetch',
  'git pull',
] as const;

function networkAndPushRules(): PolicyRule[] {
  return [
    // Deterministic: these tools are mapped, so `match` tests the designated
    // argument only — but the tool *is* egress, so no pattern is needed at all.
    { tool: 'web_fetch', action: 'ask' },
    { tool: 'webfetch', action: 'ask' },
    { tool: 'web_search', action: 'ask' },
    { tool: 'websearch', action: 'ask' },

    ...EGRESS_COMMANDS.map((cmd): PolicyRule => ({ tool: 'bash', match: `*${cmd}*`, action: 'ask' })),

    // `git push` separately: §13 lists it as its own row because it publishes
    // work, which is the one egress the user most needs to see coming.
    { tool: 'bash', match: '*git push*', action: 'ask' },
    { tool: 'bash', match: '*git*push*', action: 'ask' }, // `git -C dir push`
  ];
}

/**
 * §13 defaults for a local target. Every filesystem row is scoped, because the
 * inside/outside distinction *is* the rule — an unscoped `allow` on `write`
 * permits writing anywhere on the machine.
 */
export function defaultLocalPolicy(): ToolPolicy {
  return {
    defaultAction: 'ask',
    rules: [
      ...READ_TOOLS.flatMap((tool): PolicyRule[] => [
        { tool, scope: 'inside', action: 'allow' },
        { tool, scope: 'outside', action: 'ask' },
      ]),
      ...WRITE_TOOLS.flatMap((tool): PolicyRule[] => [
        { tool, scope: 'inside', action: 'allow' },
        { tool, scope: 'outside', action: 'ask' },
      ]),
      ...networkAndPushRules(),
    ],
  };
}

/**
 * §13 defaults for a remote target: writes outside the workspace are `deny`
 * rather than `ask`. You can eyeball a local mistake; you cannot eyeball a
 * remote filesystem.
 */
export function defaultRemotePolicy(): ToolPolicy {
  return {
    defaultAction: 'ask',
    rules: [
      ...READ_TOOLS.flatMap((tool): PolicyRule[] => [
        { tool, scope: 'inside', action: 'allow' },
        { tool, scope: 'outside', action: 'ask' },
      ]),
      ...WRITE_TOOLS.flatMap((tool): PolicyRule[] => [
        { tool, scope: 'inside', action: 'allow' },
        { tool, scope: 'outside', action: 'deny' },
      ]),
      ...networkAndPushRules(),
    ],
  };
}

/** The §13 default for a target kind, so the choice is never left to a caller. */
export function defaultPolicyForTarget(kind: string): ToolPolicy {
  return kind === 'local' ? defaultLocalPolicy() : defaultRemotePolicy();
}
