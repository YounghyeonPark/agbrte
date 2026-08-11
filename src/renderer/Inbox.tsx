/**
 * What happened while you were not looking (DESIGN.md §11).
 *
 * > the **in-app inbox is the durable record** regardless.
 *
 * The notifier is lossy by design — silent while a window has focus, absent in a
 * browser, and unable to say anything at all while the app is closed and a
 * detached host works through the night. This is where those land anyway.
 *
 * **Unread is the whole affordance.** A chronological list of everything that
 * ever happened answers a question nobody asked; "what changed since I last
 * looked" is the one people actually have, and it is the only reason the read
 * marker exists.
 */

import { useState, type JSX } from 'react';
import type { InboxEntry, InboxTrigger } from '../shared/types/index.js';

/** Plain words, because a badge colour is not a sentence. */
const SAYS: Readonly<Record<InboxTrigger, string>> = {
  result_produced: 'finished',
  failed: 'failed',
  awaiting_permission: 'asked permission',
  credentials_needed: 'needs credentials',
  quota_exhausted: 'ran out of quota',
  quota_restored: 'picked its work back up',
};

/** Only the ones a person can do something about get a colour. */
const TONE: Readonly<Record<InboxTrigger, string>> = {
  result_produced: 'text-state-done',
  failed: 'text-state-fail',
  awaiting_permission: 'text-accent',
  credentials_needed: 'text-accent',
  quota_exhausted: 'text-muted',
  quota_restored: 'text-muted',
};

export function Inbox({
  entries,
  onMarkRead,
  onOpen,
}: {
  entries: InboxEntry[];
  onMarkRead: () => void;
  onOpen?: (entry: InboxEntry) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const unread = entries.filter((e) => e.unread).length;

  /**
   * Marked read on *closing*, not on opening.
   *
   * Clearing on open means the list loses its own highlighting the instant you
   * look at it, so a glance costs you the answer to the question you opened it
   * to ask. Reading is finished when you close it.
   */
  const close = (): void => {
    setOpen(false);
    if (unread > 0) onMarkRead();
  };

  return (
    <div className="relative" data-testid="inbox">
      <button
        type="button"
        className="field text-muted flex items-center gap-2 text-xs"
        data-testid="inbox-toggle"
        data-unread={unread}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label={unread > 0 ? `Inbox, ${unread} unread` : 'Inbox'}
      >
        Inbox
        {unread > 0 && (
          <span className="bg-accent rounded-full px-2 text-[11px] text-black" data-testid="inbox-badge">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div
          className="bg-panel absolute right-0 z-10 mt-1 max-h-96 w-96 overflow-y-auto rounded border border-white/10 shadow-lg"
          data-testid="inbox-list"
        >
          {entries.length === 0 ? (
            <p className="text-muted p-3 text-xs">
              Nothing yet. Finished runs, refused tools, and quota windows reopening show up here —
              including the ones that happened while this was closed.
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <li
                  key={`${entry.sessionId}-${entry.at}-${entry.trigger}`}
                  className="border-b border-white/5 last:border-0"
                  data-testid="inbox-entry"
                  data-trigger={entry.trigger}
                  data-unread={entry.unread}
                >
                  <button
                    type="button"
                    className="grid w-full gap-1 px-3 py-2 text-left hover:bg-white/5"
                    onClick={() => onOpen?.(entry)}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`text-xs ${entry.unread ? '' : 'text-muted'}`}>
                        {entry.sessionTitle}
                      </span>
                      <small className="text-muted shrink-0 text-[11px]">
                        {new Date(entry.at).toLocaleString()}
                      </small>
                    </span>
                    <small className={`text-[11px] ${TONE[entry.trigger]}`}>
                      {SAYS[entry.trigger]}
                      {entry.detail !== undefined ? ` — ${entry.detail}` : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
