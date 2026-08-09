/**
 * Frames waiting for somebody to decide what may be seen (DESIGN.md §12.1, §12.3).
 *
 * §12.1 promises the unredacted frame is never written to disk; §12.3 wants the
 * user to draw on it before it is sent. Both hold only if the drawing happens
 * before the first store, which is what this buffer exists to make possible —
 * and it is, for the few seconds it lives, the most sensitive thing in the
 * program: somebody's whole screen, unredacted, that nobody has agreed to send.
 *
 * So the tests are about *disappearing*, not about caching.
 */

import { describe, expect, it } from 'vitest';
import { MAX_PENDING, NoSuchFrame, PendingFrames } from '@main/capture/pending.js';

const frame = (fill: number): Buffer => Buffer.alloc(16, fill);
const meta = { previewWidth: 800 };

describe('a frame waits, and then it does not', () => {
  it('gives back exactly what it was handed', () => {
    const pending = new PendingFrames();
    const id = pending.put(frame(1), { ...meta, windowTitle: 'Terminal' });

    const got = pending.take(id);
    expect(got.frame.equals(frame(1))).toBe(true);
    expect(got.meta.windowTitle).toBe('Terminal');
  });

  it('consumes on take, so the unredacted copy stops existing', () => {
    /**
     * The safety property, and the reason it is `take` rather than `get`:
     * committing hands the bytes to `redactAndStore`, and from that moment the
     * only surviving copy should be the painted one. A `get` would leave a
     * second copy alive for whatever came next to forget about.
     */
    const pending = new PendingFrames();
    const id = pending.put(frame(2), meta);
    pending.take(id);

    expect(pending.size).toBe(0);
    expect(() => pending.take(id)).toThrow(NoSuchFrame);
  });

  it('expires a frame nobody claimed', () => {
    // Someone opens the annotator and wanders off. Their desktop should not sit
    // in a heap for the rest of the day.
    let clock = 1_000;
    const pending = new PendingFrames({ ttlMs: 500, now: () => clock });
    pending.put(frame(3), meta);

    clock += 501;
    expect(pending.size).toBe(0);
  });

  it('drops one on request, for the annotator being closed', () => {
    const pending = new PendingFrames();
    const id = pending.put(frame(4), meta);
    pending.drop(id);

    expect(() => pending.take(id)).toThrow(NoSuchFrame);
  });

  it('clears everything, for the app going away', () => {
    const pending = new PendingFrames();
    pending.put(frame(5), meta);
    pending.put(frame(6), meta);
    pending.clear();

    expect(pending.size).toBe(0);
  });

  it('says the same thing however a frame went missing', () => {
    /**
     * Expired, dropped, never existed, or claimed a moment ago — one sentence,
     * naming none of it. The remedy is identical in every case, and the
     * interesting facts about a screenshot nobody agreed to send are exactly the
     * ones not worth reporting.
     */
    const pending = new PendingFrames();
    const claimed = pending.put(frame(7), meta);
    pending.take(claimed);

    const messages = [claimed, 'never-existed'].map((id) => {
      try {
        pending.take(id);
        return 'no error';
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(new Set(messages).size).toBe(1);
  });
});

describe('the pile is bounded, because each one is a whole screen', () => {
  it('evicts the oldest rather than refusing the newest', () => {
    /**
     * Refusing would leave a user unable to take a screenshot because of
     * screenshots they had already abandoned — and abandonment is exactly what
     * being oldest suggests.
     */
    let clock = 0;
    const pending = new PendingFrames({ max: 2, now: () => (clock += 10) });
    const first = pending.put(frame(1), meta);
    const second = pending.put(frame(2), meta);
    const third = pending.put(frame(3), meta);

    expect(() => pending.take(first)).toThrow(NoSuchFrame);
    expect(pending.take(second).frame.equals(frame(2))).toBe(true);
    expect(pending.take(third).frame.equals(frame(3))).toBe(true);
  });

  it('holds more than one, because a second capture mid-draw is ordinary', () => {
    expect(MAX_PENDING).toBeGreaterThan(1);
  });

  it('never grows past the cap however many arrive', () => {
    let clock = 0;
    const pending = new PendingFrames({ max: 3, now: () => (clock += 1) });
    for (let i = 0; i < 50; i += 1) pending.put(frame(i), meta);

    expect(pending.size).toBe(3);
  });
});
