/**
 * Derived session state (DESIGN.md §5.1, §10).
 *
 * A projection is the fold of an event log. It is **derived and disposable** —
 * deleting every checkpoint must lose nothing but time (§5.4, invariant 8). The
 * renderer holds a windowed projection rather than the whole log (§7), and the
 * dashboard's five progress signals read from here.
 */

import type { AgentId, SessionId } from './ids.js';
import type { ModelRef } from './runtime.js';
import type { PermissionFidelity } from './policy.js';
import type {
  ArtifactRef,
  AttentionReason,
  ChecklistItem,
  ChildRef,
  SessionBrief,
  SessionState,
} from './session.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /**
   * `'unknown'` is a first-class value, not a missing number. Under an opaque
   * windowed allowance the cost is real but unobservable, and the UI must say
   * so rather than showing $0.00 — which would be a lie — or blank, which
   * looks like a bug (§10).
   */
  cost: number | 'unknown';
}

export interface ProjectionStats {
  turns: number;
  toolCalls: number;
  toolErrors: number;
  permissionPrompts: number;
  permissionDenials: number;
  /**
   * The split signal (§4.3): a session that has compacted twice and is still
   * growing its checklist is a decomposition problem, not a compaction one.
   */
  compactions: number;
  /** Content downgrades, so a model "ignoring your screenshot" is diagnosable. */
  downgrades: number;
  captures: number;
}

/**
 * Enough to resolve an `agentId` found in the log to what produced it (§13).
 * Folded from `agent.created`, so it survives a restart.
 */
export interface ProjectedAgent {
  agentId: AgentId;
  role: string;
  runtimeId: string;
  model?: ModelRef;
  isolation: 'shared' | 'worktree';
  permissionFidelity: PermissionFidelity;
  /** Carried so a reattached session rebuilds the spec it actually ran under. */
  systemPrompt?: string;
  limits?: { maxTurns?: number; maxToolCalls?: number; tokenCeiling?: number; wallClockMs?: number };
}

export interface SessionProjection {
  sessionId: SessionId;
  state: SessionState;
  agents: ProjectedAgent[];
  /** Highest seq folded in. The resume point for an incremental fold. */
  lastSeq: number;
  lastActivityAt: string | null;
  checklist: ChecklistItem[];
  artifacts: ArtifactRef[];
  children: ChildRef[];
  usage: UsageTotals;
  needsAttention: null | { reason: AttentionReason; since: string };
  stats: ProjectionStats;
  /** Non-zero means the log had unparseable lines — real corruption (§5.1). */
  skippedLines: number;
  /** Set on a child session; durable, so a late resume still knows why it exists. */
  brief: SessionBrief | null;
  parentSessionId: SessionId | null;
}

export function emptyProjection(sessionId: SessionId): SessionProjection {
  return {
    sessionId,
    state: 'draft',
    agents: [],
    lastSeq: 0,
    lastActivityAt: null,
    checklist: [],
    artifacts: [],
    children: [],
    usage: { inputTokens: 0, outputTokens: 0, cost: 0 },
    needsAttention: null,
    stats: {
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
      permissionPrompts: 0,
      permissionDenials: 0,
      compactions: 0,
      downgrades: 0,
      captures: 0,
    },
    skippedLines: 0,
    brief: null,
    parentSessionId: null,
  };
}

/** Checklist completion, the honest form of "progress" (§10). */
export function checklistProgress(p: SessionProjection): { done: number; total: number } {
  return {
    done: p.checklist.filter((i) => i.state === 'done').length,
    total: p.checklist.length,
  };
}
