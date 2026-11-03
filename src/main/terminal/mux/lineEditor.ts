/**
 * The line somebody types to the agent, in a raw terminal.
 *
 * readline would do this, and did, while the CLI only ever talked to the agent.
 * It cannot once the same terminal also carries a live shell: readline owns
 * stdin from the moment it is created and has no notion of handing the keys to
 * another program between lines. So the agent's line is edited here, as state
 * plus a function that draws it, and the terminal session decides which of the
 * two — this or the shell — a key goes to.
 *
 * The keys are the ones a shell's own line editor has taught everybody: arrows,
 * Home/End, Ctrl+A/E/U/K/W, history on Up/Down. Not more: a line editor that
 * disagreed with bash on what Ctrl+W deletes would be worse than one with less.
 *
 * Positions are in characters (code points), and the drawing is in columns, so
 * a line of Korean puts the cursor where the characters are (`width.ts`).
 */

import type { Key } from './keys.js';
import { displayWidth } from './width.js';

export interface LineState {
  /** The line, as code points, so a cursor never lands inside a surrogate pair. */
  chars: string[];
  cursor: number;
  history: string[];
  /** Where Up/Down are in `history`; `history.length` is the line being written. */
  recall: number;
  /** The line being written, kept while somebody walks through history. */
  draft: string[];
}

export type Outcome =
  | { kind: 'edit' }
  /** Enter: the line, and a fresh state with it in history. */
  | { kind: 'submit'; line: string }
  /** A key the line does not use, handed back to its owner (Ctrl+C, Ctrl+D, the mode key). */
  | { kind: 'pass'; key: Key };

export function emptyLine(history: string[] = []): LineState {
  return { chars: [], cursor: 0, history, recall: history.length, draft: [] };
}

export function lineText(state: LineState): string {
  return state.chars.join('');
}

/** Apply one key. Returns the next state and what happened. */
export function edit(state: LineState, key: Key): { state: LineState; outcome: Outcome } {
  const s: LineState = { ...state, chars: [...state.chars] };
  const insert = (text: string): void => {
    const add = [...text];
    s.chars.splice(s.cursor, 0, ...add);
    s.cursor += add.length;
  };
  const edited = { state: s, outcome: { kind: 'edit' } as Outcome };

  switch (key.kind) {
    case 'text':
      insert(key.text);
      return edited;
    case 'paste':
      // Newlines kept: a pasted traceback is one message, and Enter sends it.
      insert(key.text);
      return edited;
    case 'enter': {
      const line = lineText(s);
      const history = line.trim() === '' || s.history[s.history.length - 1] === line ? s.history : [...s.history, line];
      return { state: emptyLine(history), outcome: { kind: 'submit', line } };
    }
    case 'backspace':
      if (s.cursor > 0) {
        s.chars.splice(s.cursor - 1, 1);
        s.cursor -= 1;
      }
      return edited;
    case 'delete':
      if (s.cursor < s.chars.length) s.chars.splice(s.cursor, 1);
      return edited;
    case 'left':
      s.cursor = Math.max(0, s.cursor - 1);
      return edited;
    case 'right':
      s.cursor = Math.min(s.chars.length, s.cursor + 1);
      return edited;
    case 'home':
      s.cursor = 0;
      return edited;
    case 'end':
      s.cursor = s.chars.length;
      return edited;
    case 'up':
    case 'down': {
      const next = key.kind === 'up' ? s.recall - 1 : s.recall + 1;
      if (next < 0 || next > s.history.length) return edited;
      if (s.recall === s.history.length) s.draft = s.chars;
      s.recall = next;
      s.chars = next === s.history.length ? [...s.draft] : [...(s.history[next] ?? '')];
      s.cursor = s.chars.length;
      return edited;
    }
    case 'ctrl':
      switch (key.key) {
        case 'a':
          s.cursor = 0;
          return edited;
        case 'e':
          s.cursor = s.chars.length;
          return edited;
        case 'b':
          s.cursor = Math.max(0, s.cursor - 1);
          return edited;
        case 'f':
          s.cursor = Math.min(s.chars.length, s.cursor + 1);
          return edited;
        case 'u':
          s.chars.splice(0, s.cursor);
          s.cursor = 0;
          return edited;
        case 'k':
          s.chars.splice(s.cursor);
          return edited;
        case 'w': {
          // bash's unix-word-rubout: back over spaces, then over the word.
          let at = s.cursor;
          while (at > 0 && s.chars[at - 1] === ' ') at -= 1;
          while (at > 0 && s.chars[at - 1] !== ' ') at -= 1;
          s.chars.splice(at, s.cursor - at);
          s.cursor = at;
          return edited;
        }
        case 'd':
          // Delete under the cursor, as in a shell — and on an empty line it is
          // the owner's (leave), which is also as in a shell.
          if (s.chars.length === 0) return { state, outcome: { kind: 'pass', key } };
          if (s.cursor < s.chars.length) s.chars.splice(s.cursor, 1);
          return edited;
        default:
          return { state, outcome: { kind: 'pass', key } };
      }
    default:
      return { state, outcome: { kind: 'pass', key } };
  }
}

/**
 * Draw the line, replacing what the last draw left.
 *
 * `previousRows` is how many rows the last draw took and `previousCursorRow`
 * which of them the cursor was left on; the line can wrap, and a redraw that
 * only cleared the row the cursor was on left the start of a long line behind
 * on the row above. Returns the bytes to write and the new pair.
 */
export function draw(
  state: LineState,
  prompt: string,
  columns: number,
  previous: { rows: number; cursorRow: number },
): { bytes: string; rows: number; cursorRow: number } {
  const cols = Math.max(1, columns);
  const promptWidth = displayWidth(prompt);
  // Newlines from a paste are shown as a visible mark, so one line stays one line.
  const shown = state.chars.map((ch) => (ch === '\n' ? '⏎' : ch));
  const text = shown.join('');
  const total = promptWidth + displayWidth(text);
  const rows = Math.floor(Math.max(0, total - 1) / cols) + 1;
  const before = promptWidth + displayWidth(shown.slice(0, state.cursor).join(''));
  let cursorRow = Math.floor(before / cols);
  let cursorCol = before % cols;
  // A cursor exactly at the end of a full row sits at the start of the next.
  if (before === total && before > 0 && before % cols === 0) {
    cursorRow = before / cols;
    cursorCol = 0;
  }

  let bytes = '';
  if (previous.cursorRow > 0) bytes += `\u001b[${previous.cursorRow}A`;
  bytes += '\r\u001b[J';
  bytes += prompt + text;
  // The terminal leaves a cursor at the very end of a full row on that row, in
  // a pending-wrap state; a space and a carriage return make it real.
  if (total > 0 && total % cols === 0) bytes += ' \r';
  const endRow = total > 0 && total % cols === 0 ? total / cols : rows - 1;
  if (endRow > cursorRow) bytes += `\u001b[${endRow - cursorRow}A`;
  bytes += '\r';
  if (cursorCol > 0) bytes += `\u001b[${cursorCol}C`;
  return { bytes, rows: Math.max(rows, endRow + 1), cursorRow };
}
