/**
 * Advisory file leases and stale-read detection (DESIGN.md §9).
 *
 * > **`shared`** (default) — agents work the workspace directly under an
 * > advisory **file lease**: exclusive, time-bounded, required before write; a
 * > write to a file modified since the agent last read it is rejected with a
 * > stale-read error the agent can recover from.
 *
 * Multiple agents per session already work. Nothing has been arbitrating their
 * writes, which means the failure available today is the quiet one: two agents
 * read the same file, both edit it, and the second silently discards the first's
 * work with every tool call reporting success.
 *
 * ## Two different rejections, deliberately
 *
 * **Contended** — someone else holds the lease. Recoverable by waiting or by
 * working elsewhere, and the error says who and until when so the agent can
 * choose.
 *
 * **Stale** — nobody holds it, but the file changed since *this* agent read it.
 * Recoverable by re-reading. Collapsing the two would tell an agent to wait for
 * a lease that is already free, which is advice it cannot act on.
 *
 * ## Keyed by path, never by session
 *
 * §9 is emphatic and gives the reason: "Anyone tempted to key leases by
 * `sessionId` should note that it would silently reintroduce cross-session
 * clobbering the moment hierarchy is used." Two children of one tree working the
 * same repo contend through this table exactly as two agents in one session do,
 * with no additional mechanism — which is why the table belongs to the workspace
 * and lives in the process adjacent to its filesystem.
 *
 * ## Advisory, and honest about it
 *
 * These bind any agent whose tools *we* run. A CLI subprocess runs its own
 * tools and is outside this table entirely, which is precisely why §3.10 forbids
 * an `all-or-nothing` runtime from `shared` isolation: nothing here can hold it,
 * so the filesystem view has to.
 */

import { createHash } from 'node:crypto';
import type { AgentId } from '@shared/types/index.js';

/**
 * How long a write keeps its file after the call returns.
 *
 * Not zero, which is the tempting answer. A lease released the instant a write
 * finishes leaves the read-modify-write window unprotected, and that window is
 * where clobbering actually happens: an agent reads, thinks, and edits, and the
 * damage is done between those steps rather than during the syscall.
 *
 * Not long either. A lease is advisory and time-bounded so a crashed agent
 * cannot hold a file forever, and thirty seconds is enough for a follow-up edit
 * while being shorter than anyone would wait before investigating.
 */
export const LEASE_TTL_MS = 30_000;

export type LeaseOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'contended';
      heldBy: AgentId;
      until: string;
    };

export type Freshness =
  /** This agent read the file and it has not changed since. */
  | { state: 'fresh' }
  /** This agent never read it, so there is nothing to be stale about. */
  | { state: 'unread' }
  /** It changed under this agent's feet. */
  | { state: 'stale' };

interface Lease {
  holder: AgentId;
  expiresAt: number;
}

export class WorkspaceLeases {
  private readonly leases = new Map<string, Lease>();
  /** What each agent last saw, per path. `agentId\0path` → content hash. */
  private readonly seen = new Map<string, string>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs: number = LEASE_TTL_MS,
  ) {}

  /**
   * Claim a path for writing, or say who has it.
   *
   * Re-entrant for the holder: an agent editing the same file twice extends its
   * own lease rather than colliding with itself, which is otherwise the first
   * thing that happens in every realistic turn.
   */
  acquire(path: string, holder: AgentId): LeaseOutcome {
    const now = this.now();
    const existing = this.leases.get(path);

    if (existing !== undefined && existing.expiresAt > now && existing.holder !== holder) {
      return {
        ok: false,
        reason: 'contended',
        heldBy: existing.holder,
        until: new Date(existing.expiresAt).toISOString(),
      };
    }

    this.leases.set(path, { holder, expiresAt: now + this.ttlMs });
    return { ok: true };
  }

  /** Give a path back early. Someone else's lease is never released by mistake. */
  release(path: string, holder: AgentId): void {
    if (this.leases.get(path)?.holder === holder) this.leases.delete(path);
  }

  /**
   * Give back every file this agent holds, at the end of a turn.
   *
   * Deliberately does **not** forget what the agent read. Those two look like
   * one operation and are not: an agent's turns are a continuous piece of work,
   * so a file it read last turn and edits this turn must still be checked
   * against what it saw. Clearing the ledger here would turn every cross-turn
   * edit from `stale` into `unread`, which is permitted — quietly removing the
   * protection at exactly the point a long job needs it.
   *
   * Releasing at all is what keeps the TTL a crash backstop rather than the
   * normal path: an idle agent should not hold a sibling's file for thirty
   * seconds after it has stopped working.
   */
  releaseHeld(holder: AgentId): void {
    for (const [path, lease] of this.leases) {
      if (lease.holder === holder) this.leases.delete(path);
    }
  }

  /** Forget an agent entirely — leases and reads — when it is finished for good. */
  releaseAll(holder: AgentId): void {
    this.releaseHeld(holder);
    for (const key of [...this.seen.keys()]) {
      if (key.startsWith(`${holder}\0`)) this.seen.delete(key);
    }
  }

  /** Record what an agent just read, so a later write can be checked against it. */
  noteRead(path: string, holder: AgentId, content: string): void {
    this.seen.set(`${holder}\0${path}`, hash(content));
  }

  /**
   * Whether what this agent last read still describes the file.
   *
   * Hashed rather than compared by mtime. Filesystem timestamp granularity is
   * coarse enough on Windows that two writes within the same tick are
   * indistinguishable, and "the check silently passed because the clock did not
   * move" is the failure mode that would make this whole file decorative.
   */
  freshness(path: string, holder: AgentId, current: string): Freshness {
    const seen = this.seen.get(`${holder}\0${path}`);
    if (seen === undefined) return { state: 'unread' };
    return seen === hash(current) ? { state: 'fresh' } : { state: 'stale' };
  }

  /** Test and diagnostic view. */
  holderOf(path: string): AgentId | null {
    const lease = this.leases.get(path);
    return lease !== undefined && lease.expiresAt > this.now() ? lease.holder : null;
  }
}

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
