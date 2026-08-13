/**
 * Fold an event log into a session projection (DESIGN.md §5.1).
 *
 * Pure and incremental: `reduceEvents(id, events, base)` continues from a
 * checkpoint, and folding from a checkpoint must produce exactly what folding
 * from zero produces. That equality is the executable form of "checkpoints are
 * derived" (§5.4, invariant 8) and is property-tested.
 */

import { addCost } from '@shared/cost.js';
import {
  emptyProjection,
  isWorkspacePath,
  type AttentionReason,
  type ChecklistItem,
  type AgbrteEvent,
  type SessionId,
  type SessionProjection,
  type SessionState,
} from '@shared/types/index.js';

/**
 * A paused or failed state the user must act on. `awaiting_children` is absent
 * deliberately: a parent waiting on descendants is not itself asking for
 * anything, and the descendant that *is* blocked raises its own attention,
 * which bubbles to the root (§10).
 */
const ATTENTION_BY_STATE: Partial<Record<SessionState, AttentionReason>> = {
  awaiting_input: 'needs_input',
  awaiting_permission: 'needs_permission',
  awaiting_credentials: 'needs_credentials',
  awaiting_quota: 'quota_exhausted',
  failed: 'failed',
};

export interface ReduceOptions {
  /** Carried through from the reader; non-zero means log corruption. */
  skippedLines?: number;
}

/**
 * Whether `ev` is already folded into `p`.
 *
 * One definition, used by the fold and by the caller that reports how much it
 * replayed. Keeping the rule in two places is how a loader ends up claiming it
 * replayed an event it then skipped.
 */
export function isAlreadyFolded(p: SessionProjection, ev: AgbrteEvent): boolean {
  if (ev.seq < p.lastSeq) return true;
  return ev.seq === p.lastSeq && p.lastSeqIds.includes(ev.id);
}

export function reduceEvents(
  sessionId: SessionId,
  events: readonly AgbrteEvent[],
  base?: SessionProjection,
  opts: ReduceOptions = {},
): SessionProjection {
  const p: SessionProjection = base
    ? cloneProjection(base)
    : emptyProjection(sessionId);

  if (opts.skippedLines !== undefined) p.skippedLines += opts.skippedLines;

  for (const ev of events) {
    /*
     * Idempotent replay: an event already folded in is skipped, so overlapping
     * a checkpoint with a tail read cannot double-count.
     *
     * By identity at the boundary, not by position. This was `ev.seq <=
     * p.lastSeq`, which is the same question asked the wrong way: two events
     * sharing a seq — which logs written before §5.1e's fix really do contain —
     * meant the second was skipped as "already folded" on every load, for good.
     * `lastSeqIds` is the handful of ids actually folded at that seq, so a
     * repeat is recognised as a repeat and a collision is not mistaken for one.
     */
    if (isAlreadyFolded(p, ev)) continue;

    if (ev.seq > p.lastSeq) {
      p.lastSeq = ev.seq;
      p.lastSeqIds = [ev.id];
    } else {
      p.lastSeqIds = [...p.lastSeqIds, ev.id];
    }
    p.lastActivityAt = ev.at;

    switch (ev.type) {
      case 'session.created':
        p.state = 'planning';
        break;

      case 'session.state': {
        p.state = ev.to;
        const reason = ATTENTION_BY_STATE[ev.to];
        p.needsAttention = reason ? { reason, since: ev.at } : null;
        break;
      }

      case 'user.turn':
        p.stats.turns += 1;
        break;

      case 'agent.tool_use':
        p.stats.toolCalls += 1;
        break;

      case 'agent.tool_result':
        if (!ev.ok) p.stats.toolErrors += 1;
        break;

      case 'permission.requested':
        // The pending set is folded, not stored, so it cannot disagree with the
        // transcript and any client can read it.
        p.pendingPermissions.push({
          requestId: ev.requestId,
          agentId: ev.agentId ?? ('unknown' as never),
          tool: ev.tool,
          args: ev.args,
          askedAt: ev.at,
          ...(ev.toolUseId !== undefined ? { toolUseId: ev.toolUseId } : {}),
        });
        break;

      case 'permission.withdrawn':
        p.pendingPermissions = p.pendingPermissions.filter((r) => r.requestId !== ev.requestId);
        break;

      case 'permission.decided':
        p.stats.permissionPrompts += 1;
        if (ev.decision.result === 'deny') p.stats.permissionDenials += 1;
        // Answered, so no longer pending. Harmless for a policy-settled call,
        // which was never in the set.
        p.pendingPermissions = p.pendingPermissions.filter((r) => r.requestId !== ev.requestId);
        break;

      case 'usage':
        p.usage.inputTokens += ev.inputTokens;
        p.usage.outputTokens += ev.outputTokens;
        p.usage.cacheReadTokens += ev.cacheReadTokens ?? 0;
        p.usage.cacheWriteTokens += ev.cacheWriteTokens ?? 0;
        // Absent is "this runtime said nothing about cost", which leaves the
        // total alone. `'unknown'` is a runtime saying a cost exists and cannot
        // be seen, and that is contagious (§10).
        if (ev.cost !== undefined) p.usage.cost = addCost(p.usage.cost, ev.cost);
        break;

      case 'content.downgraded':
        p.stats.downgrades += 1;
        break;

      case 'capture.attached':
        p.stats.captures += 1;
        break;

      case 'agent.compacted':
        p.stats.compactions += 1;
        break;

      case 'checklist.updated':
        upsertChecklistItem(p.checklist, ev.itemId, ev.state, ev.text);
        break;

      case 'artifact.created':
        p.artifacts.push({
          artifactId: ev.artifactId,
          kind: ev.kind,
          ...(ev.path !== undefined && isWorkspacePath(ev.path) ? { path: ev.path } : {}),
          createdAt: ev.at,
        });
        break;

      case 'session.spawned_child':
        upsertChild(p, ev.child);
        break;

      case 'session.brief_received':
        p.brief = ev.brief;
        p.parentSessionId = ev.parentSessionId;
        break;

      case 'session.child_result': {
        const child = p.children.find((c) => c.sessionId === ev.childSessionId);
        if (child) child.lastKnown = { ...child.lastKnown, state: 'done', updatedAt: ev.at };
        break;
      }

      case 'session.orphaned':
        // Cancelling a parent promotes children to roots rather than
        // destroying independently valuable work (§4.3).
        p.parentSessionId = null;
        break;

      case 'agent.created':
        // Recorded so a reloaded log resolves an agentId to the runtime, model,
        // and gate strength that every permission decision references.
        p.agents.push({
          agentId: ev.agentId ?? ('unknown' as never),
          role: ev.role,
          runtimeId: ev.runtimeId,
          isolation: ev.isolation,
          permissionFidelity: ev.permissionFidelity,
          ...(ev.model !== undefined ? { model: ev.model } : {}),
          ...(ev.systemPrompt !== undefined ? { systemPrompt: ev.systemPrompt } : {}),
          ...(ev.reasoning !== undefined ? { reasoning: ev.reasoning } : {}),
          ...(ev.limits !== undefined ? { limits: ev.limits } : {}),
        });
        break;

      case 'agent.reasoning_changed': {
        // The projected seat is what a rebuilt spec is made from, so a change
        // that only reached the live object would be lost on the next restart.
        const seat = p.agents.find((a) => a.agentId === ev.agentId);
        if (seat) seat.reasoning = ev.to;
        break;
      }

      case 'agent.text':
      case 'agent.stopped':
      case 'agent.started':
      case 'bus.message':
      case 'memory.written':
        break;
    }
  }

  return p;
}

/**
 * `'unknown'` is absorbing: once any turn's cost is unobservable, the total is
 * unobservable. Reporting a partial sum as if it were complete would understate
 * spend, which is worse than admitting we cannot see it.
 */
function upsertChecklistItem(
  list: ChecklistItem[],
  itemId: string,
  state: string,
  text: string | undefined,
): void {
  const next = normalizeChecklistState(state);
  const existing = list.find((i) => i.id === itemId);
  if (existing) {
    existing.state = next;
    if (text !== undefined) existing.text = text;
    return;
  }
  list.push({ id: itemId, text: text ?? itemId, state: next });
}

function normalizeChecklistState(s: string): ChecklistItem['state'] {
  return s === 'todo' || s === 'doing' || s === 'done' || s === 'blocked' ? s : 'todo';
}

function upsertChild(p: SessionProjection, child: SessionProjection['children'][number]): void {
  const idx = p.children.findIndex((c) => c.sessionId === child.sessionId);
  if (idx === -1) {
    p.children.push(child);
    return;
  }
  p.children[idx] = child;
}

/** Deep enough that a fold never mutates the checkpoint it started from. */
function cloneProjection(p: SessionProjection): SessionProjection {
  return {
    ...p,
    // Copied rather than shared: nothing pushes into it today, and a future
    // edit that does must not reach back into the checkpoint it came from.
    lastSeqIds: [...p.lastSeqIds],
    checklist: p.checklist.map((i) => ({ ...i })),
    artifacts: p.artifacts.map((a) => ({ ...a })),
    children: p.children.map((c) => ({ ...c, lastKnown: { ...c.lastKnown } })),
    usage: { ...p.usage },
    stats: { ...p.stats },
    needsAttention: p.needsAttention ? { ...p.needsAttention } : null,
  };
}
