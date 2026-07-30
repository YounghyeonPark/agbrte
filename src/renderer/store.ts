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
  RuntimeInfo,
  SessionSnapshot,
  WorkspaceInfo,
} from '../shared/ipc/contract.js';
import type { LoomEvent, PermissionRequest, Session } from '../shared/types/index.js';

/** Events retained in memory. Chosen to comfortably exceed a screenful. */
const WINDOW = 400;

export interface LoomState {
  workspace: WorkspaceInfo | null;
  runtimes: RuntimeInfo[];
  sessions: Session[];
  onDisk: Array<{ sessionId: string; title: string; goal: string }>;
  activeId: string | null;
  active: Session | null;
  events: LoomEvent[];
  /** Set when a gap was detected and a refetch is in flight. */
  refetching: boolean;
  pending: PermissionRequest[];
  busy: boolean;
  error: string | null;

  boot(): Promise<void>;
  createSession(title: string, goal: string): Promise<void>;
  openSession(sessionId: string): Promise<void>;
  addAgent(runtimeId: string, modelId: string | null): Promise<void>;
  send(text: string): Promise<void>;
  interrupt(): Promise<void>;
  respond(requestId: string, allow: boolean): Promise<void>;
  applyBatch(batch: EventBatch): void;
  applySession(session: Session): void;
  applyPermission(request: PermissionRequest): void;
  dismissError(): void;
}

const loom = () => window.loom;

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

type SetState = (partial: Partial<LoomState>) => void;

function applySnapshot(set: SetState, snapshot: SessionSnapshot): void {
  set({
    active: snapshot.session,
    activeId: snapshot.session.sessionId,
    events: snapshot.recent.slice(-WINDOW),
    refetching: false,
  });
}

export const useLoom = create<LoomState>((set, get) => ({
  workspace: null,
  runtimes: [],
  sessions: [],
  onDisk: [],
  activeId: null,
  active: null,
  events: [],
  refetching: false,
  pending: [],
  busy: false,
  error: null,

  async boot() {
    await guard(set, async () => {
      const [workspace, runtimes, sessions, onDisk, pending] = await Promise.all([
        loom().workspace.current(),
        loom().runtimes.list(),
        loom().sessions.list(),
        loom().sessions.listOnDisk(),
        loom().permissions.pending(),
      ]);
      set({ workspace, runtimes, sessions, onDisk, pending });
    });
  },

  async createSession(title, goal) {
    const session = await guard(set, () => loom().sessions.create({ title, goal }));
    if (!session) return;
    set({ sessions: [...get().sessions, session] });
    await get().openSession(session.sessionId);
  },

  async openSession(sessionId) {
    await guard(set, async () => {
      const loaded = get().sessions.some((s) => s.sessionId === sessionId);
      // A session listed from disk is not loaded yet. Resuming is what rebuilds
      // it from the log — the restart path (§15 Phase 1).
      if (!loaded) await loom().sessions.resume(sessionId);
      applySnapshot(set, await loom().sessions.snapshot(sessionId));
      set({ sessions: await loom().sessions.list() });
    });
  },

  async addAgent(runtimeId, modelId) {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, async () => {
      await loom().sessions.addAgent({
        sessionId,
        role: 'lead',
        runtimeId,
        ...(modelId !== null && modelId !== ''
          ? { model: { providerId: 'openai-compatible', modelId } }
          : {}),
      });
      applySnapshot(set, await loom().sessions.snapshot(sessionId));
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
      await loom().sessions.send({ sessionId: activeId, agentId, text });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      applySnapshot(set, await loom().sessions.snapshot(activeId));
      set({ sessions: await loom().sessions.list() });
    }
  },

  async interrupt() {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, () => loom().sessions.interrupt(sessionId));
  },

  async respond(requestId, allow) {
    await guard(set, async () => {
      await loom().permissions.respond(
        requestId,
        allow ? { result: 'allow', scope: 'once' } : { result: 'deny', reason: 'denied by user' },
      );
      set({ pending: get().pending.filter((p) => p.requestId !== requestId) });
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
      void loom()
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
    if (batch.lastSeq >= 0) loom().ack(batch.sessionId, batch.lastSeq);
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
function dedupe(events: LoomEvent[]): LoomEvent[] {
  const seen = new Set<number>();
  const out: LoomEvent[] = [];
  for (const event of events) {
    if (seen.has(event.seq)) continue;
    seen.add(event.seq);
    out.push(event);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
