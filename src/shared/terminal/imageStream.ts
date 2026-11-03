/**
 * Pictures in a terminal's output stream, taken out before the emulator sees
 * them (DESIGN.md §17 Q24, step 3).
 *
 * Three protocols put an image in a terminal, and the tools people already have
 * speak one or more of them — `imgcat` and `agbrte attach` the iTerm2 one,
 * `chafa`, `img2sixel`, `gnuplot` and matplotlib's sixel backends sixel, `kitty
 * +kitten icat`, `timg` and `viu` kitty's:
 *
 *     ESC ] 1337 ; File = args : base64 BEL           iTerm2, one sequence
 *     ESC ] 1337 ; MultipartFile = args BEL           iTerm2, in parts:
 *       ESC ] 1337 ; FilePart = base64 BEL  …           as many as it takes,
 *       ESC ] 1337 ; FileEnd BEL                        then the end
 *     ESC P p1 ; p2 ; p3 q sixels ESC \               sixel, a DEC device control string
 *     ESC _ G key=value,… ; base64 ESC \              kitty, an application program command
 *
 * ## Why before the emulator, and not as a handler inside it
 *
 * The emulator's parser can hand an OSC or a DCS to a handler, and the first
 * version of this did. Two things made that the wrong place:
 *
 *  - **A picture takes rows, and the rows have to be taken where it is.** The
 *    text after an image is drawn below it, so the image has to move the cursor
 *    down as many rows as it is tall — at the point in the stream where it
 *    arrived. A handler cannot write into the stream it is being called from:
 *    what it writes is queued behind the rest of the chunk, and the prompt that
 *    followed the picture in the same chunk was drawn on top of it. Out here,
 *    the picture is replaced by what the emulator should see instead — a marker
 *    for each row and the line feeds between them — and order is the stream's.
 *  - **The emulator has no handler for kitty's form.** An APC is parsed and
 *    thrown away by xterm.js, with no hook.
 *
 * So this is a filter: text in, text out, with each picture handed to a
 * callback that returns the text to put in its place. It knows the protocols'
 * shapes and nothing about drawing.
 *
 * ## What it must never do to everything else
 *
 * Every byte that is not one of these sequences comes out as it went in, in the
 * same order, whatever the chunking — a sequence split across two writes is held
 * until it can be told apart, and nothing else is held. An OSC that turns out
 * to be something else (`133;A`, a title) is let through the moment its prefix
 * says so. That property is what the tests are mostly about.
 *
 * ## Bounds
 *
 * One picture is held whole while it arrives, so its size is capped
 * (`MAX_PICTURE`). A sequence past the cap is read to its end and dropped, and
 * the callback hears that it was, so the screen can say so rather than show
 * nothing; without the drop, a stream that never closed its sequence would be
 * an unbounded buffer (§7), which is the thing a terminal's scrollback ring
 * exists to prevent.
 */

/** The most characters of one picture held while it arrives: 48 MB of base64, 36 MB of image. */
export const MAX_PICTURE = 48 * 1024 * 1024;

/** One picture, as the stream carried it. Nothing is decoded here. */
export type Picture =
  | {
      protocol: 'iterm2';
      /** Keys as sent, values as sent (`name` is still base64). */
      args: Record<string, string>;
      data: string;
    }
  | {
      protocol: 'sixel';
      /** What came between `ESC P` and `q`: `p1;p2;p3`, usually empty. */
      params: string;
      data: string;
    }
  | {
      protocol: 'kitty';
      control: Record<string, string>;
      payload: string;
    }
  | {
      /** Read to its end and not kept: past `MAX_PICTURE`, or a multipart that never began. */
      protocol: 'dropped';
      why: string;
    };

/** What came after `ESC ] 1337 ;` decides which iTerm2 sequence it is. */
const ITERM2 = ['File=', 'MultipartFile=', 'FilePart=', 'FileEnd'] as const;
const OSC_PREFIX = '1337;';

type State =
  | { at: 'ground' }
  /** An ESC was the last thing seen. */
  | { at: 'esc' }
  /** Inside `ESC ]`, not yet known to be ours. */
  | { at: 'osc?'; seen: string }
  /** Inside `ESC P`, reading the parameters before the final byte. */
  | { at: 'dcs?'; seen: string }
  /** Inside a sequence that is ours, until its terminator. */
  | { at: 'body'; kind: 'iterm2' | 'sixel' | 'kitty'; head: string; parts: string[]; size: number; esc: boolean };

export class ImageStream {
  private state: State = { at: 'ground' };
  /** An iTerm2 multipart image being assembled: its arguments and its parts. */
  private multipart: { args: Record<string, string>; parts: string[]; size: number } | null = null;

  /**
   * @param place Called with each picture, in stream order; returns what the
   *   emulator should be given in its place — usually row markers and line
   *   feeds, or nothing.
   */
  constructor(
    private readonly place: (picture: Picture) => string,
    /** `MAX_PICTURE`, smaller in a test. */
    private readonly limit = MAX_PICTURE,
  ) {}

  /** Filter one chunk. What comes back is for the emulator, and may be empty. */
  write(chunk: string): string {
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      const s = this.state;
      switch (s.at) {
        case 'ground': {
          const esc = chunk.indexOf('\u001b', i);
          if (esc === -1) {
            out += chunk.slice(i);
            i = chunk.length;
          } else {
            out += chunk.slice(i, esc);
            this.state = { at: 'esc' };
            i = esc + 1;
          }
          break;
        }
        case 'esc': {
          const c = chunk[i]!;
          if (c === ']') {
            this.state = { at: 'osc?', seen: '' };
            i += 1;
          } else if (c === 'P') {
            this.state = { at: 'dcs?', seen: '' };
            i += 1;
          } else if (c === '_' && chunk[i + 1] === 'G') {
            this.state = { at: 'body', kind: 'kitty', head: '', parts: [], size: 0, esc: false };
            i += 2;
          } else if (c === '_' && i + 1 === chunk.length) {
            // `ESC _` at the very end of a chunk: whether it is kitty's waits
            // for the next byte. Held as the two characters it is.
            this.state = { at: 'osc?', seen: '\u0000_' };
            i += 1;
          } else {
            // Not a start this cares about (CSI, a lone ESC, an APC that is not
            // kitty's): through as it came, and the byte after it is ground.
            out += '\u001b';
            this.state = { at: 'ground' };
          }
          break;
        }
        case 'osc?': {
          if (s.seen === '\u0000_') {
            // The APC held above: `G` makes it kitty's, anything else is not ours.
            if (chunk[i] === 'G') {
              this.state = { at: 'body', kind: 'kitty', head: '', parts: [], size: 0, esc: false };
              i += 1;
            } else {
              out += '\u001b_';
              this.state = { at: 'ground' };
            }
            break;
          }
          const seen = s.seen + chunk[i]!;
          i += 1;
          const ours = this.iterm2Kind(seen);
          if (ours === 'no') {
            out += `\u001b]${seen}`;
            this.state = { at: 'ground' };
          } else if (ours === 'yes') {
            this.state = { at: 'body', kind: 'iterm2', head: seen.slice(OSC_PREFIX.length), parts: [], size: 0, esc: false };
          } else {
            this.state = { at: 'osc?', seen };
          }
          break;
        }
        case 'dcs?': {
          const c = chunk[i]!;
          i += 1;
          if (c === 'q') {
            this.state = { at: 'body', kind: 'sixel', head: s.seen, parts: [], size: 0, esc: false };
          } else if ((c >= '0' && c <= '9') || c === ';') {
            this.state = { at: 'dcs?', seen: s.seen + c };
          } else {
            // A DCS that is not sixel — XTGETTCAP's `+q`, tmux's passthrough,
            // DECRQSS — goes to the emulator untouched.
            out += `\u001bP${s.seen}${c}`;
            this.state = { at: 'ground' };
          }
          break;
        }
        case 'body': {
          i = this.body(s, chunk, i);
          if (this.state.at === 'ground') out += this.finished;
          break;
        }
      }
    }
    return out;
  }

  /** Set by `body` when a sequence ends: what replaces it. */
  private finished = '';

  /**
   * Read a sequence's body from `chunk[i]` up to its terminator, or to the end
   * of the chunk. Returns the index after what it consumed.
   */
  private body(s: Extract<State, { at: 'body' }>, chunk: string, i: number): number {
    // An ESC was the chunk's last character: this one decides what it was.
    if (s.esc) {
      s.esc = false;
      if (chunk[i] === '\\') {
        this.end(s);
        return i + 1;
      }
      // ESC anything-else abandons the string (ECMA-48 §8.3.89 lets ESC end
      // it), and the ESC begins whatever comes next.
      this.state = { at: 'esc' };
      this.finished = '';
      return i;
    }
    let j = i;
    while (j < chunk.length) {
      const c = chunk.charCodeAt(j);
      if (c === 0x07 && s.kind === 'iterm2') {
        this.keep(s, chunk.slice(i, j));
        this.end(s);
        return j + 1;
      }
      if (c === 0x1b) {
        this.keep(s, chunk.slice(i, j));
        if (j + 1 === chunk.length) {
          s.esc = true;
          return j + 1;
        }
        if (chunk[j + 1] === '\\') {
          this.end(s);
          return j + 2;
        }
        this.state = { at: 'esc' };
        this.finished = '';
        return j + 1;
      }
      // CAN and SUB cancel a control string outright.
      if (c === 0x18 || c === 0x1a) {
        this.state = { at: 'ground' };
        this.finished = '';
        return j + 1;
      }
      j += 1;
    }
    this.keep(s, chunk.slice(i));
    return chunk.length;
  }

  private keep(s: Extract<State, { at: 'body' }>, piece: string): void {
    if (piece === '') return;
    s.size += piece.length;
    // Past the cap the rest is still read — to find the terminator — and not kept.
    if (s.size <= this.limit) s.parts.push(piece);
    else s.parts = [];
  }

  private end(s: Extract<State, { at: 'body' }>): void {
    this.state = { at: 'ground' };
    if (s.size > this.limit) {
      this.finished = this.place({ protocol: 'dropped', why: 'too large to show' });
      return;
    }
    const text = s.parts.join('');
    this.finished = '';
    switch (s.kind) {
      case 'sixel':
        this.finished = this.place({ protocol: 'sixel', params: s.head, data: text });
        return;
      case 'kitty': {
        const semi = text.indexOf(';');
        const control = parseKeys(semi === -1 ? text : text.slice(0, semi), ',');
        this.finished = this.place({ protocol: 'kitty', control, payload: semi === -1 ? '' : text.slice(semi + 1) });
        return;
      }
      case 'iterm2':
        this.finished = this.iterm2(s.head, text);
        return;
    }
  }

  /** `head` is `File=`, `MultipartFile=`, `FilePart=` or `FileEnd`; `text` the rest. */
  private iterm2(head: string, text: string): string {
    if (head === 'File=') {
      const colon = text.indexOf(':');
      const args = parseKeys(colon === -1 ? text : text.slice(0, colon), ';');
      return this.place({ protocol: 'iterm2', args, data: colon === -1 ? '' : text.slice(colon + 1) });
    }
    if (head === 'MultipartFile=') {
      this.multipart = { args: parseKeys(text, ';'), parts: [], size: 0 };
      return '';
    }
    const m = this.multipart;
    if (head === 'FilePart=') {
      if (m === null) return '';
      m.size += text.length;
      if (m.size <= this.limit) m.parts.push(text);
      return '';
    }
    // FileEnd
    this.multipart = null;
    if (m === null) return this.place({ protocol: 'dropped', why: 'an image whose start was never sent' });
    if (m.size > this.limit) return this.place({ protocol: 'dropped', why: 'too large to show' });
    return this.place({ protocol: 'iterm2', args: m.args, data: m.parts.join('') });
  }

  /** Whether an OSC body seen so far is one of iTerm2's image sequences. */
  private iterm2Kind(seen: string): 'yes' | 'no' | 'maybe' {
    for (const name of ITERM2) {
      const full = OSC_PREFIX + name;
      if (seen === full) return 'yes';
      if (full.startsWith(seen)) return 'maybe';
    }
    return 'no';
  }
}

/** `a=1,b=2` or `a=1;b=2` into a record. A key with no `=` is kept with an empty value. */
export function parseKeys(text: string, separator: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (text === '') return out;
  for (const pair of text.split(separator)) {
    const eq = pair.indexOf('=');
    if (eq === -1) out[pair] = '';
    else out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_VALUE = new Int16Array(128).fill(-1);
for (let k = 0; k < B64.length; k += 1) B64_VALUE[B64.charCodeAt(k)] = k;
// The URL-safe alphabet too, which some encoders use without saying.
B64_VALUE['-'.charCodeAt(0)] = 62;
B64_VALUE['_'.charCodeAt(0)] = 63;

/**
 * Base64 to bytes, ignoring whitespace and padding and stopping at nothing.
 *
 * Here rather than `atob` or `Buffer` because this file is shared by the
 * renderer (no `Buffer`) and the host's tests (where `atob` builds a string of
 * the whole image first). A character outside the alphabet is skipped: a
 * terminal shows what it can of a picture rather than refusing it over one
 * stray byte.
 */
export function decodeBase64(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 3) / 4) + 3);
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let k = 0; k < text.length; k += 1) {
    const code = text.charCodeAt(k);
    const v = code < 128 ? B64_VALUE[code]! : -1;
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n] = (acc >> bits) & 0xff;
      n += 1;
    }
  }
  return out.subarray(0, n);
}
