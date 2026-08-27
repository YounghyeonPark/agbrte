/**
 * Folding one session's log into what a teammate needs to read (§17 Q22).
 *
 * The decision this module makes is *what counts as worth reporting*, and that
 * is the part most likely to drift — every new event type is a chance to add
 * noise, and noise here is expensive twice over: it costs the reader's context
 * and it buries the two lines that mattered.
 *
 * So the shape is pinned from literals. No store, no manager, no log on disk.
 */

import { describe, expect, it } from 'vitest';
import { digestPeerLog, PEER_HISTORY_MAX_LINES } from '@main/store/peerDigest.js';
import type { AgbrteEvent } from '@shared/types/index.js';

/** Enough of an event to be folded; the digest reads four fields. */
const ev = (seq: number, body: Record<string, unknown>): AgbrteEvent =>
  ({ id: `e${seq}`, seq, at: '2026-08-27T00:00:00.000Z', ...body }) as AgbrteEvent;

describe('what a peer sees of another session', () => {
  it('keeps the turn, the call, the conclusion and the stop', () => {
    const { lines } = digestPeerLog([
      ev(1, { type: 'user.turn', content: [{ type: 'text', text: 'write logic.js' }] }),
      ev(2, { type: 'agent.tool_use', toolUseId: 't1', tool: 'write', args: { file_path: 'logic.js' } }),
      ev(3, { type: 'agent.text', text: 'logic.js is written.' }),
      ev(4, { type: 'agent.stopped', stop: { kind: 'transport' } }),
    ]);

    expect(lines.map((l) => `${l.kind}:${l.text}`)).toEqual([
      'turn:write logic.js',
      'did:write: logic.js',
      'said:logic.js is written.',
      'state:stopped: transport',
    ]);
  });

  it('names a call by its object, not by its payload', () => {
    /*
     * The argument that names *what was touched* is the one worth carrying. A
     * `write` call's other argument is the entire file, and copying that into a
     * teammate's context is the thing this module exists not to do — they are on
     * the same machine and can open it.
     */
    const { lines } = digestPeerLog([
      ev(1, {
        type: 'agent.tool_use',
        toolUseId: 't',
        tool: 'write',
        args: { file_path: 'src/probe.js', content: 'x'.repeat(5000) },
      }),
      ev(2, { type: 'agent.tool_use', toolUseId: 't2', tool: 'bash', args: { command: 'node test.js' } }),
    ]);

    expect(lines.map((l) => l.text)).toEqual(['write: src/probe.js', 'bash: node test.js']);
    expect(JSON.stringify(lines)).not.toContain('xxxx');
  });

  it('drops the churn every turn produces', () => {
    /*
     * `working` and `awaiting_input` happen on every turn, so reporting them
     * would fill a digest with the news that turns occur. `end_turn` and
     * `tool_calls` are the same claim in stop-reason form.
     */
    const { lines } = digestPeerLog([
      ev(1, { type: 'session.state', from: 'planning', to: 'working' }),
      ev(2, { type: 'agent.stopped', stop: { kind: 'end_turn' } }),
      ev(3, { type: 'session.state', from: 'working', to: 'awaiting_input', reason: 'end_turn' }),
      ev(4, { type: 'agent.stopped', stop: { kind: 'tool_calls' } }),
    ]);
    expect(lines).toEqual([]);
  });

  it('keeps the states that mean somebody has to do something', () => {
    const { lines } = digestPeerLog([
      ev(1, { type: 'session.state', from: 'working', to: 'awaiting_permission' }),
      ev(2, { type: 'session.state', from: 'working', to: 'done' }),
      ev(3, { type: 'session.state', from: 'working', to: 'failed' }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(['→ awaiting_permission', '→ done', '→ failed']);
  });

  it('carries no reasoning and no tool output', () => {
    /*
     * Two different reasons. A result is where the bulk is, and the reader can
     * open the thing itself. Reasoning is the model's working-out rather than
     * its work, and handing a colleague's discarded hypothesis to another model
     * as fact is how it becomes somebody's premise.
     */
    const { lines } = digestPeerLog([
      ev(1, { type: 'agent.reasoning', text: 'maybe the parser is wrong', provider: 'p' }),
      ev(2, { type: 'agent.tool_result', toolUseId: 't', ok: true, summary: 'read 4000 chars' }),
    ]);
    expect(lines).toEqual([]);
  });

  it('keeps the newest when it will not all fit, and says it clipped', () => {
    // A peer checking in wants the end of the story. The beginning is what it
    // read last time — and `since` is how it says so.
    const many = Array.from({ length: PEER_HISTORY_MAX_LINES + 10 }, (_, i) =>
      ev(i + 1, { type: 'agent.text', text: `line ${i + 1}` }),
    );
    const { lines, truncated, nextSince } = digestPeerLog(many);

    expect(truncated).toBe(true);
    expect(lines).toHaveLength(PEER_HISTORY_MAX_LINES);
    expect(lines[0]?.text).toBe('line 11');
    expect(lines.at(-1)?.text).toBe(`line ${PEER_HISTORY_MAX_LINES + 10}`);
    // The cursor is the *log's* position, not the kept window's, or a reader
    // that resumes from it would see the dropped lines again forever.
    expect(nextSince).toBe(PEER_HISTORY_MAX_LINES + 10);
  });

  it('advances the cursor even when nothing was worth keeping', () => {
    // Otherwise a peer whose teammate only churned states asks from the same
    // place every time and re-reads the same span for the life of the session.
    const { lines, nextSince } = digestPeerLog([
      ev(41, { type: 'session.state', from: 'working', to: 'awaiting_input' }),
      ev(42, { type: 'agent.stopped', stop: { kind: 'end_turn' } }),
    ]);
    expect(lines).toEqual([]);
    expect(nextSince).toBe(42);
  });

  it('flattens a line so one event cannot become a page', () => {
    const { lines } = digestPeerLog([
      ev(1, { type: 'agent.text', text: `${'a'.repeat(400)}\n\n${'b'.repeat(400)}` }),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.text).not.toContain('\n');
    expect(lines[0]!.text.length).toBeLessThanOrEqual(240);
    expect(lines[0]!.text.endsWith('…')).toBe(true);
  });
});
