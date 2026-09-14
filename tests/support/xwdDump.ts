/**
 * `xwd` output, built rather than recorded (DESIGN.md §12.1).
 *
 * A capture from a real machine would pin exactly one shape — 24bpp, LSBFirst,
 * `0xFF0000` red, 2944 wide — and every header field the decoder reads would then
 * be a constant that happened to be right. The bugs live in the fields that vary:
 * a padded row read as an unpadded one, a mask assumed instead of read, a
 * colormap not skipped. So the fixture takes them all as arguments.
 *
 * Shared by the decoder's own tests and by the host module that drives `xwd`,
 * because the second needs a dump that is genuinely decodable — a handful of
 * plausible bytes would let a stub pass while the real pair could not talk.
 */

/** Where the pixels sit relative to the header, spelled out once. */
const FIXED_HEADER = 100;
const COLOR_BYTES = 12;

export interface Dump {
  width: number;
  height: number;
  bpp: 16 | 24 | 32;
  /** X's own spelling: 0 is LSBFirst, 1 is MSBFirst. */
  byteOrder?: 0 | 1;
  /** red, green, blue. Defaults to what a PC X server reports. */
  masks?: readonly [number, number, number];
  /** Bytes of slack at the end of every row, which `bytes_per_line` covers. */
  pad?: number;
  /** Colormap entries, which come between the header and the pixels. */
  ncolors?: number;
  /** The NUL-terminated window name `xwd` writes after the fixed header. */
  name?: string;
  /** Row-major pixel values, already laid out the way the masks describe. */
  pixels: readonly (readonly number[])[];
}

export function makeXwd(dump: Dump): Buffer {
  const {
    width,
    height,
    bpp,
    byteOrder = 0,
    masks = [0xff0000, 0x00ff00, 0x0000ff],
    pad = 0,
    ncolors = 0,
    name = 'root',
    pixels,
  } = dump;

  const bytes = bpp / 8;
  const headerSize = FIXED_HEADER + name.length + 1;
  const bytesPerLine = width * bytes + pad;
  const start = headerSize + ncolors * COLOR_BYTES;
  const buf = Buffer.alloc(start + bytesPerLine * height);

  const words = new Array<number>(25).fill(0);
  words[0] = headerSize;
  words[1] = 7; // file_version
  words[2] = 2; // ZPixmap
  words[3] = bpp === 16 ? 16 : 24; // pixmap_depth
  words[4] = width;
  words[5] = height;
  words[7] = byteOrder;
  words[11] = bpp;
  words[12] = bytesPerLine;
  words[13] = 4; // TrueColor
  words[14] = masks[0];
  words[15] = masks[1];
  words[16] = masks[2];
  words[19] = ncolors;
  for (const [i, w] of words.entries()) buf.writeUInt32BE(w, i * 4);
  buf.write(name, FIXED_HEADER, 'ascii');

  /*
   * Everything that is not a pixel is filled with `0xAA` rather than left zero.
   * Zero-filled slack is the reason an offset bug passes: a decoder reading from
   * the wrong place finds zeroes, produces black, and black looks like a screen
   * that was off.
   */
  buf.fill(0xaa, headerSize, start);
  for (let y = 0; y < height; y += 1) {
    const row = start + y * bytesPerLine;
    buf.fill(0xaa, row + width * bytes, row + bytesPerLine);
    for (let x = 0; x < width; x += 1) {
      const at = row + x * bytes;
      const value = pixels[y]?.[x] ?? 0;
      if (byteOrder === 1) buf.writeUIntBE(value, at, bytes);
      else buf.writeUIntLE(value, at, bytes);
    }
  }

  return buf;
}
