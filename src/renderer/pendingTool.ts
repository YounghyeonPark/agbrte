/**
 * Which tool call is still out (DESIGN.md §14).
 *
 * The transcript sweeps a moving highlight across the tool row it is waiting
 * on. That is the one mark saying the app is *busy* rather than stuck — a
 * `working` session carries no colour on purpose (see `stateTone`), so during a
 * thirty-second shell command the row was static text and read as frozen.
 *
 * ## Why this is not in `Transcript.tsx` beside its only caller
 *
 * Because it is the part worth testing, and a `.tsx` cannot be. The test
 * project compiles as Node with no `--jsx`, so importing the component file
 * fails outright — which is why every renderer unit test in `tests/` reaches
 * for a `.ts` module and none of them for a component. Keeping the judgement
 * here and the markup there is what makes it reachable, and both failures it
 * can have are invisible in a screenshot: a sweep left running on finished work
 * stops meaning anything, and one that never starts leaves the app looking dead
 * at its busiest.
 */

import type { AgbrteEvent } from '../shared/types/index.js';

/**
 * The `seq` of the tool call awaiting a result, or `null` when none is.
 *
 * Read backwards from the tail and stop at whichever settles it first: a
 * `tool_result` means nothing is outstanding, a `tool_use` reached before any
 * result means that one is still running. The log already holds this; nothing
 * was reading it.
 *
 * Everything else is stepped over deliberately. A model can talk, reason and
 * change state between issuing a call and its result arriving, so stopping at
 * the first event that is not about tools would end the sweep the moment the
 * agent said anything — which is most of a long turn.
 *
 * Callers compute this **once per render**, not once per row: `renderRow` runs
 * for every event in the transcript, and a backwards walk inside it would be
 * quadratic on a long session to answer a question with one answer.
 */
export function pendingToolSeq(events: AgbrteEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) continue;
    if (event.type === 'agent.tool_result') return null;
    if (event.type === 'agent.tool_use') return event.seq;
  }
  return null;
}
