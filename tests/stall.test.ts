/**
 * Noticing that a session has gone quiet (DESIGN.md §10, §15 Phase 4).
 *
 * The dashboard exists to answer "what is running and what is stuck", and until
 * now a hung agent looked exactly like a busy one: both say `working`.
 *
 * Everything here turns on stalling being a **suspicion rather than a verdict**.
 * The state stays `working`, because that is what it is — the agent may simply be
 * slow, and moving it to a paused or failed state would assert something untrue
 * about work still in flight and have to be undone the moment it spoke. And it
 * has to clear itself: a warning that stays up after the thing it warned about
 * resolved is how a signal stops being read.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentId, InstanceId, Session, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let managers: SessionManager[] = [];

/** A script that stops without ending the turn, so the session sits `working`. */
const SILENT: EchoStep[] = [{ kind: 'text', text: 'thinking' }, { kind: 'stop', stop: { kind: 'tool_calls' } }];
const DONE: EchoStep[] = [{ kind: 'text', text: 'ok' }, { kind: 'stop', stop: { kind: 'end_turn' } }];

/** A clock the test moves, so nothing waits on real minutes. */
function clock(start = Date.parse('2026-01-01T00:00:00Z')): { now: () => Date; advance: (ms: number) => void } {
  let at = start;
  return { now: () => new Date(at), advance: (ms) => (at += ms) };
}

function manager(script: EchoStep[], opts: { stallAfterMs?: number; now?: () => Date } = {}): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', requiresModel: false });
  const m = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId,
    // Off unless a test asks: the sweeper is a timer, and a suite that leaves
    // them running is a suite that fails somewhere unrelated.
    stallAfterMs: opts.stallAfterMs ?? 0,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  managers.push(m);
  return m;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-stall-'));
  instanceId = (await openWorkspace(root)).instanceId;
  managers = [];
});
afterEach(async () => {
  for (const m of managers) m.dispose();
  await rm(root, { recursive: true, force: true });
});

/** Reach the private sweep, which is otherwise driven by a timer. */
const sweep = (m: SessionManager): void =>
  (m as unknown as { sweepStalled: () => void }).sweepStalled();

async function working(m: SessionManager): Promise<{ session: Session; agentId: AgentId }> {
  const session = await m.createSession({ title: 's', goal: 'g' });
  const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  return { session, agentId: agent.agentId };
}

/**
 * Wait for the session to actually be running, rather than for 50ms and a hope.
 *
 * Every one of these was a fixed sleep, and the last assertion in this file
 * flaked because of it. `send` is deliberately not awaited — the turn never
 * finishes — so the test raced the session reaching `working`, and 50ms was
 * usually but not always enough. The same fix `messageBus`, `reconnect` and
 * `treeRollup` already carry; this file was missed because its sleeps looked
 * like setup rather than synchronisation, which is what a fixed sleep always
 * looks like.
 */
async function until(what: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const isWorking = (m: SessionManager, id: SessionId) => async (): Promise<boolean> =>
  (await m.get(id)).state === 'working';

/** Live handles for a session — private, like `sweepStalled` above. */
const handleCount = (m: SessionManager, id: SessionId): number =>
  (m as unknown as { sessions: Map<string, { handles: Map<unknown, unknown> }> }).sessions.get(id)
    ?.handles.size ?? 0;

/**
 * Wait until the session is `working` **with nothing running**.
 *
 * A stronger condition than `working`, and the one the stuck-turn behaviour is
 * actually defined on: `interrupt` resolves a session only when the handle map
 * is empty, because that is what "the agent went away mid-turn" means. Waiting
 * on `working` alone raced the handle being removed — the assertion passed when
 * the drain won and failed when it did not, which is why it flaked roughly one
 * run in five rather than always.
 */
const isStuck = (m: SessionManager, id: SessionId) => async (): Promise<boolean> =>
  (await m.get(id)).state === 'working' && handleCount(m, id) === 0;

describe('a session that has gone quiet', () => {
  it('is flagged, without being moved out of `working`', async () => {
    const time = clock();
    const m = manager(SILENT, { stallAfterMs: 60_000, now: time.now });
    const { session, agentId } = await working(m);
    void m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(isWorking(m, session.sessionId));

    time.advance(61_000);
    sweep(m);

    const after = await m.get(session.sessionId);
    expect(after.needsAttention).toMatchObject({ reason: 'stalled' });
    // Still working, because that is what it is. Calling it failed or paused
    // would assert something untrue about a turn still in flight.
    expect(after.state).toBe('working');
  });

  it('is not flagged before the threshold', async () => {
    const time = clock();
    const m = manager(SILENT, { stallAfterMs: 60_000, now: time.now });
    const { session, agentId } = await working(m);
    void m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(isWorking(m, session.sessionId));

    time.advance(30_000);
    sweep(m);
    // A model taking half a minute is a model taking half a minute.
    expect((await m.get(session.sessionId)).needsAttention).toBeNull();
  });

  it('stops being flagged the moment it speaks again', async () => {
    const time = clock();
    const m = manager(SILENT, { stallAfterMs: 60_000, now: time.now });
    const { session, agentId } = await working(m);
    void m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });
    // The stronger wait, because the last assertion is about a session that is
    // `working` with nothing running — see `isStuck`.
    await until(isStuck(m, session.sessionId));

    time.advance(61_000);
    sweep(m);
    expect((await m.get(session.sessionId)).needsAttention).toMatchObject({ reason: 'stalled' });

    // Any append at all clears it — a long turn that resumes was never stuck.
    await m.interrupt(session.sessionId, agentId);
    expect((await m.get(session.sessionId)).needsAttention?.reason).not.toBe('stalled');

    /**
     * And the session now waits for a person rather than staying `working`.
     *
     * This assertion read `toBeNull()`, which passed because interrupting only
     * appended. Interrupting a turn whose agent has gone now also resolves the
     * session (§8), so it reports `needs_input` — a stronger and more truthful
     * outcome than "nothing is flagged", and the reason the old assertion was
     * worth revisiting rather than relaxing.
     */
    expect((await m.get(session.sessionId)).state).toBe('awaiting_input');
  });

  it('leaves a paused session alone', async () => {
    const time = clock();
    const m = manager(DONE, { stallAfterMs: 60_000, now: time.now });
    const { session, agentId } = await working(m);
    await m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });

    const before = await m.get(session.sessionId);
    expect(before.state).toBe('awaiting_input');

    time.advance(60 * 60_000);
    sweep(m);

    // Waiting for a human is not being stuck. Flagging it would light up every
    // session anybody ever left overnight, and a warning on everything is a
    // warning on nothing.
    const after = await m.get(session.sessionId);
    expect(after.needsAttention?.reason).not.toBe('stalled');
  });

  it('does not overwrite an attention reason that is already there', async () => {
    const time = clock();
    const m = manager(SILENT, { stallAfterMs: 60_000, now: time.now });
    const { session, agentId } = await working(m);
    void m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(isWorking(m, session.sessionId));

    time.advance(61_000);
    sweep(m);
    const first = await m.get(session.sessionId);
    const since = first.needsAttention?.since;

    time.advance(61_000);
    sweep(m);
    // The same stall, not a new one: a `since` that keeps resetting would make
    // "quiet for an hour" read as "quiet for a minute".
    expect((await m.get(session.sessionId)).needsAttention?.since).toBe(since);
  });

  it('does nothing at all when the threshold is off', async () => {
    const time = clock();
    const m = manager(SILENT, { stallAfterMs: 0, now: time.now });
    const { session, agentId } = await working(m);
    void m.send(session.sessionId, agentId, { content: [{ type: 'text', text: 'go' }] });
    await until(isWorking(m, session.sessionId));

    time.advance(60 * 60_000);
    sweep(m);
    expect((await m.get(session.sessionId)).needsAttention).toBeNull();
  });
});
