/**
 * Frames waiting for somebody to decide what may be seen (DESIGN.md §12.1, §12.3).
 *
 * §12.1 promises the unredacted frame is never written to disk. §12.3 wants the
 * user to draw on it before it is sent. Both hold only if the drawing happens
 * *before* the first store — which the section says itself: "the annotator must
 * therefore offer redaction at capture; anything later is a second-best the
 * sentence in §12.1 does not cover."
 *
 * So between the grab and the commit, the frame is here. In memory, never on
 * disk, for the same reason §6.7 stages partial blobs in memory: a file in the
 * blob directory is indistinguishable from a stored one to anything that lists
 * it, and this frame is precisely the one that must not be stored yet.
 *
 * ## It is the most sensitive buffer in the program
 *
 * A pending frame is somebody's whole screen, before any redaction. That shapes
 * every choice here:
 *
 *  - **It expires.** A user who opens the annotator and wanders off should not
 *    leave their desktop in a process's heap for the rest of the day.
 *  - **It is dropped on take.** Committing consumes it, so the window between
 *    "stored, redacted" and "the original is gone" is one statement long.
 *  - **There are few of them.** A cap, because the alternative is an unbounded
 *    pile of screenshots held by whoever can call `grab` fastest.
 *  - **Nothing here is logged.** Not the size, not the id, not a count — the
 *    interesting facts about a screenshot nobody has agreed to send are exactly
 *    the ones not worth writing down.
 */

import { randomUUID } from 'node:crypto';

/**
 * How long an unclaimed frame is kept.
 *
 * Long enough to draw carefully on a busy screenshot, short enough that walking
 * away clears it. There is no recovery from expiry by design — the remedy is to
 * take the picture again, which costs a keystroke and leaves nothing behind.
 */
export const PENDING_TTL_MS = 5 * 60 * 1000;

/**
 * How many frames may wait at once.
 *
 * More than one because taking a second capture before finishing the first is
 * ordinary; small because each one is a full screen and none of them has been
 * agreed to yet.
 */
export const MAX_PENDING = 4;

export class NoSuchFrame extends Error {
  constructor() {
    // Deliberately says nothing about which id, how many are held, or how long
    // ago one expired. The remedy is the same either way and the details are
    // about a screenshot nobody agreed to send.
    super('that capture is no longer waiting — take it again');
    this.name = 'NoSuchFrame';
  }
}

interface Held {
  frame: Buffer;
  at: number;
  meta: {
    windowTitle?: string;
    displayId?: string;
    /**
     * Width of the preview the client was shown.
     *
     * Held here rather than recomputed at commit, because the marks arriving
     * back are in *that* image's pixels and a second `scaleToFit` is a second
     * chance to get a different answer. One number, written once, by the code
     * that made the picture it describes.
     */
    previewWidth: number;
  };
}

/**
 * Frames between the grab and the commit.
 *
 * Deliberately not a general cache: `take` removes, there is no `peek`, and
 * nothing iterates. Every affordance a cache would offer is one more way for the
 * unredacted frame to outlive the moment it was needed.
 */
export class PendingFrames {
  private readonly held = new Map<string, Held>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs?: number; max?: number; now?: () => number } = {}) {
    this.ttlMs = opts.ttlMs ?? PENDING_TTL_MS;
    this.max = opts.max ?? MAX_PENDING;
    this.now = opts.now ?? Date.now;
  }

  /** Hold a frame, returning the handle the client trades back for it. */
  put(frame: Buffer, meta: Held['meta']): string {
    this.sweep();

    // The oldest goes when the cap is reached, rather than refusing the new one.
    // A refusal would leave the user unable to take a screenshot because of
    // screenshots they had already abandoned, and the oldest is the likeliest to
    // be abandoned.
    while (this.held.size >= this.max) {
      const oldest = [...this.held.entries()].reduce((a, b) => (a[1].at <= b[1].at ? a : b));
      this.held.delete(oldest[0]);
    }

    const id = randomUUID();
    this.held.set(id, { frame, at: this.now(), meta });
    return id;
  }

  /**
   * Claim a frame, removing it.
   *
   * Take rather than get, and that is the safety property: committing consumes
   * the pending frame, so the unredacted bytes stop existing at the moment the
   * redacted ones start. A `get` would leave a second copy alive for whatever
   * came next to forget about.
   */
  take(id: string): { frame: Buffer; meta: Held['meta'] } {
    this.sweep();
    const entry = this.held.get(id);
    if (entry === undefined) throw new NoSuchFrame();
    this.held.delete(id);
    return { frame: entry.frame, meta: entry.meta };
  }

  /** Abandon a frame — the user closed the annotator without sending. */
  drop(id: string): void {
    this.held.delete(id);
  }

  /** Everything, now. Called when the app is going away. */
  clear(): void {
    this.held.clear();
  }

  /** How many are waiting. For tests; deliberately not logged anywhere. */
  get size(): number {
    this.sweep();
    return this.held.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, entry] of this.held) {
      if (entry.at < cutoff) this.held.delete(id);
    }
  }
}
