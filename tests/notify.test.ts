/**
 * Being told once (DESIGN.md §10, §15 Phase 4).
 *
 * > *Done when:* … you're notified exactly once per completed session.
 *
 * The whole problem is "once". Sessions push on every state change and several
 * times per turn, and a notifier that fires on each is, at ten concurrent
 * sessions, a stream of toasts that teaches you to dismiss them unread. So what
 * is tested here is mostly **silence**: the cases that must not interrupt.
 */

import { describe, expect, it } from 'vitest';
import { Notifier } from '@main/notify.js';
import type { Session, SessionState } from '@shared/types/index.js';

function session(state: SessionState, extra: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    instanceId: 'i1',
    target: { kind: 'local' },
    title: 'the task',
    goal: 'g',
    state,
    agents: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    checklist: [],
    artifacts: [],
    needsAttention: null,
    tree: { rootSessionId: 's1', depth: 0, ancestry: [] },
    children: [],
    peerSessionIds: [],
    ...extra,
  } as Session;
}

function rig(focused = false) {
  const shown: string[] = [];
  const notifier = new Notifier({ focused: () => focused, show: (_t, body) => shown.push(body) });
  return { notifier, shown, focus: (on: boolean) => (focused = on) };
}

describe('what earns an interruption', () => {
  it('announces a session that finished', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    expect(r.shown).toEqual(['the task finished']);
  });

  it('announces one that is asking permission', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(
      session('awaiting_permission', {
        needsAttention: { reason: 'needs_permission', since: '2026-01-01T00:00:00Z' },
      }),
    );
    expect(r.shown).toEqual(['the task is asking permission']);
  });

  it('says nothing when a turn merely ends', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(
      session('awaiting_input', {
        needsAttention: { reason: 'needs_input', since: '2026-01-01T00:00:00Z' },
      }),
    );
    // Every turn ends here. Announcing it would mean a toast per turn, which is
    // the exact noise the whole design is avoiding.
    expect(r.shown).toEqual([]);
  });
});

describe('saying it once', () => {
  it('does not repeat while the state holds', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    for (let i = 0; i < 20; i += 1) r.notifier.consider(session('done'));
    // Twenty more pushes for the same session in the same state — usage
    // updating, an agent record changing — are not twenty events.
    expect(r.shown).toHaveLength(1);
  });

  it('announces again when it genuinely happens again', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    // Reopened, run again, finished again: two events, two notifications.
    expect(r.shown).toHaveLength(2);
  });

  it('says nothing about a session it is seeing for the first time', () => {
    const r = rig();
    r.notifier.consider(session('done'));
    // Attaching a host surfaces everything it already had. Announcing those
    // would greet you with a notification per session on every launch.
    expect(r.shown).toEqual([]);
  });
});

describe('while you are looking', () => {
  it('stays quiet, because the screen already says it', () => {
    const r = rig(true);
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    expect(r.shown).toEqual([]);
  });

  it('does not fire later for something seen while focused', () => {
    const r = rig(true);
    r.notifier.consider(session('working'));
    r.notifier.consider(session('done'));
    r.focus(false);
    r.notifier.consider(session('done'));
    // You were told, by the dashboard. A toast when you look away would be a
    // notification about something you already saw.
    expect(r.shown).toEqual([]);
  });
});

describe('a tree, not twelve sessions', () => {
  /** A child of `root`, so the notifier sees one tree rather than several. */
  function child(id: string, state: SessionState, extra: Partial<Session> = {}): Session {
    return session(state, {
      sessionId: id as never,
      title: id,
      tree: { rootSessionId: 's1' as never, parentSessionId: 's1' as never, depth: 1, ancestry: ['s1' as never] },
      ...extra,
    });
  }

  it('says one thing about twelve children finishing', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    for (let i = 0; i < 12; i += 1) r.notifier.consider(child(`c${i}`, 'working'));

    // Everything completes.
    r.notifier.consider(session('done'));
    for (let i = 0; i < 12; i += 1) r.notifier.consider(child(`c${i}`, 'done'));

    // §11: "A parent with twelve children must produce `subtree_complete — 12 of
    // 12 done`, not twelve notifications. Per-session coalescing alone would make
    // hierarchy unusable, since splitting is exactly what multiplies completion
    // events."
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]).toContain('13 of 13 done');
  });

  it('says nothing while any of the tree is still working', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(child('c1', 'working'));
    r.notifier.consider(session('done'));

    // A root that finished ahead of its child has not finished the work.
    expect(r.shown).toEqual([]);
  });

  it('lets a blocked descendant outrank a completion', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(child('c1', 'working'));
    r.notifier.consider(session('done'));
    r.notifier.consider(
      child('c1', 'awaiting_permission', {
        needsAttention: { reason: 'needs_permission', since: '2026-01-01T00:00:00Z' },
      }),
    );

    // §11: the actionable thing wins the one available slot. A tree announcing
    // progress while a child waits on a prompt would spend its one chance on the
    // less useful of two true things.
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]).toContain('is asking permission');
    // Named, because the root is not where the answer has to be given.
    expect(r.shown[0]).toContain('c1');
  });

  it('still says nothing about a child merely waiting for input', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(child('c1', 'working'));
    r.notifier.consider(
      child('c1', 'awaiting_input', {
        needsAttention: { reason: 'needs_input', since: '2026-01-01T00:00:00Z' },
      }),
    );
    // Every turn ends there. A toast per turn per child is the noise this whole
    // file exists to prevent, multiplied by the size of the tree.
    expect(r.shown).toEqual([]);
  });

  it('counts a failure without hiding it in the total', () => {
    const r = rig();
    r.notifier.consider(session('working'));
    r.notifier.consider(child('c1', 'working'));
    r.notifier.consider(session('done'));
    r.notifier.consider(child('c1', 'failed'));

    // "2 of 2 done" alone would report a tree that half failed as a clean finish.
    expect(r.shown[0]).toContain('1 failed');
  });
});

describe('where the platform cannot', () => {
  it('does nothing rather than pretending', () => {
    const shown: string[] = [];
    const notifier = new Notifier({
      focused: () => false,
      supported: () => false,
      show: (_t, b) => shown.push(b),
    });
    notifier.consider(session('working'));
    notifier.consider(session('done'));
    expect(shown).toEqual([]);
  });
});
