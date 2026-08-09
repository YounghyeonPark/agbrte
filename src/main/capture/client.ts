/**
 * Capturing the screen in front of you (DESIGN.md §12.1).
 *
 * > **Client capture (your screen)** — available for every target, including
 * > hosted. … `CaptureService` enumerates sources in main via
 * > `desktopCapturer.getSources({ types: ['screen','window'], thumbnailSize })`.
 * > … Frame hashed, written to the local blob store, previewed. … Optional
 * > annotation (§12.3), then attached — pushed via `putBlob` (§6.7) for remote
 * > sessions, `provenance.origin: 'client'`.
 *
 * The counterpart to `headless.ts`. That one lets an agent see its own output
 * with nobody in the loop; this one is the loop — a person pointing at what they
 * are looking at, which is still the fastest way to say "this, here, is wrong".
 *
 * ## No `electron` import, on purpose
 *
 * `desktopCapturer` and `systemPreferences` live behind a `ScreenBackend` that
 * arrives as a parameter. Not for testability first — for loadability. An ESM
 * `import … from 'electron'` is evaluated when the module *loads*, not when it
 * is used, so a single import here would make this file unloadable under plain
 * Node, and `ipc/api.ts` exists as a separate file because that exact mistake
 * crashed the headless web server before a line of it ran.
 *
 * The Electron-shaped half is `capture/electron.ts`, which is the only thing
 * that knows what a `NativeImage` is.
 *
 * ## Every step happens before the bytes are stored
 *
 * Crop, then scan, then paint, then store, and the order is the guarantee rather
 * than the sequence anyone happened to write:
 *
 *  - **Cropping is a redaction nobody calls one.** What lies outside the
 *    rectangle is what the user chose not to send, and on a desk covered in
 *    windows that is most of the sensitive content on the screen. Cutting it in
 *    the renderer's viewport would store the whole screen and *show* a slice.
 *  - **Painting happens here, on this machine.** §12.1 writes its rule as "never
 *    written to disk", which stopped being the whole of it once §6.7 let a
 *    capture cross a network: bytes that reach a remote host have left the
 *    machine they were taken on whether or not anybody stored them.
 *  - **Storing is the last thing**, and it takes the redacted buffer. The raw
 *    frame is a parameter and a local, and there is no path from here that
 *    writes or sends it.
 *
 * ## macOS asks first, and a black frame is not an answer
 *
 * §12.1: "macOS needs Screen Recording permission — check
 * `systemPreferences.getMediaAccessStatus('screen')` before the first capture
 * and route the user to System Settings rather than producing a black frame."
 * A denied grab does not fail on macOS. It succeeds and returns an empty
 * desktop, which is indistinguishable from a screenshot of a clean desk — so
 * the check is not a nicety, it is the difference between an error and a
 * mystery.
 */

import { cropFrame, fillRects, scaleToFit, sizeOf } from '../content/pixels.js';
import { redactAndStore, type Ocr, type Rect } from '../content/redact.js';
import type { ImageBlock, Sha256 } from '@shared/types/index.js';

/**
 * Whether this machine will let us look at the screen.
 *
 * `unknown` is its own value rather than an optimistic `granted`: a platform
 * whose status cannot be read is not a platform that said yes, and collapsing
 * the two would put the black-frame case back.
 */
export type ScreenAccess = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface ScreenSource {
  /** Opaque to everything above the backend. */
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** Set for screens, and recorded in provenance so a multi-monitor grab is attributable. */
  displayId?: string;
  /** A small PNG for the picker. Absent when the backend was asked not to render one. */
  thumbnailPng?: Buffer;
}

/**
 * What Electron supplies and plain Node does not.
 *
 * Three methods, because these are the three things that genuinely need the
 * platform. Everything else §12.1 asks for — cropping, scanning, painting,
 * hashing, storing — is pixels and files, and doing it on this side is what
 * keeps the capture pipeline the same on every target.
 */
export interface ScreenBackend {
  access(): Promise<ScreenAccess>;
  sources(opts: { thumbnailSize?: { width: number; height: number } }): Promise<ScreenSource[]>;
  /** A full-resolution PNG of one source. */
  grab(sourceId: string): Promise<Buffer>;
}

/** No backend at all — a browser client, or a headless host. */
export class CaptureUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CaptureUnavailable';
  }
}

/** The platform said no, and §12.1 asks that we say so rather than show a black frame. */
export class ScreenAccessDenied extends Error {
  constructor(readonly status: ScreenAccess) {
    super(
      status === 'denied' || status === 'restricted'
        ? 'screen recording is not permitted for this app — grant it in System Settings ' +
            '› Privacy & Security › Screen Recording, then try again'
        : `screen recording permission is ${status}; a capture now would be a black frame`,
    );
    this.name = 'ScreenAccessDenied';
  }
}

/**
 * The largest edge a stored capture keeps.
 *
 * A 5K display is ~15 megapixels and every provider will scale it down anyway —
 * §12.2 does it at send time regardless. Doing it once here means the blob that
 * is transferred (§6.7) and kept forever is the useful size rather than the
 * captured one. Generous enough that text stays legible, which is usually the
 * entire reason a screenshot was taken.
 */
export const MAX_STORED_EDGE = 2560;

export interface CaptureRequest {
  sourceId: string;
  /**
   * Region in the source's own pixels (§12.1's overlay produces it).
   *
   * Applied here rather than at display time — see the header. Absent means the
   * whole source.
   */
  region?: Rect;
  /** Blackouts the user drew, painted before anything is stored. */
  redactions?: readonly Rect[];
  /** Recorded in provenance so a window grab says which window. */
  windowTitle?: string;
  displayId?: string;
}

export interface CaptureResult {
  block: ImageBlock;
  /**
   * Whether the OCR pre-pass ran.
   *
   * Surfaced to the caller rather than only recorded, because §12.1 wants the UI
   * to be able to say "not scanned" — an unscanned frame read as a clean one is
   * the whole reason `scanned` exists.
   */
  scanned: boolean;
}

/**
 * Take a capture and store it against a session.
 *
 * `store` is the session's blob sink, handed in rather than reached for: for a
 * local host it writes next door and for a remote one it is §6.7's chunked
 * transfer, and this function should no more know which than `send` does.
 */
/**
 * Grab the pixels and get them ready, **without storing anything**.
 *
 * Split from storing because §12.1's guarantee decides the order. That section
 * says the unredacted frame is never written to disk, and §12.3 wants the user
 * to draw before it is sent — which only both hold if the drawing happens
 * *between* these two calls. A single `grab-and-store` forces the opposite: the
 * frame lands on disk, the user blacks something out afterwards, and the
 * original is already in a content-addressed index that §6.7 will push on
 * request. §12.3 says so itself — "the annotator must therefore offer redaction
 * at capture; anything later is a second-best".
 *
 * So the frame lives in memory until somebody decides what may be seen.
 */
export async function takeFrame(
  backend: ScreenBackend | null,
  request: Omit<CaptureRequest, 'redactions'>,
  opts: { maxEdge?: number } = {},
): Promise<Buffer> {
  if (backend === null) {
    // The `pickFolder` precedent: an API that exists and fails opaquely is worse
    // than one that explains why it cannot. A browser client has no screen to
    // enumerate, and the honest answer names the reason and the remedy.
    throw new CaptureUnavailable(
      'this client cannot capture a screen — use the desktop app, or the ' +
        'screenshot tool for a page the agent is serving',
    );
  }

  const status = await backend.access();
  // Checked before the grab, not after: on macOS a denied grab succeeds and
  // returns an empty desktop, which looks exactly like a screenshot of a tidy
  // one. Only `granted` and `unknown` proceed — `unknown` because a platform
  // that has no such concept (Windows) reports nothing and needs nothing.
  if (status !== 'granted' && status !== 'unknown') throw new ScreenAccessDenied(status);

  const raw = await backend.grab(request.sourceId);

  // Crop first. Everything after this operates on what the user chose to send,
  // which means a scan cannot spend its time on a region that is being thrown
  // away and a blackout is drawn in the coordinates the user was looking at.
  const cropped = request.region !== undefined ? await cropFrame(raw, request.region) : raw;
  return scaleToFit(cropped, opts.maxEdge ?? MAX_STORED_EDGE);
}

/**
 * Paint what the user blacked out, store the result, and describe it.
 *
 * The frame arrives as bytes nobody has written anywhere. `redactAndStore` is
 * what makes that final: it takes the buffer, paints, and hands only the result
 * on, so the unredacted pixels exist as a parameter and a local and there is no
 * path from here that writes them.
 */
export async function storeFrame(
  frame: Buffer,
  request: Pick<CaptureRequest, 'redactions' | 'windowTitle' | 'displayId'>,
  store: (redacted: Buffer, mime: string) => Promise<Sha256>,
  opts: { ocr?: Ocr; now?: () => Date } = {},
): Promise<CaptureResult> {
  const { sha256, redactions, scanned } = await redactAndStore(
    frame,
    request.redactions ?? [],
    (redacted) => store(redacted, 'image/png'),
    {
      // A painter is always available here — `pixels.ts` runs on plain Node — so
      // §12.1's fail-closed path is unreachable from this call. That is the
      // point of it being unreachable: redaction refusing to store the frame was
      // the guarantee holding by not working.
      paint: fillRects,
      ...(opts.ocr !== undefined ? { ocr: opts.ocr } : {}),
    },
  );

  const { width, height } = sizeOf(frame);
  const now = opts.now ?? ((): Date => new Date());

  return {
    scanned,
    block: {
      type: 'image',
      sha256,
      mime: 'image/png',
      width,
      height,
      provenance: {
        kind: 'screen_capture',
        // §12.1: these pixels came from the person's own machine, not from the
        // one running the work. The distinction survives into the transcript
        // because for a remote session it is the only thing that says so.
        origin: 'client',
        capturedAt: now().toISOString(),
        ...(request.displayId !== undefined ? { displayId: request.displayId } : {}),
        ...(request.windowTitle !== undefined ? { windowTitle: request.windowTitle } : {}),
        ...(redactions.length > 0 ? { redactions } : {}),
      },
    },
  };
}

/**
 * Take and store in one step, for a capture nobody is going to annotate.
 *
 * Kept because it is the honest shape of "screenshot this and send it", and
 * because the two-step path above is only worth its extra round trip when a
 * person is actually going to draw.
 */
export async function captureScreen(
  backend: ScreenBackend | null,
  request: CaptureRequest,
  store: (redacted: Buffer, mime: string) => Promise<Sha256>,
  opts: { ocr?: Ocr; now?: () => Date; maxEdge?: number } = {},
): Promise<CaptureResult> {
  const frame = await takeFrame(backend, request, opts);
  return storeFrame(frame, request, store, opts);
}

/**
 * What the user can point at.
 *
 * Thumbnails are requested small. §12.1 notes that asking at native resolution
 * yields a full-quality frame, which is how `grab` works — but a picker showing
 * nine displays at native resolution would move a hundred megabytes to draw a
 * grid of postage stamps.
 */
export async function listSources(
  backend: ScreenBackend | null,
  /**
   * `null` asks without previews.
   *
   * Used when the caller only needs ids — resolving which screen source backs a
   * display, say. Rendering nine full desktops to answer that would be the
   * expensive way to look up a number.
   */
  thumbnailSize: { width: number; height: number } | null = { width: 320, height: 200 },
): Promise<ScreenSource[]> {
  if (backend === null) return [];
  const status = await backend.access();
  if (status !== 'granted' && status !== 'unknown') throw new ScreenAccessDenied(status);
  return backend.sources(thumbnailSize === null ? {} : { thumbnailSize });
}

/**
 * The screen source backing a display.
 *
 * Falls back to the only screen when there is exactly one, because
 * `display_id` is empty on some platforms and a machine with one monitor has no
 * ambiguity to resolve. With several attached and no ids to match on there is
 * nothing honest to guess, so it says so.
 */
export function screenForDisplay(
  sources: readonly ScreenSource[],
  displayId: string,
): ScreenSource | null {
  const screens = sources.filter((s) => s.kind === 'screen');
  return screens.find((s) => s.displayId === displayId) ?? (screens.length === 1 ? screens[0]! : null);
}
