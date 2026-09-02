/**
 * Which tool call is still running (DESIGN.md §14).
 *
 * The transcript now sweeps a highlight across the tool row it is waiting on,
 * which is the one mark that says the app is busy rather than stuck. Everything
 * that can go wrong with it is in this function, and both failures are bad in
 * ways a screenshot will not show:
 *
 *   - **too eager** — a sweep on a call that already returned, or on a session
 *     nobody is running, which turns a process indicator into decoration and
 *     stops it meaning anything;
 *   - **too shy** — no sweep during the one thirty-second wait it exists for,
 *     which leaves the app looking frozen exactly when it is working hardest.
 *
 * Pure, so it is tested here rather than through a browser. Catching this in
 * e2e would mean holding a real turn open at the instant between a call and its
 * result, which is a race to observe and would be flaky in both directions.
 */

import { describe, expect, it } from 'vitest';
import { pendingToolSeq } from '../src/renderer/pendingTool.js';
import type { AgbrteEvent } from '../src/shared/types/index.js';

/** Only the fields this function reads; the rest of an event is irrelevant. */
const at = (seq: number, type: string, over: Record<string, unknown> = {}): AgbrteEvent =>
  ({ seq, type, at: new Date(seq).toISOString(), ...over }) as unknown as AgbrteEvent;

describe('the tool call still out', () => {
  it('is the last one when no result has come back', () => {
    const events = [
      at(1, 'user.turn'),
      at(2, 'agent.tool_use', { tool: 'read' }),
    ];
    expect(pendingToolSeq(events)).toBe(2);
  });

  it('is nothing once the result lands', () => {
    const events = [
      at(1, 'agent.tool_use', { tool: 'read' }),
      at(2, 'agent.tool_result', { ok: true, summary: 'read 3 lines' }),
    ];
    // The sweep has to stop. One left running on finished work is how this
    // pattern is usually got wrong — it becomes a badge rather than a signal.
    expect(pendingToolSeq(events)).toBeNull();
  });

  it('is the second call when the first has answered and the second has not', () => {
    const events = [
      at(1, 'agent.tool_use', { tool: 'read' }),
      at(2, 'agent.tool_result', { ok: true, summary: 'ok' }),
      at(3, 'agent.tool_use', { tool: 'bash' }),
    ];
    expect(pendingToolSeq(events)).toBe(3);
  });

  it('looks past everything that is not about tools', () => {
    const events = [
      at(1, 'agent.tool_use', { tool: 'bash' }),
      at(2, 'agent.reasoning', { text: 'thinking about the output' }),
      at(3, 'agent.text', { text: 'still going' }),
      at(4, 'session.state', { from: 'planning', to: 'working' }),
    ];
    /*
     * A model can talk, reason and change state between issuing a call and its
     * result arriving. Stopping at the first non-tool event would have made the
     * sweep vanish the moment the agent said anything, which is most of a long
     * turn — and the row it belongs on is the row still waiting.
     */
    expect(pendingToolSeq(events)).toBe(1);
  });

  it('is nothing in a transcript with no tools at all', () => {
    expect(pendingToolSeq([at(1, 'user.turn'), at(2, 'agent.text', { text: 'hi' })])).toBeNull();
  });

  it('is nothing in an empty transcript', () => {
    expect(pendingToolSeq([])).toBeNull();
  });

  it('reports a failed result as settled, the same as a successful one', () => {
    const events = [
      at(1, 'agent.tool_use', { tool: 'bash' }),
      at(2, 'agent.tool_result', { ok: false, summary: 'exit 1' }),
    ];
    // A call that failed is finished. The row turns red; it must not also keep
    // claiming to be in flight.
    expect(pendingToolSeq(events)).toBeNull();
  });
});
