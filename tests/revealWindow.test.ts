/**
 * The main window's route onto the screen (`revealWindow.ts`, §3.3, §4.1).
 *
 * It had one route — `ready-to-show` — and on a real Ubuntu machine under
 * Wayland that event never came: a window that existed, a renderer alive for
 * seventeen hours, and nothing on screen or in the journal. These pin the
 * second route and the sentence it leaves behind.
 *
 * Driven with a fake window and fake timers, because what is under test is the
 * ordering — which of two things happens first, and what the loser does — and a
 * real window would make that a question about how fast this machine paints.
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { revealWhenReady, type Revealable } from '../src/main/revealWindow.js';

function fakeWindow(): Revealable & {
  emit: (event: 'ready-to-show' | 'closed') => void;
  shows: number;
  destroyed: boolean;
} {
  const events = new EventEmitter();
  const win = {
    shows: 0,
    destroyed: false,
    once(event: 'ready-to-show' | 'closed', listener: () => void) {
      events.once(event, listener);
      return win;
    },
    isDestroyed: () => win.destroyed,
    show() {
      win.shows += 1;
    },
    emit(event: 'ready-to-show' | 'closed') {
      events.emit(event);
    },
  };
  return win;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('showing the main window', () => {
  it('shows on ready-to-show, and the fallback then does nothing', () => {
    /*
     * The working machine, which is nearly every machine. The event wins, the
     * window is shown once, and the timer — still pending when the event lands
     * — neither shows it again nor says anything. A warning on a machine that
     * worked would be a false diagnostic, which is worse than none.
     */
    const win = fakeWindow();
    const said: string[] = [];
    const state = revealWhenReady(win, { fallbackMs: 5_000, report: (l) => said.push(l) });

    win.emit('ready-to-show');
    vi.advanceTimersByTime(10_000);

    expect(win.shows).toBe(1);
    expect(state.how()).toBe('ready');
    expect(said).toEqual([]);
  });

  it('shows anyway when ready-to-show never comes, and says why', () => {
    /*
     * The machine that motivated this. Before, the window stayed hidden for
     * ever and nothing was written anywhere; now it is shown at the deadline and
     * the journal gets a sentence naming the event that did not arrive and the
     * workaround that was measured to work.
     */
    const win = fakeWindow();
    const said: string[] = [];
    const state = revealWhenReady(win, { fallbackMs: 5_000, report: (l) => said.push(l) });

    vi.advanceTimersByTime(4_999);
    expect(win.shows).toBe(0);
    expect(state.how()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(win.shows).toBe(1);
    expect(state.how()).toBe('fallback');
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('ready-to-show');
    expect(said[0]).toContain('--ozone-platform=x11');
  });

  it('does not show a second time when the event arrives late', () => {
    /*
     * Shown at most once. The fallback fired, and then the renderer caught up.
     * A second `show()` on its own is harmless on a visible window — but if the
     * person minimised it in between, a late event bringing it back would be the
     * app overriding what they just did.
     */
    const win = fakeWindow();
    const state = revealWhenReady(win, { fallbackMs: 5_000 });

    vi.advanceTimersByTime(5_000);
    win.emit('ready-to-show');

    expect(win.shows).toBe(1);
    expect(state.how()).toBe('fallback');
  });

  it('never shows a window that was closed before either route arrived', () => {
    // A window closed during startup is destroyed, and `show()` on a destroyed
    // BrowserWindow throws in main — an error box over an app somebody had just
    // chosen to close.
    const win = fakeWindow();
    const said: string[] = [];
    revealWhenReady(win, { fallbackMs: 5_000, report: (l) => said.push(l) });

    win.destroyed = true;
    win.emit('closed');
    vi.advanceTimersByTime(10_000);

    expect(win.shows).toBe(0);
    expect(said).toEqual([]);
  });
});
