/**
 * Tool policy and permission gating (DESIGN.md §3.10, §13).
 *
 * Policy is enforced in the tool implementation, before execution — never by
 * prompt instruction, and never by relying on a model's compliance.
 */

import type { AgentId, InstanceId, SessionId } from './ids.js';

export interface PolicyRule {
  /** Tool name, e.g. 'bash' | 'write' | 'web_fetch'. Matched case-insensitively. */
  tool: string;
  /** Glob against the tool's designated argument, e.g. 'git diff *'. */
  match?: string;
  /**
   * Whether the rule applies to paths inside or outside the workspace.
   *
   * §13's defaults table is scoped this way on every row — local writes inside
   * the workspace are `allow` while writes outside are `ask`, and on a remote
   * target `deny`. Without this field a policy cannot express that table at all,
   * and a bare `{tool:'write', action:'allow'}` silently permits writing
   * anywhere on the machine.
   *
   * A scoped rule requires a resolvable path argument and a workspace root; if
   * either is missing the rule does not apply, so an unclassifiable call falls
   * through to `defaultAction` rather than matching by accident.
   */
  scope?: 'inside' | 'outside';
  action: 'allow' | 'ask' | 'deny';
}

export interface ToolPolicy {
  rules: PolicyRule[];
  defaultAction: 'ask';
}

/**
 * Resolution order is workspace → runtime → endpoint → profile → user (§13).
 * `runtime` and `endpoint` scopes exist because trust in the thing behind an
 * agent is a real policy input: a coarse-gated CLI or an unevaluated provider
 * can be granted less than your primary configuration in the same workspace.
 */
export type PolicyScope =
  | { kind: 'user' }
  | { kind: 'profile'; profileId: string }
  | { kind: 'endpoint'; endpointId: string }
  | { kind: 'runtime'; runtimeId: string }
  | { kind: 'workspace'; instanceId: InstanceId };

/**
 * How strong a runtime's permission gate actually is (§3.10). Safety-critical:
 * `all-or-nothing` may only run under worktree or container isolation, checked
 * at agent creation (§9). Declaring this wrongly means Gilmok tells the user an
 * agent is contained when it is not.
 */
export type PermissionFidelity =
  /** Pre-execution gate we control, per call. */
  | 'callback'
  /** Rules fixed before start; `ask` compiles to deny, then deny-ask-resume. */
  | 'precomputed-allowlist'
  /** Only a blanket bypass exists; the sandbox is the sole boundary. */
  | 'all-or-nothing';

/**
 * What an adapter supplies when it needs a decision.
 *
 * Deliberately excludes `requestId` and `sessionId`: an adapter cannot know the
 * session, and letting it mint the request id produced collisions. Both adapters
 * previously wrote `sessionId: '' as never` — two independent implementations
 * reaching for the same cast is the signal that the type was wrong.
 */
export interface PermissionAsk {
  agentId: AgentId;
  tool: string;
  /** Full arguments — logged with every decision (§13). */
  args: unknown;
  /**
   * The runtime's own id for this tool call, where it has one.
   *
   * Required to distinguish concurrent calls: with `parallelToolCalls: 'many'`,
   * two calls to the same tool arrive together, and a clock-based id collides —
   * one promise never resolves and the survivor's arguments are what gets
   * logged, so a decision could be recorded against a call the user never saw.
   */
  toolUseId?: string;
}

/** An ask plus the identity only the host can stamp. */
export interface PermissionRequest extends PermissionAsk {
  requestId: string;
  sessionId: SessionId;
  /** Set when the request came from a descendant session (§4.3). */
  originSessionId?: SessionId;
}

/**
 * `match` is required on a pattern grant.
 *
 * "Always allow this pattern" previously appended `{tool, action:'allow'}` with
 * no match, silently widening one approved call into the whole tool — and the
 * type had no field in which a pattern *could* be carried, so it invited the
 * bug. Grants apply to the agent that asked, never to its siblings.
 */
export type PermissionDecision =
  | { result: 'allow'; scope: 'once' }
  /** This tool, for the rest of this agent's session. Not persisted. */
  | { result: 'allow'; scope: 'session' }
  /** This pattern only, as an inspectable rule. */
  | { result: 'allow'; scope: 'pattern'; match: string }
  | { result: 'deny'; reason: string };
