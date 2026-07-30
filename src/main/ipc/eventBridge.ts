/**
 * Event forwarding with backpressure (DESIGN.md §7).
 *
 * §7's rule: batches of at most 50 ms or 64 events, the renderer acks by `seq`,
 * and main pauses forwarding above a watermark **while continuing to persist**.
 * That last clause is the whole design. A slow or wedged renderer must not be
 * able to stall an agent, so this class can drop out of the forwarding path
 * entirely and the run continues; the renderer sees the gap flag and refetches
 * with `sessions.since`.
 *
 * Deliberately Electron-free — it takes a `send` callback. The batching and
 * watermark logic is where the bugs live, and a unit test should not need a
 * BrowserWindow to reach them.
 *
 * **Accounting is by `seq`, not by counting events.** Tracking a separate
 * "events forwarded" tally alongside acked sequence numbers means keeping two
 * numbers in agreement, and they stop agreeing the moment a pause drops events:
 * the tally says N outstanding while the renderer has already acked past them.
 * One monotonic pair — highest forwarded, highest acked — cannot drift.
 */

import type { LoomEvent } from '@shared/types/index.js';
import {
  BACKPRESSURE_WATERMARK,
  BATCH_MAX_EVENTS,
  BATCH_MAX_MS,
  type EventBatch,
} from '@shared/ipc/contract.js';

export interface EventBridgeOptions {
  send: (batch: EventBatch) => void;
  maxEvents?: number;
  maxMs?: number;
  watermark?: number;
  /** Injectable so tests drive time rather than sleeping. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Channel {
  queue: LoomEvent[];
  timer: unknown;
  /** Highest seq handed to the renderer. */
  forwardedSeq: number;
  /** Highest seq the renderer says it has rendered. */
  ackedSeq: number;
  paused: boolean;
  /** Set while paused, so the next batch tells the renderer it has a gap. */
  droppedWhilePaused: boolean;
}

export class EventBridge {
  private readonly channels = new Map<string, Channel>();
  private readonly maxEvents: number;
  private readonly maxMs: number;
  private readonly watermark: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private readonly opts: EventBridgeOptions) {
    this.maxEvents = opts.maxEvents ?? BATCH_MAX_EVENTS;
    this.maxMs = opts.maxMs ?? BATCH_MAX_MS;
    this.watermark = opts.watermark ?? BACKPRESSURE_WATERMARK;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  push(sessionId: string, event: LoomEvent): void {
    const ch = this.channelFor(sessionId);

    if (ch.paused) {
      // Withheld, not buffered. Buffering under backpressure is how a slow
      // renderer becomes main's memory leak; the log already has the event.
      ch.droppedWhilePaused = true;
      return;
    }

    ch.queue.push(event);

    if (ch.queue.length >= this.maxEvents) {
      this.flush(sessionId);
      return;
    }
    if (ch.timer == null) {
      ch.timer = this.setTimer(() => this.flush(sessionId), this.maxMs);
    }
  }

  /**
   * The renderer has rendered through `seq`.
   *
   * Monotonic and clamped: a stale or duplicated ack cannot move the mark
   * backwards and re-pause a renderer that has caught up.
   */
  ack(sessionId: string, seq: number): void {
    const ch = this.channels.get(sessionId);
    if (!ch) return;

    ch.ackedSeq = Math.max(ch.ackedSeq, seq);

    if (ch.paused && this.outstanding(ch) < this.watermark) {
      ch.paused = false;
      // Flush immediately so a caught-up renderer is not left waiting on the
      // next append, which for an idle session may never come.
      this.flush(sessionId);
    }
  }

  /** Send whatever is queued for a session now. */
  flush(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (!ch) return;

    if (ch.timer != null) {
      this.clearTimer(ch.timer);
      ch.timer = null;
    }

    const events = ch.queue;
    const hadGap = ch.droppedWhilePaused;
    if (events.length === 0 && !hadGap) return;

    ch.queue = [];
    ch.droppedWhilePaused = false;

    const lastSeq = events.at(-1)?.seq;
    if (lastSeq !== undefined) ch.forwardedSeq = Math.max(ch.forwardedSeq, lastSeq);

    if (this.outstanding(ch) >= this.watermark) ch.paused = true;

    this.opts.send({
      sessionId,
      events,
      firstSeq: events[0]?.seq ?? -1,
      lastSeq: lastSeq ?? -1,
      // "There is a gap, refetch" — not "forwarding has stopped forever".
      paused: hadGap,
    });
  }

  flushAll(): void {
    for (const sessionId of [...this.channels.keys()]) this.flush(sessionId);
  }

  /** Drop a session's channel — on window close, or when a session unloads. */
  release(sessionId: string): void {
    const ch = this.channels.get(sessionId);
    if (ch?.timer != null) this.clearTimer(ch.timer);
    this.channels.delete(sessionId);
  }

  releaseAll(): void {
    for (const sessionId of [...this.channels.keys()]) this.release(sessionId);
  }

  /** Test and diagnostic view. */
  stateOf(sessionId: string): { queued: number; outstanding: number; paused: boolean } | null {
    const ch = this.channels.get(sessionId);
    return ch
      ? { queued: ch.queue.length, outstanding: this.outstanding(ch), paused: ch.paused }
      : null;
  }

  private outstanding(ch: Channel): number {
    return Math.max(0, ch.forwardedSeq - ch.ackedSeq);
  }

  private channelFor(sessionId: string): Channel {
    let ch = this.channels.get(sessionId);
    if (!ch) {
      ch = {
        queue: [],
        timer: null,
        forwardedSeq: 0,
        ackedSeq: 0,
        paused: false,
        droppedWhilePaused: false,
      };
      this.channels.set(sessionId, ch);
    }
    return ch;
  }
}
