/**
 * Showing the main window, and not depending on one event to do it (§3.3, §4.1).
 *
 * The window is created hidden and shown on `ready-to-show`, which is Electron's
 * way of avoiding a frame of unpainted window: it fires once the renderer has
 * painted, so the first thing anybody sees is the interface rather than a blank
 * rectangle. That was the whole of it, and it had no second path.
 *
 * ## What that cost, measured
 *
 * On the user's Ubuntu 24.04 machine — GNOME 46 under Wayland, the display
 * driven by a server board's ASPEED BMC VGA — `ready-to-show` never arrived. The
 * window was created, the renderer loaded the page and stayed alive for seventeen
 * hours, and nothing was ever on screen. Nothing was logged either, because
 * nothing had *failed*: an event that does not fire is not an error. The person
 * saw an app that had not launched, launched it again, and got a second one
 * exactly as invisible.
 *
 * `--disable-gpu` did not change it and `--ozone-platform=x11` did, so it was
 * Electron's native Wayland path on that machine rather than GL. The cause was
 * never found: three weeks later, after kernel, Mesa, mutter and NVIDIA driver
 * updates, the same machine under Wayland delivered `ready-to-show` normally and
 * the fallback below never fired (`docs/status.md`). What this settles is the
 * part that was ours whatever the cause: a window whose only route onto the
 * screen was one event, with nothing said when that event did not come.
 *
 * ## The fallback, and what it costs
 *
 * If `ready-to-show` has not arrived after `fallbackMs`, the window is shown
 * anyway. On a machine where the event works, the event wins and the timer does
 * nothing. Where it does not, the cost is a moment of `backgroundColor` — the
 * theme's own ground, set in `createWindow` — instead of an app that appears
 * never to have started. That trade is not close.
 *
 * And it **says so**, on stderr, which is where a desktop launch's output lands
 * in the journal. The investigation that produced this file started from a
 * journal with nothing in it; the next one starts from a sentence naming the
 * event that did not arrive.
 *
 * Shown at most once. A person who minimises the window in the first moment has
 * made a choice, and a timer that brought it back would be overriding them.
 */

export interface Revealable {
  once(event: 'ready-to-show' | 'closed', listener: () => void): unknown;
  isDestroyed(): boolean;
  show(): void;
}

export interface RevealOptions {
  /** How long to wait for `ready-to-show` before showing the window anyway. */
  fallbackMs: number;
  /** Where the fallback reports itself; `process.stderr` in the app. */
  report?: (line: string) => void;
}

/**
 * Show `win` on `ready-to-show`, or after `fallbackMs` if that never comes.
 *
 * Returns how it was shown, for the tests and for anybody diagnosing a machine:
 * `'ready'`, `'fallback'`, or `null` while it has not been shown yet.
 */
export function revealWhenReady(
  win: Revealable,
  opts: RevealOptions,
): { how: () => 'ready' | 'fallback' | null } {
  let how: 'ready' | 'fallback' | null = null;

  const reveal = (by: 'ready' | 'fallback'): void => {
    if (how !== null || win.isDestroyed()) return;
    how = by;
    clearTimeout(timer);
    win.show();
  };

  const timer = setTimeout(() => {
    if (how !== null || win.isDestroyed()) return;
    opts.report?.(
      `window shown without ready-to-show: it had not arrived after ${opts.fallbackMs}ms. ` +
        'The renderer may not have painted — on Linux under Wayland, launching with ' +
        '--ozone-platform=x11 is the known workaround.\n',
    );
    reveal('fallback');
  }, opts.fallbackMs);

  win.once('ready-to-show', () => reveal('ready'));
  win.once('closed', () => clearTimeout(timer));

  return { how: () => how };
}
