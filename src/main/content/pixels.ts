/**
 * The pixel operations §12 needed and did not have (DESIGN.md §12.1, §12.2).
 *
 * Redaction, resizing and flattening were all injected, and nothing injected
 * them — so every one of them was, in practice, absent. For resizing that meant
 * a text downgrade instead of a picture. For **redaction it meant refusing to
 * store the screenshot at all**, since §12.1 fails closed: the guarantee held by
 * not working.
 *
 * These run on plain Node over `content/png.ts`, which is the point. An
 * Electron-only implementation would have left redaction unavailable in the
 * agent host and on every remote machine — exactly where a screenshot of
 * somebody's production console is most likely to be taken.
 *
 * ## PNG only, and it says so
 *
 * A JPEG is refused rather than passed through. Passing it through would mean
 * `redactAndStore` receiving bytes it believes are painted and storing a
 * screenshot with the secret still in it — the one outcome §12.1 exists to
 * prevent, arriving through a format check nobody wrote.
 */

import type { Rect } from './redact.js';
import { decodePng, encodePng, isPng, UnsupportedPng, type RawImage } from './png.js';

/**
 * Fill rectangles with opaque black.
 *
 * Opaque, not blurred. §12.1 offers blur as an OCR pre-pass affordance, but what
 * is *stored* has to be unrecoverable: a blur is a reversible-looking operation
 * and people have recovered text from them. A black box cannot be un-blacked.
 */
export async function fillRects(frame: Buffer, rects: readonly Rect[]): Promise<Buffer> {
  const image = decode(frame);

  for (const rect of rects) {
    // Clamped rather than trusted. A rectangle dragged past the edge of the
    // window is ordinary, and an out-of-bounds write here would either throw or
    // corrupt a different row — which on this path means a secret left visible.
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));

    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const at = (y * image.width + x) * 4;
        image.rgba[at] = 0;
        image.rgba[at + 1] = 0;
        image.rgba[at + 2] = 0;
        image.rgba[at + 3] = 0xff;
      }
    }
  }

  return encodePng(image);
}

/**
 * Scale an image down so its long edge fits, keeping the aspect ratio.
 *
 * Box-averaged rather than nearest-neighbour. Nearest is a few lines shorter and
 * turns text into noise at the ratios this is used at — and text is usually the
 * entire reason a screenshot was attached.
 *
 * Only ever downscales. An image already inside the limit is returned untouched
 * rather than resampled, because resampling it would lose detail to no purpose.
 */
export async function scaleToFit(frame: Buffer, maxLongEdge: number): Promise<Buffer> {
  const image = decode(frame);
  const longEdge = Math.max(image.width, image.height);
  if (longEdge <= maxLongEdge) return frame;

  const factor = maxLongEdge / longEdge;
  const width = Math.max(1, Math.round(image.width * factor));
  const height = Math.max(1, Math.round(image.height * factor));
  const out: RawImage = { width, height, rgba: Buffer.alloc(width * height * 4) };

  const xRatio = image.width / width;
  const yRatio = image.height / height;

  for (let y = 0; y < height; y += 1) {
    const sy0 = Math.floor(y * yRatio);
    const sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * yRatio));
    for (let x = 0; x < width; x += 1) {
      const sx0 = Math.floor(x * xRatio);
      const sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * xRatio));

      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < Math.min(sy1, image.height); sy += 1) {
        for (let sx = sx0; sx < Math.min(sx1, image.width); sx += 1) {
          const at = (sy * image.width + sx) * 4;
          r += image.rgba[at] as number;
          g += image.rgba[at + 1] as number;
          b += image.rgba[at + 2] as number;
          a += image.rgba[at + 3] as number;
          n += 1;
        }
      }

      const to = (y * width + x) * 4;
      out.rgba[to] = Math.round(r / n);
      out.rgba[to + 1] = Math.round(g / n);
      out.rgba[to + 2] = Math.round(b / n);
      out.rgba[to + 3] = Math.round(a / n);
    }
  }

  return encodePng(out);
}

/** Dimensions without decoding the whole thing, for sizing decisions. */
export function sizeOf(frame: Buffer): { width: number; height: number } {
  const image = decode(frame);
  return { width: image.width, height: image.height };
}

function decode(frame: Buffer): RawImage {
  if (!isPng(frame)) {
    // Named, not silently passed along. Returning the frame unchanged would
    // hand `redactAndStore` bytes it believes are painted (§12.1).
    throw new UnsupportedPng('only PNG frames can be edited here');
  }
  return decodePng(frame);
}
