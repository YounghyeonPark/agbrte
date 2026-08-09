/**
 * The pixel operations, against real bytes (DESIGN.md §12.1, §12.2, §15 Phase 7).
 *
 * Every one of these was an injection point that nothing injected, so redaction
 * — which fails closed — could not store a screenshot needing a blackout
 * anywhere outside Electron. The guarantee held by not working.
 *
 * These tests encode a real PNG, run the operation, and decode the result to
 * look at the pixels. Asserting on a mocked codec would check that the arguments
 * were passed along and assume the part that matters: whether the secret is
 * actually gone.
 */

import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, isPng, UnsupportedPng, type RawImage } from '@main/content/png.js';
import { fillRects, flattenAnnotations, scaleToFit, sizeOf } from '@main/content/pixels.js';

/** A solid image of a known colour, so a changed pixel is unambiguous. */
function solid(width: number, height: number, rgb: [number, number, number]): RawImage {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 0xff;
  }
  return { width, height, rgba };
}

const pixelAt = (image: RawImage, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4;
  return [image.rgba[at]!, image.rgba[at + 1]!, image.rgba[at + 2]!, image.rgba[at + 3]!];
};

describe('the codec', () => {
  it('round-trips an image byte for byte', () => {
    const original = solid(17, 11, [200, 100, 50]);
    const decoded = decodePng(encodePng(original));

    // Odd dimensions on purpose: stride arithmetic is where a codec goes wrong,
    // and a 16×16 square hides an off-by-one in every direction.
    expect(decoded.width).toBe(17);
    expect(decoded.height).toBe(11);
    expect(decoded.rgba.equals(original.rgba)).toBe(true);
  });

  it('produces something recognisable as a PNG', () => {
    expect(isPng(encodePng(solid(4, 4, [0, 0, 0])))).toBe(true);
    expect(isPng(Buffer.from('not an image'))).toBe(false);
  });

  it('refuses what it does not fully understand', () => {
    // §12.1's reasoning: a codec that half-understands a format produces an
    // image that might not have covered the secret, and an image that looks
    // redacted is worse than an error — the error stops you.
    const png = encodePng(solid(4, 4, [0, 0, 0]));
    const sixteenBit = Buffer.from(png);
    sixteenBit.writeUInt8(16, 8 + 8 + 8); // IHDR bit depth
    expect(() => decodePng(sixteenBit)).toThrow(UnsupportedPng);
  });

  it('refuses an interlaced image rather than mangling it', () => {
    const png = encodePng(solid(4, 4, [0, 0, 0]));
    const interlaced = Buffer.from(png);
    interlaced.writeUInt8(1, 8 + 8 + 12); // IHDR interlace method
    expect(() => decodePng(interlaced)).toThrow(/interlaced/);
  });

  it('refuses something that is not a PNG at all', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow(UnsupportedPng);
  });
});

describe('painting out a region', () => {
  it('actually blacks out the pixels', async () => {
    const frame = encodePng(solid(20, 20, [255, 0, 0]));
    const painted = await fillRects(frame, [{ x: 5, y: 5, w: 10, h: 10 }]);
    const out = decodePng(painted);

    // The assertion the whole feature rests on: the bytes changed, not a flag.
    expect(pixelAt(out, 10, 10)).toEqual([0, 0, 0, 255]);
    // And only where it was asked to.
    expect(pixelAt(out, 1, 1)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 18, 18)).toEqual([255, 0, 0, 255]);
  });

  it('covers the exact rectangle, edges included', async () => {
    const frame = encodePng(solid(10, 10, [255, 255, 255]));
    const out = decodePng(await fillRects(frame, [{ x: 2, y: 3, w: 4, h: 2 }]));

    expect(pixelAt(out, 2, 3)[0]).toBe(0);
    expect(pixelAt(out, 5, 4)[0]).toBe(0);
    // One pixel outside on each side stays untouched. An off-by-one here means
    // either a visible sliver of a secret or a black line through the picture.
    expect(pixelAt(out, 1, 3)[0]).toBe(255);
    expect(pixelAt(out, 6, 4)[0]).toBe(255);
    expect(pixelAt(out, 2, 2)[0]).toBe(255);
    expect(pixelAt(out, 5, 5)[0]).toBe(255);
  });

  it('clamps a rectangle dragged past the edge', async () => {
    // Ordinary: people drag past the window. An unclamped write would throw or
    // corrupt another row, and on this path that means a secret left visible.
    const frame = encodePng(solid(10, 10, [255, 255, 255]));
    const out = decodePng(await fillRects(frame, [{ x: -5, y: -5, w: 100, h: 100 }]));
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 9, 9)).toEqual([0, 0, 0, 255]);
  });

  it('paints opaque black rather than blurring', async () => {
    // §12.1 offers blur as a pre-pass affordance, but what is *stored* has to be
    // unrecoverable. People have read text back out of blurs; nobody has read it
    // out of a black box.
    const frame = encodePng(solid(8, 8, [10, 20, 30]));
    const out = decodePng(await fillRects(frame, [{ x: 0, y: 0, w: 8, h: 8 }]));
    for (let i = 0; i < 8; i += 1) expect(pixelAt(out, i, i)).toEqual([0, 0, 0, 255]);
  });

  it('refuses a format it cannot edit rather than passing it through', async () => {
    // Passing it back unchanged would hand `redactAndStore` bytes it believes
    // are painted, and store the secret.
    await expect(fillRects(Buffer.from('\xff\xd8\xffJPEG'), [{ x: 0, y: 0, w: 1, h: 1 }])).rejects.toThrow(
      UnsupportedPng,
    );
  });
});

describe('scaling to fit', () => {
  it('brings the long edge down and keeps the shape', async () => {
    const out = decodePng(await scaleToFit(encodePng(solid(800, 400, [1, 2, 3])), 200));
    expect(out.width).toBe(200);
    expect(out.height).toBe(100);
  });

  it('leaves an image already inside the limit completely alone', async () => {
    // Resampling it would lose detail to no purpose.
    const frame = encodePng(solid(100, 50, [9, 9, 9]));
    expect(await scaleToFit(frame, 200)).toBe(frame);
  });

  it('averages rather than picking, so text does not turn to noise', async () => {
    // A checkerboard: nearest-neighbour returns one of the two source colours,
    // averaging returns something between them. Text at these ratios is the
    // usual reason a screenshot was attached at all.
    const image = solid(4, 4, [0, 0, 0]);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        if ((x + y) % 2 === 0) {
          const at = (y * 4 + x) * 4;
          image.rgba[at] = 255;
          image.rgba[at + 1] = 255;
          image.rgba[at + 2] = 255;
        }
      }
    }

    const out = decodePng(await scaleToFit(encodePng(image), 2));
    const [r] = pixelAt(out, 0, 0);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(255);
  });

  it('never scales to nothing', async () => {
    const out = decodePng(await scaleToFit(encodePng(solid(1000, 4, [0, 0, 0])), 10));
    expect(out.height).toBeGreaterThanOrEqual(1);
  });
});

describe('reading a size', () => {
  it('reports what the header says', () => {
    expect(sizeOf(encodePng(solid(123, 45, [0, 0, 0])))).toEqual({ width: 123, height: 45 });
  });
});

// ------------------------------------------------ the two paths, end to end

describe('the operations the rest of §12 was waiting for', () => {
  it('lets redaction actually store a covered frame', async () => {
    /**
     * The point of this whole commit. `redactAndStore` fails closed, so before
     * a painter existed it refused every screenshot needing a blackout — the
     * guarantee held by not working, in the agent host and on every remote
     * machine.
     */
    const { redactAndStore } = await import('@main/content/redact.js');
    const frame = encodePng(solid(20, 20, [255, 0, 0]));

    let stored: Buffer | null = null;
    const result = await redactAndStore(
      frame,
      [{ x: 5, y: 5, w: 10, h: 10 }],
      async (buf) => {
        stored = buf;
        return 'a'.repeat(64) as never;
      },
      { paint: fillRects },
    );

    expect(result.redactions).toHaveLength(1);
    // What reached the store has the region actually blacked out, not a flag
    // saying it was.
    const out = decodePng(stored as unknown as Buffer);
    expect(pixelAt(out, 10, 10)).toEqual([0, 0, 0, 255]);
  });

  it('lets fitting send a scaled image instead of a text apology', async () => {
    const { fitContent } = await import('@main/content/fit.js');
    const { DEFAULT_ECHO_CAPABILITIES } = await import('@main/runtime/runtimes/echo.js');

    const frame = encodePng(solid(400, 200, [0, 128, 255]));
    const result = await fitContent(
      [
        {
          type: 'image',
          sha256: 'a'.repeat(64),
          mime: 'image/png',
          width: 400,
          height: 200,
          provenance: { kind: 'paste', origin: 'client' },
        } as never,
      ],
      {
        ...DEFAULT_ECHO_CAPABILITIES,
        input: { image: true, audio: false, pdf: false, video: false },
        imageMaxLongEdge: 100,
      },
      async (_image, max) => {
        const scaled = await scaleToFit(frame, max);
        return { sha256: 'b'.repeat(64) as never, ...sizeOf(scaled) };
      },
    );

    // A real image at a real size, where before this was a sentence explaining
    // that one could not be sent.
    expect(result.content[0]).toMatchObject({ type: 'image', width: 100, height: 50 });
  });
});

// ----------------------------------------------------------- flattening

describe('burning annotations in', () => {
  const white = (): Buffer => encodePng(solid(60, 60, [255, 255, 255]));

  it('draws a box where the box was', async () => {
    const out = decodePng(
      await flattenAnnotations(white(), [
        { kind: 'rectangle', colour: 'red', rect: { x: 10, y: 10, w: 30, h: 20 } },
      ]),
    );

    // On the edge, not in the middle: a box is an outline, and filling it would
    // cover the thing it was drawn to point at.
    expect(pixelAt(out, 25, 10)[0]).toBe(255);
    expect(pixelAt(out, 25, 10)[1]).toBeLessThan(100);
    expect(pixelAt(out, 25, 20)).toEqual([255, 255, 255, 255]);
  });

  it('puts the arrowhead at the tip', async () => {
    const out = decodePng(
      await flattenAnnotations(white(), [
        { kind: 'arrow', colour: 'blue', from: { x: 5, y: 5 }, to: { x: 50, y: 50 } },
      ]),
    );

    /**
     * Counted rather than probed at one pixel: the head is two short strokes at
     * an angle, and asserting on a single coordinate tests my trigonometry
     * rather than the property. The property is that there is visibly *more*
     * mark near the tip than near the tail, which is what an arrowhead is.
     */
    const marked = (cx: number, cy: number): number => {
      let n = 0;
      for (let y = cy - 8; y <= cy + 8; y += 1) {
        for (let x = cx - 8; x <= cx + 8; x += 1) {
          if (x < 0 || y < 0 || x >= out.width || y >= out.height) continue;
          const px = pixelAt(out, x, y);
          if ((px[2] ?? 0) > 200 && (px[0] ?? 255) < 100) n += 1;
        }
      }
      return n;
    };

    // The head is the whole meaning of an arrow, and it belongs where the user
    // was pointing rather than where their hand started.
    expect(marked(50, 50)).toBeGreaterThan(marked(5, 5));
  });

  it('follows a freehand stroke through its points', async () => {
    const out = decodePng(
      await flattenAnnotations(white(), [
        {
          kind: 'freehand',
          colour: 'green',
          points: [
            { x: 5, y: 30 },
            { x: 30, y: 30 },
            { x: 30, y: 55 },
          ],
        },
      ]),
    );
    expect(pixelAt(out, 20, 30)[1]).toBeGreaterThan(150);
    expect(pixelAt(out, 30, 45)[1]).toBeGreaterThan(150);
  });

  it('crops last, so the marks are still under the crop', async () => {
    // Annotation coordinates are in the original image's space. Cropping first
    // would move every mark out from under them.
    const out = decodePng(
      await flattenAnnotations(white(), [
        { kind: 'rectangle', colour: 'red', rect: { x: 30, y: 30, w: 20, h: 20 } },
        { kind: 'crop', rect: { x: 25, y: 25, w: 30, h: 30 } },
      ]),
    );

    expect(out.width).toBe(30);
    expect(out.height).toBe(30);
    // The box was at (30,30) in the original, so (5,5) after the crop.
    expect(pixelAt(out, 10, 5)[1]).toBeLessThan(100);
  });

  it('does not repaint blackouts', async () => {
    // They went through `redactAndStore` before the frame was ever written
    // (§12.1). Repainting here would suggest this is where redaction happens,
    // and nothing about a frame that reached this point should depend on it.
    const out = decodePng(
      await flattenAnnotations(white(), [{ kind: 'blackout', rect: { x: 0, y: 0, w: 60, h: 60 } }]),
    );
    expect(pixelAt(out, 30, 30)).toEqual([255, 255, 255, 255]);
  });

  it('leaves an unannotated frame recognisably itself', async () => {
    const out = decodePng(await flattenAnnotations(white(), []));
    expect(pixelAt(out, 30, 30)).toEqual([255, 255, 255, 255]);
    expect(out.width).toBe(60);
  });

  it('survives a stroke drawn off the edge', async () => {
    await expect(
      flattenAnnotations(white(), [
        { kind: 'arrow', colour: 'red', from: { x: -500, y: -500 }, to: { x: 900, y: 900 } },
      ]),
    ).resolves.toBeInstanceOf(Buffer);
  });
});
