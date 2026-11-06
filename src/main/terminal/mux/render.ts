/**
 * Session events as terminal lines: the live terminal's (`session.ts`) and the
 * replay of a session's past above a fresh shell (`earlier.ts`), which draw
 * the same event the same way. Its own module so the two can share it without
 * importing each other.
 */

import type { AgbrteEvent } from '@shared/types/index.js';
import { renderMarkdown, type Style } from './markdown.js';

/** Shorten a tool's arguments for one line. */
export function previewArgs(value: unknown, max = 100): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * An event as terminal lines, or none for what a person reading along does not
 * need. State changes are left out on purpose: a terminal that printed
 * "planning → working" on every turn would be a log, not a conversation; the
 * prompt's own `›` and `…` say whether the agent is busy.
 */
export function renderEvent(e: AgbrteEvent, s: Style, columns: number): string[] {
  switch (e.type) {
    case 'agent.text':
      return renderMarkdown(e.text, s, columns);
    case 'user.turn':
      // Our own turn is already on screen as typed. Another client's is not.
      if (e.actor === undefined) return [];
      return [s.dim(`‹ ${e.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')} · ${e.actor.label ?? 'elsewhere'}`)];
    case 'agent.tool_use':
      return [`${s.accent('⚒')} ${e.tool} ${s.dim(previewArgs(e.args))}`];
    case 'agent.tool_result':
      return [`${e.ok ? '✓' : '✗'} ${s.dim(previewArgs(e.summary))}`];
    case 'permission.decided':
      return e.via === 'policy' ? [] : [s.dim(`  ${e.decision.result} ${e.tool}`)];
    case 'agent.stopped':
      // The ordinary end of a turn is the prompt coming back; anything else is news.
      return e.stop.kind === 'end_turn' ? [] : [s.dim(`— ${e.stop.kind}`)];
    default:
      return [];
  }
}
