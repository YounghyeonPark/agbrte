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
        p.title = ev.title;
        // Only when there is one, so an ordinary session's projection does not
        // gain a key meaning "not a workflow" — absent already means that, and
        // a checkpoint from before this existed says the same thing by saying
        // nothing.
        if (ev.workflow !== undefined) p.workflow = ev.workflow;
        // A root's grant. A child's arrives with its brief instead, below.
        if (ev.budget !== undefined) p.budget = { ...ev.budget };
        break;

      // Last one wins, which is the whole of renaming.
      case 'session.renamed':
        p.title = ev.title;
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

      case 'skill.attached':
        // Whole config, so resume rebuilds the skill from here (§17 Q21).
        // Replace-by-id keeps a replayed attach idempotent.
        p.skills = [
          ...p.skills.filter((s) => s.id !== ev.skillId),
          { id: ev.skillId, description: ev.description, instructions: ev.instructions },
        ];
        break;

      case 'permission.standing_grant':
        // The envelope is the record: `at` says when the gate was relaxed and
        // `actor` says by whom (§17 Q19). Folded so the grant survives a
        // restart along with the transcript it explains — and `policy` with
        // it, so what is restored is the pair, never the permissive half.
        p.standingGrant = {
          grantedAt: ev.at,
          policy: ev.policy,
          ...(ev.actor !== undefined ? { grantedBy: ev.actor } : {}),
        };
        break;

      case 'usage':
        p.usage.inputTokens += ev.inputTokens;
        p.usage.outputTokens += ev.outputTokens;
        p.usage.cacheReadTokens += ev.cacheReadTokens ?? 0;
        p.usage.cacheWriteTokens += ev.cacheWriteTokens ?? 0;
        /*
         * And the budget's own counter, which is what makes it a budget (§6.5).
         *
         * `spent` was always zero — nothing anywhere incremented it — so
         * `availableTokens` was `ceiling - reservedForChildren` and a session's
         * ceiling bounded only what it could hand to children, never what it
         * could use itself. §6.5 gives that job to a ModelGateway that §15 says
         * is deliberately not built, and the half of it this deployment needs
         * turns out not to require the gateway at all: the usage is already on
         * the log, one line above.
         *
         * **Input plus output, and the cache fields deliberately not added.**
         * They are a *breakdown* of the input side — tokens served from a cache
         * or written to one are still the prompt — so adding them would charge a
         * cached turn twice and make a ceiling arbitrarily strict for callers
         * whose provider happens to report the detail. They are priced
         * differently and stay separate in `usage` for exactly that reason; a
         * token count is not a price.
         *
         * **And free tokens are not counted at all.** A ceiling bounds spending,
         * and a local model spends nothing; charging a budget for it would stop
         * a long local run at a figure chosen for a cost never incurred. The
         * totals above still record them, because what a session *used* is true
         * either way and the UI shows it — this is the budget, which is about
         * what it cost.
         */
        if (p.budget !== undefined && ev.free !== true) {
          p.budget.spent += ev.inputTokens + ev.outputTokens;
        }
        // Absent is "this runtime said nothing about cost", which leaves the
        // total alone. `'unknown'` is a runtime saying a cost exists and cannot
        // be seen, and that is contagious (§10).
        if (ev.cost !== undefined) p.usage.cost = addCost(p.usage.cost, ev.cost);
        /*
         * Which endpoint answered, kept as a set in first-use order (§13).
         *
         * The durable half of the same fact the live session tracks. Without
         * this, a host restart would answer "which endpoints did this agent
         * use" with the seat's own — the one endpoint a failed-over turn did
         * *not* reach — and the answer would silently improve as new turns ran.
         *
         * Absent means no endpoint rather than an unknown one: the echo runtime
         * and a vendor CLI both spend tokens against nothing this names.
         */
        if (ev.endpointId !== undefined) {
          // Same defaulting as `cloneProjection`: a base from an older build
          // reaches the fold with no array here.
          p.usage.endpoints ??= [];
          if (!p.usage.endpoints.includes(ev.endpointId)) p.usage.endpoints.push(ev.endpointId);
        }
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
        /*
         * The reservation this spawn took, summed back onto the parent.
         *
         * Absent on an event written before the field existed, which folds as
         * zero — the old behaviour, where a restarted parent believed nothing
         * was reserved and a tree could be made to outspend its root by
         * restarting the host between spawns.
         */
        if (p.budget !== undefined && ev.reserved !== undefined) {
          p.budget.reservedForChildren += ev.reserved;
        }
        break;

      case 'session.brief_received':
        p.brief = ev.brief;
        p.parentSessionId = ev.parentSessionId;
        // The whole position when the event carries one; older logs have only
        // the parent, and a reader falls back to that.
        if (ev.position !== undefined) p.tree = { ...ev.position };
        // A child's ceiling has always been durable — it is part of the brief,
        // which is where its whole scope lives. It simply was never read back.
        // Absent means unbudgeted, which stays absent rather than folding to a
        // zero the reader would take for a ceiling.
        if (ev.brief.budget !== undefined) p.budget = { ...ev.brief.budget };
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
        // Adopted as a root, so the position goes with the parent. Keeping a
        // stale one would leave an orphan claiming a depth under a tree it is
        // no longer in.
        p.tree = null;
        break;

      case 'session.joined_group':
        // Last one wins: a session moved from one group to another has two
        // joins in its log, and the transcript is the record of the move.
        p.group = { groupId: ev.groupId, name: ev.name };
        break;

      case 'session.left_group':
        // Guarded by id, so a stale `left` for a group this session has since
        // rejoined cannot silently empty the current membership.
        if (p.group?.groupId === ev.groupId) p.group = null;
        break;

      case 'session.peer_message_sent':
      case 'session.peer_message_received':
        // Nothing folded. The exchange is read from the log itself — the
        // recipient's `user.turn` already counts, and a projected copy of the
        // text would be a second place for the same words to live (§17 Q22).
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
          ...(ev.capabilities !== undefined ? { capabilities: ev.capabilities } : {}),
        });
        break;

      case 'agent.retired': {
        // §4.2: a session holds one agent, so a resume has to know which seats
        // were replaced. Without this fold the rule would hold until the next
        // restart and then hand the session two active agents.
        const seat = p.agents.find((a) => a.agentId === ev.agentId);
        if (seat) seat.retiredAt = ev.at;
        break;
      }

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
    // Copied per seat, not shared: `agent.retired` and `agent.reasoning_changed`
    // both edit a projected seat in place, and a checkpoint continued from is a
    // *base* — reaching back into its objects would rewrite the thing this fold
    // was supposed to leave alone (§5.4, invariant 8).
    agents: p.agents.map((a) => ({ ...a })),
    checklist: p.checklist.map((i) => ({ ...i })),
    artifacts: p.artifacts.map((a) => ({ ...a })),
    children: p.children.map((c) => ({ ...c, lastKnown: { ...c.lastKnown } })),
    /*
     * `endpoints` copied rather than shared, and defaulted rather than spread
     * blind.
     *
     * Copied because the fold pushes into it and a checkpoint continued from is
     * a *base* (§5.4, invariant 8). Defaulted because a checkpoint written
     * before this field existed has no array to copy, and `[...undefined]`
     * throws — a crash on resume, on exactly the sessions that predate the
     * feature. The house rule applies here too: a checkpoint from before this
     * existed says "no endpoint recorded" by saying nothing.
     */
    usage: { ...p.usage, endpoints: [...(p.usage.endpoints ?? [])] },
    stats: { ...p.stats },
    needsAttention: p.needsAttention ? { ...p.needsAttention } : null,
    standingGrant: p.standingGrant ? { ...p.standingGrant } : null,
    skills: p.skills.map((s) => ({ ...s })),
    group: p.group ? { ...p.group } : null,
  };
}
