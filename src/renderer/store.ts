/**
 * Renderer state (DESIGN.md §7, §14).
 *
 * The one constraint that shapes this file: **the renderer holds a windowed
 * projection over the log, never the whole thing.** A week-long session's
 * transcript can be hundreds of megabytes, and keeping it in a React store
 * turns a long-running session into a 2 GB heap. Events past `WINDOW` are
 * dropped from memory; they remain in the log and are refetchable.
 *
 * Acking is what makes the drop safe. Main pauses forwarding when we fall
 * behind and flags the resulting gap, and `applyBatch` refetches on that flag
 * rather than silently rendering a discontinuous transcript.
 */

import { create } from 'zustand';
import type {
  EventBatch,
  HostInfo,
  RuntimeInfo,
  SessionSnapshot,
  SshHostInfo,
} from '../shared/ipc/contract.js';
import type { GilmokEvent, PermissionRequest, Session } from '../shared/types/index.js';

/** Events retained in memory. Chosen to comfortably exceed a screenful. */
const WINDOW = 400;

export interface GilmokState {
  /** Every attached host. Several at once is the normal case (§8). */
  hosts: HostInfo[];
  /** Runtimes per host, keyed by instanceId — hosts need not agree. */
  runtimesByHost: Record<string, RuntimeInfo[]>;
  sessions: Session[];
  onDisk: Array<{ instanceId: string; sessionId: string; title: string; goal: string }>;
  activeId: string | null;
  active: Session | null;
  events: GilmokEvent[];
  /** Set when a gap was detected and a refetch is in flight. */
  refetching: boolean;
  pending: PermissionRequest[];
  /** Turns waiting behind the running one, possibly sent from another device. */
  queued: number;
  busy: boolean;
  error: string | null;

  /** Machines from the user's ssh config, loaded when the attach panel opens. */
  sshHosts: SshHostInfo[];

  boot(): Promise<void>;
  addHost(): Promise<void>;
  loadSshHosts(): Promise<void>;
  addRemoteHost(alias: string, workspaceRoot: string): Promise<boolean>;
  removeHost(instanceId: string): Promise<void>;
  /** Ask a host to exit. Returns false when it refused because work is running. */
  shutdownHost(instanceId: string): Promise<boolean>;
  createSession(instanceId: string, title: string, goal: string): Promise<void>;
  openSession(sessionId: string, instanceId?: string): Promise<void>;
  addAgent(runtimeId: string, modelId: string | null): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, allow: boolean): Promise<void>;
  applyBatch(batch: EventBatch): void;
  applySession(session: Session): void;
  applyPermission(request: PermissionRequest): void;
  applyHosts(hosts: HostInfo[]): void;
  dismissError(): void;
}

const gilmok = () => window.gilmok;

/** Anything thrown by an IPC call becomes visible rather than swallowed. */
async function guard<T>(set: SetState, fn: () => Promise<T>): Promise<T | undefined> {
  set({ busy: true, error: null });
  try {
    return await fn();
  } catch (err) {
    set({ error: err instanceof Error ? err.message : String(err) });
    return undefined;
  } finally {
    set({ busy: false });
  }
}

type SetState = (partial: Partial<GilmokState>) => void;

function applySnapshot(set: SetState, snapshot: SessionSnapshot): void {
  set({
    active: snapshot.session,
    activeId: snapshot.session.sessionId,
    events: snapshot.recent.slice(-WINDOW),
    queued: snapshot.queued,
    refetching: false,
  });
}

export const useGilmok = create<GilmokState>((set, get) => ({
  hosts: [],
  sshHosts: [],
  runtimesByHost: {},
  sessions: [],
  onDisk: [],
  activeId: null,
  active: null,
  events: [],
  refetching: false,
  pending: [],
  queued: 0,
  busy: false,
  error: null,

  async boot() {
    await guard(set, async () => {
      const [hosts, sessions, onDisk, pending] = await Promise.all([
        gilmok().hosts.list(),
        gilmok().sessions.list(),
        gilmok().sessions.listOnDisk(),
        gilmok().permissions.pending(),
      ]);
      set({ hosts, sessions, onDisk, pending });
      await get().applyHosts(hosts);
    });
  },

  async addHost() {
    const host = await guard(set, () => gilmok().hosts.add());
    // Null means the picker was cancelled, which is not a failure.
    if (host === undefined || host === null) return;
    await get().boot();
  },

  async loadSshHosts() {
    // Failing to read a config is not a reason to block the panel — the user can
    // still type an alias that `ssh` knows about from somewhere else.
    try {
      set({ sshHosts: await gilmok().hosts.sshHosts() });
    } catch {
      set({ sshHosts: [] });
    }
  },

  async addRemoteHost(alias, workspaceRoot) {
    const host = await guard(set, () => gilmok().hosts.addRemote(alias, workspaceRoot));
    if (host === undefined) return false;
    await get().boot();
    return true;
  },

  async shutdownHost(instanceId) {
    let stopped = false;
    await guard(set, async () => {
      const result = await gilmok().hosts.shutdown(instanceId);
      stopped = result.stopped;
      if (!stopped) {
        // Surfaced as an error banner rather than swallowed: the user pressed
        // stop and it did not stop, and the reason is the useful part. Refusing
        // while an agent is mid-turn is correct behaviour, not a fault.
        throw new Error(`host still running — ${result.reason ?? 'work is in flight'}`);
      }
      set({ activeId: null, events: [] });
    });
    return stopped;
  },

  async removeHost(instanceId) {
    await guard(set, async () => {
      await gilmok().hosts.remove(instanceId);
      // Anything open on that host is gone with it; drop the selection rather
      // than leave a pane pointing at a session nothing can answer for.
      const active = get().active;
      if (active !== null && active.instanceId === instanceId) {
        set({ active: null, activeId: null, events: [] });
      }
      await get().boot();
    });
  },

  async createSession(instanceId, title, goal) {
    const session = await guard(set, () =>
      gilmok().sessions.create({ instanceId, title, goal }),
    );
    if (!session) return;
    set({ sessions: [...get().sessions, session] });
    await get().openSession(session.sessionId, instanceId);
  },

  async openSession(sessionId, instanceId) {
    await guard(set, async () => {
      const loaded = get().sessions.some((s) => s.sessionId === sessionId);
      // A session listed from disk is not loaded yet. Resuming is what rebuilds
      // it from the log — the restart path (§15 Phase 1) — and it has to be
      // resumed on the host that owns it.
      if (!loaded) {
        const owner =
          instanceId ?? get().onDisk.find((s) => s.sessionId === sessionId)?.instanceId;
        if (owner === undefined) throw new Error('no host is known to own that session');
        await gilmok().sessions.resume(owner, sessionId);
      }
      applySnapshot(set, await gilmok().sessions.snapshot(sessionId));
      set({ sessions: await gilmok().sessions.list() });
    });
  },

  async addAgent(runtimeId, modelId) {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, async () => {
      await gilmok().sessions.addAgent({
        sessionId,
        role: 'lead',
        runtimeId,
        ...(modelId !== null && modelId !== ''
          ? { model: { providerId: 'openai-compatible', modelId } }
          : {}),
      });
      applySnapshot(set, await gilmok().sessions.snapshot(sessionId));
    });
  },

  async send(text) {
    const { activeId, active } = get();
    const agentId = active?.agents[0]?.agentId;
    if (activeId === null || agentId === undefined) return;

    // Not wrapped in `busy`: a turn can run for minutes, and blocking the whole
    // UI on it would make the transcript that arrives during the turn
    // unreadable. Failures still surface.
    try {
      set({ error: null });
      await gilmok().sessions.send({ sessionId: activeId, agentId, text });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      applySnapshot(set, await gilmok().sessions.snapshot(activeId));
      set({ sessions: await gilmok().sessions.list() });
    }
  },

  async interrupt() {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, () => gilmok().sessions.interrupt(sessionId));
  },

  async respond(requestId, allow) {
    await guard(set, async () => {
      const outcome = await gilmok().permissions.respond(
        requestId,
        allow ? { result: 'allow', scope: 'once' } : { result: 'deny', reason: 'denied by user' },
      );
      // The prompt goes either way. Another device answering first, or the agent
      // stopping and the request being withdrawn, are both reasons to stop
      // showing it — and neither is an error this client should see.
      set({ pending: get().pending.filter((p) => p.requestId !== requestId) });
      if (outcome === 'already-answered') {
        set({ error: 'Answered on another device.' });
      }
    });
  },

  applyBatch(batch) {
    const { activeId, events, refetching } = get();
    if (batch.sessionId !== activeId) return;

    if (batch.paused && !refetching) {
      // Main withheld events while we were behind. Rendering the new batch on
      // top of the old would produce a transcript with an invisible hole, so
      // refetch from where our window starts.
      set({ refetching: true });
      const from = events.at(-1)?.seq ?? 0;
      void gilmok()
        .sessions.since(batch.sessionId, from)
        .then((missed) => {
          const merged = [...events, ...missed, ...batch.events];
          set({ events: dedupe(merged).slice(-WINDOW), refetching: false });
        })
        .catch(() => set({ refetching: false }));
      return;
    }

    const merged = dedupe([...events, ...batch.events]).slice(-WINDOW);
    set({ events: merged });

    // Ack the highest seq we now hold, which is what lets main resume
    // forwarding if it had paused.
    if (batch.lastSeq >= 0) gilmok().ack(batch.sessionId, batch.lastSeq);
  },

  applySession(session) {
    set({
      sessions: get().sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
      ...(session.sessionId === get().activeId ? { active: session } : {}),
    });
  },

  applyPermission(request) {
    set({ pending: [...get().pending, request] });
  },

  applyHosts(hosts) {
    set({ hosts });
    // Runtimes are per host and fetched lazily: a host that has not finished
    // handshaking reports none, and asking again after it does is cheap.
    void Promise.all(
      hosts.map(async (h) => [h.instanceId, await gilmok().hosts.runtimes(h.instanceId)] as const),
    ).then((pairs) => set({ runtimesByHost: Object.fromEntries(pairs) }));
  },

  dismissError() {
    set({ error: null });
  },
}));

/**
 * Drop duplicate seqs, keeping order.
 *
 * A refetch deliberately overlaps what we already hold — asking for events
 * *after* our last seq risks missing one if the window boundary moved — so
 * overlap is expected and must not render twice.
 */
function dedupe(events: GilmokEvent[]): GilmokEvent[] {
  const seen = new Set<number>();
  const out: GilmokEvent[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
