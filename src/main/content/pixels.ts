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
import type { Annotation, AnnotationColour, Point } from './annotate.js';
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

// --------------------------------------------------------------- flattening

/** The palette, as RGB. Kept beside the drawing rather than in the UI layer. */
const RGB: Readonly<Record<AnnotationColour, [number, number, number]>> = {
  red: [255, 59, 48],
  yellow: [255, 214, 10],
  green: [52, 199, 89],
  blue: [10, 132, 255],
  white: [255, 255, 255],
  black: [0, 0, 0],
};

/** Thick enough to survive §12.2's downscaling, which is the point of drawing it. */
const STROKE = 3;

/**
 * Burn annotations into an image (§12.3).
 *
 * > Annotations are stored as **vector operations** alongside the original hash
 * > and flattened to PNG at send time … so they stay editable and the original
 * > is never destroyed.
 *
 * Which is why this takes the original every time and returns a new buffer: it
 * is called at send, not at draw, and the vectors remain the truth.
 *
 * ## Order matters twice
 *
 * **Blackouts are not flattened here.** They went through `redactAndStore`
 * before the frame was ever written (§12.1); repainting them would be harmless
 * and misleading, since it would suggest this function is where redaction
 * happens. It is not, and nothing about a frame that reached this point should
 * depend on it.
 *
 * **Crop is applied last.** Annotation coordinates are in the original image's
 * space, so cropping first would move every mark out from under them.
 *
 * ## Text labels are marked, not lettered
 *
 * A text annotation draws a small filled square at its anchor and nothing else.
 * Rendering glyphs means shipping a bitmap font — ninety-odd hand-entered
 * characters — for words the generated description already carries verbatim, and
 * §12.3 notes the description is often the only part a weaker vision model reads
 * anyway. What the image has to convey is *where*; what it said is in the text
 * block travelling beside it.
 */
export async function flattenAnnotations(
  frame: Buffer,
  annotations: readonly Annotation[],
): Promise<Buffer> {
  const image = decode(frame);
  let crop: Rect | null = null;

  for (const a of annotations) {
    switch (a.kind) {
      case 'rectangle':
        strokeRect(image, a.rect, RGB[a.colour]);
        break;
      case 'arrow':
        drawArrow(image, a.from, a.to, RGB[a.colour]);
        break;
      case 'freehand':
        for (let i = 1; i < a.points.length; i += 1) {
          drawLine(image, a.points[i - 1] as Point, a.points[i] as Point, RGB[a.colour]);
        }
        break;
      case 'text':
        // Where, not what. See the note above.
        fillRect(image, { x: a.at.x - 4, y: a.at.y - 4, w: 9, h: 9 }, RGB[a.colour]);
        break;
      case 'blackout':
        break;
      case 'crop':
        // Last one wins: two crops are a user changing their mind, not a
        // request to intersect them.
        crop = a.rect;
        break;
    }
  }

  return encodePng(crop === null ? image : cropTo(image, crop));
}

function cropTo(image: RawImage, rect: Rect): RawImage {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const out: RawImage = { width, height, rgba: Buffer.alloc(width * height * 4) };
  for (let y = 0; y < height; y += 1) {
    const from = ((y0 + y) * image.width + x0) * 4;
    image.rgba.copy(out.rgba, y * width * 4, from, from + width * 4);
  }
  return out;
}

function fillRect(image: RawImage, rect: Rect, rgb: [number, number, number]): void {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) put(image, x, y, rgb);
  }
}

function strokeRect(image: RawImage, rect: Rect, rgb: [number, number, number]): void {
  const { x, y, w, h } = rect;
  drawLine(image, { x, y }, { x: x + w, y }, rgb);
  drawLine(image, { x: x + w, y }, { x: x + w, y: y + h }, rgb);
  drawLine(image, { x: x + w, y: y + h }, { x, y: y + h }, rgb);
  drawLine(image, { x, y: y + h }, { x, y }, rgb);
}

/**
 * A line, with a head at the far end.
 *
 * The head is drawn at `to` because that is what an arrow means — the same
 * reason the description leads with the tip rather than the tail.
 */
function drawArrow(image: RawImage, from: Point, to: Point, rgb: [number, number, number]): void {
  drawLine(image, from, to, rgb);

  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const size = 14;
  const spread = Math.PI / 7;
  for (const side of [angle + Math.PI - spread, angle + Math.PI + spread]) {
    drawLine(
      image,
      to,
      { x: Math.round(to.x + Math.cos(side) * size), y: Math.round(to.y + Math.sin(side) * size) },
      rgb,
    );
  }
}

/** Bresenham, thickened by stamping a square at each step. */
function drawLine(image: RawImage, from: Point, to: Point, rgb: [number, number, number]): void {
  let x = Math.round(from.x);
  let y = Math.round(from.y);
  const x1 = Math.round(to.x);
  const y1 = Math.round(to.y);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let err = dx + dy;

  // Bounded, so a stroke between two absurd coordinates cannot spin. The cap is
  // generous against any real screen and is a backstop, not a limit anyone hits.
  for (let steps = 0; steps < 20_000; steps += 1) {
    stamp(image, x, y, rgb);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

function stamp(image: RawImage, cx: number, cy: number, rgb: [number, number, number]): void {
  const half = Math.floor(STROKE / 2);
  for (let y = cy - half; y <= cy + half; y += 1) {
    for (let x = cx - half; x <= cx + half; x += 1) put(image, x, y, rgb);
  }
}

function put(image: RawImage, x: number, y: number, rgb: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const at = (y * image.width + x) * 4;
  image.rgba[at] = rgb[0];
  image.rgba[at + 1] = rgb[1];
  image.rgba[at + 2] = rgb[2];
  image.rgba[at + 3] = 0xff;
}

function decode(frame: Buffer): RawImage {
  if (!isPng(frame)) {
    // Named, not silently passed along. Returning the frame unchanged would
    // hand `redactAndStore` bytes it believes are painted (§12.1).
    throw new UnsupportedPng('only PNG frames can be edited here');
  }
  return decodePng(frame);
}
