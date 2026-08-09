/**
 * The Electron half of client capture (DESIGN.md §12.1).
 *
 * Everything this file does is the three things plain Node cannot: ask the OS
 * whether we may look at the screen, list what there is to look at, and get the
 * pixels. Cropping, scanning, painting, hashing and storing are all in
 * `client.ts` and run everywhere.
 *
 * It is a separate file for the reason `ipc/register.ts` is: an ESM
 * `import … from 'electron'` is evaluated when the module **loads**, not when it
 * is used, so importing it anywhere reachable from the headless web server
 * crashes that server before a line of it runs. This module is only ever loaded
 * from the Electron entry point.
 *
 * ## A thumbnail at native resolution is the capture
 *
 * §12.1: "A thumbnail requested at native display resolution yields a
 * full-quality `NativeImage` — simpler and lower-latency than a media stream for
 * a still." So `grab` is `getSources` again with the size turned up, rather than
 * a second API. The picker's small thumbnails and the real capture are the same
 * call with a different number, which is worth knowing when reading it.
 */

import { desktopCapturer, screen, systemPreferences } from 'electron';
import type { ScreenAccess, ScreenBackend, ScreenSource } from './client.js';

/**
 * A ceiling for a window grab.
 *
 * A window has no display to read a size from, and Electron caps rather than
 * upscales — so asking for more than any window could be yields that window at
 * its own resolution. 8K covers a maximised window on the largest display
 * anybody is likely to have, and costs nothing on smaller ones.
 */
const WINDOW_CAP = { width: 7680, height: 4320 };

/**
 * Ask the platform, and treat silence as silence.
 *
 * Only macOS gates screen recording, and `getMediaAccessStatus('screen')` is the
 * documented way to read it. Windows needs no permission and Linux has no such
 * API, and both report `unknown` — which `client.ts` proceeds on, because a
 * platform with nothing to say must not be read as a platform that said no.
 *
 * Wrapped in a try because this is a platform API keyed by a string, and a
 * throw from it should mean "cannot tell" rather than "cannot capture".
 */
async function access(): Promise<ScreenAccess> {
  if (process.platform !== 'darwin') return 'unknown';
  try {
    const status = systemPreferences.getMediaAccessStatus('screen');
    // The union is Electron's own; anything outside it is a version we do not
    // recognise, and guessing which way it means is worse than saying unknown.
    return status === 'granted' ||
      status === 'denied' ||
      status === 'restricted' ||
      status === 'not-determined'
      ? status
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function toSource(
  s: Electron.DesktopCapturerSource,
  withThumbnail: boolean,
): ScreenSource {
  return {
    id: s.id,
    name: s.name,
    // Electron's ids are `screen:…` and `window:…`, which is the only thing
    // that distinguishes them — `display_id` is empty for some window sources
    // and non-empty for others depending on platform.
    kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    ...(s.display_id ? { displayId: s.display_id } : {}),
    ...(withThumbnail && !s.thumbnail.isEmpty() ? { thumbnailPng: s.thumbnail.toPNG() } : {}),
  };
}

/** Native pixel size of the display backing a source, or the window ceiling. */
function nativeSize(source: ScreenSource): { width: number; height: number } {
  if (source.kind !== 'screen') return WINDOW_CAP;

  const display =
    screen.getAllDisplays().find((d) => String(d.id) === source.displayId) ??
    screen.getPrimaryDisplay();
  // `size` is in DIPs; `scaleFactor` is what turns it into the pixels actually
  // on the glass. Asking in DIPs on a retina display captures a quarter of the
  // detail and produces a screenshot whose text is exactly too blurry to read.
  return {
    width: Math.round(display.size.width * display.scaleFactor),
    height: Math.round(display.size.height * display.scaleFactor),
  };
}

/**
 * The backend `client.ts` takes as a parameter.
 *
 * A function rather than a class so nothing here is constructed at import time —
 * `screen` is unusable before the app is ready, and a module-level `getAllDisplays`
 * would move that failure from a capture to a launch.
 */
export function electronScreenBackend(): ScreenBackend {
  return {
    access,

    sources: async ({ thumbnailSize }) => {
      const found = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: thumbnailSize ?? { width: 320, height: 200 },
        // The window title is what a person recognises in a picker, and it is
        // also what §12.1 records in provenance.
        fetchWindowIcons: false,
      });
      return found.map((s) => toSource(s, thumbnailSize !== undefined));
    },

    grab: async (sourceId) => {
      // Two passes: the first is cheap and only exists to learn which display
      // this source is on, because the size to ask for depends on the answer.
      const cheap = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 1, height: 1 },
      });
      const meta = cheap.find((s) => s.id === sourceId);
      if (meta === undefined) {
        // Sources are enumerated fresh each time and a window can close between
        // the picker and the click. Saying which is more useful than a generic
        // failure, because "that window is gone" is a thing the user can act on.
        throw new Error(`capture source ${sourceId} is no longer available`);
      }

      const full = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: nativeSize(toSource(meta, false)),
      });
      const hit = full.find((s) => s.id === sourceId);
      if (hit === undefined || hit.thumbnail.isEmpty()) {
        throw new Error(`capture source ${sourceId} produced no image`);
      }
      return hit.thumbnail.toPNG();
    },
  };
}
