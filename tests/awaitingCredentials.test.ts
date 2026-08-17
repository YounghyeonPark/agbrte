/**
 * A session parked on a login (DESIGN.md §3.9, §3.11, §4.1).
 *
 * The bug this pins down was not a missing feature. `StopReason` had
 * `{kind:'auth'}`, `stopDisposition` mapped it to `pause`, `stateForStop` mapped
 * it to `awaiting_credentials`, and the attention map already called it
 * `needs_credentials` — every piece existed and nothing produced the stop, so a
 * Claude Code seat that had never been logged in ended its turn as ordinary
 * assistant text ("Not logged in · Please run /login") with the session sitting
 * in `awaiting_input`. The user's only visible move was the Terminal view, which
 * by design observes and cannot type: §3.11 keeps Agbrte out of the vendor's
 * auth path entirely, so the one control on screen was the one that cannot help.
 *
 * Two things are asserted here that "it parks" does not cover:
 *
 *  - **The reason is an instruction, not a diagnosis.** A pause whose whole
 *    contract is "somebody fixes this and it resumes" is worth nothing if the
 *    person is not told what to fix or where. `vendor-cli-session` puts the
 *    credential on whichever machine runs the loop (§3.11), which for a remote
 *    seat is not the machine the user is looking at.
 *  - **It actually resumes.** §4.1's `awaiting_*` family means *paused, holding
 *    all state* — so the next turn has to just work, with the session's work
 *    still there.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoConfig, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentId, InstanceId, SessionId, StopReason } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let managers: SessionManager[] = [];

/** What a CLI adapter puts on the stop: the command, and nothing vaguer. */
const ADVICE =
  'Claude Code is not logged in, or its saved login was rejected — run `claude auth login` ' +
  'in a terminal on the machine this agent runs on';

const FINE: EchoStep[] = [{ kind: 'text', text: 'ok' }, { kind: 'stop', stop: { kind: 'end_turn' } }];

/**
 * Stops once for the given reason, then behaves.
 *
 * The point of the fixture is the *second* turn: a runtime that always refuses
 * would prove only that the session parks, and the claim under test is that the
 * pause is recoverable.
 */
function oncePark(stop: StopReason): EchoRuntime {
  let first = true;
  const config: EchoConfig = {
    get script(): EchoStep[] {
      if (first) {
        first = false;
        return [{ kind: 'text', text: 'starting' }, { kind: 'stop', stop }];
      }
      return FINE;
    },
  };
  return new EchoRuntime(config);
}

/** `machineName` is fixed so the assertion is about the sentence, not the runner. */
function manager(runtime: EchoRuntime): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(runtime, { label: 'Echo', model: 'none' });
  const m = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId,
    stallAfterMs: 0,
    machineName: 'build-box',
  });
  managers.push(m);
  return m;
}

async function parked(
  stop: StopReason,
): Promise<{ m: SessionManager; sessionId: SessionId; agentId: AgentId }> {
  const m = manager(oncePark(stop));
  const session = await m.createSession({ title: 's', goal: 'g' });
  const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'do the work' }] });
  return { m, sessionId: session.sessionId, agentId: agent.agentId };
}

/** The reason recorded on the transition into the pause. */
async function reasonFor(m: SessionManager, sessionId: SessionId): Promise<string> {
  const events = await m.events(sessionId);
  const row = [...events].reverse().find((e) => e.type === 'session.state');
  return row?.to === 'awaiting_credentials' ? (row.reason ?? '') : '';
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-creds-'));
  instanceId = (await openWorkspace(root)).instanceId;
  managers = [];
});
afterEach(async () => {
  for (const m of managers) m.dispose();
  await rm(root, { recursive: true, force: true });
});

describe('a runtime whose credential will not work', () => {
  it('parks rather than failing', async () => {
    const { m, sessionId } = await parked({ kind: 'auth', detail: ADVICE });
    const session = await m.get(sessionId);

    // §4.1: a login is a wait, not a fault. `failed` would tell the user to
    // start again, and `awaiting_input` — where an unclassified stop lands —
    // asks for a turn nobody can usefully send.
    expect(session.state).toBe('awaiting_credentials');
    expect(session.needsAttention).toMatchObject({ reason: 'needs_credentials' });
  });

  it('records what to do and where, not just "auth"', async () => {
    const { m, sessionId } = await parked({ kind: 'auth', detail: ADVICE });
    const reason = await reasonFor(m, sessionId);

    // The command, from the adapter that knows which CLI refused.
    expect(reason).toContain('claude auth login');
    // The machine, from the owner — the only party that knows where the loop
    // runs. A remote seat telling somebody to log in "locally" sends them to a
    // machine with no credential on it (§3.11).
    expect(reason).toContain('build-box');
    expect(reason).toContain(root);
    // And the promise that makes waiting safe.
    expect(reason).toMatch(/holding its work|Nothing is lost/i);
    // The bare kind is what this replaced; it must not be the whole message.
    expect(reason).not.toBe('auth');
  });

  it('still says something useful when the runtime named no remedy', async () => {
    // §3.9 allows `auth` with no detail, and a provider that reports only a 401
    // has nothing honest to add. What must not happen is the word `undefined`
    // reaching a person, or a confident instruction nobody established.
    const { m, sessionId } = await parked({ kind: 'auth' });
    const reason = await reasonFor(m, sessionId);

    expect(reason).not.toContain('undefined');
    expect(reason).toContain('build-box');
    expect(reason.length).toBeGreaterThan('auth'.length);
  });

  it('picks the turn up on the next send, once the credential is fixed', async () => {
    const { m, sessionId, agentId } = await parked({ kind: 'auth', detail: ADVICE });
    expect((await m.get(sessionId)).state).toBe('awaiting_credentials');

    // No unpark, no retry, no special call: §4.1's pause holds state and the
    // ordinary path resumes it. A seat left `stopped`, a handle never released,
    // or a state that refused new turns would each break this.
    await m.send(sessionId, agentId, { content: [{ type: 'text', text: 'again' }] });

    const after = await m.get(sessionId);
    expect(after.state).toBe('awaiting_input');
    expect(after.needsAttention).toMatchObject({ reason: 'needs_input' });
    // Parked, not stopped — a crashed seat would not have run this turn.
    expect(after.agents[0]?.status).toBe('idle');

    // And the work from before the pause is still in the log, which is the
    // entire reason for pausing instead of failing.
    const events = await m.events(sessionId);
    expect(events.filter((e) => e.type === 'user.turn')).toHaveLength(2);
    expect(events.some((e) => e.type === 'agent.text' && e.text === 'starting')).toBe(true);
    expect(events.some((e) => e.type === 'agent.text' && e.text === 'ok')).toBe(true);
  });
});
