/**
 * Turning a drag into a rectangle the capture pipeline can use (DESIGN.md §12.1).
 *
 * > A transparent, always-on-top, click-through-until-armed overlay handles
 * > region selection.
 *
 * The overlay is a window; this is the arithmetic. It is separate because the
 * arithmetic is where region selection actually goes wrong, and it is the only
 * part that can be checked without a compositor.
 *
 * ## Three coordinate spaces, and only one of them is the picture
 *
 * A drag happens in **CSS pixels inside one overlay window**. Electron places
 * that window using **DIPs in the virtual-screen space**, where a second monitor
 * to the left of the primary has a negative origin. And `desktopCapturer`
 * returns **native device pixels**, which on a retina display is twice the DIPs
 * in each direction.
 *
 * Every one of those conversions has a plausible-looking wrong answer:
 *
 *  - Forget the window origin and a selection on the second monitor lands at the
 *    same offset on the first.
 *  - Forget `scaleFactor` and a retina selection crops the **top-left quarter**
 *    of what the user drew — which looks enough like a working feature to ship.
 *  - Apply `scaleFactor` twice and it crops a quarter of that again.
 *
 * So the overlay reports the drag in its own window's coordinates and this
 * converts, once, with the display it happened on named explicitly.
 *
 * ## A drag that leaves the display it started on
 *
 * Clamped to that display. `desktopCapturer` has one source per screen, so a
 * rectangle spanning two monitors is not a capture anyone can take — and
 * clamping keeps the part the user was pointing at, where refusing would throw
 * away a gesture that was ninety percent right.
 */

import type { Rect } from '../content/redact.js';

/** The subset of `Electron.Display` this needs, so tests need no Electron. */
export interface DisplayInfo {
  id: number;
  /** DIPs in the virtual-screen space. `x`/`y` may be negative. */
  bounds: { x: number; y: number; width: number; height: number };
  /** DIPs → device pixels. 2 on a retina display, 1.5 on much of Windows. */
  scaleFactor: number;
}

/** What the overlay reports: a drag, in the coordinates of its own window. */
export interface Selection {
  displayId: number;
  /** CSS pixels within the overlay, which covers exactly one display. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ResolvedRegion {
  /** Matches `ScreenSource.displayId`, so the caller knows what to grab. */
  displayId: string;
  /** In the captured image's own pixels — what `cropFrame` expects. */
  region: Rect;
}

/**
 * The smallest drag that counts as a selection.
 *
 * Below this it is a click, and a click that produced a 3×2-pixel screenshot
 * would read as the overlay being broken. Measured in CSS pixels, before
 * scaling, because it is about what the hand did rather than what the display
 * is.
 */
export const MIN_SELECTION_PX = 8;

export class SelectionTooSmall extends Error {
  constructor() {
    super('that was a click rather than a drag — hold and drag to choose a region');
    this.name = 'SelectionTooSmall';
  }
}

export class UnknownDisplay extends Error {
  constructor(id: number) {
    super(`display ${id} is no longer attached`);
    this.name = 'UnknownDisplay';
  }
}

/**
 * Convert a drag into a region in capture pixels.
 *
 * Normalizes direction first: dragging up-and-left is the same gesture as
 * down-and-right and produces negative width if taken literally, which every
 * downstream clamp would then quietly turn into an empty rectangle.
 */
export function resolveSelection(
  displays: readonly DisplayInfo[],
  selection: Selection,
): ResolvedRegion {
  const display = displays.find((d) => d.id === selection.displayId);
  // A monitor can be unplugged between opening the overlay and letting go of
  // the mouse. Saying which is more useful than a coordinate failure later.
  if (display === undefined) throw new UnknownDisplay(selection.displayId);

  const x0 = Math.min(selection.x, selection.x + selection.w);
  const y0 = Math.min(selection.y, selection.y + selection.h);
  const x1 = Math.max(selection.x, selection.x + selection.w);
  const y1 = Math.max(selection.y, selection.y + selection.h);

  if (x1 - x0 < MIN_SELECTION_PX || y1 - y0 < MIN_SELECTION_PX) throw new SelectionTooSmall();

  // Clamped to the display, in CSS pixels, before scaling. A drag off the edge
  // of a monitor is ordinary, and `desktopCapturer` has one source per screen —
  // so the part on this display is the part that can be captured.
  const cx0 = Math.max(0, Math.min(display.bounds.width, x0));
  const cy0 = Math.max(0, Math.min(display.bounds.height, y0));
  const cx1 = Math.max(cx0, Math.min(display.bounds.width, x1));
  const cy1 = Math.max(cy0, Math.min(display.bounds.height, y1));

  const scale = display.scaleFactor;
  return {
    displayId: String(display.id),
    region: {
      // Rounded outward, so a fractional edge keeps the pixel the user could see
      // rather than shaving it. Losing a row off a selection drawn around a line
      // of text is exactly the row that mattered.
      x: Math.floor(cx0 * scale),
      y: Math.floor(cy0 * scale),
      w: Math.ceil((cx1 - cx0) * scale),
      h: Math.ceil((cy1 - cy0) * scale),
    },
  };
}

/**
 * The first overlay to answer, ignoring the ones that fail.
 *
 * Not `Promise.race`, for two reasons that pull the same way.
 *
 * **A rejection must not read as a cancel.** `race` settles on whichever
 * promise finishes first including a rejected one, so an overlay that failed to
 * load on a secondary monitor would resolve the whole selection — as `null` if
 * caught, which is Escape, silently cancelling a capture the user is still in
 * the middle of drawing on another screen.
 *
 * **The losers must not go unhandled.** Once one answers, the rest are still
 * awaiting `executeJavaScript` in windows the caller is about to destroy, which
 * rejects them. With `race` nothing is watching, so on a two-monitor machine
 * every successful region selection would raise an unhandled rejection — and a
 * strict Node would take the app down over a capture that worked.
 *
 * So: the first *resolution* wins, failures are counted, and only all of them
 * failing is a failure — with the first error, because "the overlay did not
 * open" is worth reading and "3 overlays failed" is not.
 */
export function firstAnswer(attempts: Array<Promise<Selection | null>>): Promise<Selection | null> {
  return new Promise((resolve, reject) => {
    let outstanding = attempts.length;
    let firstError: unknown = null;

    for (const attempt of attempts) {
      attempt.then(resolve, (err: unknown) => {
        firstError ??= err;
        outstanding -= 1;
        if (outstanding === 0) reject(firstError instanceof Error ? firstError : new Error(String(firstError)));
      });
    }
  });
}
