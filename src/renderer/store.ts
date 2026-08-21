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
  ReasoningMode,
  HostInfo,
  RuntimeInfo,
  SessionSnapshot,
  SshHostInfo,
  WorkspaceDiscoveryDto,
} from '../shared/ipc/contract.js';
import type {
  AgbrteEvent,
  ContentBlock,
  InboxEntry,
  MatrixCell,
  McpServerConfig,
  PermissionRequest,
  PermissionResolved,
  Session,
} from '../shared/types/index.js';

/** Events retained in memory. Chosen to comfortably exceed a screenful. */
const WINDOW = 400;

/**
 * What the attach panel knows about looking around one machine (§6.2).
 *
 * Three phases and one alias. `result` is the machine's own answer — which may
 * itself say `unavailable`, meaning it answered and cannot be asked — while
 * `error` is this client failing to reach it at all. Both are shown in the
 * panel; neither is an app-level failure.
 */
export interface DiscoveryState {
  alias: string;
  phase: 'looking' | 'done' | 'failed';
  result: WorkspaceDiscoveryDto | null;
  error: string | null;
}

export interface AgbrteState {
  /** Every attached host. Several at once is the normal case (§8). */
  hosts: HostInfo[];
  /** Runtimes per host, keyed by instanceId — hosts need not agree. */
  runtimesByHost: Record<string, RuntimeInfo[]>;
  /** The support matrix per host (§3.13). Empty until a host has answered. */
  conformanceByHost: Record<string, MatrixCell[]>;
  /** What happened while nobody was looking (§11), newest first. */
  inbox: InboxEntry[];
  refreshInbox(): Promise<void>;
  markInboxRead(): Promise<void>;
  sessions: Session[];
  onDisk: Array<{
    instanceId: string;
    sessionId: string;
    title: string;
    goal: string;
    group?: { groupId: string; name: string };
  }>;
  activeId: string | null;
  active: Session | null;
  events: AgbrteEvent[];
  /** Set when a gap was detected and a refetch is in flight. */
  refetching: boolean;
  pending: PermissionRequest[];
  /** A transient line about something that happened elsewhere. */
  notice: string | null;
  /** Turns waiting behind the running one, possibly sent from another device. */
  queued: number;
  busy: boolean;
  error: string | null;

  /** Machines from the user's ssh config, loaded when the attach panel opens. */
  sshHosts: SshHostInfo[];
  /**
   * The look-around for **one machine at a time**, in whatever state it is in.
   *
   * One field rather than three, because the panel has to render a search that
   * is running, one that answered, and one that could not — and the alias is
   * part of every one of them. A list of folders on `build-01` beside a field
   * that now says `laptop` is worse than no list: it looks current.
   */
  discovery: DiscoveryState | null;

  boot(): Promise<void>;
  addHost(): Promise<void>;
  /**
   * The native picker, an attach, and the host it produced (§6.2, §10).
   *
   * Separate from `addHost` only because it hands the host *back*: the one-shot
   * path in App.tsx has to create a session on the folder it just attached, and
   * searching `hosts` afterwards for "the new one" is a guess — attaching a
   * folder that is already attached adds nothing to that list.
   *
   * Which is not an error, and this is where that is decided: `fleet.attach` is
   * idempotent by `instanceId` and returns the host already running, so
   * re-choosing an attached folder reuses it. `null` covers a cancelled picker
   * and a failure alike; the second has already put a line in the error banner,
   * and the first is not a failure at all.
   */
  attachLocalHost(root?: string): Promise<HostInfo | null>;
  /**
   * Name a folder without opening it (§8).
   *
   * The native picker on its own, because choosing a folder and opening one are
   * now two acts: session creation asks which folder, shows what is already in
   * it, and only then commits. `null` for a cancelled picker or a failure the
   * banner already carries.
   */
  pickFolder(): Promise<string | null>;
  loadSshHosts(): Promise<void>;
  /**
   * Ask a machine what is on it (§6.2).
   *
   * Called by the panel on its own once a machine is chosen, so two properties
   * are not optional. **It never raises the error banner** — see below — and
   * **the last call wins**: an answer for a machine the user has since moved on
   * from is dropped rather than rendered under the new name.
   *
   * *When* to call it is `attachTrigger.ts`, which is pure and testable; this is
   * only what happens once that is decided.
   */
  discoverWorkspaces(alias: string): Promise<void>;
  /**
   * Forget the look-around, and abandon one that is in flight.
   *
   * Called when the machine changes and when the panel closes. The `ssh` on the
   * far side is not reachable from here — there is no cancel on that IPC, and it
   * is one bounded read-only command with its own kill — so this cancels the
   * *result*: nothing lands, and nothing is shown.
   */
  clearDiscovery(): void;
  addRemoteHost(alias: string, workspaceRoot: string): Promise<boolean>;
  /** The same, handing the host back so a caller can work in what it opened. */
  attachRemoteHost(alias: string, workspaceRoot: string): Promise<HostInfo | null>;
  removeHost(instanceId: string): Promise<void>;
  /** Ask a host to exit. Returns false when it refused because work is running. */
  shutdownHost(instanceId: string): Promise<boolean>;
  /** Restart a host onto the bundle this build ships (§6.3). */
  updateHost(instanceId: string): Promise<void>;
  /**
   * Create a session and open it, so the caller lands *in* it (§10).
   *
   * The open is part of this rather than a second call every caller makes,
   * which is what lets the one-shot path in App.tsx be a sequence of two.
   * A refusal is the error banner and no session; nothing to return either way.
   *
   * `mcpServers` is creation-only because the owner is (§17 Q20):
   * `SessionManager` attaches them in `createSession` and has no command to
   * attach one afterwards, so this is the single call that can carry them —
   * which is also why the values in `env` are handed straight to the IPC and
   * never kept in this store.
   */
  createSession(
    instanceId: string,
    title: string,
    goal: string,
    mcpServers?: McpServerConfig[],
  ): Promise<void>;
  openSession(sessionId: string, instanceId?: string): Promise<void>;
  /** Deselect, so a narrow screen can show the list again. */
  closeSession(): void;
  /**
   * Seat this session's agent, replacing the one there if there is one (§4.2).
   *
   * A session holds one model, so this is "add" on an empty session and
   * "change" on a seated one — the same call, because the host is what decides,
   * and a renderer that guessed would be a second rule to keep in step with the
   * first. True when the seat landed, which is what makes it worth remembering
   * as this host's default.
   */
  addAgent(runtimeId: string, modelId: string | null, endpointId?: string): Promise<boolean>;
  /** `to` addresses one agent in a roster; absent means the first (§4.2). */
  /**
   * A turn from the user, optionally carrying what they pointed at (§12).
   *
   * `blocks` are already stored on the owning host — `capture.grab` put them
   * there — so this call carries hashes rather than pixels however far away
   * that host is.
   */
  send(text: string, to?: string, blocks?: ContentBlock[]): Promise<void>;
  interrupt(): Promise<void>;
  /** Move a seat's reasoning effort (§3.4). Rejects loudly rather than silently. */
  setReasoning(agentId: string, mode: ReasoningMode): Promise<void>;
  /** Stored bytes as a `data:` URL, or null when they are gone (§12). */
  loadBlob(sha256: string, mime?: string): Promise<string | null>;
  respond(requestId: string, allow: boolean): Promise<void>;
  /** Answer a split an agent proposed on the open session (§4.3). */
  respondSplit(proposalId: string, approved: boolean): Promise<void>;
  /**
   * Put another session in a group with the open one (§17 Q22).
   *
   * `name` is used only when the open session has no group yet; when it has
   * one, the other session joins *that* group by id. Deciding here rather than
   * in the component keeps one place answering "which group is this".
   */
  groupWith(sessionId: string, name: string): Promise<void>;
  /** Take the open session out of its group. */
  leaveGroup(): Promise<void>;
  applyBatch(batch: EventBatch): void;
  applySession(session: Session): void;
  applyPermission(request: PermissionRequest): void;
  /** A prompt settled elsewhere, or withdrawn. Removes it and says why. */
  applyPermissionResolved(resolved: PermissionResolved): void;
  applyHosts(hosts: HostInfo[]): void;
  /**
   * Re-read which sessions exist, and where, from the hosts themselves.
   *
   * Narrower than `boot`, and deliberately not it: `boot` also re-lists hosts
   * and calls `applyHosts`, which is where this is called *from*.
   */
  reconcileSessions(): Promise<void>;
  dismissError(): void;
  dismissNotice(): void;
  /**
   * Say something that has to outlive the screen it happened on.
   *
   * One caller: an installed vendor CLI ends with a sign-in this app cannot
   * perform, and the agent is seated in the same press — which navigates away
   * from the pane the sentence was printed in. A follow-up that vanishes at the
   * moment it becomes actionable is the failure the whole set-up feature exists
   * to remove, in miniature: no error, and still nothing that runs.
   *
   * Deliberately the same slot the permission narration uses, rather than a
   * second banner: it is dismissible, it sits above whatever is open, and two
   * kinds of "something happened elsewhere" would be two things to keep in step.
   */
  say(notice: string): void;
}

const agbrte = () => window.agbrte;

/**
 * Which look-around is the current one.
 *
 * Module scope rather than store state because nothing renders it: it exists so
 * that a superseded answer can recognise itself as superseded, and putting it in
 * the store would invite a component to depend on a number that means nothing to
 * a person.
 */
let discoveryTicket = 0;

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

type SetState = (partial: Partial<AgbrteState>) => void;

/**
 * Adopt a snapshot without throwing away anything newer than it.
 *
 * A snapshot is authoritative about *a moment*, not about now. `send()` takes
 * one in its `finally`, and the turn is still running then — the IPC resolves
 * when the turn is accepted, not when it ends — so events keep arriving while
 * the request is in flight. Replacing the list wholesale erases exactly those,
 * leaving one row missing from the middle of a transcript that otherwise looks
 * complete. That does not read as data loss; it reads as the thing never having
 * happened, which is why it survived this long.
 *
 * The row it ate in a live run was `permission.decided … allow via policy`. §13
 * requires every decision be recorded and shown, and an audit trail missing an
 * allow is indistinguishable from a gate that was never consulted.
 *
 * Switching *to a different session* still replaces, because then the previous
 * events belong to something else entirely.
 */
function applySnapshot(set: SetState, get: () => AgbrteState, snapshot: SessionSnapshot): void {
  const sameSession = get().activeId === snapshot.session.sessionId;
  // `dedupe` sorts by seq, so a late snapshot slots in rather than appending.
  const events = sameSession
    ? dedupe([...get().events, ...snapshot.recent]).slice(-WINDOW)
    : snapshot.recent.slice(-WINDOW);

  set({
    active: snapshot.session,
    activeId: snapshot.session.sessionId,
    events,
    queued: snapshot.queued,
    refetching: false,
  });
}

export const useAgbrte = create<AgbrteState>((set, get) => ({
  hosts: [],
  sshHosts: [],
  discovery: null,
  runtimesByHost: {},
  conformanceByHost: {},
  inbox: [],
  sessions: [],
  onDisk: [],
  activeId: null,
  active: null,
  events: [],
  refetching: false,
  pending: [],
  notice: null,
  queued: 0,
  busy: false,
  error: null,

  async boot() {
    await guard(set, async () => {
      const [hosts, sessions, onDisk, pending] = await Promise.all([
        agbrte().hosts.list(),
        agbrte().sessions.list(),
        agbrte().sessions.listOnDisk(),
        agbrte().permissions.pending(),
      ]);
      set({ hosts, sessions, onDisk, pending });
      await get().applyHosts(hosts);
    });
  },

  async addHost() {
    // The attach panel wants the side effect and nothing else; the host it
    // produced is the one-shot path's business (see `attachLocalHost`).
    await get().attachLocalHost();
  },

  async pickFolder() {
    const chosen = await guard(set, () => agbrte().hosts.pickFolder());
    // `undefined` means it threw and `guard` has already put the reason in the
    // banner; `null` means the picker was cancelled, which is not a failure.
    return chosen === undefined ? null : chosen;
  },

  async attachLocalHost(root) {
    const host = await guard(set, () => agbrte().hosts.add(root));
    // `null` means the picker was cancelled and `undefined` means it threw —
    // neither leaves a host to work with, and only the second is a failure,
    // which `guard` has already put in the banner.
    if (host === undefined || host === null) return null;
    // Re-listed even when the folder was already attached: `boot` is also what
    // refreshes the sessions on disk, and a workspace attached elsewhere in the
    // meantime may have gained some.
    await get().boot();
    return host;
  },

  async loadSshHosts() {
    // Failing to read a config is not a reason to block the panel — the user can
    // still type an alias that `ssh` knows about from somewhere else.
    try {
      set({ sshHosts: await agbrte().hosts.sshHosts() });
    } catch {
      set({ sshHosts: [] });
    }
  },

  async discoverWorkspaces(alias) {
    /*
     * Deliberately **not** `guard`.
     *
     * `guard` is what puts a failure in the app's error banner, and the banner
     * is for things a person just tried to do. This search starts on its own the
     * moment a machine is named, so a sleeping build box or an expired key would
     * throw a red banner across the window at somebody who only clicked
     * "Remote" — an alarm about an action they did not take, over a field that
     * still works perfectly well by hand. The failure is carried on this state
     * instead and rendered as one line inside the panel.
     */
    const ticket = (discoveryTicket += 1);
    set({ discovery: { alias, phase: 'looking', result: null, error: null } });
    try {
      const result = await agbrte().hosts.discoverWorkspaces(alias);
      // The last call wins. Without this, a slow machine named first can land
      // its answer under a second machine's name — the one failure mode an
      // automatic search adds that a button never had.
      if (ticket !== discoveryTicket) return;
      set({ discovery: { alias, phase: 'done', result, error: null } });
    } catch (err) {
      if (ticket !== discoveryTicket) return;
      set({
        discovery: {
          alias,
          phase: 'failed',
          result: null,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  },

  clearDiscovery() {
    // Bumping the ticket is the cancel: whatever is in flight will find itself
    // superseded and drop its answer.
    discoveryTicket += 1;
    set({ discovery: null });
  },

  async addRemoteHost(alias, workspaceRoot) {
    return (await get().attachRemoteHost(alias, workspaceRoot)) !== null;
  },

  async attachRemoteHost(alias, workspaceRoot) {
    // Hands the host *back*, which `addRemoteHost` does not: session creation
    // needs the checkout it just opened, to list what is already in it.
    const host = await guard(set, () => agbrte().hosts.addRemote(alias, workspaceRoot));
    if (host === undefined) return null;
    // Re-listed even when the folder was already attached: `boot` is also what
    // refreshes the sessions on disk, and a workspace attached elsewhere in the
    // meantime may have gained some.
    await get().boot();
    return host;
  },

  async shutdownHost(instanceId) {
    let stopped = false;
    await guard(set, async () => {
      const result = await agbrte().hosts.shutdown(instanceId);
      stopped = result.stopped;
      if (!stopped) {
        // Surfaced as an error banner rather than swallowed: the user pressed
        // stop and it did not stop, and the reason is the useful part. Refusing
        // while an agent is mid-turn is correct behaviour, not a fault.
        throw new Error(`host still running — ${result.reason ?? 'work is in flight'}`);
      }
      set({ active: null, activeId: null, events: [] });
    });
    return stopped;
  },

  /**
   * Restart a host so a newly deployed bundle takes effect.
   *
   * The open session is cleared the way `shutdownHost` clears it: the host
   * genuinely stops, and holding a transcript from a process that no longer
   * exists shows the user a live view of nothing. It comes back on the next
   * attach, resumed from its log — which the returned host already reflects,
   * because `hosts.update` waits for the new one.
   *
   * A refusal is an error banner rather than a silence, for the same reason as
   * stopping: the person pressed a control and it did not do the thing, and
   * "an agent is mid-turn" is the useful half of that sentence.
   */
  async updateHost(instanceId) {
    await guard(set, async () => {
      await agbrte().hosts.update(instanceId);
      set({ active: null, activeId: null, events: [] });
      /*
       * And re-read everything, because the host is a different process now.
       *
       * `applyHosts` reconciles off the push as well, which is what covers a
       * client that did not press this button — but the person who *did* press
       * it is owed a settled screen when the call returns, not one that catches
       * up a moment later. Both paths land on the same lists, so the second one
       * to arrive is a no-op.
       */
      await get().boot();
    });
  },

  async removeHost(instanceId) {
    await guard(set, async () => {
      await agbrte().hosts.remove(instanceId);
      // Anything open on that host is gone with it; drop the selection rather
      // than leave a pane pointing at a session nothing can answer for.
      const active = get().active;
      if (active !== null && active.instanceId === instanceId) {
        set({ active: null, activeId: null, events: [] });
      }
      await get().boot();
    });
  },

  async createSession(instanceId, title, goal, mcpServers) {
    const session = await guard(set, () =>
      agbrte().sessions.create({
        instanceId,
        title,
        goal,
        // Omitted rather than sent empty: the host reads absent as "none were
        // named", and an empty array would put a `mcp: []` on a session that
        // never asked for one.
        ...(mcpServers !== undefined && mcpServers.length > 0 ? { mcpServers } : {}),
      }),
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
        await agbrte().sessions.resume(owner, sessionId);
      }
      applySnapshot(set, get, await agbrte().sessions.snapshot(sessionId));
      set({ sessions: await agbrte().sessions.list() });
    });
  },

  closeSession() {
    // Both, because `active` is its own field rather than derived from
    // `activeId`. Clearing only the id left the session pane rendered against a
    // stale record — invisible on a desktop, and on a phone it meant the back
    // button did nothing.
    set({ active: null, activeId: null, events: [] });
  },

  async addAgent(runtimeId, modelId, endpointId) {
    const sessionId = get().activeId;
    if (sessionId === null) return false;
    /*
     * The seat being taken over, when there is one (§4.2).
     *
     * Sent as an id the host checks rather than as "just replace whatever is
     * there": if somebody else changed the model since this window last read
     * the session, the host refuses and says so, instead of this click quietly
     * discarding their choice. Retired seats are skipped — they are in the
     * roster to name old transcript rows, not to be replaced twice.
     */
    const incumbent = get().active?.agents.find((a) => a.status !== 'retired');
    // `guard` turns a failure into the error banner and `undefined`, so the
    // boolean is "did the seat land" — which is what decides whether the choice
    // becomes the remembered default (agentDefaults.ts).
    const added = await guard(set, async () => {
      await agbrte().sessions.addAgent({
        sessionId,
        role: 'lead',
        runtimeId,
        ...(incumbent !== undefined ? { replacing: incumbent.agentId } : {}),
        ...(modelId !== null && modelId !== ''
          ? {
              model: {
                providerId: 'openai-compatible',
                modelId,
                ...(endpointId !== undefined ? { endpointId } : {}),
              },
            }
          : {}),
      });
      applySnapshot(set, get, await agbrte().sessions.snapshot(sessionId));
      return true;
    });
    return added === true;
  },

  async send(text, to, blocks) {
    const { activeId, active } = get();
    /**
     * Whoever the pane is focused on, else the first *live* agent (§4.2).
     *
     * Always addressing `agents[0]` was fine while a session had one agent and
     * silently wrong the moment it had a roster: every turn went to the lead
     * however carefully you had selected a worker to talk to. It became wrong
     * again for a different reason once a model could be changed — seat zero is
     * then a retired seat, and the host refuses a turn addressed to one.
     */
    const agentId = to ?? active?.agents.find((a) => a.status !== 'retired')?.agentId;
    if (activeId === null || agentId === undefined) return;

    // Not wrapped in `busy`: a turn can run for minutes, and blocking the whole
    // UI on it would make the transcript that arrives during the turn
    // unreadable. Failures still surface.
    try {
      set({ error: null });
      await agbrte().sessions.send({
        sessionId: activeId,
        agentId,
        text,
        ...(blocks !== undefined && blocks.length > 0 ? { blocks } : {}),
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      applySnapshot(set, get, await agbrte().sessions.snapshot(activeId));
      set({ sessions: await agbrte().sessions.list() });
    }
  },

  async loadBlob(sha256, mime) {
    const { activeId } = get();
    if (activeId === null) return null;
    // Not through `guard`: a picture that will not load is not an error banner
    // across the app, and the row that asked says so itself.
    try {
      return await agbrte().sessions.blob(activeId, sha256, mime);
    } catch {
      return null;
    }
  },

  async setReasoning(agentId, mode) {
    const { activeId } = get();
    if (activeId === null) return;
    // Through `guard`, so a host too old to know the command — or a model that
    // takes no effort — says so on screen instead of leaving the select showing
    // a value nothing accepted.
    await guard(set, async () => {
      await agbrte().sessions.setReasoning(activeId, agentId, mode);
      applySnapshot(set, get, await agbrte().sessions.snapshot(activeId));
    });
  },

  async interrupt() {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, () => agbrte().sessions.interrupt(sessionId));
  },

  async respondSplit(proposalId, approved) {
    const session = get().active;
    if (session === null) return;
    await guard(set, async () => {
      // The pushed session carries the updated `pendingSplits`, so the prompt
      // clears from the same place it appeared rather than being removed here
      // and possibly disagreeing with the host.
      await agbrte().sessions.respondSplit(session.sessionId, proposalId, { approved });
    });
  },

  async groupWith(sessionId, name) {
    const active = get().active;
    if (active === null) return;
    await guard(set, async () => {
      const group = active.group;
      await agbrte().sessions.group(
        // Both when starting one, so the host writes the whole set in a single
        // command — a client that grouped members one at a time could stop
        // halfway and leave a group whose other half never joined.
        group === undefined ? [active.sessionId, sessionId] : [sessionId],
        group?.name ?? name,
        group?.groupId,
      );
      // Re-listed rather than patched: the reply covers the sessions named, and
      // the list is what both the panel's members and its picker read from.
      set({ sessions: await agbrte().sessions.list() });
      applySnapshot(set, get, await agbrte().sessions.snapshot(active.sessionId));
    });
  },

  async leaveGroup() {
    const sessionId = get().activeId;
    if (sessionId === null) return;
    await guard(set, async () => {
      await agbrte().sessions.ungroup(sessionId);
      set({ sessions: await agbrte().sessions.list() });
      applySnapshot(set, get, await agbrte().sessions.snapshot(sessionId));
    });
  },

  async respond(requestId, allow) {
    await guard(set, async () => {
      const outcome = await agbrte().permissions.respond(
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
      void agbrte()
        .sessions.since(batch.sessionId, from)
        .then((missed) => {
          /*
           * `get().events`, not the `events` read before the await.
           *
           * Batches keep arriving while this request is in flight, and they take
           * the branch below — correctly — because `refetching` is set. Merging
           * onto the captured array instead of the current one overwrites every
           * one of them, silently: no error, no gap anything checks, just an
           * event that was on disk and never on screen.
           *
           * That is not theoretical. It swallowed a `permission.decided … allow
           * via policy` row in a live run, and §13's audit trail missing an
           * allow reads exactly like a gate that was never consulted.
           */
          const merged = [...get().events, ...missed, ...batch.events];
          set({ events: dedupe(merged).slice(-WINDOW), refetching: false });
          // The gap is closed, so tell main it can resume. Returning early
          // without this leaves the stream paused with nobody waiting on it.
          if (batch.lastSeq >= 0) agbrte().ack(batch.sessionId, batch.lastSeq);
        })
        .catch(() => {
          // Said out loud. The hole is real and permanent for this client, and
          // a transcript quietly missing a turn is worse than a visible error.
          set({ refetching: false, error: 'Some events could not be reloaded — reopen the session.' });
        });
      return;
    }

    const merged = dedupe([...events, ...batch.events]).slice(-WINDOW);
    set({ events: merged });

    // Ack the highest seq we now hold, which is what lets main resume
    // forwarding if it had paused.
    if (batch.lastSeq >= 0) agbrte().ack(batch.sessionId, batch.lastSeq);
  },

  applySession(session) {
    set({
      sessions: get().sessions.map((s) => (s.sessionId === session.sessionId ? session : s)),
      ...(session.sessionId === get().activeId ? { active: session } : {}),
    });
  },

  applyPermissionResolved(resolved) {
    const had = get().pending.some((p) => p.requestId === resolved.requestId);
    set({ pending: get().pending.filter((p) => p.requestId !== resolved.requestId) });
    // Only narrated when this client was actually showing it. A device that
    // never saw the prompt does not need to be told about its ending, and a
    // notice for something you never saw reads as a fault.
    if (!had) return;
    const who = resolved.actor?.label;
    set({
      notice:
        resolved.outcome === 'withdrawn'
          ? `A permission request was withdrawn — ${resolved.reason ?? 'it can no longer be answered'}`
          : `${who ?? 'Someone else'} ${resolved.decision?.result === 'deny' ? 'denied' : 'allowed'} a permission request`,
    });
  },

  applyPermission(request) {
    set({ pending: [...get().pending, request] });
  },

  /**
   * What is loaded, what is on disk, and what is waiting — asked again.
   *
   * This store's `sessions` is a **cache of one host generation's memory**, and
   * a host is a process that gets replaced (§6.4). `applySession` only ever
   * updates a record that is already in the array — it cannot add one and
   * cannot remove one — so the array is refreshed by exactly one thing, and
   * until now that thing was `boot`, which ran when the window opened.
   *
   * The consequence was on screen after the first working `hosts.update`: the
   * replacement host starts with **nothing loaded**, so the sidebar (fed from
   * `onDisk`) said three sessions were resumable while the dashboard's Needs-you
   * rail (fed from `sessions`) still showed a fourth as waiting for the user,
   * with a token count and a state belonging to a process that no longer
   * existed. Opening it asked a host that had never heard of it. §10 says the
   * summons must be right; a summons from the previous generation is the one
   * kind that cannot be.
   *
   * `pending` comes too, and for the same reason rather than for tidiness: a
   * permission request belongs to the process that raised it, so every one of
   * them is gone when that process is, and a prompt left on screen would be
   * answerable into nothing.
   *
   * Failure is left alone rather than surfaced. This runs off a push, not off
   * anything the user did, and a banner nobody can connect to an action is
   * worse than one stale list that the next reconcile fixes.
   */
  async reconcileSessions() {
    try {
      const [sessions, onDisk, pending] = await Promise.all([
        agbrte().sessions.list(),
        agbrte().sessions.listOnDisk(),
        agbrte().permissions.pending(),
      ]);
      set({ sessions, onDisk, pending });
    } catch {
      // Keep what we have; the next push asks again.
    }
  },

  applyHosts(hosts) {
    const before = get().hosts;
    set({ hosts });

    /*
     * A link that has just come back may be a different process (§6.4).
     *
     * `reconnecting → connected` is the only signal a client has that the host
     * serving a workspace was replaced — by `hosts.update`, by `agbrte update`
     * at a terminal, or by a crash and a respawn — and after that everything
     * this store believes about *which* sessions are loaded describes the
     * process that went away. Asked here rather than in `updateHost` because
     * the client that pressed the button is not the only one that has to be
     * right: a phone watching the same fleet gets this push and nothing else.
     *
     * A host arriving or leaving is the same question with a different cause,
     * so it takes the same answer.
     */
    const byId = new Map(before.map((h) => [h.instanceId, h]));
    const reattached = hosts.some(
      (h) => h.link === 'connected' && byId.get(h.instanceId)?.link === 'reconnecting',
    );
    const membershipChanged =
      hosts.length !== before.length || hosts.some((h) => !byId.has(h.instanceId));
    if (reattached || membershipChanged) void get().reconcileSessions();

    // Runtimes are per host and fetched lazily: a host that has not finished
    // handshaking reports none, and asking again after it does is cheap.
    void Promise.all(
      hosts.map(async (h) => [h.instanceId, await agbrte().hosts.runtimes(h.instanceId)] as const),
    ).then((pairs) => set({ runtimesByHost: Object.fromEntries(pairs) }));

    // Separately, and allowed to fail on its own. Building the matrix probes
    // every runtime on that host, so it is slower than listing them — and a
    // picker that waited for it would be unusable on a host whose model endpoint
    // is down.
    void Promise.all(
      hosts.map(
        async (h) =>
          [h.instanceId, await agbrte().hosts.conformance(h.instanceId).catch(() => [])] as const,
      ),
    ).then((pairs) => set({ conformanceByHost: Object.fromEntries(pairs) }));
  },

  async refreshInbox() {
    // Allowed to fail quietly. A host that cannot be reached contributes no
    // entries, and an inbox that threw would take the window down with it.
    set({ inbox: await agbrte().inbox.list().catch(() => []) });
  },

  async markInboxRead() {
    await agbrte().inbox.markRead().catch(() => undefined);
    // Cleared locally as well as on the host, so the badge goes out now rather
    // than on whatever the next refresh happens to be.
    set({ inbox: get().inbox.map((e) => ({ ...e, unread: false })) });
  },

  dismissNotice() {
    set({ notice: null });
  },

  say(notice) {
    set({ notice });
  },

  dismissError() {
    set({ error: null });
  },
}));

/**
 * Drop events we already hold, keeping seq order.
 *
 * A refetch deliberately overlaps what we already hold — asking for events
 * *after* our last seq risks missing one if the window boundary moved — so
 * overlap is expected and must not render twice.
 *
 * Keyed on `id`, not `seq`. The same event fetched twice carries the same id,
 * which is what "already holding it" actually means; `seq` is where an event
 * sits, and two events sharing a position is a bug in the writer rather than a
 * repeat. Keying on position made this function the thing that *executed* that
 * bug: an `EventLog` race handed `usage` and `permission.decided` the same seq,
 * and this quietly discarded the decision as a duplicate. The writer is fixed,
 * and this no longer has the power to hide it if it regresses.
 */
function dedupe(events: AgbrteEvent[]): AgbrteEvent[] {
  const seen = new Set<string>();
  const out: AgbrteEvent[] = [];
  for (const event of events) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    out.push(event);
  }
  return out.sort((a, b) => a.seq - b.seq);
}
