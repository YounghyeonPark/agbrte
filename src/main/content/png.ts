/**
 * A deliberately narrow PNG codec (DESIGN.md §12.1, §12.2).
 *
 * ## Why this exists rather than a dependency
 *
 * Every pixel operation in §12 — redaction, resizing, flattening — was injected
 * and therefore unavailable outside Electron. For resizing that only cost a
 * worse answer. For **redaction it fails closed**, which meant the agent host
 * and every remote machine simply could not store a screenshot that needed
 * covering. The guarantee held by refusing to work.
 *
 * The alternatives were a native decoder (a build dependency per platform, on a
 * project whose installer is one self-contained shell script) or Electron's
 * `nativeImage`, which cannot draw at all — it resizes and crops and has no way
 * to fill a rectangle. So: a small codec over `node:zlib`, which is built in.
 * Redaction now works wherever Node does.
 *
 * ## It refuses everything it does not fully understand
 *
 * Interlaced, 16-bit, palettes, greyscale: all rejected rather than approximated.
 * The reason is §12.1's. A codec that half-understands a format produces an
 * image that might not have covered the secret, and an image that *looks*
 * redacted is worse than an error — the error stops you, the picture does not.
 * So the supported set is 8-bit RGB and RGBA, non-interlaced, and everything
 * else is a named refusal.
 *
 * Encoding always writes 8-bit RGBA with no filtering. Filters exist to make the
 * zlib stream compress better; getting one subtly wrong produces a corrupt image
 * for a saving nobody asked for here.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class UnsupportedPng extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnsupportedPng';
  }
}

export interface RawImage {
  width: number;
  height: number;
  /** Straight RGBA, four bytes per pixel, top-left first. */
  rgba: Buffer;
}

export function isPng(data: Buffer): boolean {
  return data.length >= 8 && data.subarray(0, 8).equals(SIGNATURE);
}

export function decodePng(data: Buffer): RawImage {
  if (!isPng(data)) throw new UnsupportedPng('not a PNG');

  let width = 0;
  let height = 0;
  let colourType = -1;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const bitDepth = body.readUInt8(8);
      colourType = body.readUInt8(9);
      const interlace = body.readUInt8(12);

      if (bitDepth !== 8) throw new UnsupportedPng(`bit depth ${bitDepth} is not supported; only 8`);
      if (interlace !== 0) throw new UnsupportedPng('interlaced PNGs are not supported');
      if (colourType !== 2 && colourType !== 6) {
        throw new UnsupportedPng(`colour type ${colourType} is not supported; only RGB and RGBA`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width === 0 || height === 0) throw new UnsupportedPng('no IHDR, or a zero-sized image');
  if (idat.length === 0) throw new UnsupportedPng('no image data');

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (raw.length < expected) throw new UnsupportedPng('truncated image data');

  // Undo the per-scanline filters. Each row is prefixed by its filter type, and
  // every filter refers to the *reconstructed* bytes above and to the left —
  // which is why this walks forward and cannot be vectorised away.
  const out = Buffer.alloc(width * height * 4);
  const prior = Buffer.alloc(stride);
  const line = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const start = y * (stride + 1);
    const filter = raw[start] ?? 0;
    raw.copy(line, 0, start + 1, start + 1 + stride);

    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? (line[i - channels] as number) : 0;
      const b = prior[i] as number;
      const c = i >= channels ? (prior[i - channels] as number) : 0;
      const x = line[i] as number;

      switch (filter) {
        case 0:
          break;
        case 1:
          line[i] = (x + a) & 0xff;
          break;
        case 2:
          line[i] = (x + b) & 0xff;
          break;
        case 3:
          line[i] = (x + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          line[i] = (x + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new UnsupportedPng(`unknown scanline filter ${filter}`);
      }
    }

    for (let x = 0; x < width; x += 1) {
      const from = x * channels;
      const to = (y * width + x) * 4;
      out[to] = line[from] as number;
      out[to + 1] = line[from + 1] as number;
      out[to + 2] = line[from + 2] as number;
      out[to + 3] = channels === 4 ? (line[from + 3] as number) : 0xff;
    }

    line.copy(prior);
  }

  return { width, height, rgba: out };
}

export function encodePng(image: RawImage): Buffer {
  const stride = image.width * 4;
  // Filter 0 on every row. See the note above on why no filter is chosen.
  const raw = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * (stride + 1)] = 0;
    image.rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10); // compression
  ihdr.writeUInt8(0, 11); // filter method
  ihdr.writeUInt8(0, 12); // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = ((CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}
