/**
 * Redaction before disk (DESIGN.md §12.1, §15 Phase 7).
 *
 * > **Redaction is applied to the stored blob, not just the view** — the
 * > unredacted frame is never written to disk and therefore can never be
 * > uploaded.
 *
 * That is a claim about *ordering*, not about diligence, so the tests are about
 * ordering. A pipeline that writes the frame and then paints over it has already
 * lost: the original is on disk, in the content-addressed index, and §6.7 will
 * push it to a remote host on request. Nothing done afterwards makes that
 * untrue.
 */

import { describe, expect, it } from 'vitest';
import {
  RedactionRefused,
  redactAndStore,
  scanForSecrets,
  SECRET_MARKERS,
  type Ocr,
  type Painter,
  type Rect,
} from '@main/content/redact.js';
import type { Sha256 } from '@shared/types/index.js';

const FRAME = Buffer.from('the original frame, with a secret in it');
const PAINTED = Buffer.from('painted');

/** A store that records exactly what it was handed. */
function recorder() {
  const written: Buffer[] = [];
  const store = async (buf: Buffer): Promise<Sha256> => {
    written.push(buf);
    return 'a'.repeat(64) as Sha256;
  };
  return { written, store };
}

const paint: Painter = async () => PAINTED;
const BOX: Rect = { x: 10, y: 20, w: 100, h: 30 };

describe('what reaches the store', () => {
  it('is the painted frame, never the original', async () => {
    const r = recorder();
    await redactAndStore(FRAME, [BOX], r.store, { paint });

    expect(r.written).toHaveLength(1);
    // The load-bearing assertion of this whole feature.
    expect(r.written[0]).toEqual(PAINTED);
    expect(r.written[0]?.equals(FRAME)).toBe(false);
  });

  it('is stored exactly once', async () => {
    // A write-then-repaint pipeline would show two, and the first would be the
    // one that matters.
    const r = recorder();
    await redactAndStore(FRAME, [BOX], r.store, { paint });
    expect(r.written).toHaveLength(1);
  });

  it('records every rectangle for audit', async () => {
    const result = await redactAndStore(FRAME, [BOX], recorder().store, { paint });
    expect(result.redactions).toEqual([BOX]);
  });
});

describe('when it cannot paint', () => {
  it('refuses rather than storing the frame unpainted', async () => {
    const r = recorder();

    // The opposite resolution to §12.2's resizer, and deliberately so: an image
    // that cannot be resized degrades to a text note because the cost is a worse
    // answer. An image that cannot be redacted is refused, because the cost is a
    // credential on someone else's disk.
    await expect(redactAndStore(FRAME, [BOX], r.store)).rejects.toThrow(RedactionRefused);
    expect(r.written).toEqual([]);
  });

  it('says how many regions were at stake', async () => {
    await expect(
      redactAndStore(FRAME, [BOX, BOX], recorder().store),
    ).rejects.toThrow(/2 region/);
  });

  it('still stores a frame nobody asked to redact', async () => {
    // Not the same case: no redaction was requested and none was skipped, so
    // refusing here would break every ordinary screenshot.
    const r = recorder();
    const result = await redactAndStore(FRAME, [], r.store);
    expect(r.written[0]).toEqual(FRAME);
    expect(result.redactions).toEqual([]);
  });
});

describe('the OCR pre-pass', () => {
  const ocr: Ocr = async () => [
    { x: 0, y: 0, w: 50, h: 10, text: 'const key = "sk-live-abc123"' },
    { x: 0, y: 20, w: 50, h: 10, text: 'ordinary code' },
    { x: 0, y: 40, w: 50, h: 10, text: 'Authorization: Bearer eyJhbGciOi' },
  ];

  it('finds the shapes §12.1 names, and leaves the rest alone', async () => {
    const scan = await scanForSecrets(FRAME, ocr);
    expect(scan.scanned).toBe(true);
    expect(scan.matches.map((m) => m.marker)).toEqual(['sk-', 'Bearer ']);
  });

  it('paints what it found alongside what was drawn by hand', async () => {
    const result = await redactAndStore(FRAME, [BOX], recorder().store, { paint, ocr });
    expect(result.redactions).toHaveLength(3);
    expect(result.redactions[0]).toEqual(BOX);
  });

  it('refuses when it finds something and cannot paint it', async () => {
    // A frame with a key in it and no way to cover it must not be stored,
    // whether the rectangle came from a person or from the sweep.
    const r = recorder();
    await expect(redactAndStore(FRAME, [], r.store, { ocr })).rejects.toThrow(RedactionRefused);
    expect(r.written).toEqual([]);
  });

  it('distinguishes "looked and found nothing" from "could not look"', async () => {
    const looked = await scanForSecrets(FRAME, async () => [{ x: 0, y: 0, w: 1, h: 1, text: 'fine' }]);
    const couldNot = await scanForSecrets(FRAME);

    // Collapsing these lets an unscanned frame read as a clean one, which is the
    // reassuring version of the failure this whole file exists to prevent.
    expect(looked).toEqual({ scanned: true, matches: [] });
    expect(couldNot).toEqual({ scanned: false, matches: [] });
  });

  it('treats a failed sweep as unscanned, not as clean', async () => {
    const scan = await scanForSecrets(FRAME, async () => {
      throw new Error('the OCR model is not loaded');
    });
    expect(scan.scanned).toBe(false);
  });

  it('carries whether it ran through to the result', async () => {
    const unscanned = await redactAndStore(FRAME, [BOX], recorder().store, { paint });
    expect(unscanned.scanned).toBe(false);
  });
});

describe('the marker list', () => {
  it('is short on purpose', () => {
    /**
     * §12.1 names four. A scanner that tries to be clever about secrets in
     * general produces false positives, a user who learns to ignore them, and a
     * false sense that the sweep is a guarantee rather than a helper. These are
     * unambiguous enough that a match is almost always real, which is what makes
     * looking at the highlight worthwhile.
     */
    expect([...SECRET_MARKERS]).toEqual(['sk-', 'Bearer ', 'AKIA', '-----BEGIN']);
  });
});
