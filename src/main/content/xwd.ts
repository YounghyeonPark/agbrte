/**
 * The format `xwd` writes, decoded (DESIGN.md §12.1).
 *
 * §12.1 names a "remote display grab where a real or virtual display exists"
 * and never built one, and the reason it is worth building now is what a probe
 * of a real machine found: an Ubuntu box with a desktop logged in for six weeks
 * had `xwd` installed and nothing else. No ImageMagick, no `scrot`, no `ffmpeg`,
 * and GNOME's own screenshot refused over D-Bus — "Screenshot is not allowed",
 * which is GNOME 4x keeping that API for portal callers. `xwd` is part of
 * `x11-apps` and is the one thing that was simply there.
 *
 * What it writes is not an image format anybody else reads. Pillow, which *was*
 * installed on that machine, cannot open it. So the choice was a dependency on
 * the far machine or a decoder here, and this project already encodes PNG by
 * hand (`content/png.ts`) — which makes the pair complete rather than novel.
 *
 * ## The format, and the two fields that actually vary
 *
 * A hundred bytes of big-endian `u32`, a NUL-terminated window name, then
 * optional colormap entries, then the pixels. Most of the header is either
 * constant in practice or irrelevant to a screen grab; the two that decide how
 * to read the bytes are `bits_per_pixel` and `bytes_per_line`, and the second is
 * the one that bites: **a row is padded**, so a 2944-pixel row at 24bpp is not
 * 8832 bytes, and reading it as if it were shears the picture diagonally.
 *
 * The masks are read rather than assumed. A modern X server on a PC gives
 * `0xFF0000` red with the bytes in memory as B, G, R — but the header says so,
 * and a decoder that hardcodes BGR is one that silently swaps red and blue on
 * the first machine that disagrees. Swapped colour is exactly the kind of wrong
 * that looks like a rendering opinion rather than a bug.
 *
 * ## What it refuses
 *
 * Paletted visuals (`ncolors > 0` with 8bpp) are not decoded. A desktop in 256
 * colours is not a case this reaches — the probe found 24bpp TrueColor, which is
 * every machine this will meet — and a half-implemented palette path would be
 * code nobody exercises pretending to be support.
 *
 * 16bpp *is* read, and it is not speculative: §12.1's other case is "a virtual
 * display", and `Xvfb -screen 0 1024x768x16` is a normal way to make one. That is
 * also the only depth where a channel is narrower than a byte, so it is what
 * makes the scaling below matter.
 */

import type { RawImage } from './png.js';

/** The fixed part of an XWD header: 25 big-endian `u32`. */
const HEADER_WORDS = 25;
const HEADER_BYTES = HEADER_WORDS * 4;
/** One `XWDColor`: pixel, r, g, b, flags, pad. */
const COLOR_BYTES = 12;

export class UnsupportedXwd extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedXwd';
  }
}

/** Where a mask's bits start, and how many there are. */
function channel(mask: number): { shift: number; bits: number } {
  if (mask === 0) return { shift: 0, bits: 0 };
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  let bits = 0;
  while (((mask >>> (shift + bits)) & 1) === 1) bits += 1;
  return { shift, bits };
}

/**
 * Scale a channel to eight bits.
 *
 * A 5-bit channel at full brightness is 31, and `31 << 3` is 248 rather than
 * 255 — a white that is not quite white, on every pixel. Repeating the high bits
 * into the low ones is the standard fix and costs nothing.
 */
function toByte(value: number, bits: number): number {
  if (bits === 8) return value;
  if (bits === 0) return 0;
  return Math.round((value * 255) / ((1 << bits) - 1));
}

/** What the header says, for the caller that only needs to know the size. */
export interface XwdHeader {
  width: number;
  height: number;
  bitsPerPixel: number;
  /** Where the pixels begin: past the window name and the colormap. */
  pixelsAt: number;
  /** A padded row's real length, which is the field that gets decoding wrong. */
  bytesPerLine: number;
}

/**
 * Read the header and nothing else.
 *
 * Exported because listing the displays on a machine needs the size of each one
 * and, more to the point, needs to know whether it can be read at all — and the
 * cheap way to learn both is to start a grab and stop after a hundred bytes. A
 * decoder that only had `decodeXwd` would make that a choice between a listing
 * that moves twelve megabytes per display and a listing that guesses (§3.3).
 *
 * The validation lives here rather than in `decodeXwd` for the same reason: a
 * display this cannot decode should be reported as such while it is being
 * listed, not when somebody clicks it (§3.5).
 */
export function readXwdHeader(data: Buffer): XwdHeader {
  if (data.length < HEADER_BYTES) throw new UnsupportedXwd('too short to be an XWD header');

  const word = (i: number): number => data.readUInt32BE(i * 4);
  const width = word(4);
  const height = word(5);
  const bitsPerPixel = word(11);

  if (width === 0 || height === 0) throw new UnsupportedXwd('a display with no pixels in it');
  if (bitsPerPixel !== 16 && bitsPerPixel !== 24 && bitsPerPixel !== 32) {
    // Named rather than guessed at: 8bpp means a colormap, which is a different
    // decoder and not one any machine this meets needs.
    throw new UnsupportedXwd(`${bitsPerPixel} bits per pixel, and only 16, 24 and 32 are read`);
  }
  if (word(14) === 0 && word(15) === 0 && word(16) === 0) {
    // No masks means the colour lives in the colormap, which is the paletted case
    // this does not decode — and it has to be said as "paletted", because the
    // picture it would otherwise produce is a black rectangle that looks like a
    // capture of a blank screen rather than a decoder that gave up.
    throw new UnsupportedXwd('a paletted visual, and only direct colour is read');
  }

  return {
    width,
    height,
    bitsPerPixel,
    pixelsAt: word(0) + word(19) * COLOR_BYTES,
    bytesPerLine: word(12),
  };
}

/** `xwd` output as straight RGBA, or a refusal naming what it met. */
export function decodeXwd(data: Buffer): RawImage {
  const { width, height, bitsPerPixel, pixelsAt: start, bytesPerLine } = readXwdHeader(data);

  const word = (i: number): number => data.readUInt32BE(i * 4);
  const byteOrder = word(7);
  const redMask = word(14);
  const greenMask = word(15);
  const blueMask = word(16);

  const need = bytesPerLine * height;
  if (start + need > data.length) {
    // A truncated dump is the ordinary failure of a capture that was killed, and
    // it has to say so rather than produce a picture with garbage at the bottom.
    throw new UnsupportedXwd(
      `the pixels are cut short: ${data.length - start} bytes for ${need}`,
    );
  }

  const red = channel(redMask);
  const green = channel(greenMask);
  const blue = channel(blueMask);
  const bytes = bitsPerPixel / 8;
  const rgba = Buffer.allocUnsafe(width * height * 4);

  /*
   * One closure rather than three copies of the loop.
   *
   * It is called three million times for a 2944×1080 grab, which is the sort of
   * thing that argues for unrolling it — but it is monomorphic and V8 inlines it,
   * and the alternative is the same twenty lines written three times with the
   * `bytes_per_line` arithmetic repeated in each. That arithmetic is exactly what
   * gets it wrong.
   */
  const pixelAt =
    bytes === 4
      ? (at: number): number => (byteOrder === 1 ? data.readUInt32BE(at) : data.readUInt32LE(at))
      : bytes === 2
        ? (at: number): number => (byteOrder === 1 ? data.readUInt16BE(at) : data.readUInt16LE(at))
        : (at: number): number =>
            byteOrder === 1
              ? (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!
              : data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16);

  for (let y = 0; y < height; y += 1) {
    // From `bytes_per_line`, never from `width * bytes`. A padded row read as an
    // unpadded one shears the picture a little further on every scanline, which
    // looks like a broken capture rather than a broken reader.
    let at = start + y * bytesPerLine;
    let out = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const pixel = pixelAt(at);

      rgba[out] = toByte((pixel >>> red.shift) & ((1 << red.bits) - 1), red.bits);
      rgba[out + 1] = toByte((pixel >>> green.shift) & ((1 << green.bits) - 1), green.bits);
      rgba[out + 2] = toByte((pixel >>> blue.shift) & ((1 << blue.bits) - 1), blue.bits);
      rgba[out + 3] = 255;
      at += bytes;
      out += 4;
    }
  }

  return { width, height, rgba };
}
