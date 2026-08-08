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
 * ## Coalesced per tree, not per session
 *
 * §11 is explicit and gives the reason: "A parent with twelve children must
 * produce `subtree_complete — 12 of 12 done`, not twelve notifications.
 * Per-session coalescing alone would make hierarchy unusable, since splitting is
 * exactly what multiplies completion events."
 *
 * So the unit is the **root**: one pending notification per tree, and a newer
 * trigger replaces an older one. A single session is a tree of one, which is why
 * this costs nothing before anybody splits anything.
 *
 * And **blocking beats finishing**. If any descendant needs a person, that
 * outranks a completion elsewhere in the tree — there is one slot, and the
 * actionable thing should have it. A tree that announced "3 of 5 done" while a
 * child sat waiting on a permission prompt would be using its one chance to say
 * the less useful of the two true things.
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

import type { Session } from '@shared/types/index.js';

/**
 * How much a trigger deserves the tree's one slot.
 *
 * Ordered by what a person can *do* about it, not by severity. A blocked
 * descendant is waiting on them; a failure wants a decision; a finish is news.
 * §11: "the actionable thing wins the one available slot".
 */
const RANK: Readonly<Record<string, number>> = {
  needs_permission: 5,
  needs_credentials: 5,
  split_proposed: 4,
  failed: 3,
  stalled: 2,
  quota_exhausted: 1,
};

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
  /**
   * The last thing announced per **root**, so a repeat says nothing.
   *
   * Keyed by root rather than by session: that is the whole of §11's tree rule.
   * Twelve children finishing is one event about one tree, not twelve events.
   */
  private readonly announced = new Map<string, string>();
  /** Every session seen, so a tree can be assessed from any push into it. */
  private readonly seen = new Map<string, Session>();

  constructor(private readonly deps: NotifierDeps) {}

  /**
   * Consider a session for a notification.
   *
   * Called on every `session` push, which is often — the filtering is the point,
   * not an optimisation. What is assessed is the *tree* the session belongs to,
   * because that is the unit a person cares about.
   */
  consider(session: Session): void {
    this.seen.set(session.sessionId, session);

    const rootId = session.tree.rootSessionId;
    const summary = this.assess(rootId);
    /**
     * Empty string for "nothing to say", never `undefined`.
     *
     * `undefined` already means "this tree has never been assessed", and
     * collapsing the two made the first push compare equal to itself and return
     * before recording — so the *second* push also looked like a first sight and
     * nothing was ever announced.
     */
    const key = summary?.key ?? '';
    const previous = this.announced.get(rootId);
    if (previous === key) return;

    // Recorded before deciding whether to show, so something seen while focused
    // does not fire later when focus is lost. You were told, by the screen.
    this.announced.set(rootId, key);

    // A first sight is not a transition. Attaching a host surfaces every session
    // it already had, and announcing those would greet you with a notification
    // per tree on every launch.
    if (previous === undefined) return;
    if (summary === null) return;
    if (this.deps.supported?.() === false) return;
    if (this.deps.focused()) return;

    const show = this.deps.show ?? defaultShow;
    show(summary.title, summary.body);
  }

  /**
   * The one thing worth saying about a tree right now, or `null`.
   *
   * Returns a `key` as well as the words: the key is what coalescing compares,
   * and it has to change exactly when the *situation* does. Comparing the
   * rendered text would work by accident and break the moment two different
   * situations happened to read the same.
   */
  private assess(rootId: string): { key: string; title: string; body: string } | null {
    const tree = [...this.seen.values()].filter((s) => s.tree.rootSessionId === rootId);
    if (tree.length === 0) return null;
    const root = tree.find((s) => s.sessionId === rootId) ?? tree[0]!;

    // Blocking beats finishing. One slot, and the actionable thing gets it.
    let blocked: Session | null = null;
    let best = 0;
    for (const session of tree) {
      const reason = session.needsAttention?.reason;
      if (reason === undefined) continue;
      const rank = RANK[reason] ?? 0;
      // `needs_input` is not in RANK and so scores 0: every turn ends there, and
      // a toast per turn is the exact noise this whole file exists to prevent.
      if (rank > best) {
        best = rank;
        blocked = session;
      }
    }

    if (blocked !== null) {
      const what = headline(blocked);
      if (what !== null) {
        const where = blocked.sessionId === rootId ? '' : ` (${blocked.title})`;
        return {
          key: `block:${blocked.sessionId}:${blocked.needsAttention?.reason ?? ''}`,
          title: root.title,
          body: `${root.title}${where} ${what}`,
        };
      }
    }

    const finished = tree.filter((s) => s.state === 'done' || s.state === 'failed');
    if (finished.length < tree.length) return null;

    // §11's `subtree_complete`: a root and all its descendants finished. The
    // count is the point — "12 of 12" is what makes one line stand in for twelve
    // notifications rather than hiding eleven of them.
    const failed = finished.filter((s) => s.state === 'failed').length;
    return {
      key: `complete:${tree.length}:${failed}`,
      title: root.title,
      body:
        tree.length === 1
          ? `${root.title} ${failed === 1 ? 'failed' : 'finished'}`
          : `${root.title} — ${tree.length} of ${tree.length} done` +
            (failed > 0 ? `, ${failed} failed` : ''),
    };
  }

  /** A session that is gone can be forgotten; its id will not come back. */
  forget(sessionId: string): void {
    this.seen.delete(sessionId);
    this.announced.delete(sessionId);
  }

  /** Drop sessions that are no longer listed, so the map cannot grow forever. */
  prune(sessions: Session[]): void {
    const live = new Set<string>(sessions.map((s) => s.sessionId));
    for (const id of [...this.seen.keys()]) if (!live.has(id)) this.seen.delete(id);
    for (const id of [...this.announced.keys()]) if (!live.has(id)) this.announced.delete(id);
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
