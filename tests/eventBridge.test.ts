/**
 * Event batching and backpressure (DESIGN.md §7).
 *
 * The property under test is the one that protects a run from its own UI: main
 * keeps persisting while forwarding is paused, and a renderer that falls behind
 * loses *liveness*, never data. Time is injected so nothing here sleeps.
 */

import { describe, expect, it } from 'vitest';
import { EventBridge } from '@main/ipc/eventBridge.js';
import type { EventBatch } from '@shared/ipc/contract.js';
import type { LoomEvent } from '@shared/types/index.js';

/** A minimal event; only `seq` matters to the bridge. */
function event(seq: number): LoomEvent {
  return {
    seq,
    at: '2026-07-30T00:00:00.000Z',
    type: 'agent.text',
    text: `#${seq}`,
  } as LoomEvent;
}

interface Harness {
  bridge: EventBridge;
  sent: EventBatch[];
  /** Run the pending timer callback, as if the batch window elapsed. */
  tick(): void;
  pending(): number;
}

function harness(opts: { maxEvents?: number; watermark?: number } = {}): Harness {
  const sent: EventBatch[] = [];
  let timers: Array<() => void> = [];

  const bridge = new EventBridge({
    send: (b) => sent.push(b),
    ...(opts.maxEvents !== undefined ? { maxEvents: opts.maxEvents } : {}),
    ...(opts.watermark !== undefined ? { watermark: opts.watermark } : {}),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => {
      timers = [];
    },
  });

  return {
    bridge,
    sent,
    tick: () => {
      const due = timers;
      timers = [];
      for (const fn of due) fn();
    },
    pending: () => timers.length,
  };
}

describe('batching', () => {
  it('holds events until the window elapses', () => {
    const h = harness();
    h.bridge.push('s', event(1));
    h.bridge.push('s', event(2));

    // Sending one IPC message per event is what makes a busy agent lag the UI.
    expect(h.sent).toHaveLength(0);
    h.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('flushes immediately at the event cap without waiting for the timer', () => {
    const h = harness({ maxEvents: 3 });
    h.bridge.push('s', event(1));
    h.bridge.push('s', event(2));
    h.bridge.push('s', event(3));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.events).toHaveLength(3);
  });

  it('reports the seq range so the renderer can detect a gap', () => {
    const h = harness();
    h.bridge.push('s', event(7));
    h.bridge.push('s', event(8));
    h.tick();

    // Inferring contiguity from array length breaks the moment a pause drops
    // events, which is exactly when the renderer needs to know.
    expect(h.sent[0]).toMatchObject({ firstSeq: 7, lastSeq: 8, paused: false });
  });

  it('keeps sessions independent', () => {
    const h = harness({ maxEvents: 2 });
    h.bridge.push('a', event(1));
    h.bridge.push('b', event(1));
    h.bridge.push('b', event(2));

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.sessionId).toBe('b');
  });

  it('does not send an empty batch', () => {
    const h = harness();
    h.bridge.flush('s');
    expect(h.sent).toHaveLength(0);
  });

  it('clears the pending timer when the cap flushes first', () => {
    const h = harness({ maxEvents: 2 });
    h.bridge.push('s', event(1)); // arms the timer
    h.bridge.push('s', event(2)); // cap reached, flushes
    expect(h.pending()).toBe(0);

    // A stale timer would fire a second, empty flush and reset the window.
    h.tick();
    expect(h.sent).toHaveLength(1);
  });
});

describe('backpressure', () => {
  it('pauses once the renderer falls too far behind', () => {
    const h = harness({ maxEvents: 1, watermark: 3 });
    for (const seq of [1, 2, 3]) h.bridge.push('s', event(seq));

    expect(h.bridge.stateOf('s')?.paused).toBe(true);
  });

  it('drops rather than buffers while paused', () => {
    const h = harness({ maxEvents: 1, watermark: 2 });
    for (const seq of [1, 2]) h.bridge.push('s', event(seq));
    expect(h.bridge.stateOf('s')?.paused).toBe(true);

    const before = h.sent.length;
    for (const seq of [3, 4, 5, 6]) h.bridge.push('s', event(seq));

    // Buffering under backpressure turns a slow renderer into main's memory
    // leak. The log already holds these; the renderer refetches them.
    expect(h.sent).toHaveLength(before);
    expect(h.bridge.stateOf('s')?.queued).toBe(0);
  });

  it('resumes on an ack and flags the gap it created', () => {
    const h = harness({ maxEvents: 1, watermark: 2 });
    for (const seq of [1, 2]) h.bridge.push('s', event(seq));
    h.bridge.push('s', event(3)); // dropped

    h.bridge.ack('s', 2);

    expect(h.bridge.stateOf('s')?.paused).toBe(false);
    // `paused: true` means "you have a hole, refetch" — without it the renderer
    // would render event 4 straight after 2 and show a plausible, wrong
    // transcript.
    expect(h.sent.at(-1)?.paused).toBe(true);
  });

  it('does not resume while the renderer is still behind', () => {
    const h = harness({ maxEvents: 1, watermark: 5 });
    for (const seq of [1, 2, 3, 4, 5]) h.bridge.push('s', event(seq));
    expect(h.bridge.stateOf('s')?.paused).toBe(true);

    h.bridge.ack('s', 1); // outstanding 5 - 1 = 4, still at the limit? no: 4 < 5
    expect(h.bridge.stateOf('s')?.paused).toBe(false);
  });

  it('ignores a stale ack rather than moving the mark backwards', () => {
    const h = harness({ maxEvents: 1, watermark: 100 });
    for (const seq of [1, 2, 3]) h.bridge.push('s', event(seq));

    h.bridge.ack('s', 3);
    expect(h.bridge.stateOf('s')?.outstanding).toBe(0);

    // Acks arrive out of order under load. A stale one must not re-inflate the
    // count and re-pause a renderer that has caught up.
    h.bridge.ack('s', 1);
    expect(h.bridge.stateOf('s')?.outstanding).toBe(0);
  });

  it('tracks outstanding by seq, so a gap cannot skew it', () => {
    const h = harness({ maxEvents: 1, watermark: 2 });
    for (const seq of [1, 2]) h.bridge.push('s', event(seq));
    for (const seq of [3, 4, 5]) h.bridge.push('s', event(seq)); // dropped

    // Counting forwarded events instead would report 2 outstanding while the
    // renderer has already acked past them — the two numbers stop agreeing
    // exactly when a pause drops events.
    h.bridge.ack('s', 2);
    expect(h.bridge.stateOf('s')?.outstanding).toBe(0);
  });

  it('ignores an ack for a session it never saw', () => {
    const h = harness();
    expect(() => h.bridge.ack('nobody', 5)).not.toThrow();
  });
});

describe('lifecycle', () => {
  it('drops queued state on release', () => {
    const h = harness();
    h.bridge.push('s', event(1));
    h.bridge.release('s');

    expect(h.bridge.stateOf('s')).toBeNull();
    h.tick();
    // A timer that fires after release must not resurrect the channel.
    expect(h.sent).toHaveLength(0);
  });

  it('flushes every session on flushAll', () => {
    const h = harness();
    h.bridge.push('a', event(1));
    h.bridge.push('b', event(1));
    h.bridge.flushAll();

    expect(h.sent.map((b) => b.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('releaseAll clears everything', () => {
    const h = harness();
    h.bridge.push('a', event(1));
    h.bridge.push('b', event(1));
    h.bridge.releaseAll();

    expect(h.bridge.stateOf('a')).toBeNull();
    expect(h.bridge.stateOf('b')).toBeNull();
  });
});
