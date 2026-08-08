/**
 * Telling you once when a session wants you (DESIGN.md §10, §15 Phase 4).
 *
 * > *Done when:* … you're notified exactly once per completed session.
 *
 * ## The whole problem is "once"
 *
 * A session emits a push on every state change and several per turn, and the
 * naive version fires on each — which for ten concurrent sessions is a stream of
 * toasts that teaches you to dismiss them without reading. What earns a
 * notification is a *transition into* a state that wants a person: finishing,
 * failing, or stopping to ask something. Staying in that state, or being pushed
 * again for an unrelated field, does not.
 *
 * So this remembers the last state it announced per session and says nothing
 * until that changes. A session that finishes, is reopened, runs again and
 * finishes again is two notifications, because it is two events. A session
 * pushed forty times while `awaiting_input` is one.
 *
 * ## Silent while you are looking
 *
 * If a window has focus, the same information is already on screen — the
 * dashboard shows exactly this, in the Needs-you rail, as it happens. An OS
 * notification for something you are looking at is pure interruption. So the
 * rule is: notify when the app does not have focus, and let the UI carry it
 * when it does.
 *
 * ## Desktop only, honestly
 *
 * The web client cannot do this. The Notification API requires a secure context
 * and the intended arrangement is `http://` to a tailnet address, so a browser
 * would refuse. Serving over TLS would fix it and is not built; pretending
 * otherwise by silently doing nothing there would be worse than saying so.
 */

import type { Session, SessionState } from '@shared/types/index.js';

/** What a state change is worth interrupting someone for. */
function headline(session: Session): string | null {
  if (session.state === 'done') return 'finished';
  if (session.state === 'failed') return 'failed';

  const reason = session.needsAttention?.reason;
  if (reason === undefined) return null;
  switch (reason) {
    case 'needs_permission':
      return 'is asking permission';
    case 'needs_credentials':
      return 'needs credentials';
    case 'quota_exhausted':
      // Parking resumes on its own, so this is information rather than a
      // summons — but it is the difference between "slow" and "waiting until
      // 4pm", which is worth knowing before you wait for it.
      return 'is out of quota';
    case 'split_proposed':
      return 'is proposing a split';
    case 'stalled':
      return 'has gone quiet';
    case 'needs_input':
      // Deliberately silent. Every turn ends here, so notifying would mean a
      // toast per turn — the exact noise this exists to avoid.
      return null;
    case 'failed':
      return 'failed';
  }
}

export interface NotifierDeps {
  /** Whether any window currently has focus. */
  focused: () => boolean;
  /** Injectable so a test does not need a desktop. */
  show?: (title: string, body: string) => void;
  /** Off where the platform cannot, so nothing pretends. */
  supported?: () => boolean;
}

export class Notifier {
  /** The last state announced per session, so a repeat says nothing. */
  private readonly announced = new Map<string, SessionState>();

  constructor(private readonly deps: NotifierDeps) {}

  /**
   * Consider a session for a notification.
   *
   * Called on every `session` push, which is often — the filtering is the point,
   * not an optimisation.
   */
  consider(session: Session): void {
    const previous = this.announced.get(session.sessionId);
    if (previous === session.state) return;

    // Recorded before deciding whether to show, so a state seen while focused
    // does not fire later when focus is lost. You were told, by the screen.
    this.announced.set(session.sessionId, session.state);

    // A first sight is not a transition. Attaching a host surfaces every session
    // it already had, and announcing those would greet you with a notification
    // per session on every launch.
    if (previous === undefined) return;

    const what = headline(session);
    if (what === null) return;
    if (this.deps.supported?.() === false) return;
    if (this.deps.focused()) return;

    const show = this.deps.show ?? defaultShow;
    show(session.title, `${session.title} ${what}`);
  }

  /** A session that is gone can be forgotten; its id will not come back. */
  forget(sessionId: string): void {
    this.announced.delete(sessionId);
  }

  /** Drop sessions that are no longer listed, so the map cannot grow forever. */
  prune(sessions: Session[]): void {
    const live = new Set<string>(sessions.map((s) => s.sessionId));
    for (const id of [...this.announced.keys()]) {
      if (!live.has(id)) this.announced.delete(id);
    }
  }
}

/**
 * The real notification, loaded only when one is actually shown.
 *
 * Deliberately not a top-level `import ... from 'electron'`. An ESM import is
 * evaluated when the module loads, not when it is used, so a top-level one makes
 * this file unloadable outside Electron — which is how `register.ts` came to
 * crash a headless server with `SyntaxError: Named export 'BrowserWindow' not
 * found` before a line ran. Everything above is plain logic and stays testable
 * under Node; only this last step needs a desktop.
 */
function defaultShow(title: string, body: string): void {
  void (async () => {
    try {
      const { Notification } = await import('electron');
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch {
      // No Electron here. Nothing to show, and nothing worth failing over.
    }
  })();
}
