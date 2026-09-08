/**
 * How far a workflow run has got, from what a client already holds (§4.4, §4.3).
 *
 * ## Why this needs nothing new on the wire
 *
 * A run spawns one child per node and names each child after the **node id** —
 * `spawnFor` does that deliberately, because the title is "the run's only
 * durable link back to the document". `Session.children` already crosses the
 * wire with a title and a `lastKnown` state per child (§4.3), so a client
 * holding an open run holds the graph's state too. It was there all along; the
 * only thing missing was the reading.
 *
 * The host has its own copy of this rule in `nodeStates`, and the two agree by
 * following the same order rather than by sharing code: the host reaches into
 * its manager for a loaded child, and a client reaches into the session list.
 * Neither can do the other's lookup, and the *rule* — prefer the live state,
 * fall back to the cache — is what has to match.
 *
 * ## The cache is second, and that is the whole of the correctness
 *
 * §4.3 calls `lastKnown` "a cache for rendering a tree whose children may be
 * unreachable, never authoritative". After a host restart the parent comes back
 * with the cache as it was at spawn, so every finished node reads as still
 * running — a picture of a run that has quietly ended, drawn as one still
 * going. So a child that is in hand answers for itself, and the cache answers
 * only for one that is not.
 */

import type { NodeState } from './schedule.js';
import type { Session, SessionState } from '../types/session.js';

/** One session's state, as a node's. Cancelled counts as failed, as on the host. */
function asNode(state: SessionState): NodeState {
  if (state === 'done') return 'done';
  if (state === 'failed' || state === 'cancelled') return 'failed';
  return 'running';
}

/**
 * What each node of this run is doing, by node id.
 *
 * A node with no child yet is simply absent — it has not been spawned, which
 * `unstarted` already means to everything that reads this. Saying it here would
 * require knowing the document, and this deliberately does not: a run whose
 * document has been edited since it started should still draw the children it
 * actually has.
 */
export function runProgress(
  run: Session,
  /** Everything the client knows about, for the live half of the rule above. */
  sessions: readonly Session[],
): Record<string, NodeState> {
  const states: Record<string, NodeState> = {};
  for (const child of run.children) {
    const live = sessions.find((s) => s.sessionId === child.sessionId);
    states[child.title] = asNode(live?.state ?? child.lastKnown.state);
  }
  return states;
}
