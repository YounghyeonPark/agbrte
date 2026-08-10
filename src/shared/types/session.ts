/**
 * Sessions, agents, and the session tree (DESIGN.md §4).
 */

import type { AgentId, InstanceId, SessionId } from './ids.js';
import type { NormalizedTurn } from './content.js';
import type { AgentRole, AgentSpec, ModelRef, RuntimeCapabilities } from './runtime.js';
import type { ExecutionTarget } from './target.js';
import type { PermissionDecision } from './policy.js';
import type { WorkspacePath } from './paths.js';

/**
 * The four `awaiting_*` states plus `awaiting_children` are deliberately
 * parallel: each means *paused, holding all state, will resume* — never
 * failed. A sleeping laptop, a seat allowance resetting at 4pm, an unapproved
 * tool, and a parent waiting on descendants are the same shape of problem, and
 * treating any of them as a failure discards hours of work.
 */
export type SessionState =
  | 'draft'
  | 'planning'
  | 'working'
  | 'awaiting_input'
  | 'awaiting_permission'
  | 'awaiting_credentials'
  | 'awaiting_quota'
  | 'awaiting_children'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled';

const PAUSED: ReadonlySet<SessionState> = new Set<SessionState>([
  'awaiting_input',
  'awaiting_permission',
  'awaiting_credentials',
  'awaiting_quota',
  'awaiting_children',
]);

const TERMINAL: ReadonlySet<SessionState> = new Set<SessionState>([
  'done',
  'failed',
  'cancelled',
]);

/** Paused is not failed. Callers branch on this rather than listing states. */
export const isPaused = (s: SessionState): boolean => PAUSED.has(s);
export const isTerminal = (s: SessionState): boolean => TERMINAL.has(s);
export const isActive = (s: SessionState): boolean => !PAUSED.has(s) && !TERMINAL.has(s);

export type AttentionReason =
  | 'needs_input'
  | 'needs_permission'
  | 'needs_credentials'
  | 'quota_exhausted'
  | 'split_proposed'
  | 'failed'
  | 'stalled';

export interface ChecklistItem {
  id: string;
  text: string;
  state: 'todo' | 'doing' | 'done' | 'blocked';
  /** Set when a child session owns this item (§4.3). */
  delegatedTo?: SessionId;
}

export interface ArtifactRef {
  artifactId: string;
  kind: string;
  path?: WorkspacePath;
  createdAt: string;
}

/**
 * Hierarchical budget (§4.3). A child's ceiling is reserved from its parent's
 * remainder at spawn, so a tree cannot outspend what its root was granted —
 * without which "split when the scope is too large" is a cost bomb.
 */
/**
 * What an attached client may do to a session (§7, §17 Q14).
 *
 * Enforced by the session owner, never by the client: a read-only client that
 * can still send is not read-only. The role belongs to a *connection*, so the
 * same person on two devices can hold different roles — a phone watching a run
 * while the desk machine drives it.
 */
export type AccessRole = 'read-write' | 'read-only';

/**
 * How an identity was established.
 *
 * Recorded next to the identity itself because the two are not the same claim.
 * "This is uid 1000" backed by socket permissions the kernel enforced, and "this
 * is uid 1000" because a client said so, are worth entirely different amounts —
 * and a log that flattens them cannot be audited later, only believed.
 *
 * Ordered weakest last on purpose. New sources (`tailscale`, `oidc`) slot in
 * without touching anything that reads this, because a reader that does not know
 * a source must treat it as no better than `asserted`.
 */
export type IdentitySource =
  /** The OS refused everyone else: a 0600 socket, or a pipe's default DACL. */
  | 'peer-credential'
  /** An `ssh` session authenticated the unix user before a byte reached us. */
  | 'ssh'
  /** The client named itself and nothing checked. Never grants `read-write`. */
  | 'asserted';

/**
 * Who caused something.
 *
 * `id` is stable and `label` is not — which is why they are separate fields
 * rather than one string. An email, a login name and a display name all change
 * while remaining the same person, and a log that keyed on one of those would
 * quietly split one actor into several across a rename. A uid, a Tailscale user
 * id and an OIDC `sub` do not change.
 */
export interface Actor {
  /** Stable and opaque. Never an email or a display name. */
  id: string;
  /** What established `id`, and therefore what it is worth. */
  via: IdentitySource;
  /** For display only. Absent when nothing readable is known. */
  label?: string;
}

/**
 * A permission request that is no longer open.
 *
 * Sent to every attached client, not only the one that answered. With several
 * devices on one session the same prompt is on several screens, so the answer
 * has to travel the same way the question did.
 *
 * `actor` says who settled it, which is the difference between a prompt that
 * vanishes mysteriously and one that says "Bob allowed this". It is absent on a
 * withdrawal, because nobody decided — the agent that asked simply went away.
 */
export interface PermissionResolved {
  requestId: string;
  sessionId: SessionId;
  outcome: 'answered' | 'withdrawn';
  decision?: PermissionDecision;
  reason?: string;
  actor?: Actor;
}

/** A write attempted by a client that may only read. */
export class AccessDenied extends Error {
  constructor(readonly action: string) {
    super(`read-only access cannot ${action}`);
    this.name = 'AccessDenied';
  }
}

export interface SessionBudget {
  tokenCeiling: number;
  spent: number;
  costCeiling?: number;
  cost?: number | 'unknown';
  reservedForChildren: number;
  inheritedFrom?: SessionId;
}

/**
 * Permission to split without asking, granted in advance (§17 Q8).
 *
 * §4.3 keeps splits user-approved because "a decomposition mistake made at 3am
 * is expensive". The expense, though, is in **not being able to see it** — and
 * requiring approval at 3am does not prevent the mistake, it prevents the run.
 * A long overnight session stalls at exactly the moment it most needs to
 * decompose, and stalls until morning.
 *
 * So the grant is made when the person is present and thinking about the run,
 * and it is a **budget rather than a mode**. Three properties make that the
 * difference:
 *
 * - It is **spent**. Two of three used is visible, and the third is the last.
 *   A mode has no such edge and quietly applies forever.
 * - Every automatic split still writes `session.split_proposed` *and*
 *   `session.split_decided`, so the transcript reads exactly as a manual one
 *   does and a decomposition can be reviewed in the morning. What it does not
 *   do is raise `needsAttention` — that is the stall being removed, and the
 *   only thing being removed.
 * - It lives on the session, so it cannot leak into the next one by being a
 *   setting somebody turned on once.
 */
export interface SplitGrant {
  /** Splits still allowed without asking. Zero means every split asks again. */
  remaining: number;
  /** How many were granted, so the UI can say "2 of 3". */
  granted: number;
  /**
   * Deepest tree position an automatic split may create.
   *
   * Separate from §4.3's `maxDepth`, which is the hard ceiling for every split.
   * This is the depth a *person* was willing to be absent for, and it is
   * normally shallower.
   */
  maxDepth: number;
}

/** Budget actually available to this session's own agents right now. */
export function availableTokens(b: SessionBudget): number {
  return Math.max(0, b.tokenCeiling - b.spent - b.reservedForChildren);
}

/**
 * Position in the session tree. Note: this is *session* lineage.
 * `LineageId` (§5.2) is *repository* lineage — unrelated concepts,
 * deliberately different names.
 */
export interface TreePosition {
  /** Self when this is a root — makes tree queries one index scan. */
  rootSessionId: SessionId;
  parentSessionId?: SessionId;
  /** Root is 0. Capped by `maxDepth` (default 3). */
  depth: number;
  /** Ancestor ids, root-first: breadcrumbs, and cycle prevention. */
  ancestry: SessionId[];
}

/** What a child owes its parent (§4.3). Results flow up by reference. */
export interface ResultContract {
  /** Hard ceiling on what may enter the parent's context. */
  summaryMaxTokens: number;
  artifacts: Array<{ kind: string; required: boolean }>;
  /** JSON Schema the returned summary must satisfy. */
  structured?: object;
}

/**
 * A parent's cached projection of a child. The child owns the truth; this
 * exists so a tree still renders when the child's workspace is unreachable —
 * the same pattern as the offline mirror (§6.6).
 */
export interface ChildRef {
  sessionId: SessionId;
  /** May differ from the parent's — cross-repo children. */
  instanceId: InstanceId;
  /** May differ from the parent's — cross-machine children. */
  target: ExecutionTarget;
  title: string;
  contract: ResultContract;
  lastKnown: {
    state: SessionState;
    checklistDone: number;
    checklistTotal: number;
    updatedAt: string;
    cost: number | 'unknown';
  };
}

/**
 * What a child receives instead of its parent's transcript (§4.3). Built by
 * `rehydrate()` with a scope filter — the same function that resumes a moved
 * workspace, switches provider mid-session, and resumes after a quota window.
 *
 * Durable, not an opening prompt: written as an event and permanently part of
 * the child's rehydration seed, so a child resumed in three weeks still knows
 * why it exists.
 */
export interface SessionBrief {
  /** Why this work exists at all. */
  parentGoal: string;
  /** This child's narrow goal. */
  scope: string;
  /** Load-bearing, not politeness: without it a child reads widely to
   *  re-derive context, which is the cost the split was meant to avoid. */
  outOfScope: string[];
  contract: ResultContract;
  acceptance: string[];
  /** Lineage-keyed project memory — free, since it follows the repo. */
  memoryRefs: string[];
  pointers: Array<{ kind: 'file' | 'artifact' | 'event'; ref: string; why: string }>;
  /** A small, deliberate set — by exception, not default. */
  verbatim?: NormalizedTurn[];
  budget: SessionBudget;
}

/**
 * What an agent has spent (§10).
 *
 * Cache reads and writes are separate because they are priced separately, and
 * `cost` is a union rather than an optional number so "we cannot see it" cannot
 * be summed as zero.
 */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number | 'unknown';
}

export interface AgentRecord {
  agentId: AgentId;
  role: AgentRole;
  /** Carries runtimeId, ModelRef, and AuthMode. workspacePath is environment. */
  spec: Omit<AgentSpec, 'workspacePath'>;
  /** Snapshot at start, recorded in the log for reproducibility. */
  resolvedCapabilities: RuntimeCapabilities;
  status: 'idle' | 'parked' | 'running' | 'blocked' | 'crashed' | 'stopped';
  isolation: 'shared' | 'worktree';
  resumeToken: string | null;
  lastEventSeq: number;
  usage: AgentUsage;
}

export interface Session {
  sessionId: SessionId;
  instanceId: InstanceId;
  target: ExecutionTarget;
  title: string;
  goal: string;
  state: SessionState;
  agents: AgentRecord[];
  createdAt: string;
  updatedAt: string;
  checklist: ChecklistItem[];
  artifacts: ArtifactRef[];
  budget?: SessionBudget;
  /** Splits this session may make without asking (§17 Q8). Absent means none. */
  splitGrant?: SplitGrant;
  /**
   * What is blocking here, or beneath here (§4.3, §10).
   *
   * `from` is set when the blockage belongs to a *descendant* rather than to
   * this session. §4.3 calls bubbling "the single most important tree behavior
   * in the UI": a child three levels down waiting on a permission prompt is the
   * easiest thing in the system to lose, and a rail that showed only a session's
   * own blockage would show a parent sitting in `awaiting_children` looking
   * patient while the actual question went unanswered forever.
   *
   * The breadcrumb comes with it, because "something below this needs you" is
   * not actionable — you have to be able to get there.
   */
  needsAttention:
    | null
    | {
        reason: AttentionReason;
        since: string;
        /** Absent when it is this session's own. */
        from?: { sessionId: SessionId; title: string; path: string[] };
      };
  tree: TreePosition;
  /** Cached projection; each child owns its own truth. */
  children: ChildRef[];
  /** Genuinely unrelated work run alongside — not a parent/child relationship. */
  peerSessionIds: SessionId[];
  /**
   * Splits proposed here and not yet answered (§4.3).
   *
   * On the session rather than fetched separately, because it is the *reason*
   * `needsAttention` says `split_proposed` — and a rail that says a session is
   * blocked while the thing blocking it lives behind another round trip is a
   * rail you cannot act on. The detail travels with the summons.
   */
  pendingSplits: SplitProposal[];
}

/**
 * Display order for sessions (§10): needsAttention first, then most recent.
 *
 * With many sessions the scarce resource is your attention, so blocked work must
 * be impossible to miss. Exported because a fleet spanning several hosts has to
 * re-sort the merged list — concatenating per-host sorted lists does not preserve
 * this order, and two copies of the comparator would drift.
 *
 * Lives beside `Session` rather than in the session manager because the
 * renderer needs it too: sessions arrive there ranked and then drift as
 * pushes update them in place. Keeping it in a main-process module would
 * have meant either a second copy or dragging the manager into the web
 * bundle, and this is a property of the type, not of the manager.
 */
export function byAttentionThenRecency(a: Session, b: Session): number {
  const attention = Number(Boolean(b.needsAttention)) - Number(Boolean(a.needsAttention));
  if (attention !== 0) return attention;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * A split an agent wants, and a person has not yet agreed to (§4.3).
 *
 * > The parent agent proposes via a `propose_split` tool and **the user
 * > approves.** Automatic splitting is policy-gated and off by default: it
 * > multiplies cost, and a decomposition mistake made autonomously produces a
 * > tree of subtly mis-scoped children that is harder to salvage than a single
 * > overlong session.
 *
 * Carries `why` because the approval is a judgement, not a formality. A user
 * asked to approve a split with no stated reason can only say yes.
 */
export interface SplitProposal {
  proposalId: string;
  title: string;
  scope: string;
  outOfScope: string[];
  contract: ResultContract;
  tokenCeiling: number;
  /** What in this session's state made a split the right move. */
  why: string;
}

/** Limits that keep trees from exploding (§4.3). */
export const TREE_LIMITS = {
  maxDepth: 3,
  maxChildrenPerSession: 8,
  maxOpenDescendants: 24,
} as const;

export interface ModelChip {
  agentId: AgentId;
  model: ModelRef | null;
  runtimeId: string;
  authKind: 'api-key' | 'vendor-cli-session' | 'none';
  fidelity: RuntimeCapabilities['permissionFidelity'];
}
