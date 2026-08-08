/**
 * The durable record of things you were meant to be told (DESIGN.md §11).
 *
 * > the **in-app inbox is the durable record** regardless.
 *
 * ## Why this exists at all, given there are notifications
 *
 * The notifier is lossy on purpose, in three different ways, and each one is a
 * case where something happened and nobody ever found out:
 *
 *  - it stays silent while a window has focus, because the dashboard is already
 *    showing it — but you look away, and the dashboard moves on;
 *  - the web client cannot notify at all: `Notification` needs a secure context
 *    and the intended arrangement is `http://` to a tailnet address;
 *  - a detached host keeps working with the app closed, so a run that finished
 *    at 3 a.m. had no one to tell.
 *
 * An inbox that only recorded what was *delivered* would inherit all three
 * holes. So it records what *happened*.
 *
 * ## Derived from the log, never written alongside it
 *
 * §5 makes the event log the source of truth, and an inbox kept as its own
 * store is a second one that can disagree with it — a notification for a session
 * whose transcript says otherwise, or a run that finished with nothing in the
 * list. Every entry here is folded out of events that were already being
 * written, which is also why the inbox survives a crash, a relocation, and the
 * app never having been open when the thing happened.
 *
 * The one piece that is *not* derivable is how far you have read, because that
 * is a fact about a person rather than about the work. It is a single timestamp
 * per workspace (`readAt`), deliberately not per entry: entries are chronological
 * and a per-entry set is a second thing to keep consistent for no gain.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AgbrteEvent,
  InboxEntry,
  InboxTrigger,
  Session,
  SessionState,
} from '@shared/types/index.js';

/**
 * What a state transition is worth recording, or `null` for the ordinary ones.
 *
 * `awaiting_input` is deliberately absent, for the reason `needs_input` is
 * silent in the notifier: every turn ends there, so recording it would bury
 * every real event under a per-turn log of nothing having happened.
 */
function triggerFor(to: SessionState): InboxTrigger | null {
  switch (to) {
    case 'done':
      return 'result_produced';
    case 'failed':
      return 'failed';
    case 'awaiting_permission':
      return 'awaiting_permission';
    case 'awaiting_credentials':
      return 'credentials_needed';
    case 'awaiting_quota':
      return 'quota_exhausted';
    default:
      return null;
  }
}

/**
 * Fold one session's events into inbox entries.
 *
 * Exported because this is the whole substance of the feature and it should be
 * testable without a filesystem or a manager.
 */
export function entriesFrom(
  session: Pick<Session, 'sessionId' | 'title' | 'instanceId'>,
  events: readonly AgbrteEvent[],
  readAt: number,
): InboxEntry[] {
  const out: InboxEntry[] = [];

  for (const event of events) {
    const body = event as unknown as { type: string; to?: SessionState; reason?: string };

    let trigger: InboxTrigger | null = null;
    if (body.type === 'session.state' && body.to !== undefined) {
      trigger = triggerFor(body.to);
    } else if (body.type === 'session.unparked') {
      // §11 singles this out: "parked work resuming hours later is exactly the
      // event you'd otherwise miss entirely." Nothing prompts you at 4 a.m.
      trigger = 'quota_restored';
    }
    if (trigger === null) continue;

    out.push({
      sessionId: session.sessionId,
      sessionTitle: session.title,
      instanceId: session.instanceId,
      at: event.at,
      trigger,
      ...(body.reason !== undefined ? { detail: body.reason } : {}),
      unread: Date.parse(event.at) > readAt,
    });
  }

  return out;
}

/** Newest first, and capped — an inbox is a list you read, not an archive. */
export function merge(parts: readonly InboxEntry[][], limit = 100): InboxEntry[] {
  return parts
    .flat()
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/**
 * How far this workspace has been read.
 *
 * Per workspace rather than per client, so two devices attached to one host
 * agree about what you have already seen — the same reason the host owns session
 * state at all (§8). Stored beside the log rather than in it: it is a fact about
 * a reader, and putting it in the transcript would make "I looked at this" part
 * of the session's history.
 */
export class ReadMarker {
  constructor(private readonly path: string) {}

  static in(devagentsDir: string): ReadMarker {
    return new ReadMarker(join(devagentsDir, 'inbox.json'));
  }

  async read(): Promise<number> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as { readAt?: string };
      const at = parsed.readAt === undefined ? NaN : Date.parse(parsed.readAt);
      return Number.isFinite(at) ? at : 0;
    } catch {
      // Never read, or unreadable. Zero means everything is unread, which is the
      // safe direction: showing you something twice is a nuisance, and hiding it
      // is the failure the inbox exists to prevent.
      return 0;
    }
  }

  async mark(at: Date): Promise<void> {
    await writeFile(this.path, `${JSON.stringify({ readAt: at.toISOString() }, null, 2)}\n`, 'utf8');
  }
}
