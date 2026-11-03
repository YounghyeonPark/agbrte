/**
 * Whether a file is a video or a sound, from its first bytes (DESIGN.md §17
 * Q24, step 4).
 *
 * The terminal's player rides on the iTerm2 file sequence a picture uses
 * (`terminalImages.ts` says why), and that sequence does not say what the file
 * is — `imgcat` never needed to. The bytes do, the same way `imageSize` reads a
 * picture's: a container's signature is in its first few bytes, and the rows a
 * player takes have to be decided in the moment the sequence arrives, before
 * the browser has looked at anything.
 *
 * The formats are the ones the app's browser plays — Chromium, as Electron
 * ships it, with the proprietary decoders (H.264, AAC, MP3) built in. A
 * container it cannot play (AVI, WMV) is not recognised here, so it is refused
 * by name instead of drawn as a player that never starts.
 *
 * Video or sound decides the shape of what is drawn: a box of the picture's
 * size, or a strip of controls. Containers that carry either (MP4, WebM, Ogg)
 * are looked into for a video track; when that cannot be told from the bytes
 * at hand, the answer leans to video, because a video box playing only sound
 * still plays, and a strip of controls cannot show a picture.
 */

export interface MediaType {
  kind: 'video' | 'audio';
  mime: string;
  /** The picture's own size, when the header says it; otherwise the player picks one. */
  width?: number;
  height?: number;
}

const ascii = (b: Uint8Array, i: number, n: number): string => String.fromCharCode(...b.subarray(i, i + n));
const be32 = (b: Uint8Array, i: number): number => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);

/** How far into a file the track headers are looked for. A faststart MP4 has them in the first few kilobytes. */
const LOOK = 1024 * 1024;

export function mediaType(b: Uint8Array): MediaType | null {
  if (b.length < 12) return null;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return { kind: 'audio', mime: 'audio/wav' };
  if (ascii(b, 4, 4) === 'ftyp') return mp4(b);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return matroska(b);
  if (ascii(b, 0, 4) === 'OggS') {
    // The first page carries the first stream's header; Theora's says so.
    return contains(b, 'theora', 4096) ? { kind: 'video', mime: 'video/ogg' } : { kind: 'audio', mime: 'audio/ogg' };
  }
  if (ascii(b, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac' };
  if (ascii(b, 0, 3) === 'ID3') return { kind: 'audio', mime: 'audio/mpeg' };
  if (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    // A frame sync: AAC in ADTS has layer bits 00, MPEG audio (MP3) does not.
    return (b[1]! & 0x06) === 0 ? { kind: 'audio', mime: 'audio/aac' } : { kind: 'audio', mime: 'audio/mpeg' };
  }
  return null;
}

/**
 * MP4 and its family. The brand names the audio-only ones (`M4A `), and the
 * track headers, when the index is at the front, say whether there is a
 * picture and how big it is. An index at the end — a file not written for
 * streaming — leaves only the brand.
 */
function mp4(b: Uint8Array): MediaType {
  const brand = ascii(b, 8, 4);
  const audioBrand = brand === 'M4A ' || brand === 'M4B ' || brand === 'M4P ' || brand === 'F4A ';
  const mime = brand === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  const moov = findBox(b, 0, Math.min(b.length, LOOK), 'moov');
  if (moov === null) return audioBrand ? { kind: 'audio', mime: 'audio/mp4' } : { kind: 'video', mime };
  let at = moov.start;
  while (at + 8 <= moov.end) {
    const trak = findBox(b, at, moov.end, 'trak');
    if (trak === null) break;
    const tkhd = findBox(b, trak.start, trak.end, 'tkhd');
    if (tkhd !== null) {
      // Version 1 has 64-bit times, so the size sits 12 bytes further on. Both
      // are 16.16 fixed point, and a sound track's are zero.
      const v1 = b[tkhd.start] === 1;
      const off = tkhd.start + (v1 ? 88 : 76);
      if (off + 8 <= tkhd.end) {
        const width = Math.round(be32(b, off) / 65536);
        const height = Math.round(be32(b, off + 4) / 65536);
        if (width > 0 && height > 0) return { kind: 'video', mime, width, height };
      }
    }
    at = trak.end;
  }
  return { kind: 'audio', mime: 'audio/mp4' };
}

/** A box named `name` among the boxes in `[from, to)`: where its contents start and end. */
function findBox(b: Uint8Array, from: number, to: number, name: string): { start: number; end: number } | null {
  let i = from;
  while (i + 8 <= to) {
    let size = be32(b, i);
    let header = 8;
    if (size === 1 && i + 16 <= to) {
      // A 64-bit size; one past four gigabytes is not something held in memory here.
      size = be32(b, i + 8) * 2 ** 32 + be32(b, i + 12);
      header = 16;
    } else if (size === 0) size = to - i;
    if (size < header) return null;
    if (ascii(b, i + 4, 4) === name) return { start: i + header, end: Math.min(to, i + size) };
    i += size;
  }
  return null;
}

/**
 * WebM and Matroska. A video track's codec id starts `V_` (`V_VP9`, `V_AV1`,
 * `V_MPEG4/ISO/AVC`) and sits in the track list near the front; the doctype
 * says which of the two it is.
 */
function matroska(b: Uint8Array): MediaType {
  const webm = contains(b, 'webm', 64);
  // The CodecID element (0x86) with a one-byte length, then the id. Matched as
  // the element and not as the two letters, which an Opus track's private data
  // could hold by chance.
  let video = false;
  const end = Math.min(b.length, 64 * 1024) - 4;
  for (let i = 0; i < end && !video; i += 1) {
    video = b[i] === 0x86 && (b[i + 1]! & 0x80) !== 0 && b[i + 2] === 0x56 && b[i + 3] === 0x5f;
  }
  if (video) return { kind: 'video', mime: webm ? 'video/webm' : 'video/x-matroska' };
  return { kind: 'audio', mime: webm ? 'audio/webm' : 'audio/x-matroska' };
}

function contains(b: Uint8Array, text: string, within: number): boolean {
  const end = Math.min(b.length, within) - text.length;
  outer: for (let i = 0; i <= end; i += 1) {
    for (let k = 0; k < text.length; k += 1) if (b[i + k] !== text.charCodeAt(k)) continue outer;
    return true;
  }
  return false;
}
