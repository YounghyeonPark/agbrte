/**
 * Which blobs a session has, derived from the events already held (§12).
 *
 * Split from the component because it is the part worth testing and the part a
 * test cannot reach through JSX: the main tsconfig compiles without `--jsx`, so
 * a `.test.ts` importing a `.tsx` is excluded from typechecking rather than
 * checked. A pure function in a `.ts` file is checked like everything else.
 */

import type { AgbrteEvent } from '../shared/types/index.js';

export interface Entry {
  sha256: string;
  mime?: string;
  /** Which part of the session produced it — the panel groups on this. */
  origin: 'attached' | 'produced';
  at: string;
}

/** Everything in the held window that has bytes behind it, newest last. */
export function artifactsIn(events: readonly AgbrteEvent[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const event of events) {
    // Every hash, not the first: a tool may hand back several, and showing one
    // of them would put the reader and the model in front of different evidence.
    const found: Entry[] =
      event.type === 'capture.attached'
        ? [{ sha256: event.sha256, mime: event.mime, origin: 'attached', at: event.at }]
        : event.type === 'agent.tool_result'
          ? (event.resultBlobs ?? []).map((sha256) => ({
              sha256,
              origin: 'produced' as const,
              at: event.at,
            }))
          : [];

    for (const entry of found) {
      // One row per blob: the same screenshot attached to three turns is one
      // picture, and a panel that repeats it buries the others.
      if (seen.has(entry.sha256)) continue;
      seen.add(entry.sha256);
      out.push(entry);
    }
  }
  return out;
}
