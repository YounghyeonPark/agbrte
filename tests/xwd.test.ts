/**
 * Reading what `xwd` writes (DESIGN.md §12.1).
 *
 * Synthetic dumps rather than a recorded one, and that is the point of the file.
 * A capture from the machine this was written for would pin exactly one shape —
 * 24bpp, LSBFirst, `0xFF0000` red, 2944 wide — and every field this decoder reads
 * would then be a constant that happened to be right. The bugs live in the
 * fields that vary: a padded row read as an unpadded one, a mask assumed instead
 * of read, a colormap not skipped.
 *
 * So each dump here is built with one field moved, and the assertion is on the
 * pixels rather than on "it did not throw". A decoder that shears the picture
 * still returns a picture.
 */

import { describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../src/main/content/png.js';
import { decodeXwd, readXwdHeader, UnsupportedXwd } from '../src/main/content/xwd.js';
import { makeXwd } from './support/xwdDump.js';

/** One image as `[r, g, b, a]` tuples, which is what a failure has to show. */
function tuples(image: { width: number; height: number; rgba: Buffer }): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < image.width * image.height; i += 1) {
    out.push([...image.rgba.subarray(i * 4, i * 4 + 4)]);
  }
  return out;
}

const RED = [255, 0, 0, 255];
const GREEN = [0, 255, 0, 255];
const BLUE = [0, 0, 255, 255];
const WHITE = [255, 255, 255, 255];

describe('the fields that actually vary between machines', () => {
  it('finds each row through bytes_per_line, not width times depth', () => {
    /*
     * The bug this exists for. A 3-pixel row at 24bpp is 9 bytes of colour and
     * `xwd` pads it to 12, so a decoder computing its own stride starts row 1
     * three bytes early and every row after that drifts further — a picture
     * sheared diagonally, which reads as a broken capture rather than a broken
     * reader. The padding here is `0xAA`, so getting it wrong is visible as
     * colour and not as black.
     */
    const image = decodeXwd(
      makeXwd({
        width: 3,
        height: 2,
        bpp: 24,
        pad: 3,
        pixels: [
          [0xff0000, 0x00ff00, 0x0000ff],
          [0x0000ff, 0xff0000, 0x00ff00],
        ],
      }),
    );

    expect(image.width).toBe(3);
    expect(image.height).toBe(2);
    expect(tuples(image)).toEqual([RED, GREEN, BLUE, BLUE, RED, GREEN]);
  });

  it('takes the channel order from the masks instead of assuming BGR', () => {
    /*
     * The machine this was built against stores B, G, R — and hardcoding that is
     * the mistake, because a header that says otherwise is then ignored. Swapped
     * red and blue is the worst kind of wrong here: it looks like a colour
     * decision somebody made rather than a decoder reading the bytes backwards.
     */
    const swapped = decodeXwd(
      makeXwd({
        width: 2,
        height: 1,
        bpp: 24,
        masks: [0x0000ff, 0x00ff00, 0xff0000],
        pixels: [[0xff0000, 0x0000ff]],
      }),
    );

    // Same bytes as the case above, read through the masks the header gives: the
    // pixel that was red is now blue.
    expect(tuples(swapped)).toEqual([BLUE, RED]);
  });

  it('skips the window name and the colormap to find the pixels', () => {
    /*
     * `header_size` covers the name `xwd` writes, and the colormap sits after it
     * — twelve bytes an entry, present even on a TrueColor visual, where some
     * servers still emit a handful. Both are filled with `0xAA` here, so a
     * decoder that starts at a fixed 100 bytes produces garbage rather than a
     * plausible-looking image.
     */
    const image = decodeXwd(
      makeXwd({
        width: 2,
        height: 2,
        bpp: 24,
        name: 'a rather long window title',
        ncolors: 8,
        pixels: [
          [0xff0000, 0x00ff00],
          [0x0000ff, 0xffffff],
        ],
      }),
    );

    expect(tuples(image)).toEqual([RED, GREEN, BLUE, WHITE]);
  });

  it('reads a big-endian 32bpp dump', () => {
    // MSBFirst is what an X server on a big-endian host reports, and 32bpp is
    // what a depth-24 visual is usually padded to. Neither is the shape the
    // probe found, which is exactly why both are pinned.
    const image = decodeXwd(
      makeXwd({
        width: 2,
        height: 1,
        bpp: 32,
        byteOrder: 1,
        masks: [0x00ff0000, 0x0000ff00, 0x000000ff],
        pixels: [[0x00ff0000, 0x000000ff]],
      }),
    );

    expect(tuples(image)).toEqual([RED, BLUE]);
  });

  it('opens a 5/6/5 channel all the way to 255 rather than to 248', () => {
    /*
     * The depth a virtual display is often made at — `Xvfb -screen 0 WxHx16` —
     * and the only one where a channel is narrower than a byte. Shifting 31 up
     * by three gives 248: a white that is not white, on every pixel, which looks
     * like a washed-out screen instead of an arithmetic bug.
     */
    const image = decodeXwd(
      makeXwd({
        width: 3,
        height: 1,
        bpp: 16,
        masks: [0xf800, 0x07e0, 0x001f],
        pixels: [[0xffff, 0xf800, 0x001f]],
      }),
    );

    expect(tuples(image)).toEqual([WHITE, RED, BLUE]);
  });
});

describe('the header alone, which is what a display listing reads', () => {
  it('reports the size from the first few hundred bytes', () => {
    /*
     * The claim the listing rests on. Enumerating the displays on a machine has
     * to know how big each one is and whether it can be opened at all, and the
     * cheap way is to start a grab and stop after the header — so `readXwdHeader`
     * must not need the pixels. A version that did would make a listing cost
     * twelve megabytes per display, which is more than the view it precedes.
     */
    const dump = makeXwd({
      width: 2944,
      height: 1080,
      bpp: 24,
      name: 'the actual size the probe measured',
      pixels: [[0]],
    });

    const header = readXwdHeader(dump.subarray(0, 256));
    expect(header.width).toBe(2944);
    expect(header.height).toBe(1080);
    expect(header.bitsPerPixel).toBe(24);
    // Padded to a four-byte boundary by the server, which is the field a decoder
    // must read rather than compute: 2944 × 3 is 8832 and happens to already be
    // a multiple of four, so this is the width that would hide the bug.
    expect(header.bytesPerLine).toBe(8832);
  });

  it('refuses a truncated header rather than reporting a size from padding', () => {
    const dump = makeXwd({ width: 8, height: 8, bpp: 24, pixels: [[0]] });
    expect(() => readXwdHeader(dump.subarray(0, 40))).toThrow(/too short/u);
  });
});

describe('what it refuses, and by name', () => {
  it('refuses a depth it does not read, saying which', () => {
    const dump = makeXwd({ width: 1, height: 1, bpp: 24, pixels: [[0]] });
    dump.writeUInt32BE(8, 11 * 4); // bits_per_pixel

    expect(() => decodeXwd(dump)).toThrow(UnsupportedXwd);
    expect(() => decodeXwd(dump)).toThrow(/8 bits per pixel/u);
  });

  it('calls a maskless visual paletted, rather than returning black', () => {
    /*
     * Masks of zero mean the colour is in the colormap. Left to run, the mask
     * arithmetic yields zero for every channel — a black rectangle, which is
     * indistinguishable from a capture of a blanked screen. The refusal has to
     * name the format so somebody knows the display is the problem.
     */
    const dump = makeXwd({
      width: 2,
      height: 1,
      bpp: 24,
      masks: [0, 0, 0],
      pixels: [[1, 2]],
    });

    expect(() => decodeXwd(dump)).toThrow(/paletted/u);
  });

  it('says a dump is cut short instead of decoding what arrived', () => {
    /*
     * The ordinary failure of a capture that was killed or a transfer that was
     * interrupted, and the tempting behaviour — decode the rows that are there —
     * produces an image with garbage along the bottom that nobody can tell from
     * a rendering artifact.
     */
    const dump = makeXwd({ width: 4, height: 4, bpp: 24, pixels: [[0]] });
    const short = dump.subarray(0, dump.length - 10);

    expect(() => decodeXwd(short)).toThrow(/cut short/u);
  });

  it('refuses a header that describes no pixels', () => {
    const dump = makeXwd({ width: 2, height: 1, bpp: 24, pixels: [[0, 0]] });
    dump.writeUInt32BE(0, 5 * 4); // pixmap_height

    expect(() => decodeXwd(dump)).toThrow(/no pixels/u);
  });

  it('refuses something that is not a header at all', () => {
    expect(() => decodeXwd(Buffer.from('nope'))).toThrow(/too short/u);
  });
});

describe('the pair this completes', () => {
  it('turns a dump into a PNG the codec next door reads back', () => {
    /*
     * The whole reason the decoder is here rather than on the far machine: that
     * machine has `xwd` and nothing that can read it, and this repository already
     * writes PNG by hand. The round trip is the claim — an X display grab becomes
     * an attachment through code that was already here.
     */
    const image = decodeXwd(
      makeXwd({
        width: 2,
        height: 2,
        bpp: 24,
        pad: 2,
        pixels: [
          [0xff0000, 0x00ff00],
          [0x0000ff, 0xffffff],
        ],
      }),
    );

    const back = decodePng(encodePng(image));
    expect(back.width).toBe(2);
    expect(back.height).toBe(2);
    expect(back.rgba.equals(image.rgba)).toBe(true);
  });
});
