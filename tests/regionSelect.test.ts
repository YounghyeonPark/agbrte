/**
 * Turning a drag into a rectangle (DESIGN.md §12.1, §15 Phase 7).
 *
 * The overlay itself needs a compositor and is not tested. The arithmetic is,
 * because the arithmetic is where region selection goes wrong **silently**:
 * every conversion between the three coordinate spaces has a plausible-looking
 * wrong answer that still produces a picture.
 *
 * The one that would have shipped is `scaleFactor`. Forget it on a retina
 * display and the capture is the **top-left quarter** of what the user drew —
 * a real region, in the right place, containing the wrong thing.
 */

import { describe, expect, it } from 'vitest';
import {
  firstAnswer,
  MIN_SELECTION_PX,
  resolveSelection,
  SelectionTooSmall,
  UnknownDisplay,
  type DisplayInfo,
  type Selection,
} from '@main/capture/region.js';
import { screenForDisplay, type ScreenSource } from '@main/capture/client.js';

const PRIMARY: DisplayInfo = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  scaleFactor: 1,
};

/** Retina, and to the *left* of the primary — so its origin is negative. */
const RETINA_LEFT: DisplayInfo = {
  id: 2,
  bounds: { x: -1440, y: 0, width: 1440, height: 900 },
  scaleFactor: 2,
};

const DISPLAYS = [PRIMARY, RETINA_LEFT];

describe('a drag becomes a region in capture pixels', () => {
  it('passes through unchanged at scale 1', async () => {
    const { displayId, region } = resolveSelection(DISPLAYS, {
      displayId: 1,
      x: 100,
      y: 200,
      w: 300,
      h: 150,
    });

    expect(displayId).toBe('1');
    expect(region).toEqual({ x: 100, y: 200, w: 300, h: 150 });
  });

  it('scales to device pixels, which is the mistake that still produces a picture', async () => {
    /**
     * Without this the capture is the top-left quarter of the selection: a real
     * region, in the right place, containing the wrong thing. It looks enough
     * like a working feature to ship, which is why it gets its own test rather
     * than being covered incidentally.
     */
    const { region } = resolveSelection(DISPLAYS, { displayId: 2, x: 100, y: 50, w: 200, h: 100 });

    expect(region).toEqual({ x: 200, y: 100, w: 400, h: 200 });
  });

  it('does not add the display origin, because the drag is already window-local', async () => {
    // The other direction of the same mistake. The overlay covers exactly one
    // display, so a drag inside it is in that display's space already — adding
    // `bounds.x` would push a selection on the left-hand monitor 1440 pixels
    // off the edge of its own capture.
    const { region } = resolveSelection(DISPLAYS, { displayId: 2, x: 0, y: 0, w: 100, h: 100 });

    expect(region.x).toBe(0);
    expect(region.y).toBe(0);
  });

  it('normalizes a drag made up and to the left', async () => {
    // The same gesture as down-and-right, and taken literally it is a negative
    // width — which every downstream clamp quietly turns into an empty crop.
    const { region } = resolveSelection(DISPLAYS, {
      displayId: 1,
      x: 400,
      y: 350,
      w: -300,
      h: -150,
    });

    expect(region).toEqual({ x: 100, y: 200, w: 300, h: 150 });
  });

  it('clamps a drag that ran off the edge of its monitor', async () => {
    // Ordinary, and `desktopCapturer` has one source per screen — so the part on
    // this display is the part that can be captured. Refusing would throw away a
    // gesture that was ninety percent right.
    const { region } = resolveSelection(DISPLAYS, {
      displayId: 1,
      x: 1800,
      y: 1000,
      w: 400,
      h: 400,
    });

    expect(region).toEqual({ x: 1800, y: 1000, w: 120, h: 80 });
  });

  it('rounds outward, keeping the pixel the user could see', async () => {
    // A row shaved off a selection drawn around a line of text is exactly the
    // row that mattered.
    const { region } = resolveSelection([{ ...PRIMARY, scaleFactor: 1.5 }], {
      displayId: 1,
      x: 10.4,
      y: 10.4,
      w: 101,
      h: 101,
    });

    expect(region.x).toBe(Math.floor(10.4 * 1.5));
    expect(region.w).toBeGreaterThanOrEqual(Math.round(101 * 1.5));
  });
});

describe('gestures that were not selections', () => {
  it('refuses a click', async () => {
    // A click that produced a 3×2-pixel screenshot would read as the overlay
    // being broken. This is also the safety net for the mouse-up that opened the
    // picker landing on a freshly-armed overlay.
    expect(() => resolveSelection(DISPLAYS, { displayId: 1, x: 500, y: 500, w: 0, h: 0 })).toThrow(
      SelectionTooSmall,
    );
  });

  it('refuses a drag that is long but one pixel tall', async () => {
    // Both edges have to clear the floor. A 900×1 selection is a slip of the
    // hand, not a request for a 900×1 image.
    expect(() =>
      resolveSelection(DISPLAYS, { displayId: 1, x: 0, y: 0, w: 900, h: 1 }),
    ).toThrow(SelectionTooSmall);
  });

  it('accepts a deliberate small drag', async () => {
    expect(() =>
      resolveSelection(DISPLAYS, {
        displayId: 1,
        x: 0,
        y: 0,
        w: MIN_SELECTION_PX,
        h: MIN_SELECTION_PX,
      }),
    ).not.toThrow();
  });

  it('says which display went away rather than failing on a coordinate', async () => {
    // A monitor can be unplugged between opening the overlay and letting go.
    expect(() => resolveSelection(DISPLAYS, { displayId: 99, x: 0, y: 0, w: 50, h: 50 })).toThrow(
      UnknownDisplay,
    );
  });
});

describe('finding the capture source for a display', () => {
  const screens = (ids: Array<string | undefined>): ScreenSource[] =>
    ids.map((displayId, i) => ({
      id: `screen:${i}`,
      name: `Display ${i}`,
      kind: 'screen' as const,
      ...(displayId !== undefined ? { displayId } : {}),
    }));

  it('matches on the display id when there is one', () => {
    expect(screenForDisplay(screens(['1', '2']), '2')?.id).toBe('screen:1');
  });

  it('falls back to the only screen, because one monitor has no ambiguity', () => {
    // `display_id` is empty on some platforms, and refusing there would make
    // region selection fail on machines where it is least likely to be wrong.
    expect(screenForDisplay(screens([undefined]), '7')?.id).toBe('screen:0');
  });

  it('refuses to guess between several unlabelled screens', () => {
    // Nothing honest to pick. Capturing the wrong monitor and calling it the
    // selected region is worse than an error naming the display.
    expect(screenForDisplay(screens([undefined, undefined]), '7')).toBeNull();
  });

  it('ignores windows, which are not displays', () => {
    const mixed: ScreenSource[] = [
      { id: 'window:3', name: 'Terminal', kind: 'window' },
      ...screens(['1']),
    ];
    expect(screenForDisplay(mixed, '1')?.id).toBe('screen:0');
  });
});

describe('several monitors, several overlays, one answer', () => {
  /**
   * `Promise.race` was the obvious thing to write and is wrong twice, in ways
   * that only show up on a machine with two monitors — which is exactly the
   * machine region selection exists for.
   */
  const later = <T,>(value: T, ms: number): Promise<T> =>
    new Promise((res) => setTimeout(() => res(value), ms));
  const failsIn = (ms: number): Promise<never> =>
    new Promise((_, rej) => setTimeout(() => rej(new Error('overlay died')), ms));

  const drag: Selection = { displayId: 1, x: 0, y: 0, w: 100, h: 100 };

  it('takes the first drag, whichever screen it happened on', async () => {
    await expect(firstAnswer([later(null as Selection | null, 50), later(drag, 5)])).resolves.toEqual(
      drag,
    );
  });

  it('does not let a failed overlay cancel a selection still being drawn', async () => {
    /**
     * The first bug. `race` settles on whichever promise finishes first
     * *including a rejected one*, so an overlay that failed to load on a
     * secondary monitor would end the whole selection — as `null` if caught,
     * which is Escape. The user is mid-drag on their main screen and the
     * capture silently cancels.
     */
    await expect(firstAnswer([failsIn(1), later(drag, 20)])).resolves.toEqual(drag);
  });

  it('leaves no unhandled rejection when the losers are torn down', async () => {
    /**
     * The second bug, and the one that would have taken the app down. After an
     * answer, the other overlays are still awaiting `executeJavaScript` in
     * windows the caller destroys — which rejects them, with nothing watching.
     *
     * Checked by watching for the process-level event rather than by reading
     * the implementation, because the implementation is exactly what is in
     * question.
     */
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const loser = failsIn(30);
      await expect(firstAnswer([later(drag, 1), loser])).resolves.toEqual(drag);
      // Past the point where the loser rejects, plus a turn for the handler.
      await new Promise((res) => setTimeout(res, 80));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports the failure when every overlay failed', async () => {
    // Only then. "The overlay did not open" is worth reading; hanging forever
    // because nothing could answer is not.
    await expect(firstAnswer([failsIn(1), failsIn(5)])).rejects.toThrow('overlay died');
  });

  it('passes a cancel through, because Escape is an answer', async () => {
    await expect(firstAnswer([later(null as Selection | null, 1)])).resolves.toBeNull();
  });
});
