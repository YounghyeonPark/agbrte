/**
 * A session with two live agents — the shape that predates §4.2's cap.
 *
 * A session holds one agent now, and `SessionManager.addAgent` refuses a second
 * active seat by name. Two-seat sessions still exist: they are on disk, they
 * resume, they attribute their rows, their agents can still message each other
 * through the bus, and their turns still queue per agent rather than per
 * session. All of that is behaviour that has to keep working, so it has to keep
 * being tested — and the fixture cannot be `addAgent` twice any more.
 *
 * So this reaches the admission path *underneath* the cap, which is exactly
 * where those sessions came from: `admitSeat` is what `addAgent` calls once the
 * roster rule has been answered. Nothing here is a supported route to a second
 * seat — the cast is deliberate and ugly for that reason, in the same style as
 * the `deliver` reach in `messageBus.test.ts`. If this file ever becomes
 * convenient enough to use by accident, the guard it dodges has been put in the
 * wrong place.
 */

import type { SessionManager, NewAgentInput } from '@main/sessionManager.js';
import type { AgentRecord, SessionId } from '@shared/types/index.js';

interface Inner {
  sessions: Map<string, unknown>;
  admitSeat: (
    live: unknown,
    input: NewAgentInput,
    replacing: null,
    actor?: unknown,
  ) => Promise<AgentRecord>;
}

/** Seat an agent *beside* the one already there, the way a pre-cap build did. */
export function seatBeside(
  manager: SessionManager,
  sessionId: SessionId | string,
  input: NewAgentInput,
): Promise<AgentRecord> {
  const inner = manager as unknown as Inner;
  const live = inner.sessions.get(sessionId);
  if (live === undefined) throw new Error(`no live session ${sessionId} to seat beside`);
  return inner.admitSeat.call(manager, live, input, null);
}
