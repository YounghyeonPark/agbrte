/**
 * Getting a host back when a turn died (DESIGN.md §8, §10, §4.1).
 *
 * Found in the field rather than reasoned about: a deploy to a real server was
 * blocked because `agbrte stop` refused, on behalf of a session that had been
 * `working` since the previous day. Its agent had gone away mid-turn.
 *
 * Both halves of that refusal are correct. §10 will not let stall detection move
 * the state, because a stall is a suspicion and an agent may simply be slow.
 * §8 will not let a host holding a live agent go down because a window closed.
 * Together they meant the host could not be asked to exit at all, and upgrading
 * it meant killing the process.
 *
 * The missing piece was an explicit interrupt that resolves it — a person
 * saying so, rather than a timer inferring it.
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
const managers: SessionManager[] = [];

/** A turn that stops without ending, so the session sits `working`. */
const SILENT: EchoStep[] = [{ kind: 'text', text: 'thinking' }, { kind: 'stop', stop: { kind: 'tool_calls' } }];
const DONE: EchoStep[] = [{ kind: 'stop', stop: { kind: 'end_turn' } }];

function manager(script: EchoStep[]): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
  managers.push(m);
  return m;
}

const liveOf = (m: SessionManager, id: string): { session: Session; handles: Map<AgentId, unknown> } =>
  (m as unknown as { sessions: Map<string, { session: Session; handles: Map<AgentId, unknown> }> })
    .sessions.get(id)!;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-stuck-'));
  instanceId = (await openWorkspace(root)).instanceId;
});
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/**
 * A session left `working` with nothing behind it.
 *
 * Reached without any staging, which is the uncomfortable part: a turn that
 * stops on `tool_calls` releases its handle and stays `working`, so this is not
 * only what a crashed agent host looks like — it is a state the ordinary path
 * arrives at. Whatever produced the one found on the server, nothing was ever
 * going to move it.
 */
async function stuck(m: SessionManager): Promise<SessionId> {
  const session = await m.createSession({ title: 's', goal: 'g' });
  const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

  const live = liveOf(m, session.sessionId);
  expect(live.session.state).toBe('working');
  expect(live.handles.size).toBe(0);
  return session.sessionId;
}

describe('a session whose agent went away mid-turn', () => {
  it('is released by an explicit interrupt', async () => {
    const m = manager(SILENT);
    const sessionId = await stuck(m);

    await m.interrupt(sessionId);

    // `awaiting_input`, not `failed`: nothing is broken (§4.1), the work stopped
    // and is waiting for whoever stopped it.
    expect(m.get(sessionId).state).toBe('awaiting_input');
  });

  it('says in the log that nothing was running', async () => {
    const m = manager(SILENT);
    const sessionId = await stuck(m);
    await m.interrupt(sessionId);

    const events = await m.events(sessionId);
    // A state change with no explanation is the kind of thing that reads as a
    // bug six months later.
    expect(JSON.stringify(events)).toContain('no turn was running');
  });

  it('lets the host be asked to stop afterwards', async () => {
    /**
     * The whole point. `shutdown` refuses while anything is `working`, so a
     * session left there by a dead turn holds the host for good — which is what
     * blocked a real deploy.
     */
    const m = manager(SILENT);
    const sessionId = await stuck(m);
    const busy = (): boolean =>
      [...(m as unknown as { sessions: Map<string, { session: Session }> }).sessions.values()].some(
        (l) => l.session.state === 'working',
      );

    expect(busy()).toBe(true);
    await m.interrupt(sessionId);
    expect(busy()).toBe(false);
  });
});

describe('what it does not do', () => {
  it('leaves a finished session alone', async () => {
    const m = manager(DONE);
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    const before = m.get(session.sessionId).state;
    await m.interrupt(session.sessionId);
    // Interrupting something that already stopped should not invent a
    // transition; the session was not working and nothing changed.
    expect(m.get(session.sessionId).state).toBe(before);
  });

  it('leaves a session with a live turn to its handle', async () => {
    /**
     * The inference is "working *with no handle*", not "working". A turn that is
     * genuinely in flight has a handle, and forcing a state on it would end work
     * that was fine — so the handle is asked and the state is left alone.
     */
    const m = manager(SILENT);
    const sessionId = await stuck(m);

    const live = liveOf(m, sessionId);
    let asked = false;
    live.handles.set('ghost' as AgentId, {
      interrupt: async () => {
        asked = true;
      },
    });

    await m.interrupt(sessionId);

    expect(asked).toBe(true);
    // Still working: something is running, and nobody here gets to decide it is
    // not.
    expect(m.get(sessionId).state).toBe('working');
  });

  it('is only ever explicit — a stall does not trigger it', async () => {
    /**
     * §10's rule, and the reason this lives in `interrupt` rather than in the
     * sweeper: a stall is a suspicion, an agent may simply be slow, and a timer
     * that resolved sessions would be stall detection issuing the verdict §10
     * denies it.
     */
    const m = manager(SILENT);
    const sessionId = await stuck(m);

    const sweeper = m as unknown as { sweepStalled: () => void; deps: { stallAfterMs?: number } };
    sweeper.deps.stallAfterMs = 1;
    await new Promise((r) => setTimeout(r, 10));
    sweeper.sweepStalled();

    // Flagged, and still working. Nobody said to stop it.
    expect(m.get(sessionId).needsAttention?.reason).toBe('stalled');
    expect(m.get(sessionId).state).toBe('working');
  });
});
