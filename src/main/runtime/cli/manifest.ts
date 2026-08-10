/**
 * Installed-CLI manifests (DESIGN.md §3.12).
 *
 * `agent-cli-stdio` drives an agent CLI the user already installed and logged
 * into. One adapter plus a per-CLI manifest, so adding a tool is configuration
 * and a conformance run rather than a new codebase — that is the whole claim,
 * and this file is where it either holds or does not.
 *
 * ## Two departures from the §3.12 sketch, both forced by real protocols
 *
 * **`parse.map: EventFieldMap` became a function.** A field map can lift
 * `msg.foo.bar` into an event, and nothing these CLIs emit is that shape: one
 * assistant record carries an array of content blocks that becomes several
 * events, and a tool result means nothing until paired with the `tool_use` that
 * preceded it. A declarative map would have had to grow until it was a language,
 * so the manifest supplies a small stateful reader instead.
 *
 * **The reader is a factory, not a function.** Pairing needs per-run state, and
 * a manifest is a shared constant — one reader instance would leak tool ids
 * between concurrent agents.
 */

import type {
  PermissionFidelity,
  PolicyRule,
  RuntimeCapabilities,
  RuntimeEvent,
  StopReason,
  ToolPolicy,
} from '@shared/types/index.js';

/**
 * What one parsed record from a CLI means.
 *
 * `stopped` is deliberately not reachable through `event`: the adapter has to
 * intercept the end of a run to decide whether to re-spawn for deny-ask-resume,
 * and a manifest that could pass a `stopped` through would end the turn behind
 * its back.
 */
export type CliRecord =
  /** Content to forward verbatim. */
  | { kind: 'event'; event: Exclude<RuntimeEvent, { type: 'stopped' }> }
  /** The CLI's own session id, which becomes our resume token (§5.4: a cache). */
  | { kind: 'session'; sessionId: string }
  /** This run is over, and why. */
  | { kind: 'end'; stop: StopReason }
  /**
   * A tool call the CLI's own allowlist refused.
   *
   * The signal deny-ask-resume is built on: nothing executed, so asking the user
   * now and re-running is a real gate, just one that costs a process.
   */
  | { kind: 'denied'; tool: string; args: unknown; toolUseId?: string };

/** Per-run parser. Stateful, because tool results are meaningless unpaired. */
export type CliReader = (record: unknown) => CliRecord[];

export interface CliAgentManifest {
  cliId: string;
  /** Shown where an agent is configured, so an unverified manifest says so. */
  label: string;

  detect: {
    binary: string;
    versionArgs: string[];
    /** First capture group is the version. */
    versionPattern: RegExp;
  };

  invoke: {
    promptMode: 'argv' | 'stdin';
    baseArgs: string[];
    /**
     * How this CLI is told which model to use, when the user names one.
     *
     * Absent means the CLI offers no such flag and its own default stands.
     * Optional even when present: these tools authenticate themselves and pick
     * a sensible default, so naming a model is a choice rather than a
     * requirement — which is exactly what `RuntimeDescriptor.model:
     * 'optional'` now expresses and a boolean could not.
     */
    modelArgs?: (modelId: string) => string[];
    /**
     * Absent means this CLI cannot continue a previous run.
     *
     * Not a cosmetic gap: without it there is no deny-ask-resume, because
     * granting a rule and starting over would redo everything the agent already
     * did. The adapter checks for this rather than assuming, and a manifest
     * without it declares `nativeResume: false` to match.
     */
    resumeArgs?: (token: string) => string[];
    allowArgs?: (rules: string[]) => string[];
    denyArgs?: (rules: string[]) => string[];
    permissionModeArgs?: string[];
    /** Skips discovery of local hooks, skills, plugins, MCP, instructions (§3.12). */
    deterministicArgs?: string[];
    workspaceArgs?: (path: string) => string[];
  };

  /**
   * Canonical tool name → this CLI's own name.
   *
   * The agbrte-side names are lowercase; every one of these CLIs capitalizes.
   * The claude-agent-sdk adapter learned this the expensive way — deny rules
   * emitted as `bash` matched nothing, and deny rules were the only protection
   * on the paths its callback skipped.
   */
  toolNames: Readonly<Record<string, string>>;

  parse: {
    framing: 'ndjson';
    reader: () => CliReader;
  };

  permissionFidelity: PermissionFidelity;
  needsPty: boolean;

  /** Everything except the fidelity, which lives above so it cannot disagree. */
  capabilities: Omit<RuntimeCapabilities, 'permissionFidelity'>;

  /**
   * Whether this manifest's flag surface has been run against a real install.
   *
   * These protocols are the vendor's to change and a manifest written from
   * documentation is a hypothesis. Carried as data so the difference is visible
   * in the picker and in the conformance matrix, rather than being a comment
   * nobody reads.
   */
  verified: false | { version: string; checkedOn: string };
}

// --------------------------------------------------------------- policy → args

/**
 * What happened to a rule that does not survive translation.
 *
 * §3.5's rule for schema degradation applies here for the same reason: a loss
 * that is not reported becomes folklore ("this CLI just ignores my policy").
 */
export interface PolicyLoss {
  rule: PolicyRule;
  /** `denied` — dropped, so the tool falls through to a denial and a prompt.
   *  `broadened` — compiled, but covering more than the rule said. */
  effect: 'denied' | 'broadened';
  reason: string;
}

export interface CompiledPolicy {
  allow: string[];
  deny: string[];
  losses: PolicyLoss[];
}

/**
 * Compile our `ToolPolicy` into a CLI's allowlist syntax.
 *
 * ## Why a scoped `allow` is refused rather than translated
 *
 * §13's defaults table is scoped on every row — writes *inside* the workspace
 * are allowed, writes *outside* are `ask`, and on a remote target `deny`. An
 * allowlist has no notion of inside and outside, so compiling
 * `{tool:'write', scope:'inside', action:'allow'}` to a bare `Write` would hand
 * the agent the whole filesystem while the UI went on displaying a rule that
 * says "inside the workspace". That is the exact widening §13 forbids, arriving
 * through a translation instead of through a bad rule.
 *
 * So it is dropped. The tool falls through to the CLI's denial, which surfaces
 * as a prompt and costs a re-spawn — strictly worse ergonomics, and the only
 * honest option. A scoped `deny` compiles without its scope, because denying
 * both sides is stricter than asked; that is reported too, since a user whose
 * rule was meant to allow the inside case needs to know why it does not.
 */
export function compilePolicy(
  policy: ToolPolicy,
  toolNames: Readonly<Record<string, string>>,
): CompiledPolicy {
  const allow: string[] = [];
  const deny: string[] = [];
  const losses: PolicyLoss[] = [];

  for (const rule of policy.rules) {
    // An unmapped name goes through unchanged: a rule we cannot translate is
    // still better sent than silently discarded.
    const name = toolNames[rule.tool.toLowerCase()] ?? rule.tool;
    const term = rule.match !== undefined ? `${name}(${rule.match})` : name;

    if (rule.action === 'deny') {
      deny.push(term);
      if (rule.scope !== undefined) {
        losses.push({
          rule,
          effect: 'broadened',
          reason:
            `an allowlist cannot express "${rule.scope} the workspace", so this denies ` +
            `${rule.tool} on both sides`,
        });
      }
      continue;
    }

    if (rule.action === 'ask') {
      // Expected, not a loss: `ask` compiling to deny is the documented shape of
      // this branch, and with `defaultAction: 'ask'` reporting it would mean
      // reporting nearly every tool.
      continue;
    }

    if (rule.scope !== undefined) {
      losses.push({
        rule,
        effect: 'denied',
        reason:
          `an allowlist cannot express "${rule.scope} the workspace", and granting ` +
          `${rule.tool} unscoped would permit it anywhere on the machine`,
      });
      continue;
    }

    allow.push(term);
  }

  return { allow: [...new Set(allow)], deny: [...new Set(deny)], losses };
}

// ------------------------------------------------------------------- framing

/**
 * NDJSON across chunk boundaries.
 *
 * A pipe hands over whatever happened to be buffered, so a record is routinely
 * split mid-string and two records routinely arrive in one read. Parsing chunks
 * as if they were lines works on every short test and fails on real output, at
 * which point the symptom is a turn that lost its middle.
 */
export class LineSplitter {
  private buffer = '';

  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split('\n');
    // The last piece has no terminator yet, so it stays for the next chunk.
    this.buffer = parts.pop() ?? '';
    return parts.map(stripCr).filter((l) => l.length > 0);
  }

  /** Whatever arrived without a final newline — CLIs often end that way. */
  flush(): string[] {
    const rest = stripCr(this.buffer);
    this.buffer = '';
    return rest.length > 0 ? [rest] : [];
  }
}

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/**
 * Parse one line, or `null`.
 *
 * A CLI writes more than its protocol to stdout — a deprecation notice, a
 * progress spinner, an update banner. Those are not failures and must not end a
 * turn, so an unparseable line is skipped rather than thrown.
 */
export function parseLine(line: string): unknown | null {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}
