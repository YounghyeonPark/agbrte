/**
 * The durable event log (DESIGN.md §5.1).
 *
 * `events.jsonl` is append-only. Every turn, tool call, tool result,
 * permission decision, bus message, capture, child spawn, received brief, and
 * state transition is one JSON line with a monotonic `seq`.
 *
 * Two rules govern every event type added here:
 *
 *  1. Append-only means the schema is forever. Readers of an older version
 *     must be able to skip an unknown `type` safely.
 *  2. Every path is workspace-relative (`EncodedPath`), and every event
 *     records which runtime, provider, model, and adapter version produced
 *     it. With one provider that is a nicety; with many it is the difference
 *     between a reproducible transcript and a mystery.
 */

import type { AgentId, EventId, SessionId, Sha256 } from './ids.js';
import type { ContentBlock, DowngradeNote } from './content.js';
import type { EncodedPath } from './paths.js';
import type { PermissionDecision, PolicyRule } from './policy.js';
import type { ModelRef, RuntimeCapabilities, StopReason } from './runtime.js';
import type { PermissionFidelity } from './policy.js';
import type { ChildRef, SessionBrief, SessionState } from './session.js';

/** Provenance stamped on every event that came from a model or adapter. */
export interface EventOrigin {
  runtimeId: string;
  adapterVersion: string;
  model?: ModelRef;
  /** Installed vendor CLI version, when the runtime is a CLI subprocess. */
  cliVersion?: string;
}

/** Common envelope. `seq` — not `at` — orders events (§5.4d). */
export interface EventEnvelope {
  id: EventId;
  seq: number;
  /** ISO 8601 from the writing host's clock. Advisory only. */
  at: string;
  /** Measured offset from the app's clock at connect, for cross-machine reading. */
  clockSkewMs?: number;
  agentId?: AgentId;
  origin?: EventOrigin;
}

export type EventBody =
  | { type: 'session.created'; goal: string; title: string }
  | { type: 'session.state'; from: SessionState; to: SessionState; reason?: string }
  | { type: 'user.turn'; content: ContentBlock[] }
  | { type: 'agent.text'; text: string }
  | { type: 'agent.tool_use'; toolUseId: string; tool: string; args: unknown }
  | {
      type: 'agent.tool_result';
      toolUseId: string;
      ok: boolean;
      /** Full output goes to a blob; the log keeps a bounded summary. */
      summary: string;
      resultSha256?: Sha256;
      path?: EncodedPath;
    }
  | { type: 'agent.stopped'; stop: StopReason }
  /**
   * §13 requires *every* decision be logged, not only the prompted ones. An
   * earlier version returned early for policy `allow` and `deny` without
   * appending, so a transcript could show hundreds of tool calls and no record
   * that the gate was ever consulted.
   */
  | {
      type: 'permission.decided';
      requestId: string;
      tool: string;
      args: unknown;
      decision: PermissionDecision;
      /** Whether policy decided it outright or a human was asked. */
      via: 'policy' | 'user' | 'escalation-guard';
      /** The deciding rule and the value its `match` was tested against. */
      rule?: PolicyRule;
      subject?: string | null;
      toolUseId?: string;
    }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cost?: number | 'unknown' }
  | { type: 'content.downgraded'; note: DowngradeNote }
  | { type: 'capture.attached'; sha256: Sha256; mime: string }
  | { type: 'checklist.updated'; itemId: string; state: string; text?: string }
  /** `createdAt` is the envelope's `at` — never duplicated into the body. */
  | { type: 'artifact.created'; artifactId: string; kind: string; path?: EncodedPath }
  | { type: 'bus.message'; from: AgentId; to: AgentId | 'session'; kind: string; content: ContentBlock[] }
  | { type: 'memory.written'; slug: string; summary: string }
  // hierarchy (§4.3)
  | { type: 'session.spawned_child'; child: ChildRef }
  | { type: 'session.brief_received'; brief: SessionBrief; parentSessionId: SessionId }
  | { type: 'session.child_result'; childSessionId: SessionId; summary: string; artifactIds: string[] }
  | { type: 'session.orphaned'; formerParentSessionId: SessionId }
  // adapter/agent lifecycle
  /**
   * Recorded when an agent joins a session, so a reloaded log can resolve an
   * `agentId` to the runtime, model, isolation, and permission fidelity it ran
   * under. Without it "which agent tried that" is unanswerable after a restart
   * even though every decision names an agent (§13).
   */
  | {
      type: 'agent.created';
      role: string;
      runtimeId: string;
      model?: ModelRef;
      isolation: 'shared' | 'worktree';
      permissionFidelity: PermissionFidelity;
      capabilities: RuntimeCapabilities;
      /**
       * Recorded because reattaching after a restart rebuilds the `AgentSpec`
       * from this event. Without them an agent came back with no system prompt
       * and default limits while its transcript looked intact — a silent
       * behavior change, which is worse than a visible failure.
       */
      systemPrompt?: string;
      limits?: { maxTurns?: number; maxToolCalls?: number; tokenCeiling?: number; wallClockMs?: number };
    }
  | {
      type: 'agent.started';
      /** `fresh` only when there is genuinely no prior history to carry. */
      resumeMode: 'fresh' | 'native' | 'rehydrated';
      /** Set on `rehydrated`: how much of the log the seed represents. */
      seededThroughSeq?: number;
    }
  | { type: 'agent.compacted'; beforeTokens: number; afterTokens: number };

export type LoomEvent = EventEnvelope & EventBody;

/** Event types this build understands. Unknown types are skipped, not fatal. */
export function isKnownEventType(type: string): boolean {
  return KNOWN_EVENT_TYPES.has(type);
}

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.created',
  'session.state',
  'user.turn',
  'agent.text',
  'agent.tool_use',
  'agent.tool_result',
  'agent.stopped',
  'permission.decided',
  'usage',
  'content.downgraded',
  'capture.attached',
  'checklist.updated',
  'artifact.created',
  'bus.message',
  'memory.written',
  'session.spawned_child',
  'session.brief_received',
  'session.child_result',
  'session.orphaned',
  'agent.created',
  'agent.started',
  'agent.compacted',
]);
