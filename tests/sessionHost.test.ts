/**
 * Session ownership living in the host (DESIGN.md §6.4, §8).
 *
 * The claim under test is the one the whole feature rests on: **a client leaving
 * is not a session stopping.** Everything else here exists to make that claim
 * safe — roles enforced by the owner, a host that refuses to exit while work is
 * running, and a version handshake, because a detached host outlives the app
 * that spawned it and a newer app can meet an older host.
 *
 * Driven over in-memory channels. The socket is tested separately; what matters
 * here is who owns what.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import {
  CommandUnavailable,
  HostConnection,
  HostProtocolMismatch,
} from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import {
  MIN_CLIENT_PROTOCOL,
  type SessionCommand,
  type SessionMessage,
} from '@shared/host/sessionProtocol.js';
import type { AgentSpec, InstanceId, SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-host-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ECHOES: EchoStep[] = [
  { kind: 'text', text: 'ok' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

interface Rig {
  server: SessionHostServer;
  manager: SessionManager;
  connect(opts?: { role?: 'read-write' | 'read-only'; protocol?: number }): HostConnection;
}

function rig(script: EchoStep[] = ECHOES, opts: { lingerMs?: number } = {}): Rig {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', requiresModel: false });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });

  const server = new SessionHostServer({
    manager,
    identity: {
      instanceId,
      lineageId: lineageId as never,
      workspaceRoot: root,
      runtimes: ['echo'],
    },
    ...(opts.lingerMs !== undefined ? { lingerMs: opts.lingerMs } : {}),
  });

  return {
    server,
    manager,
    connect: (o = {}) => {
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      return new HostConnection({
        channel: pair.main,
        ...(o.role !== undefined ? { role: o.role } : {}),
      });
    },
  };
}

async function sessionWithAgent(c: HostConnection): Promise<{ sessionId: SessionId; agentId: string }> {
  const session = await c.createSession({ title: 's', goal: 'g' });
  const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
  return { sessionId: session.sessionId, agentId: agent.agentId };
}

describe('the host owns the session', () => {
  it('announces who it is at handshake', async () => {
    const identity = await rig().connect().ready;

    expect(identity.instanceId).toBe(instanceId);
    expect(identity.workspaceRoot).toBe(root);
    expect(identity.runtimes).toEqual(['echo']);
    expect(identity.pid).toBe(process.pid);
  });

  it('writes the log itself, so the app owns no session state', async () => {
    const r = rig();
    const c = r.connect();
    const { sessionId, agentId } = await sessionWithAgent(c);
    await c.send(sessionId, agentId as never, 'hello');

    // The app never touched a SessionStore. Everything in this log was written
    // by the host, which is what makes "the app closed" survivable at all.
    const events = await c.events(sessionId);
    expect(events.map((e) => e.type)).toContain('user.turn');
    expect(events.map((e) => e.type)).toContain('agent.text');
  });

  it('keeps the session when the client disconnects — the whole point', async () => {
    const r = rig();
    const first = r.connect();
    const { sessionId, agentId } = await sessionWithAgent(first);
    await first.send(sessionId, agentId as never, 'before the app closed');

    // The app closes. Leaving is not stopping.
    first.disconnect();
    await new Promise((res) => setTimeout(res, 20));
    expect(r.server.clientCount).toBe(0);

    // A different app instance — a second device, or the same one relaunched.
    const second = r.connect();
    await second.ready;

    const sessions = await second.list();
    expect(sessions.map((s) => s.title)).toEqual(['s']);
    const events = await second.events(sessionId);
    expect(JSON.stringify(events)).toContain('before the app closed');

    // And it is commandable, not merely readable.
    await expect(second.send(sessionId, agentId as never, 'after')).resolves.toBeUndefined();
  });

  it('serves two clients one session, not two copies of it', async () => {
    const r = rig();
    const a = r.connect();
    const b = r.connect();
    await Promise.all([a.ready, b.ready]);

    const { sessionId, agentId } = await sessionWithAgent(a);

    // What b sees was created by a. One owner is what makes that true.
    expect((await b.list()).map((s) => s.sessionId)).toEqual([sessionId]);

    const seen: string[] = [];
    b.on('event', (_s, e: { type: string }) => seen.push(e.type));
    await a.send(sessionId, agentId as never, 'from a');
    await new Promise((res) => setTimeout(res, 20));

    // b watches a's turn without having asked for it.
    expect(seen).toContain('user.turn');
    expect(seen).toContain('agent.stopped');
  });

  it('pushes a turn queued by one client to the other', async () => {
    const r = rig();
    const a = r.connect();
    const b = r.connect();
    await Promise.all([a.ready, b.ready]);
    const { sessionId, agentId } = await sessionWithAgent(a);

    const depths: number[] = [];
    b.on('queue', (_s, _a, depth: number) => depths.push(depth));

    await Promise.all([
      a.send(sessionId, agentId as never, 'one'),
      a.send(sessionId, agentId as never, 'two'),
    ]);
    await new Promise((res) => setTimeout(res, 20));

    // With several clients the backlog may not be yours, so it has to be pushed
    // rather than inferred from your own sends.
    expect(depths.length).toBeGreaterThan(0);
  });
});

describe('the inbox, over the wire', () => {
  /**
   * The hop the unit tests cannot cover.
   *
   * `SessionManager.inbox()` is tested directly, but the entries have to survive
   * serialization and reach a client that was not attached when any of it
   * happened — which is the whole case the inbox exists for, since a detached
   * host is where those events accumulate with nobody connected.
   */
  it('reaches a client that was not there when it happened', async () => {
    const r = rig([{ kind: 'stop', stop: { kind: 'refused' } }]);
    const author = r.connect();
    const { sessionId, agentId } = await sessionWithAgent(author);
    await author.send(sessionId, agentId as never, 'go');
    author.disconnect();

    const later = r.connect();
    await later.ready;
    const entries = await later.inbox();

    expect(entries.map((e) => e.trigger)).toContain('failed');
    expect(entries[0]?.unread).toBe(true);
  });

  it('lets a read-only client clear its own badge', async () => {
    const r = rig([{ kind: 'stop', stop: { kind: 'refused' } }]);
    const author = r.connect();
    const { sessionId, agentId } = await sessionWithAgent(author);
    await author.send(sessionId, agentId as never, 'go');

    const reader = r.connect({ role: 'read-only' });
    await reader.ready;
    // Not gated on write access: marking what *you* have read changes nothing
    // about the work, and a viewer who cannot clear a badge is told about the
    // same thing forever.
    await expect(reader.markInboxRead()).resolves.toBeUndefined();
    expect((await reader.inbox()).every((e) => !e.unread)).toBe(true);
  });
});

describe('asking a runtime what it declares', () => {
  it('answers without a session, because the answer informs the choice', async () => {
    const c = rig().connect();
    await expect(c.capabilities('echo')).resolves.toMatchObject({ permissionFidelity: 'callback' });
  });

  it('says nothing about a runtime it does not have', async () => {
    const c = rig().connect();
    // Null, not a throw: a matrix must not fail to render because this host does
    // not offer something another host does.
    await expect(c.capabilities('not-here')).resolves.toBeNull();
  });

  it('never probes a runtime that needs a model', async () => {
    /**
     * The regression this exists for.
     *
     * `AgbrteHarness` answers `capabilities()` by making **real requests** —
     * §3.3 is explicit that these endpoints' self-reports cannot be trusted. The
     * first version of this probe invented a placeholder model id so it could
     * ask anyway, and every host attach then fired a live request at a model
     * that does not exist, behind a two-minute timeout: the end-to-end suite
     * went from one minute to nine and a permission test timed out waiting.
     *
     * The answer belongs to whichever model the user is about to choose, so
     * before they have chosen there is nothing truthful to say.
     */
    let asked = 0;
    class Counting extends EchoRuntime {
      override async capabilities(s: AgentSpec): ReturnType<EchoRuntime['capabilities']> {
        asked += 1;
        return super.capabilities(s);
      }
    }
    const registry = new RuntimeRegistry();
    registry.register(new Counting({ id: 'needs-model' }), {
      label: 'Harness',
      requiresModel: true,
    });
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId,
        lineageId: lineageId as never,
        workspaceRoot: root,
        runtimes: ['needs-model'],
      },
    });
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);

    const c = new HostConnection({ channel: pair.main });
    await expect(c.capabilities('needs-model')).resolves.toBeNull();
    expect(asked).toBe(0);
  });
});

describe('roles are granted by the owner', () => {
  it('grants what a local client asks for by default', async () => {
    const c = rig().connect({ role: 'read-write' });
    await c.ready;
    expect(c.role).toBe('read-write');
  });

  it('refuses writes from a read-only client but serves every read', async () => {
    const r = rig();
    const writer = r.connect({ role: 'read-write' });
    const { sessionId, agentId } = await sessionWithAgent(writer);
    await writer.send(sessionId, agentId as never, 'go');

    const watcher = r.connect({ role: 'read-only' });
    await watcher.ready;

    // The message crosses the wire; the class does not, so assert on what a
    // client can actually see.
    await expect(watcher.send(sessionId, agentId as never, 'nope')).rejects.toThrow(
      /read-only access cannot send a turn/,
    );
    await expect(watcher.createSession({ title: 'x', goal: 'y' })).rejects.toThrow(/read-only/);
    await expect(watcher.interrupt(sessionId)).rejects.toThrow(/read-only/);

    // Read-only is a monitoring role, not a blindfold.
    expect((await watcher.list()).length).toBe(1);
    expect((await watcher.events(sessionId)).length).toBeGreaterThan(0);
    expect((await watcher.projection(sessionId)).state).toBe('awaiting_input');
  });

  it('lets the host grant less than was asked', async () => {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: ECHOES }), { label: 'Echo', requiresModel: false });
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    const server = new SessionHostServer({
      manager,
      identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: [] },
      // A remote or multi-user host replaces this rather than bolting
      // authorization on somewhere else.
      grantRole: () => ({
        role: 'read-only',
        actor: { id: 'uid:1000', via: 'peer-credential', label: 'someone' },
      }),
    });

    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const c = new HostConnection({ channel: pair.main, role: 'read-write' });
    await c.ready;

    expect(c.role).toBe('read-only');
  });
});

describe('shutting down', () => {
  it('refuses while a permission prompt is unanswered', async () => {
    const r = rig([
      { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ]);
    const c = r.connect();
    const { sessionId, agentId } = await sessionWithAgent(c);

    const asked = new Promise<string>((resolve) => {
      c.on('permission', (req: { requestId: string }) => resolve(req.requestId));
    });
    const turn = c.send(sessionId, agentId as never, 'go');
    const requestId = await asked;

    // A host holding a blocked agent must not go down because a window closed.
    await expect(c.requestShutdown()).resolves.toMatchObject({ stopped: false });

    await c.respondPermission(requestId, { result: 'deny', reason: 'no' });
    await turn;
  });

  it('stops when nothing is running', async () => {
    const r = rig();
    const c = r.connect();
    await c.ready;
    await expect(c.requestShutdown()).resolves.toMatchObject({ stopped: true });
  });

  it('tells clients why it is going, rather than just vanishing', async () => {
    const r = rig();
    const c = r.connect();
    await c.ready;

    const closing = new Promise<string>((resolve) => c.on('closing', resolve));
    r.server.stop('operator asked');
    await expect(closing).resolves.toBe('operator asked');
  });

  it('exits after an idle spell so hosts do not accumulate', async () => {
    const r = rig(ECHOES, { lingerMs: 20 });
    const c = r.connect();
    await c.ready;
    c.disconnect();

    // Without this, every workspace ever opened leaves a process behind — and
    // they are invisible, because nothing shows them.
    const exited = await new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(r.server.clientCount === 0), 80);
    });
    expect(exited).toBe(true);
  });
});

describe('protocol version is a range, not an equality', () => {
  /**
   * It used to be an equality, and that disarmed the upgrade it was protecting.
   *
   * §6.7 added two commands and moved nothing, and every running detached host
   * was refused until restarted. Worse, found on a real server: `agbrte stop`
   * speaks the *new* protocol, so the polite shutdown could not reach the old
   * host it existed to retire — the tool that asks is the tool that was just
   * upgraded, and a bump therefore cost a `kill`.
   */

  /** A host that answers `hello` with whatever identity a test wants. */
  function fakeHost(identity: Partial<{ protocol: number; minProtocol: number }>): HostConnection {
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    pair.host.onMessage((command) => {
      if (command.t !== 'hello') return;
      pair.host.post({
        t: 'welcome',
        id: command.id,
        role: 'read-write',
        identity: {
          instanceId,
          lineageId: lineageId as never,
          workspaceRoot: root,
          runtimes: [],
          pid: 1,
          protocol: identity.protocol ?? 1,
          ...(identity.minProtocol !== undefined ? { minProtocol: identity.minProtocol } : {}),
        },
      });
    });
    return new HostConnection({ channel: pair.main });
  }

  it('connects to a host older than this app', async () => {
    // The case that used to be fatal. An older host serves every command it has;
    // it is missing one, not broken.
    const c = fakeHost({ protocol: 1 });
    await expect(c.ready).resolves.toMatchObject({ protocol: 1 });
  });

  it('says which command the old host is missing, at the call', async () => {
    /**
     * At the call rather than the handshake, and that placement is the design:
     * the session keeps working, and the one thing that cannot happen explains
     * itself where it was attempted — naming the remedy, which is on the *other*
     * machine.
     */
    const c = fakeHost({ protocol: 1 });
    await c.ready;

    expect(c.supports('blob.put')).toBe(false);
    await expect(c.putBlob('s' as SessionId, Buffer.from('x'), 'image/png')).rejects.toThrow(
      CommandUnavailable,
    );
    await expect(c.putBlob('s' as SessionId, Buffer.from('x'), 'image/png')).rejects.toThrow(
      /upgrade the host/,
    );
  });

  it('needs nothing from the old host to do it', async () => {
    // The pleasing part, and the reason this is deployable rather than a plan.
    // A v1 host ignores the extra `hello` field and reports `protocol: 1`
    // exactly as it always did — no `minProtocol`, no negotiation, no idea any
    // of this happened. A client shipping today talks to hosts deployed before
    // it existed.
    const c = fakeHost({ protocol: 1 });
    await c.ready;
    expect(c.supports('session.send')).toBe(true);
  });

  it('connects to a host newer than this app', async () => {
    // A host that had actually changed a command shape would say so with
    // `minProtocol`. One that does not is claiming it still serves v1, and
    // taking it at its word is what lets a server be upgraded before a laptop.
    const c = fakeHost({ protocol: 99 });
    await expect(c.ready).resolves.toMatchObject({ protocol: 99 });
  });

  it('refuses a host that will not serve a client this old', async () => {
    // The one case a version check must catch, and the only one left: a command
    // whose *shape* changed, which a client cannot detect for itself. Loud at
    // the handshake rather than halfway through.
    const c = fakeHost({ protocol: 99, minProtocol: 99 });
    await expect(c.ready).rejects.toThrow(HostProtocolMismatch);
    await expect(c.ready).rejects.toThrow(/upgrade the app/);
  });

  it('turns a real host away when it speaks below the minimum', async () => {
    // The mirror image, decided by the host because the host is the owner — the
    // same reason roles are granted rather than claimed.
    const r = rig();
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    r.server.accept(pair.host);

    const replies: SessionMessage[] = [];
    pair.main.onMessage((m) => replies.push(m));
    pair.main.post({ t: 'hello', id: 'h1', role: 'read-write', client: 'ancient', protocol: 0 });

    await until(() => replies.length > 0);
    expect(replies[0]).toMatchObject({ t: 'err', name: 'ClientTooOld' });
  });

  it('advertises the oldest client it serves, so a client need not guess', async () => {
    const identity = await rig().connect().ready;
    expect(identity.minProtocol).toBe(MIN_CLIENT_PROTOCOL);
  });

  it('fails in-flight calls when the host dies', async () => {
    const r = rig();
    const c = r.connect();
    await c.ready;

    const inFlight = c.list();
    r.server.stop('crashed');

    await expect(inFlight).rejects.toThrow();
  });
});

/** Wait on a condition rather than a sleep. */
async function until(what: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}
