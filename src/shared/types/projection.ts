/**
 * Derived session state (DESIGN.md §5.1, §10).
 *
 * A projection is the fold of an event log. It is **derived and disposable** —
 * deleting every checkpoint must lose nothing but time (§5.4, invariant 8). The
 * renderer holds a windowed projection rather than the whole log (§7), and the
 * dashboard's five progress signals read from here.
 */

import type { AgentId, SessionId } from './ids.js';
import type { ModelRef, ReasoningRequest, RuntimeCapabilities } from './runtime.js';
import type { PermissionFidelity, ToolPolicy } from './policy.js';
import type {
  ArtifactRef,
  AttentionReason,
  ChecklistItem,
  ChildRef,
  SessionBrief,
  SessionBudget,
  SessionState,
  SkillConfig,
  StandingGrant,
  TreePosition,
} from './session.js';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  /**
   * Every endpoint a turn actually reached, in first-use order (§13).
   *
   * Folded rather than read from the seat, because a turn that failed over was
   * answered by an endpoint the seat does not name. Empty for a runtime with no
   * endpoint — the echo runtime, a vendor CLI — which is *no endpoint* rather
   * than an unknown one.
   */
  endpoints: string[];
  /** Separate because they are priced separately (§3.6a, §10). */
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  /**
   * When this seat stopped being the session's agent, folded from
   * `agent.retired` (§4.2).
   *
   * The whole reason the event exists: a resume that could not tell a replaced
   * seat from a live one would rebuild both as active, and a session that had
   * its model changed once would come back holding two agents — which is what
   * admission refuses to create. Absent means the seat is still the one.
   */
  retiredAt?: string;
  /**
   * The capability snapshot recorded at admission, verbatim from
   * `agent.created`.
   *
   * Carried so a retired seat can be rebuilt without being re-admitted: it will
   * never run again, and asking a registry to admit a runtime that may since
   * have been uninstalled would drop the seat — taking the name off every
   * transcript row it wrote.
   */
  capabilities?: RuntimeCapabilities;
  /** Carried so a reattached session rebuilds the spec it actually ran under. */
  systemPrompt?: string;
  /** Carried so a restart rebuilds the effort it was admitted with (§3.4). */
  reasoning?: ReasoningRequest;
  limits?: { maxTurns?: number; maxToolCalls?: number; tokenCeiling?: number; wallClockMs?: number };
}

export interface SessionProjection {
  sessionId: SessionId;
  state: SessionState;
  /**
   * What it is called, as the log says (§5.1).
   *
   * `session.json` holds a title too and is what a sidebar reads without opening
   * anything — but that file is a *hint*, and this is the record. A session that
   * is opened takes its name from here, so a rename survives a hint that was
   * never written, a folder copied without it, or a file edited by hand.
   *
   * Optional because a checkpoint written before renaming existed has no title
   * in it, and the answer there is the one that has always worked: fall back to
   * the metadata file.
   */
  title?: string;
  /**
   * The workflow document this session is a run of, if it is one (§4.4).
   *
   * Folded from `session.created` and never written anywhere else, so a host
   * that comes back reads which document it was running out of the log — the
   * same place it reads what the children did. Absent for every ordinary
   * session, and absent from a checkpoint written before this existed, both of
   * which mean *not a run*.
   */
  workflow?: string;
  /**
   * What this session may spend, and what is already reserved (§4.3).
   *
   * Folded rather than remembered, and it had to become foldable: a budget lived
   * only in memory, so a restarted session had none — which at the time meant
   * **a restarted session could not split**, and now means its subtree comes
   * back unbudgeted and can outspend what its root was actually granted. The
   * ceiling comes from `session.created` for a root and from the brief for a
   * child; `reservedForChildren` is the sum of what each `session.spawned_child`
   * took.
   *
   * `spent` is folded from the same `usage` events as the totals above — input
   * plus output, with the cache fields left out because they are a breakdown of
   * the input side rather than tokens on top of it. It used to be folded as a
   * constant zero, correctly, because nothing incremented it anywhere; §6.5
   * gives that job to a ModelGateway and §15 records the gateway as not built.
   * The enforcement this deployment needed turned out not to require it.
   */
  budget?: SessionBudget;
  agents: ProjectedAgent[];
  /** Highest seq folded in. The resume point for an incremental fold. */
  lastSeq: number;
  /**
   * Ids of the events folded *at* `lastSeq` — normally one.
   *
   * More than one means a log written while `EventLog` allocated `seq` across an
   * await and handed the same number to two appends (§5.1e). Those logs exist,
   * and they are replayed on every load, so the fold has to answer "have we
   * folded this already?" by identity. Answering it by position dropped the
   * second event every time, permanently — a log holding a permission decision
   * the projection did not have is the exact failure §13 exists to prevent.
   */
  lastSeqIds: string[];
  lastActivityAt: string | null;
  checklist: ChecklistItem[];
  artifacts: ArtifactRef[];
  children: ChildRef[];
  usage: UsageTotals;
  needsAttention: null | { reason: AttentionReason; since: string };
  /**
   * Requests awaiting an answer, folded from the log: requested, minus decided,
   * minus withdrawn.
   *
   * Derived rather than stored so it cannot disagree with the transcript, and so
   * any client can read it — the previous in-memory set was reachable only from
   * the process that created it.
   */
  pendingPermissions: Array<{
    requestId: string;
    agentId: AgentId;
    tool: string;
    args: unknown;
    toolUseId?: string;
    askedAt: string;
  }>;
  stats: ProjectionStats;
  /**
   * The gate was relaxed for this session (§17 Q19), folded from
   * `permission.standing_grant`. In the projection because the grant must
   * survive a restart the same way the transcript it explains does — a
   * reloaded session that silently resumed asking would contradict its own
   * log's `via: 'standing-grant'` lines.
   *
   * `policy` rides along from the event so a resume restores the *pair*: the
   * grant, and the rules it was granted beside. Restoring the grant onto a
   * default-rebuilt policy would turn every rule the person tightened into an
   * ask the grant then answers yes — the permissive half surviving alone.
   */
  standingGrant: (StandingGrant & { policy: ToolPolicy }) | null;
  /**
   * Skills injected into this session (§17 Q21), folded from `skill.attached`.
   *
   * Whole configs, not references: a skill is pure data, so unlike an MCP
   * server it is rebuilt on resume from here — the log is the truth and it
   * holds the truth entire.
   */
  skills: SkillConfig[];
  /**
   * The group this session is in (§17 Q22), folded from `session.joined_group`
   * and `session.left_group`.
   *
   * In the projection because membership has to survive a restart the way the
   * transcript it explains does: a resumed session that had quietly forgotten
   * its group would show peer messages in its own log with nobody to answer
   * them, and would refuse a reply to the session that had just asked.
   */
  group: { groupId: string; name: string } | null;
  /** Non-zero means the log had unparseable lines — real corruption (§5.1). */
  skippedLines: number;
  /** Set on a child session; durable, so a late resume still knows why it exists. */
  brief: SessionBrief | null;
  parentSessionId: SessionId | null;
  /**
   * Where this session sits in its tree (§4.3), folded from
   * .
   *
   *  above is the same fact narrowed and stays, because a log
   * written before this carries only that — and one parent is enough for the
   * thing a child most needs, which is somewhere to report its result.
   *
   * Null for a root, and for a child whose log predates the field. A reader
   * meeting null falls back to the parent, which is what shipped.
   */
  tree: TreePosition | null;
}

export function emptyProjection(sessionId: SessionId): SessionProjection {
  return {
    sessionId,
    state: 'draft',
    agents: [],
    lastSeq: 0,
    lastSeqIds: [],
    lastActivityAt: null,
    checklist: [],
    artifacts: [],
    children: [],
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      endpoints: [],
    },
    needsAttention: null,
    pendingPermissions: [],
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
    standingGrant: null,
    skills: [],
    group: null,
    skippedLines: 0,
    brief: null,
    parentSessionId: null,
    tree: null,
  };
}

/** Checklist completion, the honest form of "progress" (§10). */
export function checklistProgress(p: SessionProjection): { done: number; total: number } {
  return {
    done: p.checklist.filter((i) => i.state === 'done').length,
    total: p.checklist.length,
  };
}
