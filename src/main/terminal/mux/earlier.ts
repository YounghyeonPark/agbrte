/**
 * What happened in a session before this terminal was opened on it, as lines
 * drawn above the new shell's first prompt (DESIGN.md §17 Q24, Q23).
 *
 * A tab is a session, and a session outlives the shell in it: the app restarts,
 * the tab comes back, and the shell inside is a new process with an empty
 * screen. The tab looked like a terminal nobody had used, over a session with
 * an hour of commands and answers in its log — and the agent, which *had* been
 * shown those commands, would refer to output the person could no longer see.
 * So a terminal opened on a session that has a past draws the end of it first,
 * from the log, dimmed and fenced off, the way a shell prints the last login.
 *
 * ## From the log, and only the parts a person typed or read
 *
 * The screen itself is not kept anywhere — the host never stored the bytes a
 * pane drew, and a pseudoconsole's screen is not something to replay into
 * another one. What the log holds is the conversation: `shell.block` for each
 * command the person ran (already masked when it was written, §17 Q23), the
 * person's messages, and what the agent said and did. Those are drawn as the
 * live terminal draws them (`renderEvent`), with the person's own messages
 * shown as typed — `? …` — rather than as a message from elsewhere, because in
 * a replay every turn carries an actor and none of them is "elsewhere".
 *
 * ## Bounded
 *
 * The end of it, not all of it: a session that ran for a week would otherwise
 * scroll the first prompt off the screen for a minute. A command's output is
 * cut to its last few lines, and the whole to its last `maxLines`; what was
 * left out is in the session's record, and the first line says so.
 */

import type { AgbrteEvent } from '@shared/types/index.js';
import type { Style } from './markdown.js';
import { renderEvent } from './render.js';

/** The most lines drawn, header and footer included. */
export const EARLIER_MAX_LINES = 80;
/** The most lines of one command's output. Its end, which is where a failure says why. */
export const EARLIER_OUTPUT_LINES = 6;

/**
 * The control characters a log line must not carry onto the screen. `shell.block`
 * output is stored as plain text, but "stored as plain text" is a property of
 * the writer, and a cursor move replayed into a fresh shell's screen would draw
 * over the prompt the replay exists to sit above.
 */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/gu;

function plain(text: string): string {
  return text.replace(CONTROL, '');
}

/** One event as the lines it draws in a replay. */
function linesOf(e: AgbrteEvent, s: Style, columns: number): string[] {
  switch (e.type) {
    case 'shell.block': {
      const out = plain(e.output).replace(/\s+$/u, '').split(/\r?\n/u);
      const shown = out.length > EARLIER_OUTPUT_LINES ? out.slice(-EARLIER_OUTPUT_LINES) : out;
      return [
        s.dim(`$ ${plain(e.command)}`),
        ...(out.length > shown.length ? [s.dim(`  … ${out.length - shown.length} lines above`)] : []),
        ...(shown.length === 1 && shown[0] === '' ? [] : shown.map((l) => s.dim(l))),
      ];
    }
    case 'user.turn': {
      const text = plain(e.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ').trim());
      return text === '' ? [] : [`${s.accent('?')} ${text}`];
    }
    case 'agent.text':
    case 'agent.tool_use':
    case 'agent.tool_result':
    case 'permission.decided':
    case 'agent.stopped':
      return renderEvent(e, s, columns).map(plainLine);
    default:
      return [];
  }
}

/**
 * Keep the style's own escapes and nothing else. `renderEvent` draws markdown
 * through `Style`, whose sequences are SGR only; anything else in a line came
 * from the text, and is dropped for the reason `CONTROL` is.
 */
function plainLine(line: string): string {
  return line.replace(/\u001b(?!\[[\d;]*m)/gu, '').replace(/[\u0000-\u0008\u000b-\u001a\u001c-\u001f\u007f]/gu, '');
}

/**
 * The lines to draw above a fresh shell's first prompt for `events`, or none
 * when nothing in them is worth drawing — a new session's log holds only its
 * creation, and a header over nothing is noise on every new tab.
 */
export function earlierLines(
  events: readonly AgbrteEvent[],
  s: Style,
  columns: number,
  o: { palette: boolean; maxLines?: number },
): string[] {
  const body: string[] = [];
  for (const e of events) body.push(...linesOf(e, s, columns));
  if (body.length === 0) return [];
  const room = Math.max(1, (o.maxLines ?? EARLIER_MAX_LINES) - 2);
  const cut = body.length > room;
  const kept = cut ? body.slice(-room) : body;
  // Where the rest is, named as it can be reached from here: the app's palette
  // opens the record, and a terminal outside the app has no such key.
  const rest = o.palette ? 'the rest is in its record, Ctrl+Shift+P' : 'the rest is in the app';
  return [
    s.dim(cut ? `── earlier in this session (its end; ${rest}) ──` : '── earlier in this session ──'),
    ...kept,
    s.dim('── a new shell ──'),
  ];
}
