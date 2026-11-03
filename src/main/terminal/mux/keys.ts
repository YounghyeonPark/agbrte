/**
 * Keys out of a raw terminal's input.
 *
 * In raw mode stdin delivers bytes, not keys: an arrow is three bytes, a paste
 * is hundreds, and a chunk can end in the middle of either. The agent's input
 * line needs keys; the shell needs the bytes untouched. So this reads keys only
 * where the agent is listening and the shell's input passes through as it came.
 *
 * Bracketed paste is honoured: a paste arrives as one `paste` key, so a pasted
 * paragraph with newlines in it is text in the line rather than four sends.
 */

export type Key =
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'enter' }
  | { kind: 'backspace' }
  | { kind: 'delete' }
  | { kind: 'left' }
  | { kind: 'right' }
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'home' }
  | { kind: 'end' }
  | { kind: 'tab' }
  | { kind: 'escape' }
  /** A control key, by its letter: `ctrl('c')` is Ctrl+C. `@` is Ctrl+Space / Ctrl+`. */
  | { kind: 'ctrl'; key: string }
  /** Alt with a key, which terminals send as ESC and the key. */
  | { kind: 'alt'; key: string }
  /** A sequence this does not name; carried so nothing typed vanishes silently. */
  | { kind: 'unknown'; raw: string };

const PASTE_START = '\u001b[200~';
const PASTE_END = '\u001b[201~';

/** CSI sequences by their final part. */
const CSI: Readonly<Record<string, Key>> = {
  A: { kind: 'up' },
  B: { kind: 'down' },
  C: { kind: 'right' },
  D: { kind: 'left' },
  H: { kind: 'home' },
  F: { kind: 'end' },
  '1~': { kind: 'home' },
  '7~': { kind: 'home' },
  '4~': { kind: 'end' },
  '8~': { kind: 'end' },
  '3~': { kind: 'delete' },
};

export class KeyReader {
  private carry = '';
  private pasting: string | null = null;

  /** Read one chunk; answer the keys it completed. An unfinished sequence waits for the next. */
  push(chunk: string): Key[] {
    const keys: Key[] = [];
    let text = this.carry + chunk;
    this.carry = '';
    let run = '';
    const flush = (): void => {
      if (run !== '') keys.push({ kind: 'text', text: run });
      run = '';
    };

    while (text.length > 0) {
      if (this.pasting !== null) {
        const end = text.indexOf(PASTE_END);
        if (end === -1) {
          // Hold back what could be the start of the end marker.
          const keep = partialSuffix(text, PASTE_END);
          this.pasting += text.slice(0, text.length - keep);
          this.carry = text.slice(text.length - keep);
          return keys;
        }
        this.pasting += text.slice(0, end);
        keys.push({ kind: 'paste', text: this.pasting.replace(/\r\n?/gu, '\n') });
        this.pasting = null;
        text = text.slice(end + PASTE_END.length);
        continue;
      }

      const ch = text[0]!;
      if (ch === '\u001b') {
        flush();
        if (text.startsWith(PASTE_START)) {
          this.pasting = '';
          text = text.slice(PASTE_START.length);
          continue;
        }
        if (text.length === 1) {
          // A lone ESC at the end of a chunk is either the Escape key or the
          // start of a sequence the next chunk finishes. Held, and decided by
          // `flushPending` if nothing follows.
          this.carry = text;
          return keys;
        }
        const next = text[1]!;
        if (next === '[' || next === 'O') {
          const m = /^\u001b[[O]([0-?]*)([ -/]*)([@-~])/u.exec(text);
          if (m === null) {
            if (text.length < 16) {
              this.carry = text;
              return keys;
            }
            keys.push({ kind: 'unknown', raw: text.slice(0, 2) });
            text = text.slice(2);
            continue;
          }
          const [whole, params = '', , final = ''] = m;
          // Modifier parameters (`1;5C` is Ctrl+Right) are read as the plain key.
          const base = params.split(';')[0] ?? '';
          const named = CSI[final === '~' ? `${base}~` : final];
          keys.push(named ?? { kind: 'unknown', raw: whole });
          text = text.slice(whole.length);
          continue;
        }
        keys.push({ kind: 'alt', key: next });
        text = text.slice(2);
        continue;
      }

      const code = ch.charCodeAt(0);
      if (ch === '\r' || ch === '\n') {
        flush();
        keys.push({ kind: 'enter' });
        // `\r\n` from a terminal that sends both is one Enter.
        text = text.slice(ch === '\r' && text[1] === '\n' ? 2 : 1);
        continue;
      }
      if (ch === '\u007f' || ch === '\b') {
        flush();
        keys.push({ kind: 'backspace' });
        text = text.slice(1);
        continue;
      }
      if (ch === '\t') {
        flush();
        keys.push({ kind: 'tab' });
        text = text.slice(1);
        continue;
      }
      if (code < 0x20) {
        flush();
        keys.push({ kind: 'ctrl', key: code === 0 ? '@' : String.fromCharCode(code + 0x60) });
        text = text.slice(1);
        continue;
      }
      run += ch;
      text = text.slice(1);
    }
    flush();
    return keys;
  }

  /**
   * Nothing followed a held ESC: it was the Escape key. Called by the reader's
   * owner after a short quiet period, which is how every terminal program tells
   * the key from the start of a sequence.
   */
  flushPending(): Key[] {
    if (this.carry === '\u001b') {
      this.carry = '';
      return [{ kind: 'escape' }];
    }
    return [];
  }
}

/** How much of the end of `text` could be the start of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(marker.length - 1, text.length); n > 0; n -= 1) {
    if (marker.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}
