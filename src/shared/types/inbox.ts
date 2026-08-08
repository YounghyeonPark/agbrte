/**
 * What the inbox carries (DESIGN.md §11).
 *
 * The shape lives here rather than beside the fold that produces it, because it
 * crosses the IPC boundary: the renderer and the web bridge both name it, and a
 * type reachable only from main would make `shared` import from it — the wrong
 * direction, and the one that turns a boundary into a suggestion.
 */

import type { SessionId } from './ids.js';

/**
 * Why an entry is worth a person's attention.
 *
 * A subset of §11's `NotifyTrigger` — the ones this phase can actually derive.
 * Naming a trigger the fold cannot produce would put a row in the type that
 * never appears, which reads as a gap in the data rather than in the code.
 */
export type InboxTrigger =
  | 'result_produced'
  | 'failed'
  | 'awaiting_permission'
  | 'credentials_needed'
  | 'quota_exhausted'
  | 'quota_restored';

export interface InboxEntry {
  sessionId: SessionId;
  sessionTitle: string;
  instanceId: string;
  at: string;
  trigger: InboxTrigger;
  /** The reason recorded on the transition, where there was one. */
  detail?: string;
  /** Whether this happened after the last time the inbox was read. */
  unread: boolean;
}
