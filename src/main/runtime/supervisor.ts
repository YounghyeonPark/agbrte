/**
 * Agent event pump (DESIGN.md §3.9, §4.1, §8, §10).
 *
 * Drains an `AgentHandle`'s event stream into the durable log and translates
 * the terminating `StopReason` into a session state.
 *
 * The one rule that matters most here: **a pause is not a failure.** A spent
 * quota window, a dead egress tunnel, and an unapproved tool all mean *hold all
 * state and resume* (§4.1). Mapping any of them to `failed` throws away hours
 * of work, which is why the mapping lives in one tested table rather than being
 * re-derived at each call site.
 */

import {
  stopDisposition,
  type AgentHandle,
  type AgentId,
  type EventOrigin,
  type ProgressSignal,
  type RuntimeEvent,
  type Sha256,
  type SessionState,
  type StopReason,
} from '@shared/types/index.js';
import type { SessionStore } from '../store/sessionStore.js';
import { addCost, type Cost } from '@shared/cost.js';
import type { AgentUsage } from '@shared/types/index.js';

export interface PumpOptions {
  origin: EventOrigin;
  agentId?: AgentId;
  /** Heartbeats are progress signals, not durable history — they stay in memory. */
  onProgress?: (p: ProgressSignal) => void;
  /** Called for each durable event written, for live UI forwarding. */
  onEvent?: (e: RuntimeEvent) => void;
}

export interface PumpOutcome {
  stop: StopReason;
  disposition: ReturnType<typeof stopDisposition>;
  /** The state the session should move to. Never `failed` for a pause. */
  nextState: SessionState;
  eventsWritten: number;
  resumeToken: string | null;
  usage: AgentUsage;
}

/**
 * Where a terminated turn leaves the session.
 *
 * `end_turn` becomes `awaiting_input` rather than `done`: the agent finished
 * *its* turn, not the session's goal. Only an explicit completion — a checklist
 * fully done, or the user closing it out — makes a session `done`.
 */
export function stateForStop(stop: StopReason): SessionState {
  switch (stop.kind) {
    case 'end_turn':
      return 'awaiting_input';
    case 'tool_calls':
      return 'working';
    case 'quota_exhausted':
      return 'awaiting_quota';
    case 'auth':
      return 'awaiting_credentials';
    case 'limit_reached':
      // Not `awaiting_quota`: no window will reset. The user must decide whether
      // to raise the ceiling or accept the work as it stands.
      return 'awaiting_input';
    /*
     * Transient, and nothing recovers from them yet.
     *
     * These were `working`, on the strength of "the supervisor retries". It does
     * not. `stopDisposition` returns `'retry'` for all five, and its only reader
     * turns anything that is not `'fail'` into `idle`; no provider, runtime,
     * supervisor or manager code re-issues the turn. So the pump returned, no
     * agent was running, and the session sat displayed as busy — raising no
     * `needsAttention`, because `working` is not in the attention family (§10).
     *
     * A stall that reports progress is the worst shape available on a workbench
     * built for unattended runs: nobody is told, and the dashboard says the one
     * session that needs a person is the one that is fine. `awaiting_input` is
     * honest — somebody has to decide whether to send the turn again — and not
     * `failed`, because §4.1 reserves failure for faults that will not come back.
     *
     * When a retry exists (backoff, a cap, and compaction for the overflow case)
     * these move back to `working`, and this comment goes with them.
     */
    case 'rate_limited':
    case 'unavailable':
    case 'transport':
    case 'context_overflow':
    case 'invalid_tool_args':
      return 'awaiting_input';
    case 'max_output_tokens':
    case 'refused':
    case 'content_filtered':
    case 'misconfigured':
      return 'failed';
  }
}

const IMPLICIT_STOP: StopReason = { kind: 'transport' };

/**
 * Consume every event from a handle, writing durable ones to the log.
 *
 * A stream that ends without an explicit `stopped` event is treated as a
 * transport failure — which is retryable — rather than as a clean finish. A
 * silently truncated turn reported as success is the worst outcome available,
 * because it looks like the work was done.
 */
export async function pumpAgent(
  handle: AgentHandle,
  store: SessionStore,
  opts: PumpOptions,
): Promise<PumpOutcome> {
  const meta = { origin: opts.origin, ...(opts.agentId ? { agentId: opts.agentId } : {}) };

  let stop: StopReason | null = null;
  let eventsWritten = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cost: Cost = 0;

  for await (const ev of handle.events) {
    opts.onEvent?.(ev);

    switch (ev.type) {
      case 'text':
        await store.append({ type: 'agent.text', text: ev.text }, meta);
        eventsWritten += 1;
        break;

      case 'reasoning':
        // Stamped with the runtime that produced it, so §3.9's boundary can be
        // enforced later without guessing which adapter shaped the text.
        await store.append(
          { type: 'agent.reasoning', text: ev.text, provider: opts.origin.runtimeId ?? 'unknown' },
          meta,
        );
        eventsWritten += 1;
        break;

      case 'tool_use':
        await store.append(
          { type: 'agent.tool_use', toolUseId: ev.id, tool: ev.tool, args: ev.args },
          meta,
        );
        eventsWritten += 1;
        break;

      case 'tool_result':
        await store.append(
          {
            type: 'agent.tool_result',
            toolUseId: ev.id,
            ok: ev.ok,
            summary: ev.summary,
            ...(ev.blobs !== undefined ? { resultBlobs: ev.blobs as Sha256[] } : {}),
          },
          meta,
        );
        eventsWritten += 1;
        break;

      case 'usage':
        inputTokens += ev.inputTokens;
        outputTokens += ev.outputTokens;
        cacheReadTokens += ev.cacheReadTokens ?? 0;
        cacheWriteTokens += ev.cacheWriteTokens ?? 0;
        // `addCost` rather than the hand-rolled contagion this used to carry —
        // which handled an unknown *accumulator* but not an unknown arriving on
        // the event, a case that could not happen until turns started reporting
        // one. One rule, in one place (§10).
        cost = ev.cost === undefined ? cost : addCost(cost, ev.cost);
        await store.append(
          {
            type: 'usage',
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
            ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
            ...(ev.cost !== undefined ? { cost: ev.cost } : {}),
          },
          meta,
        );
        eventsWritten += 1;
        break;

      case 'stopped':
        stop = ev.stop;
        await store.append({ type: 'agent.stopped', stop: ev.stop }, meta);
        eventsWritten += 1;
        break;
    }
  }

  const finalStop = stop ?? IMPLICIT_STOP;

  return {
    stop: finalStop,
    disposition: stopDisposition(finalStop),
    nextState: stateForStop(finalStop),
    eventsWritten,
    resumeToken: handle.resumeToken(),
    usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost },
  };
}

/** Human-readable reason recorded on the state transition event. */
export function stopReasonSummary(stop: StopReason): string {
  switch (stop.kind) {
    case 'quota_exhausted':
      return stop.resetsAt
        ? `${stop.scope} quota exhausted, resets at ${stop.resetsAt}`
        : `${stop.scope} quota exhausted`;
    case 'rate_limited':
      return stop.retryAfterMs ? `rate limited, retry in ${stop.retryAfterMs}ms` : 'rate limited';
    case 'refused':
      return stop.category ? `refused (${stop.category})` : 'refused';
    case 'content_filtered':
      return `content filtered on ${stop.stage}`;
    case 'invalid_tool_args':
      return `invalid tool arguments: ${stop.detail}`;
    case 'limit_reached':
      return stop.detail ? `${stop.limit} limit reached: ${stop.detail}` : `${stop.limit} limit reached`;
    case 'misconfigured':
      return `misconfigured: ${stop.detail}`;
    default:
      return stop.kind;
  }
}
