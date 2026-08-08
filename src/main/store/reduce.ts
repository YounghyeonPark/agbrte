/**
 * Fold an event log into a session projection (DESIGN.md §5.1).
 *
 * Pure and incremental: `reduceEvents(id, events, base)` continues from a
 * checkpoint, and folding from a checkpoint must produce exactly what folding
 * from zero produces. That equality is the executable form of "checkpoints are
 * derived" (§5.4, invariant 8) and is property-tested.
 */

import {
  emptyProjection,
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
    // Idempotent replay: an event already folded in is skipped, so overlapping
    // a checkpoint with a tail read cannot double-count.
    if (ev.seq <= p.lastSeq) continue;
    p.lastSeq = ev.seq;
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
        p.usage.cost = addCost(p.usage.cost, ev.cost);
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
          ...(ev.path !== undefined && '$ws' in ev.path ? { path: ev.path } : {}),
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
          ...(ev.limits !== undefined ? { limits: ev.limits } : {}),
        });
        break;

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
function addCost(total: number | 'unknown', delta: number | 'unknown' | undefined): number | 'unknown' {
  if (total === 'unknown' || delta === 'unknown') return 'unknown';
  if (delta === undefined) return total;
  return total + delta;
}

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
    checklist: p.checklist.map((i) => ({ ...i })),
    artifacts: p.artifacts.map((a) => ({ ...a })),
    children: p.children.map((c) => ({ ...c, lastKnown: { ...c.lastKnown } })),
    usage: { ...p.usage },
    stats: { ...p.stats },
    needsAttention: p.needsAttention ? { ...p.needsAttention } : null,
  };
}
