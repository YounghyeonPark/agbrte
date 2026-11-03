/**
 * How big an image file is, from its first bytes (DESIGN.md §17 Q24, step 3).
 *
 * A picture in a terminal takes rows, and the rows have to be taken in the
 * same moment the picture arrives (`imageStream.ts`) — before the browser has
 * decoded anything, which it only does asynchronously. Every format a terminal
 * image protocol carries in practice says its size in a header, so the size is
 * read from there, synchronously, and the decode happens later on its own.
 *
 * PNG, GIF, JPEG, WebP and BMP: what `imgcat`, matplotlib, screenshots and the
 * agent's captures produce. Anything else returns `null`, and the picture is
 * refused by name rather than drawn at a guessed size.
 */

export interface ImageSize {
  width: number;
  height: number;
  mime: string;
}

const be16 = (b: Uint8Array, i: number): number => (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const le16 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number): number => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number): number => (le16(b, i) | (le16(b, i + 2) << 16)) | 0;
const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));

export function imageSize(b: Uint8Array): ImageSize | null {
  if (b.length >= 24 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    return sized(be32(b, 16), be32(b, 20), 'image/png');
  }
  if (b.length >= 10 && ascii(b, 0, 3) === 'GIF') {
    return sized(le16(b, 6), le16(b, 8), 'image/gif');
  }
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4);
    if (chunk === 'VP8X') return sized(le24(b, 24) + 1, le24(b, 27) + 1, 'image/webp');
    if (chunk === 'VP8L') {
      const bits = le32(b, 21);
      return sized((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, 'image/webp');
    }
    if (chunk === 'VP8 ') return sized(le16(b, 26) & 0x3fff, le16(b, 28) & 0x3fff, 'image/webp');
    return null;
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    // A bottom-up BMP stores its height positive and a top-down one negative.
    return sized(Math.abs(le32(b, 18)), Math.abs(le32(b, 22)), 'image/bmp');
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  return null;
}

/**
 * JPEG keeps its size in the start-of-frame segment, which can come after an
 * EXIF block holding a thumbnail — a phone's photo puts tens of kilobytes
 * first — so the segments are walked rather than a fixed offset read.
 */
function jpeg(b: Uint8Array): ImageSize | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = b[i + 1]!;
    // Fill bytes and markers that carry no length.
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return sized(be16(b, i + 7), be16(b, i + 5), 'image/jpeg');
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    i += 2 + be16(b, i + 2);
  }
  return null;
}

function sized(width: number, height: number, mime: string): ImageSize | null {
  return width > 0 && height > 0 ? { width, height, mime } : null;
}
