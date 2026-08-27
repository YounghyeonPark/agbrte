/**
 * The app answering from a recording instead of a host (§7).
 *
 * The published client's third state, and the one nearly every visitor lands in:
 * no host, no install, and the real renderer driving a file. What is worth
 * pinning down here is not that a lookup works — it is the three decisions that
 * make the difference between a demo and something that looks broken.
 *
 * Only `replay` is exercised, which is why it lives in its own file: `demo.ts`
 * fetches and paints a banner, needs a document, and is not where any of the
 * decisions are. `hostAddress.ts` and `askForHost.ts` are split on the same line.
 */

import { describe, expect, it } from 'vitest';
import { replay } from '../src/web/replay.js';

const recording = {
  model: 'qwen2.5:7b',
  calls: [
    { channel: 'sessions:list', args: [], value: [{ id: 'a' }, { id: 'b' }] },
    { channel: 'sessions:snapshot', args: ['a'], value: { id: 'a', title: 'first' } },
    { channel: 'sessions:snapshot', args: ['b'], value: { id: 'b', title: 'second' } },
    { channel: 'sessions:since', args: ['a', 41], value: { events: [] } },
  ],
};

describe('replaying a recorded session', () => {
  it('answers per arguments, so two sessions are not one transcript', async () => {
    const link = replay(recording);
    await expect(link.call('sessions:snapshot', ['a'])).resolves.toEqual({
      id: 'a',
      title: 'first',
    });
    await expect(link.call('sessions:snapshot', ['b'])).resolves.toEqual({
      id: 'b',
      title: 'second',
    });
  });

  /*
   * A cursor the renderer computes at runtime will not be one that was recorded,
   * and refusing on that would empty a transcript that is sitting right there.
   * The channel's answer is the same data either way — only its freshness
   * differs, and nothing in a recording is fresh.
   */
  it('falls back to the channel when the arguments were never recorded', async () => {
    const link = replay(recording);
    await expect(link.call('sessions:since', ['a', 999])).resolves.toEqual({ events: [] });
  });

  /*
   * The one that matters. Everything that *changes* something — sending a turn,
   * creating a session, answering a permission — was never asked during a
   * recording, so it has no answer here. Resolving those with `undefined` would
   * let the UI act as though the send had worked and then show a session that
   * never replies, which reads as a broken program rather than as a demo.
   */
  it('refuses an unrecorded channel by name rather than resolving empty', async () => {
    const link = replay(recording);
    await expect(link.call('sessions:send', ['a', 'hello'])).rejects.toThrow(/recorded session/i);
  });

  it('drops acks and never pushes, because nothing is running', () => {
    const link = replay(recording);
    expect(() => link.fire('ack', ['a', 3])).not.toThrow();

    let pushed = 0;
    const off = link.on('events', () => (pushed += 1));
    expect(pushed).toBe(0);
    expect(() => off()).not.toThrow();
  });

  it('keeps the first answer when a channel was recorded more than once', async () => {
    // The renderer polls: `sessions:list` is asked over and over. The fallback
    // has to be deterministic, or which transcript a card opens onto depends on
    // how long the recorder happened to sit on the dashboard.
    const polled = {
      model: 'm',
      calls: [
        { channel: 'sessions:list', args: [], value: ['first'] },
        { channel: 'sessions:list', args: ['x'], value: ['second'] },
      ],
    };
    await expect(replay(polled).call('sessions:list', ['unrecorded'])).resolves.toEqual(['first']);
  });
});
