/**
 * Restarting a host onto the bundle the app ships (DESIGN.md §6.3, §6.4).
 *
 * `hosts.update` → `Fleet.updateHost` is the one control that deliberately
 * takes a running host down and expects another to be there afterwards, and it
 * is the only one whose *failure* mode is the user losing sight of every session
 * on a machine. So it is tested against **real detached processes** rather than
 * an in-memory server: the whole difficulty is the interval between a host
 * answering `{stopped:true}` and its listener actually closing, and an
 * in-memory channel has no such interval — it closes the moment it is asked to.
 *
 * The reported failure was exactly that interval. The old host replies, the
 * fleet forgets it, `attach` reconnects on the same socket path, reaches the
 * process on its way out, and `ready` rejects with "peer ended the connection" —
 * leaving the sidebar reading "No hosts attached yet" with nothing attached and
 * no further attempt made.
 *
 * Needs `npm run build`, since the host is started by running the built bundle.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOwnMachine } from './support/machineHome.js';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Fleet } from '@main/fleet.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import { SessionHostServer, type HostSelfDescription } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { processAlive, readMachineRecord } from '../src/host/discovery.js';
import { until } from './support/until.js';
import { createApi } from '@main/ipc/api.js';
import { CH } from '@shared/ipc/contract.js';
import type { HostInfo } from '@shared/ipc/contract.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AgentId, InstanceId, Session, SessionId } from '@shared/types/index.js';

/*
 * Its own machine directory per test (§8).
 *
 * This suite starts real hosts, and a host is one per machine — so without this
 * every test here would share one with every other test in the run, and a case
 * asserting that *nothing* is listening would be handed one that a previous case
 * left lingering. See `support/machineHome.ts`.
 */
useOwnMachine();

const HOST_BUNDLE = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');
const RUNTIMES = [{ id: 'echo', label: 'Echo', version: '1', model: 'none' as const }];

let roots: string[] = [];
let fleets: Fleet[] = [];

async function built(): Promise<boolean> {
  try {
    await access(HOST_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-update-'));
  roots.push(root);
  return root;
}

beforeEach(() => {
  roots = [];
  fleets = [];
});

afterEach(async () => {
  for (const fleet of fleets) {
    for (const host of fleet.hosts()) {
      // Stop the real process, not just the link: a leaked host holds the temp
      // directory open and outlives the run by design.
      await fleet.shutdownHost(host.instanceId as InstanceId).catch(() => undefined);
    }
    await fleet.detachAll();
  }
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** A fleet that starts and reaches genuine detached host processes. */
function realFleet(): Fleet {
  const fleet = new Fleet({
    runtimes: RUNTIMES,
    maxBackoffMs: 50,
    connect: ({ workspaceRoot }) =>
      connectOrSpawnHost({
        workspaceRoot,
        hostEntry: HOST_BUNDLE,
        // Node, not Electron: this suite runs under Vitest.
        execPath: process.execPath,
        startupTimeoutMs: 20_000,
      }),
  });
  fleets.push(fleet);
  return fleet;
}

describe('updating a host, against real processes', () => {
  it('ends attached with its sessions listable, every time, twelve times over', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);

    const root = await makeRoot();
    const fleet = realFleet();
    const attached = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });
    const instanceId = attached.instanceId;

    // Something durable to look for afterwards. Sessions live in the log, so a
    // replacement host has to find it there — which is the claim `updateHost`
    // makes when it says the update costs the turn and not the work.
    const session = await fleet.createSession(instanceId, {
      title: 'survives updates',
      goal: 'be here afterwards',
    });

    const seen: number[] = [attached.pid];
    const detached: string[] = [];
    fleet.on('detached', (_id: unknown, reason: unknown) => detached.push(reason as string));

    for (let round = 1; round <= 12; round += 1) {
      const host = await fleet.updateHost(instanceId);

      // The point of the whole exercise: attached, on the same identity, with a
      // live link. Anything else is the reported bug.
      expect(host.instanceId, `round ${round}`).toBe(instanceId);
      expect(host.link, `round ${round}`).toBe('connected');
      expect(fleet.hosts().map((h) => h.instanceId), `round ${round}`).toEqual([instanceId]);

      /*
       * A genuinely new process, or the update did nothing.
       *
       * Against the pid it **replaced**, which is the claim `updateHost` makes.
       * This used to be against every pid ever seen, and that is a claim about
       * the operating system rather than about this code: thirteen short-lived
       * processes in a few seconds, and a pid from round three is free to come
       * back at round eleven. It did, on the machine this was rerun on. The same
       * fact is already written down in `discovery.ts`, which refuses to use a
       * live pid as evidence that a host is running for exactly this reason —
       * the socket answers that question, and a pid is a diagnostic.
       *
       * The history is still carried, because it is what makes the failure
       * readable: "same as the one it replaced" is a bug in the update, and that
       * is what this now says.
       */
      expect(host.pid, `round ${round}: the update returned the host it replaced`).not.toBe(
        seen[seen.length - 1],
      );
      expect(processAlive(host.pid), `round ${round}`).toBe(true);

      /*
       * And the one it replaced is **gone**, checked here rather than at the end.
       *
       * The end-of-test version swept every pid the run had ever seen, which is
       * unsound for the reason above — a reused pid belongs to a stranger and
       * counts as alive. Asked immediately after the replacement, about the one
       * process that has just been asked to stop, the window in which a pid could
       * be reused by something unrelated is milliseconds rather than a minute.
       *
       * It is worth asking at all because the failure is real and has happened:
       * `stop()` once closed a host's clients and left the process running, so a
       * host reported as replaced was still there holding the workspace.
       */
      const replaced = seen[seen.length - 1]!;
      await until(
        async () => !processAlive(replaced),
        15_000,
        () => `round ${round}: the host it replaced (pid ${replaced}) is still running`,
      );
      seen.push(host.pid);

      /*
       * And it can be talked to, not merely listed — and it still owns the
       * session, which is the claim `updateHost` makes about what an update
       * costs. On disk rather than live: a restarted host has resumed nothing
       * yet (§5.4), exactly as one started this morning has not, and a session
       * it can enumerate is a session it can resume.
       */
      const onDisk = await fleet.listOnDisk();
      expect(onDisk.map((s) => s.sessionId), `round ${round}`).toContain(session.sessionId);
    }

    // Resumed once at the end, which is the stronger claim: the replacement host
    // reads that log and serves the session, rather than merely seeing a folder.
    const resumed = await fleet.resumeSession(instanceId, session.sessionId);
    expect(resumed.title).toBe('survives updates');
    expect((await fleet.list()).map((s) => s.sessionId)).toContain(session.sessionId);

    /*
     * One host serves this machine, and it is the one the fleet is talking to.
     *
     * Asked of the *record* rather than of a list of pids, which is what the
     * socket already guarantees and a pid cannot: a second host on this machine
     * could not have bound the socket, and §6.4's rule is that the record is a
     * hint while the socket is the truth — so the useful question is whether the
     * hint agrees with the process the fleet ended up attached to.
     */
    const record = await readMachineRecord();
    expect(record?.pid, 'the machine record names a different host').toBe(fleet.hosts()[0]?.pid);
    expect(detached, 'the user lost the host at some point').toEqual([]);
  }, 300_000);

  it('keeps the other folders on that machine, because they share the process', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first`);

    /*
     * A host is one per **machine** and holds several folders (§8), so restarting
     * one folder's host restarts them all — they share the process, not merely
     * the computer.
     *
     * `onClosing` reads `updating` to tell "the host is going away" from "the
     * host is going away *because we are restarting it*". Those are the same
     * event with opposite meanings, and only the entry being updated carried the
     * flag — so every sibling took the first reading and was **forgotten**.
     * Updating one project dropped the others out of the sidebar, mid-turn, with
     * their sessions perfectly intact and nothing on screen saying why.
     */
    const first = await makeRoot();
    const second = await makeRoot();
    const fleet = realFleet();

    const a = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: first });
    const b = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: second });

    // One process, two folders — which is the premise, and worth asserting
    // before the behaviour that depends on it.
    expect(b.pid).toBe(a.pid);
    expect(b.machineId).toBe(a.machineId);

    const session = await fleet.createSession(b.instanceId, {
      title: 'in the other folder',
      goal: 'still here afterwards',
    });

    const lost: string[] = [];
    fleet.on('detached', (id: unknown) => lost.push(id as string));

    await fleet.updateHost(a.instanceId);

    // Neither was dropped, and the sibling comes back on its own rather than
    // needing a second button.
    expect(lost, 'a workspace was forgotten because its neighbour was updated').toEqual([]);
    await until(() => fleet.hosts().every((h) => h.link === 'connected'), 30_000);
    expect(fleet.hosts().map((h) => h.instanceId).sort()).toEqual(
      [a.instanceId, b.instanceId].sort(),
    );

    // And the sibling's folder was reopened by the replacement, so its session
    // is readable again — an entry listed but unserved would be the same bug
    // wearing a link badge.
    const onDisk = await fleet.listOnDisk();
    expect(onDisk.map((s) => s.sessionId)).toContain(session.sessionId);
  }, 180_000);

  it('leaves nothing attached only if it says so, when the replacement cannot start', async () => {
    if (!(await built())) return;

    const root = await makeRoot();
    let entry = HOST_BUNDLE;
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      maxBackoffMs: 50,
      // Short, because this test *wants* the window to run out. The background
      // dial that outlives it is the part under test, not the wait.
      updateWindowMs: 3_000,
      connect: ({ workspaceRoot }) =>
        connectOrSpawnHost({
          workspaceRoot,
          hostEntry: entry,
          execPath: process.execPath,
          startupTimeoutMs: 5_000,
        }),
    });
    fleets.push(fleet);

    const attached = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });
    // The bundle disappears between the stop and the restart — a deploy that
    // half-landed, or an app directory replaced under a running host.
    entry = join(root, 'no-such-bundle.js');

    await expect(fleet.updateHost(attached.instanceId)).rejects.toThrow(
      /stopped this host to update it, and the replacement did not come up/i,
    );

    // The failure is a sentence, not an empty sidebar. The machine stays listed
    // as reconnecting with a dial still running behind it, so putting the bundle
    // back is all it takes — no second button, no lost view of the workspace.
    expect(fleet.hosts()).toHaveLength(1);
    expect(fleet.hosts()[0]!.link).toBe('reconnecting');

    // And that dial is real: restore the bundle and the host returns by itself.
    entry = HOST_BUNDLE;
    await until(() => fleet.hosts()[0]?.link === 'connected', 30_000);
    expect(fleet.hosts()[0]!.instanceId).toBe(attached.instanceId);
  }, 120_000);
});

/**
 * The loop `updateHost` borrows, cut for real.
 *
 * `redial` was factored out of `reconnect` so an update could put a deadline on
 * it, which means a dropped link now runs code an update shares. Reasoning that
 * the refactor is behaviour-preserving is not evidence, and the in-memory
 * reconnect suite cannot supply it either: what it cuts is an object reference.
 * So this cuts a real named pipe to a real process, mid-turn, and asks §15's
 * question — **zero event loss, zero duplication** — of what actually arrived.
 */
describe('a link cut for real, mid-turn', () => {
  it('comes back to the same process with no gap and no repeat', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first`);

    const root = await makeRoot();
    // Captured so the test can destroy the socket the way a dying tunnel does.
    // Reassigned on every dial, so a later cut kills the *current* one.
    let live: HostConnection | null = null;
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      maxBackoffMs: 50,
      connect: async ({ workspaceRoot }) => {
        live = await connectOrSpawnHost({
          workspaceRoot,
          hostEntry: HOST_BUNDLE,
          execPath: process.execPath,
          startupTimeoutMs: 20_000,
        });
        return live;
      },
    });
    fleets.push(fleet);

    const attached = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });
    const seen: number[] = [];
    fleet.on('event', (_i: unknown, _s: unknown, event: { seq: number }) => seen.push(event.seq));
    const links: string[] = [];
    fleet.on('link', (_i: unknown, state: unknown) => links.push(state as string));

    const session = await fleet.createSession(attached.instanceId, { title: 'cut', goal: 'g' });
    const agent = await fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    /*
     * A queue of turns rather than one, so the host is *writing* across the cut
     * and across the reconnect. That interval is the whole point: a host with
     * nothing to say while the link is down makes every reconnect look correct,
     * and one that stops writing before the catch-up returns makes it look
     * correct too. Thirty because the failure needs an event produced inside a
     * single round trip, and a backlog long enough to outlast one is the only
     * way to ask for that without a hook in the code under test. Not awaited,
     * for the same reason — the work has to be in flight.
     */
    const turns: Array<Promise<unknown>> = [];
    const fire = (n: number): void => {
      for (let i = 0; i < n; i += 1) {
        turns.push(
          fleet
            .send(session.sessionId, agent.agentId as AgentId, `turn ${turns.length}`)
            .catch(() => undefined),
        );
      }
    };

    // Three cuts, each while the host has a backlog to get through.
    for (let cut = 1; cut <= 3; cut += 1) {
      fire(30);
      (live as HostConnection | null)?.disconnect();
      await until(() => links.filter((l) => l === 'reconnecting').length === cut, 15_000);
      // The *announcement*, not the field: `redial` flips `link` before it
      // replays what was missed, so waiting on the field would read `seen`
      // mid-catch-up.
      await until(() => links.filter((l) => l === 'connected').length === cut, 30_000);
    }
    await Promise.all(turns);

    // The link really went down and really came back, three times over.
    expect(links.filter((l) => l === 'reconnecting')).toHaveLength(3);
    // Same process throughout: the work never stopped, it was only unwatched.
    expect(fleet.hosts()[0]!.pid).toBe(attached.pid);

    /*
     * Quiet before comparing, and quiet on **both** sides.
     *
     * A turn accepted before the last cut can still be draining, so the log has
     * to stop growing first. That was the whole of this wait, and it was half of
     * the answer: the log is written by the host and the pushes arrive over the
     * socket, so the file can settle while the last push is still on the wire.
     * Compared then, a moment of lag reads exactly like loss.
     *
     * Measured rather than guessed: this failed once on a loaded macOS runner
     * with the *last* sequence number missing from the pushed list and every
     * earlier one present — the signature of lag, where real loss across a
     * reconnect leaves a hole in the middle.
     *
     * The claim is unchanged and still fails when it should: an event that never
     * arrives runs this wait out, and the diagnosis names both counts instead of
     * printing two long arrays.
     */
    let settled: number[] = [];
    await until(
      async () => {
        const now = (await fleet.events(session.sessionId)).map((e) => e.seq);
        const stopped = now.length === settled.length && now.length > 0;
        settled = now;
        if (!stopped) return false;
        const from = seen[0];
        return from !== undefined && seen.length === now.filter((s) => s >= from).length;
      },
      20_000,
      () => `the host wrote ${String(settled.length)} events and pushed ${String(seen.length)}`,
    );

    /*
     * Everything the host wrote from the first event this app saw reached it
     * exactly once, in order.
     *
     * "From the first event it saw" rather than "all of them", because
     * `session.created` is not pushed to anyone — the manager emits it before
     * this app has a way to be interested, and a new session reaches a client as
     * `push.session` rather than as an event. That is true with no cut at all
     * (measured), so asserting otherwise here would be this test failing for
     * something it is not about.
     */
    expect(seen).toEqual([...seen].sort((a, b) => a - b)); // in order
    expect(seen).toEqual([...new Set(seen)]); // and once each
    const first = seen[0]!;
    expect(first).toBeLessThanOrEqual(3);
    expect(seen).toEqual(settled.filter((s) => s >= first));
  }, 180_000);
});

/**
 * The neighbouring case: a host entitled to refuse.
 *
 * In memory rather than as a process, because what is under test is `updateHost`
 * believing a `{stopped:false}` answer — and a pending permission is the
 * deterministic way to produce one. The real-process suite above covers the
 * timing this cannot.
 */
describe('a host that will not stop', () => {
  async function busyRig() {
    const root = await makeRoot();
    const identity = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    const script: EchoStep[] = [
      { kind: 'tool', tool: 'bash', args: { command: 'ls' } },
      { kind: 'stop', stop: { kind: 'end_turn' } },
    ];
    registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
    });

    let dials = 0;
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      maxBackoffMs: 1,
      connect: async () => {
        dials += 1;
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    fleets.push(fleet);
    return { root, fleet, instanceId: identity.instanceId as InstanceId, dials: () => dials };
  }

  it('stays attached, and the refusal carries the host\'s own reason', async () => {
    const r = await busyRig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const session = await r.fleet.createSession(r.instanceId, { title: 'busy', goal: 'g' });
    const agent = await r.fleet.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    // Not awaited: `send` resolves when the turn ends, and the turn is exactly
    // what must still be in flight when the update is asked for.
    const turn = r.fleet.send(session.sessionId, agent.agentId as AgentId, 'go');
    // A permission the host is holding open is work in flight, and a host
    // holding work is entitled to say no.
    await until(async () => (await r.fleet.pendingPermissions()).length > 0);

    const before = r.dials();
    await expect(r.fleet.updateHost(r.instanceId)).rejects.toThrow(/work is still running/);

    // Nothing was stopped, so nothing needed reattaching — and the host the user
    // was watching is still the host they are watching.
    expect(r.fleet.hosts().map((h) => h.instanceId)).toEqual([r.instanceId]);
    expect(r.fleet.hosts()[0]!.link).toBe('connected');
    expect(r.dials(), 'a refused update must not dial anything').toBe(before);
    expect((await r.fleet.list()).map((s: { sessionId: SessionId }) => s.sessionId)).toEqual([
      session.sessionId,
    ]);

    // Let the held turn go, so the suite does not end with one outstanding.
    const [pending] = await r.fleet.pendingPermissions();
    await r.fleet.respondPermission(pending!.request.requestId, { result: 'deny', reason: 'no' });
    await turn;
  });
});

/**
 * The button, from the condition that shows it to the restart it asks for.
 *
 * Cheap end-to-end: the real IPC handlers over a real `Fleet`, which is every
 * layer between the renderer's `onClick` and the host except the click itself.
 * Worth having because this control was **unreachable for its whole life** —
 * `snapshot()` dropped `bundleVersion`, so `outdated` was permanently
 * `undefined`, the button never rendered, and the code behind it was never once
 * run. A test that only calls `updateHost` would have left that half untested
 * again, and it is the half that decides whether anybody ever presses it.
 */
describe('the Update button', () => {
  it('shows only for a host on another bundle, and stops showing after the restart', async () => {
    const root = await makeRoot();
    const workspace = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: workspace.instanceId,
    });

    // What the *next* host to start reports about itself: the deployed bundle,
    // which is the app's own version once the update has happened (§6.3a).
    let running = '0.0.1-old';
    const identity = (): HostSelfDescription => ({
      instanceId: workspace.instanceId,
      lineageId: workspace.lineageId,
      workspaceRoot: root,
      runtimes: ['echo'],
      endpoints: [],
      bundleVersion: running,
    });

    const fleet = new Fleet({
      runtimes: RUNTIMES,
      maxBackoffMs: 1,
      connect: async () => {
        // A fresh server per dial: a new *process* on the same workspace
        // identity, which is what a restart produces.
        const server = new SessionHostServer({ manager, identity: identity() });
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    fleets.push(fleet);

    const api = createApi({
      fleet,
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
      // The version this client would deploy — `app.getVersion()` in the app.
      shippingVersion: '0.0.2-new',
    });

    await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });

    const listed = async (): Promise<HostInfo> =>
      ((await api.handlers.get(CH.hostsList)!()) as HostInfo[])[0]!;

    // The condition the button is gated on, all the way through the IPC layer.
    expect((await listed()).outdated, 'the Update button would never render').toBe(true);

    // Pressing it. The host that starts next runs what was deployed.
    running = '0.0.2-new';
    await api.handlers.get(CH.hostsUpdate)!(workspace.instanceId);

    const after = await listed();
    expect(after.link).toBe('connected');
    expect(after.outdated, 'the button would still be offering an update that happened').toBe(
      false,
    );
    api.dispose();
  });
});

/**
 * What the window is looking at, after the process it was looking at is gone.
 *
 * The update now keeps the host attached — and that is what exposed this. A
 * replacement host starts with **nothing loaded**: sessions live in their logs
 * (§5.4) and are read on demand, so `session.list` on a host two hundred
 * milliseconds old is empty and correct. Every client-side cache of the previous
 * generation's list is then a description of a process that no longer exists,
 * and the reported symptom is both halves of that at once — a Needs-you card for
 * a session the sidebar did not list, and
 * `sessions.snapshot: unknown session <uuid>` on opening it.
 *
 * Driven through the real IPC handlers, because `sessions.snapshot` is the call
 * that failed and it is four routed reads in one; asking `Fleet` directly would
 * test a different function than the one in the error message.
 */
describe('the view after a host is replaced', () => {
  it('offers nothing it cannot open, and opens everything it offers', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first`);

    const root = await makeRoot();
    const fleet = realFleet();
    const api = createApi({
      fleet,
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
    });
    const attached = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });

    const made: string[] = [];
    for (const title of ['test', 'test2', 'test3']) {
      const session = await fleet.createSession(attached.instanceId, { title, goal: 'g' });
      made.push(session.sessionId);
    }
    // Seated, so the record the app caches is a substantial one rather than a
    // stub — this is the card that survived the swap in the report.
    await fleet.addAgent(made[0] as SessionId, { role: 'worker', runtimeId: 'echo' });

    const loaded = async (): Promise<Session[]> =>
      (await api.handlers.get(CH.sessionsList)!()) as Session[];
    const onDisk = async (): Promise<Array<{ sessionId: string }>> =>
      (await api.handlers.get(CH.sessionsListOnDisk)!()) as Array<{ sessionId: string }>;

    expect((await loaded()).map((s) => s.sessionId).sort()).toEqual([...made].sort());

    await api.handlers.get(CH.hostsUpdate)!(attached.instanceId);

    /*
     * The two lists agree, and they agree on "nothing is loaded".
     *
     * This is what the dashboard's rail is fed from, so an empty list here is
     * the rail being empty — which is the honest answer, because a summons
     * belongs to the process that raised it and that process has exited. §10's
     * rule is that the rail must never be wrong, and a card inherited from a
     * dead generation is the one kind of wrong it cannot recover from.
     */
    expect(await loaded()).toEqual([]);
    expect((await onDisk()).map((s) => s.sessionId).sort()).toEqual([...made].sort());
    expect(await api.handlers.get(CH.permissionsPending)!()).toEqual([]);

    // And every session the UI offers opens. This is the reported failure
    // exactly: one `sessions.snapshot` per card, on a host that has never heard
    // of any of them.
    for (const { sessionId } of await onDisk()) {
      const snapshot = (await api.handlers.get(CH.sessionsSnapshot)!(sessionId)) as {
        session: Session;
      };
      expect(snapshot.session.sessionId).toBe(sessionId);
    }

    // Opening them loaded them, which is what opening a session means — so the
    // lists now agree the other way round, with no second mechanism involved.
    expect((await loaded()).map((s) => s.sessionId).sort()).toEqual([...made].sort());
    // The seat survived the restart, because it was never in memory to lose.
    const reopened = (await loaded()).find((s) => s.sessionId === made[0]);
    expect(reopened?.agents).toHaveLength(1);
    api.dispose();
  }, 180_000);
});
