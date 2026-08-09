/**
 * Redaction, applied before anything reaches disk (DESIGN.md §12.1).
 *
 * > Screenshots leak tokens, customer data, and credentials — and with remote
 * > sessions and third-party providers that leak crosses a network onto someone
 * > else's disk. … **Redaction is applied to the stored blob, not just the
 * > view** — the unredacted frame is never written to disk and therefore can
 * > never be uploaded.
 *
 * That last clause is the whole design, and it is a claim about *ordering*
 * rather than about diligence. A pipeline that writes the frame and then paints
 * over it has already lost: the original is on disk, it is in the blob store's
 * content-addressed index, and §6.7 will happily push it to a remote host. No
 * amount of care afterwards makes that untrue.
 *
 * So this module never receives the store and the raw frame in a shape that
 * would let the raw frame be written. `redactAndStore` takes the buffer, paints,
 * and hands only the result on — the unredacted bytes exist as a local variable
 * and nothing else.
 *
 * ## It fails closed
 *
 * Painting rectangles onto pixels needs a decoder, and there is not always one
 * (§12.2 hit the same wall for resizing). The two cases resolve *oppositely* and
 * that difference is the point. An image that cannot be resized degrades to a
 * text note, because the cost of not sending it is a worse answer. An image that
 * cannot be redacted is **refused**, because the cost of storing it is a
 * credential on someone else's disk — and a fallback that quietly stored the
 * original would be worse than having no redaction feature at all.
 *
 * ## The scan is a pre-pass, not a guarantee
 *
 * The OCR sweep catches the obvious shapes — `sk-`, `Bearer `, `AKIA`,
 * `-----BEGIN`. It is a helper for the human doing the redacting, and it is
 * reported as such: `scanned: false` when no OCR was available, so nobody reads
 * an empty match list as "nothing sensitive here".
 */

import type { Sha256 } from '@shared/types/index.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A word or line OCR found, and where it sits. */
export interface OcrBox extends Rect {
  text: string;
}

/** Local OCR over a frame. Injected: it is a native dependency and optional. */
export type Ocr = (frame: Buffer) => Promise<OcrBox[]>;

/** Paint opaque rectangles onto an encoded image. Injected: needs a decoder. */
export type Painter = (frame: Buffer, rects: readonly Rect[]) => Promise<Buffer>;

/**
 * What §12.1 names, and nothing more.
 *
 * Deliberately a short list of *prefixes* rather than an attempt at general
 * secret detection. A scanner that tries to be clever produces false positives,
 * a user who learns to ignore them, and a false sense that the sweep is a
 * guarantee. These four are unambiguous enough that a match is almost always
 * real, which is what makes the highlight worth looking at.
 */
export const SECRET_MARKERS = ['sk-', 'Bearer ', 'AKIA', '-----BEGIN'] as const;

export class RedactionRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RedactionRefused';
  }
}

export interface ScanResult {
  /**
   * Whether OCR actually ran.
   *
   * Separate from an empty `matches`, and that distinction is load-bearing: "we
   * looked and found nothing" and "we could not look" are different facts, and
   * collapsing them lets an unscanned frame read as a clean one.
   */
  scanned: boolean;
  matches: Array<{ rect: Rect; marker: string }>;
}

/** Find the obvious secret shapes in a frame, where OCR is available. */
export async function scanForSecrets(frame: Buffer, ocr?: Ocr): Promise<ScanResult> {
  if (ocr === undefined) return { scanned: false, matches: [] };

  let boxes: OcrBox[];
  try {
    boxes = await ocr(frame);
  } catch {
    // A failed sweep is an unscanned frame, not a clean one.
    return { scanned: false, matches: [] };
  }

  const matches: ScanResult['matches'] = [];
  for (const box of boxes) {
    const marker = SECRET_MARKERS.find((m) => box.text.includes(m));
    if (marker !== undefined) matches.push({ rect: { x: box.x, y: box.y, w: box.w, h: box.h }, marker });
  }
  return { scanned: true, matches };
}

export interface RedactedImage {
  sha256: Sha256;
  /** Every rectangle painted, recorded for audit (§12.1). */
  redactions: Rect[];
  /** Whether the OCR pre-pass ran, so an unscanned frame is not read as clean. */
  scanned: boolean;
}

/**
 * Paint the rectangles, then store — and only ever in that order.
 *
 * The signature is the safety property. `store` receives one buffer and it is
 * the redacted one; the original is a parameter and a local, and there is no
 * path from here that writes it. Anyone tempted to add a "keep the original for
 * undo" option should note that §12.1 rules it out by name: the unredacted frame
 * is never written to disk *so that* it can never be uploaded, and an undo
 * buffer on disk is exactly the thing being ruled out.
 */
export async function redactAndStore(
  frame: Buffer,
  rects: readonly Rect[],
  store: (redacted: Buffer) => Promise<Sha256>,
  opts: { paint?: Painter; ocr?: Ocr } = {},
): Promise<RedactedImage> {
  const scan = await scanForSecrets(frame, opts.ocr);
  const all = [...rects, ...scan.matches.map((m) => m.rect)];

  if (all.length === 0) {
    // Nothing to paint. Storing the frame unchanged is correct here and is not
    // the failure above: no redaction was asked for and none was skipped.
    return { sha256: await store(frame), redactions: [], scanned: scan.scanned };
  }

  if (opts.paint === undefined) {
    // Fails closed. The alternative — store it unpainted and report the
    // rectangles anyway — would write a credential to disk and label it
    // redacted, which is worse than refusing and worse than never offering it.
    throw new RedactionRefused(
      `${all.length} region(s) need redacting and no painter is available here; ` +
        'refusing rather than storing the unredacted frame',
    );
  }

  const painted = await opts.paint(frame, all);
  return { sha256: await store(painted), redactions: all, scanned: scan.scanned };
}
