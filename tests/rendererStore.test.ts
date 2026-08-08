/**
 * What the renderer does when a prompt is settled somewhere else (§15 Phase 5).
 *
 * The other half of the proving criterion. `tests/attribution.test.ts` shows the
 * announcement reaching a second *client*; this shows what a client does with it,
 * which is the part a user actually experiences: the question comes off the
 * screen, and it says who answered rather than vanishing without explanation.
 *
 * Tested against the store directly rather than through a browser. Driving it
 * end to end would need an agent that asks for permission, and the only way to
 * make one ask is a tool policy the UI has no field for — so a browser test
 * would have been testing a fixture, not the feature.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAgbrte } from '../src/renderer/store.js';
import type { PermissionRequest } from '@shared/types/index.js';

const request = (requestId: string): PermissionRequest =>
  ({ requestId, sessionId: 's1', agentId: 'a1', tool: 'shell', args: { cmd: 'ls' } }) as never;

const BOB = { id: 'uid:1001', via: 'peer-credential', label: 'bob@desk' } as const;

beforeEach(() => {
  useAgbrte.setState({ pending: [], notice: null });
});

describe('a prompt settled elsewhere', () => {
  it('comes off this screen', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermission(request('r2'));

    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'allow', scope: 'once' },
      actor: BOB,
    });

    // Only that one. Another open question is not collateral.
    expect(useAgbrte.getState().pending.map((p) => p.requestId)).toEqual(['r2']);
  });

  it('says who answered, because a prompt vanishing alone reads as a bug', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'deny', reason: 'no' },
      actor: BOB,
    });

    const notice = useAgbrte.getState().notice ?? '';
    expect(notice).toContain('bob@desk');
    // The verb matters: "denied" and "allowed" prompt different next actions.
    expect(notice).toContain('denied');
  });

  it('explains a withdrawal without naming anyone', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'withdrawn',
      reason: 'the agent that asked is no longer running',
    });

    const notice = useAgbrte.getState().notice ?? '';
    // Nobody decided, so nobody is named. Attributing it would invent a
    // decision that was never made.
    expect(notice).toContain('withdrawn');
    expect(notice).toContain('no longer running');
    expect(notice).not.toContain('Someone else');
  });

  it('says nothing about a prompt this client never saw', () => {
    const store = useAgbrte.getState();
    store.applyPermissionResolved({
      requestId: 'never-seen',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'allow', scope: 'once' },
      actor: BOB,
    });

    // A device that was not showing the question does not need to be told about
    // its ending — a notice for something you never saw reads as a fault.
    expect(useAgbrte.getState().notice).toBeNull();
  });
});
