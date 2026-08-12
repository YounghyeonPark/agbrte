import { describe, expect, it } from 'vitest';
import { reduceEvents } from '@main/store/reduce.js';
import {
  emptyProjection,
  newEventId,
  newSessionId,
  type EventBody,
  type AgbrteEvent,
  type SessionId,
} from '@shared/types/index.js';

const SID: SessionId = newSessionId();

/** Build a log with sequential seq and predictable timestamps. */
function log(...bodies: EventBody[]): AgbrteEvent[] {
  return bodies.map(
    (body, i) =>
      ({
        id: newEventId(),
        seq: i + 1,
        at: new Date(Date.UTC(2026, 6, 29, 12, 0, i)).toISOString(),
        ...body,
      }) as AgbrteEvent,
  );
}

describe('reduceEvents', () => {
  it('starts from an empty projection', () => {
    const p = reduceEvents(SID, []);
    expect(p.state).toBe('draft');
    expect(p.lastSeq).toBe(0);
    expect(p.usage.cost).toBe(0);
  });

  it('tracks state transitions and the last seq', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'session.created', goal: 'g', title: 't' },
        { type: 'session.state', from: 'planning', to: 'working' },
      ),
    );
    expect(p.state).toBe('working');
    expect(p.lastSeq).toBe(2);
  });

  it('derives needsAttention from a paused state and clears it on resume', () => {
    const paused = reduceEvents(
      SID,
      log({ type: 'session.state', from: 'working', to: 'awaiting_quota' }),
    );
    expect(paused.needsAttention).toEqual({
      reason: 'quota_exhausted',
      since: expect.any(String) as unknown as string,
    });

    const resumed = reduceEvents(
      SID,
      log(
        { type: 'session.state', from: 'working', to: 'awaiting_quota' },
        { type: 'session.state', from: 'awaiting_quota', to: 'working' },
      ),
    );
    expect(resumed.needsAttention).toBeNull();
  });

  it('does not raise attention for awaiting_children — the blocked descendant does', () => {
    const p = reduceEvents(
      SID,
      log({ type: 'session.state', from: 'working', to: 'awaiting_children' }),
    );
    expect(p.state).toBe('awaiting_children');
    expect(p.needsAttention).toBeNull();
  });

  it('accumulates usage', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'usage', inputTokens: 100, outputTokens: 20, cost: 0.5 },
        { type: 'usage', inputTokens: 50, outputTokens: 10, cost: 0.25 },
      ),
    );
    expect(p.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      // Separate because they are priced separately (§3.6a): reads are far
      // cheaper than input tokens and writes dearer, so one field could not
      // carry both prices.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.75,
    });
  });

  it("treats 'unknown' cost as absorbing rather than reporting a partial sum", () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'usage', inputTokens: 10, outputTokens: 1, cost: 0.1 },
        { type: 'usage', inputTokens: 10, outputTokens: 1, cost: 'unknown' },
        { type: 'usage', inputTokens: 10, outputTokens: 1, cost: 0.1 },
      ),
    );
    // Showing 0.2 would understate spend and look authoritative (§10).
    expect(p.usage.cost).toBe('unknown');
    expect(p.usage.inputTokens).toBe(30);
  });

  it('ignores a usage event with no cost field rather than going unknown', () => {
    const p = reduceEvents(SID, log({ type: 'usage', inputTokens: 5, outputTokens: 5 }));
    expect(p.usage.cost).toBe(0);
  });

  it('upserts checklist items by id, preserving first-seen order', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'checklist.updated', itemId: 'a', state: 'todo', text: 'First' },
        { type: 'checklist.updated', itemId: 'b', state: 'todo', text: 'Second' },
        { type: 'checklist.updated', itemId: 'a', state: 'done' },
      ),
    );
    expect(p.checklist.map((i) => [i.id, i.state, i.text])).toEqual([
      ['a', 'done', 'First'],
      ['b', 'todo', 'Second'],
    ]);
  });

  it('counts compactions — the split signal', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'agent.compacted', beforeTokens: 900, afterTokens: 300 },
        { type: 'agent.compacted', beforeTokens: 900, afterTokens: 320 },
      ),
    );
    // Two compactions with a still-growing checklist means decompose, not
    // compact again (§4.3).
    expect(p.stats.compactions).toBe(2);
  });

  it('counts tool errors, permission denials, and downgrades separately', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'agent.tool_use', toolUseId: '1', tool: 'bash', args: {} },
        { type: 'agent.tool_result', toolUseId: '1', ok: false, summary: 'boom' },
        {
          type: 'permission.decided',
          requestId: 'r1',
          tool: 'bash',
          args: {},
          decision: { result: 'deny', reason: 'outside workspace' },
          via: 'policy',
        },
        { type: 'content.downgraded', note: { reason: 'no_image_support', detail: 'text only' } },
      ),
    );
    expect(p.stats).toMatchObject({
      toolCalls: 1,
      toolErrors: 1,
      permissionPrompts: 1,
      permissionDenials: 1,
      downgrades: 1,
    });
  });

  it('is idempotent on replay — an already-folded event is skipped', () => {
    const events = log(
      { type: 'usage', inputTokens: 10, outputTokens: 1, cost: 1 },
      { type: 'usage', inputTokens: 10, outputTokens: 1, cost: 1 },
    );
    const once = reduceEvents(SID, events);
    // Overlapping a checkpoint with a tail read must not double-count.
    const twice = reduceEvents(SID, events, once);
    expect(twice.usage).toEqual(once.usage);
    expect(twice.lastSeq).toBe(2);
  });

  it('folding from a base equals folding from zero', () => {
    const events = log(
      { type: 'session.created', goal: 'g', title: 't' },
      { type: 'user.turn', content: [{ type: 'text', text: 'hi' }] },
      { type: 'usage', inputTokens: 10, outputTokens: 2, cost: 0.01 },
      { type: 'checklist.updated', itemId: 'a', state: 'doing', text: 'Work' },
      { type: 'session.state', from: 'planning', to: 'working' },
      { type: 'agent.compacted', beforeTokens: 100, afterTokens: 40 },
    );

    const whole = reduceEvents(SID, events);
    const split = reduceEvents(SID, events.slice(3), reduceEvents(SID, events.slice(0, 3)));

    expect(split).toEqual(whole);
  });

  it('does not mutate the base projection it folds from', () => {
    const base = reduceEvents(SID, log({ type: 'checklist.updated', itemId: 'a', state: 'todo' }));
    const snapshot = structuredClone(base);

    reduceEvents(SID, log({ type: 'checklist.updated', itemId: 'a', state: 'done' }).map((e) => ({ ...e, seq: 99 })), base);

    expect(base).toEqual(snapshot);
  });

  it('records a received brief so a late resume still knows why it exists', () => {
    const parent = newSessionId();
    const p = reduceEvents(
      SID,
      log({
        type: 'session.brief_received',
        parentSessionId: parent,
        brief: {
          parentGoal: 'migrate the monorepo',
          scope: 'migrate packages/ui',
          outOfScope: ['packages/api'],
          contract: { summaryMaxTokens: 800, artifacts: [] },
          acceptance: ['tests pass'],
          memoryRefs: [],
          pointers: [],
          budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
        },
      }),
    );
    expect(p.parentSessionId).toBe(parent);
    expect(p.brief?.scope).toBe('migrate packages/ui');
    expect(p.brief?.outOfScope).toEqual(['packages/api']);
  });

  it('promotes an orphaned child to a root', () => {
    const parent = newSessionId();
    const p = reduceEvents(
      SID,
      log(
        {
          type: 'session.brief_received',
          parentSessionId: parent,
          brief: {
            parentGoal: 'g',
            scope: 's',
            outOfScope: [],
            contract: { summaryMaxTokens: 500, artifacts: [] },
            acceptance: [],
            memoryRefs: [],
            pointers: [],
            budget: { tokenCeiling: 1000, spent: 0, reservedForChildren: 0 },
          },
        },
        { type: 'session.orphaned', formerParentSessionId: parent },
      ),
    );
    // Cancelling a parent must not destroy independently valuable work (§4.3).
    expect(p.parentSessionId).toBeNull();
    expect(p.brief).not.toBeNull();
  });

  it('carries a skipped-line count through so corruption is visible', () => {
    const p = reduceEvents(SID, [], emptyProjection(SID), { skippedLines: 2 });
    expect(p.skippedLines).toBe(2);
  });
});

describe('cache tokens accumulate separately (§3.6a, §10)', () => {
  it('keeps reads and writes apart, because their prices are apart', () => {
    const p = reduceEvents(
      SID,
      log(
        { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 900, cost: 0.01 },
        { type: 'usage', inputTokens: 10, outputTokens: 5, cacheWriteTokens: 100, cost: 0.02 },
      ),
    );

    expect(p.usage.cacheReadTokens).toBe(900);
    expect(p.usage.cacheWriteTokens).toBe(100);
  });

  it('leaves the total alone when a runtime says nothing about cost', () => {
    /**
     * Absent and `'unknown'` are different facts and this is where collapsing
     * them would bite. A runtime that reports no cost field has not told us a
     * cost is unobservable — it has told us nothing — and treating silence as
     * `'unknown'` would make every `echo` turn poison a session's total.
     */
    const p = reduceEvents(
      SID,
      log(
        { type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0.5 },
        { type: 'usage', inputTokens: 1, outputTokens: 1 },
      ),
    );

    expect(p.usage.cost).toBe(0.5);
  });
});

/**
 * A log whose seq numbers collide (DESIGN.md §5.1e).
 *
 * `EventLog` used to allocate `seq` across an await, so overlapping appends were
 * issued the same number. That is fixed, but the logs written before it are on
 * disk and are replayed every time a session loads — and the fold skipped
 * anything at or below `lastSeq`, so the second event at a shared seq was
 * dropped from the projection on every single load. Not a display problem: the
 * log recorded a permission decision and the session state did not have it.
 *
 * The guard is there so that overlapping a checkpoint with a tail read cannot
 * double-count. That is a question about *identity* — the same event seen twice
 * — and answering it with position was what turned a writer's bug into
 * permanent loss. The renderer's dedupe was changed for the same reason; leaving
 * the reducer keyed on seq would have left the two disagreeing about what "an
 * event we already have" means.
 */
describe('two events sharing a seq', () => {
  const collided = (): AgbrteEvent[] => {
    const events = log(
      { type: 'user.turn', content: [{ type: 'text', text: 'go' }] },
      { type: 'usage', inputTokens: 1, outputTokens: 1 },
      { type: 'agent.text', text: 'done' },
    ) as AgbrteEvent[];
    // What the race actually produced: the third event handed the second's seq.
    (events[2] as { seq: number }).seq = events[1]!.seq;
    return events;
  };

  it('folds both instead of discarding the later one', () => {
    const p = reduceEvents(SID, collided());
    // The text arrived after a usage row that had taken its number.
    expect(p.lastActivityAt, 'the colliding event was skipped entirely').toBe(collided()[2]!.at);
  });

  it('still refuses to fold the same event twice', () => {
    const events = collided();
    const once = reduceEvents(SID, events);
    // A checkpoint at that point, replayed over the same tail — the overlap the
    // seq guard exists for.
    const twice = reduceEvents(SID, events, once);
    expect(twice.usage.inputTokens, 'the overlap was counted again').toBe(once.usage.inputTokens);
  });
});
