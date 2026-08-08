/**
 * Scheduling against a shared allowance (DESIGN.md §8, §3.11).
 *
 * > every agent with the same `quotaGroup` draws on one allowance whether
 * > they're on one machine or five; eight agents scheduled independently against
 * > a single seat allowance will burn the window in minutes.
 *
 * ## What this actually buys, stated narrowly
 *
 * The parking machinery already handles a spent window *after* it is hit: the
 * session goes to `awaiting_quota` and resumes at `resetsAt` (§4.1). What it
 * cannot do is stop the other seven agents from each sending their own request
 * to independently discover the same fact. **The first agent to learn a window
 * is spent is the one that should tell the rest**, and that is this file.
 *
 * ## Optimistic by default, and that is deliberate
 *
 * §17's third open question settles this: a `quotaGroup` for a subscription is
 * really global to the user, and Agbrte only sees what it schedules — usage from
 * the vendor's own app or another device is invisible. So a bucket sized from a
 * guessed limit would be wrong in whichever direction it guessed, and wrong
 * quietly. There is no throttle at all until a provider says there should be;
 * from then on the interval is learned from what it said, and decays back as
 * requests start succeeding again.
 *
 * That is "sized from observed limits" taken literally. The alternative — ship a
 * number — means a local setup gets slower for no reason and a real limit still
 * is not respected.
 *
 * ## A local model draws on nobody's allowance
 *
 * `auth: none` gets no group and never waits. Throttling an Ollama on the same
 * machine would be pure harm: there is no shared credential, no window, and
 * nothing to protect.
 *
 * ## Where this lives, against what §8 says
 *
 * §8's process table puts the QuotaScheduler in main. It is in the **session
 * host** instead, because that is where turns actually start — a scheduler in
 * main could not gate a turn sent by the CLI, by a second client, or by the
 * host's own parked-session sweeper waking at reset. §13's rule that a gate
 * which can be bypassed is not a gate applies to this one too.
 *
 * The cost is real and worth naming: a credential group spanning *two hosts* is
 * scheduled by each of them separately. That is the same blind spot §17 already
 * admits for the vendor's own app, arriving from another direction, and it is
 * not solved here.
 */

import type { AuthMode, StopReason } from '@shared/types/index.js';

/** The first interval imposed once a provider says to slow down. */
const FIRST_BACKOFF_MS = 1_000;
/** No more than this between requests, however unhappy a provider is. */
const MAX_BACKOFF_MS = 60_000;
/** Successes needed to halve the learned interval. */
const DECAY_AFTER_SUCCESSES = 3;

/**
 * Which allowance an agent draws on, or `null` for none.
 *
 * Derived from `AuthMode` rather than configured, because the credential *is*
 * the allowance: two agents sharing a key share its limit whether or not anyone
 * remembered to say so.
 */
export function groupFor(auth: AuthMode): string | null {
  switch (auth.kind) {
    case 'vendor-cli-session':
      // §3.11 names this explicitly: agents on one seat, sharing one throttle.
      return `cli:${auth.cliId}:${auth.quotaGroup}`;
    case 'api-key':
      // One key, one allowance. The endpoint id is the key's identity here,
      // since the key itself must never leave the module that holds it (§13).
      return `key:${auth.endpointId}`;
    case 'none':
      return null;
  }
}

export interface QuotaStatus {
  group: string;
  /** Milliseconds currently imposed between requests. 0 when unthrottled. */
  intervalMs: number;
  /** When the whole group may send again, if it is being held. */
  heldUntil: string | null;
  /** Agents queued behind the group right now. */
  waiting: number;
}

export interface QuotaSchedulerOptions {
  now?: () => number;
  /** Overridden in tests so nothing waits on real time. */
  sleep?: (ms: number) => Promise<void>;
}

interface Group {
  intervalMs: number;
  lastStart: number;
  /** Epoch ms until which nobody in this group may send. */
  heldUntil: number;
  successes: number;
  waiting: number;
}

export class QuotaScheduler {
  private readonly groups = new Map<string, Group>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: QuotaSchedulerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Wait until this group may send, then claim the slot.
   *
   * Resolves immediately for an ungrouped agent and for a group nothing has
   * complained about — which is every group until a provider says otherwise.
   *
   * `onWait` fires only when there is a real wait, so a caller can say why a
   * turn has not started. A session queued behind a shared credential looks
   * exactly like a hung one otherwise, and §10's stall detector would flag it.
   */
  async acquire(group: string | null, onWait?: (ms: number) => void): Promise<void> {
    if (group === null) return;
    const entry = this.groupOf(group);

    for (;;) {
      const now = this.now();
      const heldFor = entry.heldUntil - now;
      const spacedFor = entry.intervalMs === 0 ? 0 : entry.intervalMs - (now - entry.lastStart);
      const wait = Math.max(heldFor, spacedFor);
      if (wait <= 0) break;

      entry.waiting += 1;
      onWait?.(wait);
      try {
        await this.sleep(wait);
      } finally {
        entry.waiting -= 1;
      }
      // Re-checked rather than assumed: another agent's failure may have
      // extended the hold while this one was sleeping, and sending anyway would
      // be exactly the request the hold exists to prevent.
    }

    entry.lastStart = this.now();
  }

  /**
   * Tell the group what a provider just said.
   *
   * This is the whole point of grouping. One agent hitting a spent window is
   * information about the *credential*, not about that agent, so the other seven
   * should never send the request that would tell them the same thing.
   */
  observe(group: string | null, stop: StopReason): void {
    if (group === null) return;
    const entry = this.groupOf(group);

    switch (stop.kind) {
      case 'quota_exhausted': {
        const resetsAt = stop.resetsAt === undefined ? NaN : Date.parse(stop.resetsAt);
        // A window with no stated reset is *not* held. Holding until a time
        // nobody named would block the group forever; those sessions park and
        // wait for a person instead, which is §4.1's answer to the same problem.
        if (Number.isFinite(resetsAt)) entry.heldUntil = Math.max(entry.heldUntil, resetsAt);
        entry.successes = 0;
        return;
      }

      case 'rate_limited': {
        if (stop.retryAfterMs !== undefined) {
          entry.heldUntil = Math.max(entry.heldUntil, this.now() + stop.retryAfterMs);
        }
        // Doubling from a small start, because the provider told us the current
        // pace is wrong but not what the right one is.
        entry.intervalMs = Math.min(
          entry.intervalMs === 0 ? FIRST_BACKOFF_MS : entry.intervalMs * 2,
          MAX_BACKOFF_MS,
        );
        entry.successes = 0;
        return;
      }

      case 'end_turn':
      case 'tool_calls': {
        // Decays rather than clearing. One success after a rate limit means the
        // spacing worked, not that it was unnecessary — dropping straight back
        // to unthrottled would rediscover the limit immediately.
        if (entry.intervalMs === 0) return;
        entry.successes += 1;
        if (entry.successes < DECAY_AFTER_SUCCESSES) return;
        entry.successes = 0;
        entry.intervalMs = entry.intervalMs <= FIRST_BACKOFF_MS ? 0 : Math.floor(entry.intervalMs / 2);
        return;
      }

      default:
        // Everything else — a refusal, a transport failure, a misconfiguration —
        // says nothing about the allowance. Treating a dropped connection as
        // evidence of a rate limit would throttle a group for a network blip.
        return;
    }
  }

  /** Every group this host has scheduled against. For the UI and for tests. */
  status(): QuotaStatus[] {
    const now = this.now();
    return [...this.groups.entries()].map(([group, entry]) => ({
      group,
      intervalMs: entry.intervalMs,
      heldUntil: entry.heldUntil > now ? new Date(entry.heldUntil).toISOString() : null,
      waiting: entry.waiting,
    }));
  }

  private groupOf(group: string): Group {
    let entry = this.groups.get(group);
    if (entry === undefined) {
      // Unthrottled until something says otherwise (§17, open question 3).
      entry = { intervalMs: 0, lastStart: 0, heldUntil: 0, successes: 0, waiting: 0 };
      this.groups.set(group, entry);
    }
    return entry;
  }
}
