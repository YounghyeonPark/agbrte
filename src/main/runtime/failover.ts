/*
 * When a turn should be tried somewhere else (DESIGN.md §3.9, §4.1, §6.5).
 *
 * §3.9 states the opportunity and the caveat together:
 *
 *   > **Cross-provider fallback comes nearly free.** Because rehydration
 *   > reconstructs context from our own log rather than provider state, an agent
 *   > stopped by `refused`, `unavailable`, persistent `rate_limited`, or
 *   > `quota_exhausted` can be restarted on a different provider with its task
 *   > intact. One caveat stated plainly: **opaque provider-specific reasoning
 *   > blocks cannot cross a provider boundary** — they are dropped at the
 *   > handoff and the drop is recorded, so the transcript explains any
 *   > discontinuity.
 *
 * The list matters more than it looks. Every stop reason that is *not* here is
 * one where moving the turn is wrong, and most of them are wrong in a way that
 * looks like the fallback working:
 *
 *  - `misconfigured` is permanent (§4.1 — an unknown model id, a malformed
 *    request). Retrying it elsewhere spends a second endpoint's turn on the same
 *    doomed request, which is precisely the failure `misconfigured` was split out
 *    of `invalid_tool_args` to stop.
 *  - `limit_reached` is a ceiling *we* set. Nothing about the endpoint is wrong,
 *    and moving would spend a budget that is already gone — the user's decision
 *    to raise it or re-scope is the remedy, not another server.
 *  - `content_filtered` and `invalid_tool_args` are about this request. A second
 *    endpoint would filter or reject the same content, more slowly.
 *  - `end_turn`, `tool_calls`, `max_output_tokens` are not failures at all.
 *
 * `auth` is the one judgement call, and it is excluded. A missing credential is
 * a configuration fault whose remedy is a command somebody types (§3.9's own
 * note on it), and moving the turn to an endpoint that happens to have a key
 * would answer a credential problem by quietly sending the work — and the code
 * in it — to a different vendor. §13 forbids exactly that kind of unannounced
 * change of recipient.
 */

import type { StopReason } from '@shared/types/index.js';

/**
 * Whether this stop is worth trying at another endpoint.
 *
 * `rate_limited` is here on §3.9's word *persistent*, and this function cannot
 * see persistence — it is handed one stop, not a history. The caller supplies
 * that: a rate limit carrying a short `retryAfterMs` is a wait, not a move, and
 * §3.9's `awaiting_quota` machinery already handles the waiting. So this answers
 * "is this the kind of failure another endpoint could succeed at", and the
 * caller decides whether it is worth doing yet.
 */
export function couldMoveEndpoint(stop: StopReason): boolean {
  switch (stop.kind) {
    case 'refused':
    case 'unavailable':
    case 'rate_limited':
    case 'quota_exhausted':
      return true;
    default:
      return false;
  }
}

/**
 * Why the transcript says a turn moved, in words a person can act on.
 *
 * Written here rather than at the call site because the sentence is the *only*
 * explanation of a discontinuity a reader will otherwise find inexplicable: the
 * model changed mid-session, and §3.9's dropped reasoning blocks mean the new
 * one starts without the working-out the old one had. A row saying "moved to
 * `local`" and nothing else invites the question this answers.
 */
export function moveReason(stop: StopReason, from: string, to: string): string {
  const why =
    stop.kind === 'quota_exhausted'
      ? `${from} has no ${stop.scope} allowance left`
      : stop.kind === 'rate_limited'
        ? `${from} is rate limiting`
        : stop.kind === 'unavailable'
          ? `${from} did not answer`
          : `${from} refused the request`;
  return `${why} — continuing on ${to}`;
}
