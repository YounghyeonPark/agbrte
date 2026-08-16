/**
 * Single-session view over several hosts (DESIGN.md §10, §15).
 *
 * The sidebar groups sessions by the host they run on, because §8's caps are per
 * host and §10 puts a target badge on every card: "what is running this, and
 * where" has to be answerable without a click. Several hosts are attached at
 * once, which is the designed shape — the previous one-workspace-at-a-time view
 * was the limitation.
 *
 * Still one session at a time in the main pane. The dashboard grid, the Needs-you
 * rail, and per-agent panes are Phase 4 and Phase 6.
 *
 * ## Two conventions
 *
 * **`data-testid` marks anything a test drives.** Styling classes are Tailwind
 * utilities and change whenever the design does; a test that selects on a layout
 * class breaks on a purely visual edit and reports it as a failure.
 *
 * **The permission prompt is inline, not a modal.** §14 specifies Radix for
 * dialogs, and its reasoning — no hand-rolled focus management — is right for
 * dialogs. This is not one: it appears *during* a run, unprompted, and a modal
 * that steals focus mid-sentence is the wrong shape for that. Inline needs no
 * focus trap to be correct, so Radix's value does not apply.
 */

// React 19 no longer declares a global `JSX` namespace; it is exported instead.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { loadAgentDefault, resolveAgentDefault, saveAgentDefault } from './agentDefaults.js';
import { AttachHost } from './AttachHost.js';
import { Dashboard } from './Dashboard.js';
import { SupportMatrix } from './SupportMatrix.js';
import { Inbox } from './Inbox.js';
import { Search } from './Search.js';
import { Artifacts } from './Artifacts.js';
import { Roster } from './Roster.js';
import { agentLabel } from './attribution.js';
import { StartGuide } from './StartGuide.js';
import { Welcome } from './Welcome.js';
import { About } from './About.js';
import { RuntimeSelect } from './RuntimeSelect.js';
import { CapabilityBadges } from './CapabilityBadges.js';
import { panelBadges, rowBadges, toolWarning, worthChecking } from './modelCapabilities.js';
import { useAgbrte } from './store.js';
import { Composer, EventRow, PermissionPrompt, SplitPrompt, Transcript, WorkingDots, summarize } from './Transcript.js';
import { Preview } from './Preview.js';
import { TerminalView } from './TerminalView.js';
import type { EndpointModelsDto, ModelInstallDto, SessionTemplateDto } from '@shared/ipc/contract.js';
import CATALOGUE from '../shared/models/catalogue.json' with { type: 'json' };
import type { HostInfo, RuntimeInfo } from '../shared/ipc/contract.js';
import type {
  MatrixCell,
  ModelCapabilityHint,
  Session,
  SessionState,
} from '../shared/types/index.js';
import type { UpdateState } from '../shared/ipc/contract.js';

/** Session-state colour, by what the state *means* (§4.1). */
export function stateTone(state: SessionState): string {
  switch (state) {
    // Neither of these is a request, so neither gets a hue. `working` was the
    // accent and `done` was green, which meant a screen of healthy sessions was
    // as colourful as a screen of stuck ones — and the accent is the only mark
    // the eye has for "this one needs you".
    case 'working':
      return 'text-ink';
    case 'done':
      return 'text-muted';
    case 'failed':
      return 'text-state-fail';
    case 'awaiting_input':
    case 'awaiting_permission':
    case 'awaiting_credentials':
    case 'awaiting_quota':
    case 'awaiting_children':
      // A pause is not a failure. It needs attention, which is a different
      // thing, and the colour has to say so.
      return 'text-state-paused';
    default:
      return 'text-muted';
  }
}

/**
 * The same state, where something else on screen already says it.
 *
 * Removing the amber card borders was not the reduction it looked like: the
 * dashboard went from four glowing outlines to nine amber labels — one heading,
 * four card lines, four sidebar lines — all saying the thing every session had
 * in common. The signal had been moved, not reduced, and a signal that marks
 * everything marks nothing.
 *
 * So the rule is about context rather than about state: **red always, amber only
 * where it is the only thing saying so.** A session's own header keeps the amber,
 * because there it is the sole indicator. A dashboard card sits under a heading
 * that reads "Needs you", and a sidebar row is navigation next to a screen that
 * has already said it — both use this.
 *
 * `failed` is the exception on purpose, and the reason greyscale could not take
 * over completely: §4.1 requires that a pause never read as a breakage, so the
 * one state that *is* a breakage keeps its colour wherever it appears.
 */
export function quietTone(state: SessionState): string {
  return state === 'failed' ? 'text-state-fail' : 'text-muted';
}

export const LABEL = 'text-[10px] uppercase tracking-wider';

export function App(): JSX.Element {
  const store = useAgbrte();
  const [attaching, setAttaching] = useState<false | 'local' | 'remote'>(false);
  /*
   * Which full-pane page is open over whatever else is showing, or `none`.
   *
   * One field for both pages rather than two booleans, because they occupy the
   * same pane and two booleans can both be true. Toggled open even with a
   * session showing, because a page you can only reach from an empty window is
   * unreachable exactly when it is wanted.
   */
  const [view, setView] = useState<'none' | 'guide' | 'about'>('none');
  /*
   * Which pane a narrow screen is showing. Above `md` both are up and this is
   * ignored.
   *
   * It defaults to the main pane because that is where the dashboard is, and on
   * a phone "what is running and what needs me" is the reason you opened the
   * app. The earlier rule — sidebar until a session is open — was right when the
   * main pane held only a start guide and became wrong the moment it held
   * something worth seeing.
   */
  const [pane, setPane] = useState<'main' | 'hosts'>('main');
  /*
   * The app's own update, held here rather than in the store.
   *
   * It is not session state and nothing else reads it — the store is what two
   * clients share a view of, and this is a fact about *this* installation. A
   * browser tab watching the same host has its own answer, and it is "no".
   */
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  /**
   * Which agent's pane is open, or `null` for the unified timeline (§4.2).
   *
   * Local to the view, not to the session: it is a way of *looking*, and two
   * devices attached to one session should not fight over what each is reading.
   */
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  /**
   * Whether the mid-session agent form is open (§4.2's roster growing).
   *
   * View state, like `focusedAgent`: which forms are unfolded is a way of
   * looking at a session, not a fact about it.
   */
  const [changingAgent, setChangingAgent] = useState(false);
  /*
   * Chat or raw terminal, and whether the seat has a raw side at all (§3.12).
   *
   * Availability is probed rather than inferred from the runtime id — the
   * owner answers `null` for a seat with no raw stream (harness, echo, an old
   * host), and branching on runtime identity here is exactly the leakage the
   * probe exists to avoid. View state like the rest: which pane is showing is
   * a way of looking, not a fact about the session.
   */
  const [terminal, setTerminal] = useState(false);
  const [rawAvailable, setRawAvailable] = useState(false);
  /**
   * The session an automatic first-agent add is in flight for, or `null`.
   *
   * Held so the picker is not flashed for the half-second the add takes — the
   * promise of a remembered default is landing *in the chat*, not watching a
   * form fill itself in. On failure this clears and the picker returns, which
   * is the fallback: the error banner says why, the form says what to do.
   */
  const [autoAdding, setAutoAdding] = useState<string | null>(null);
  /**
   * Sessions an auto-add was already attempted for — attempted, not finished.
   *
   * A ref rather than state because the guard has to be synchronous: the effect
   * below re-runs on every `active` push, and `addAgent` is slow enough that two
   * runs would otherwise both find zero agents and add two seats. Added to
   * before the call, never removed on failure — one attempt per session, then
   * the picker.
   */
  const autoAddTried = useRef(new Set<string>());
  /**
   * Where the one-shot has got to, or `null` when it is not running.
   *
   * One line rather than a step counter or a spinner per stage: the whole point
   * of collapsing four controls into one is that the person stops tracking
   * stages, and a progress display with its own stages hands them back.
   */
  const [starting, setStarting] = useState<string | null>(null);
  const { hosts, runtimesByHost, conformanceByHost, inbox, sessions, onDisk, active, events, pending, queued, error, notice, busy } =
    store;

  // Probed per session and per first seat, after the store is in hand (see the
  // state's comment above for why a probe rather than a runtime-id branch).
  const rawAgentId = active?.agents[0]?.agentId ?? null;
  const rawAgentStatus = active?.agents[0]?.status ?? null;

  // A different seat is a different question, so the answer is thrown away and
  // the pane returns to chat. The only place availability goes back to false.
  useEffect(() => {
    setTerminal(false);
    setRawAvailable(false);
  }, [active?.sessionId, rawAgentId]);

  /*
   * Asked while a turn is in flight, not once when the seat appeared.
   *
   * `SessionManager.rawLog` answers `null` both for a seat with no raw side and
   * for one *between turns* — a finished turn releases its handle and the tail
   * lives and dies with it. Asking once, at the moment the seat first appeared,
   * therefore always landed before any handle had ever existed: the answer was
   * `null` for every runtime, and the toggle never appeared at all.
   *
   * A turn in flight is both the one window in which a handle exists and the
   * only time somebody wants to watch one, so that is when this asks. `working`
   * is the trigger rather than the seat's own `running` because of the order
   * `runTurn` does things in: the handle is opened first, then the session is
   * pushed as `working`, and only then is the seat marked `running` — so the
   * session state is the first push that is guaranteed to have a handle behind
   * it. Both are watched, and it keeps asking while either holds, because one
   * poll landing in a gap should not cost the toggle for the whole turn.
   *
   * Latched: a seat that has shown a raw stream once has a raw side, and taking
   * the toggle away between turns would close the pane out from under a reader.
   */
  useEffect(() => {
    const sessionId = active?.sessionId;
    if (sessionId === undefined || rawAgentId === null || rawAvailable) return;
    let alive = true;
    const ask = (): void =>
      void window.agbrte.sessions.rawLog(sessionId, rawAgentId).then(
        (t) => {
          if (alive && t !== null) setRawAvailable(true);
        },
        () => undefined,
      );
    ask();
    // Only while a turn runs: a harness seat will never answer, and polling one
    // forever is a request a second that cannot succeed.
    const turning = active?.state === 'working' || rawAgentStatus === 'running';
    const timer = turning ? setInterval(ask, 1_000) : null;
    return () => {
      alive = false;
      if (timer !== null) clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.sessionId, rawAgentId, rawAgentStatus, active?.state, rawAvailable]);

  /**
   * The newest agent line in the open session (§12.4).
   *
   * A derivation rather than state: the transcript is already here, and a second
   * copy of "what was said last" is a second thing that can fall out of step
   * with the first.
   */
  const lastAgentText = [...events].reverse().find((e) => e.type === 'agent.text')?.text;

  useEffect(() => {
    void store.boot();
    void useAgbrte.getState().refreshInbox();

    const offEvents = window.agbrte.on.events((b) => useAgbrte.getState().applyBatch(b));
    const offSession = window.agbrte.on.session((s) => {
      useAgbrte.getState().applySession(s);
      // Refreshed on every state push rather than polled. The inbox is folded
      // from the log, so it only ever changes when the log does — and the push
      // that carries a session into `done` is exactly the moment an entry for
      // it exists to be read.
      void useAgbrte.getState().refreshInbox();
    });
    const offPermission = window.agbrte.on.permission((r) => useAgbrte.getState().applyPermission(r));
    const offResolved = window.agbrte.on.permissionResolved((r) =>
      useAgbrte.getState().applyPermissionResolved(r),
    );
    const offHosts = window.agbrte.on.hosts((h) => useAgbrte.getState().applyHosts(h));
    const offUpdate = window.agbrte.on.update(setUpdate);
    // Asked once as well as subscribed: a window opened after the download
    // finished would otherwise wait for a push that already happened.
    void window.agbrte.update.state().then(setUpdate, () => undefined);

    // Without these the listeners accumulate on every remount and events render
    // twice — a duplication bug, not a crash, which is why it is easy to miss.
    return () => {
      offEvents();
      offSession();
      offPermission();
      offResolved();
      offHosts();
      offUpdate();
    };
  }, []);

  // A different session is a different form: one left open does not follow.
  useEffect(() => setChangingAgent(false), [active?.sessionId]);

  /*
   * A session with no agents gets the remembered default, silently (§4.2).
   *
   * Only when the remembered choice is still offerable on this host — runtime
   * reported, model remembered where required, endpoint still present — which
   * `resolveAgentDefault` decides by the same rules the picker enforces. When
   * nothing valid is remembered, nothing happens and the picker shows exactly
   * as before: the first run teaches the form, every later run skips it.
   *
   * Waits for `runtimesByHost` to hold an answer for this host rather than
   * treating "not answered yet" as "no runtimes": the entry is absent until the
   * host's handshake lands, and the effect re-runs when it does.
   */
  useEffect(() => {
    if (active === null || active.agents.length > 0) return;
    if (autoAddTried.current.has(active.sessionId)) return;
    const host = hosts.find((h) => h.instanceId === active.instanceId);
    const runtimes = runtimesByHost[active.instanceId];
    if (host === undefined || runtimes === undefined) return;
    const remembered = loadAgentDefault(active.instanceId);
    if (remembered === null) return;
    const args = resolveAgentDefault(remembered, runtimes, host.endpoints);
    if (args === null) return;

    // Marked before the call, synchronously — the double-add guard.
    autoAddTried.current.add(active.sessionId);
    const sessionId = active.sessionId;
    setAutoAdding(sessionId);
    // Failure surfaces through the store's error banner like any other add;
    // clearing `autoAdding` is what brings the picker back as the fallback.
    void useAgbrte
      .getState()
      .addAgent(args.runtimeId, args.modelId, args.endpointId)
      .finally(() => setAutoAdding((current) => (current === sessionId ? null : current)));
  }, [active, hosts, runtimesByHost]);

  /**
   * Add a seat and, if it landed, make the choice the new default for this host.
   *
   * Success is the filter: a runtime that failed to start or a model the host
   * refused must not become what every future session silently reaches for.
   */
  const addAgentRemembering = async (
    runtimeId: string,
    modelId: string | null,
    endpointId?: string,
  ): Promise<void> => {
    const session = active;
    if (session === null) return;
    const added = await store.addAgent(runtimeId, modelId, endpointId);
    if (!added) return;
    saveAgentDefault(session.instanceId, {
      runtimeId,
      // The same shape `addAgent` sent, providerId included (store.ts fixes it
      // to `openai-compatible`), so replaying it later is replaying this add.
      model:
        modelId !== null && modelId !== ''
          ? {
              providerId: 'openai-compatible',
              modelId,
              ...(endpointId !== undefined ? { endpointId } : {}),
            }
          : null,
    });
    setChangingAgent(false);
  };

  /**
   * A folder, a session on it, and the chat — one press (§10, §15).
   *
   * **An added path, not a replacement.** `Attach host…` and the per-host `+`
   * are untouched and stay the route for anything this cannot express: a
   * machine over ssh, a second and third session in one workspace, a session
   * from a template, a title that is not the folder's name. What this serves is
   * the common case — one session per folder — where those four controls are
   * four questions with only one answer each.
   *
   * The steps run in order and stop where they fail, leaving the user at the
   * furthest point reached with the error banner saying why. That is
   * deliberate: an attached host and a session in the list are worth keeping
   * even when the next step did not happen, and there is nothing to undo that
   * would not also throw away work. Cancelling the folder picker is not a
   * failure and says nothing.
   *
   * Step three — the agent — is not here. A session with no agents is what the
   * auto-add effect above is for: it adds this host's remembered choice and the
   * composer is what appears. With nothing valid remembered the picker shows
   * instead, which is the fallback rather than a failure, and choosing there
   * once is what makes every later run of this land in the chat.
   */
  const newSessionOneShot = async (): Promise<void> => {
    // A full-pane page would otherwise cover the session this is about to open,
    // and below `md` the main pane is where the progress line and the error
    // banner live — the sidebar this may have been pressed from is not.
    setView('none');
    setPane('main');
    setStarting('Choose a folder to work in…');
    try {
      const host = await store.attachLocalHost();
      // Cancelled, or refused with the banner already saying why. Either way
      // nothing is attached, which is as far as this got.
      if (host === null) return;

      // The folder's name, with no title dialog. Somebody who wants to name a
      // session still can — that is what the per-host `+` form is for.
      const title = folderName(host.root) ?? (host.label === '' ? 'New session' : host.label);
      setStarting(`Starting a session in ${title}…`);
      // Goal and title the same string: §7's `create` requires a goal, and
      // inventing prose for one would put words in the user's mouth.
      await store.createSession(host.instanceId, title, title);
    } finally {
      setStarting(null);
    }
  };

  const runtimesHere = active === null ? [] : (runtimesByHost[active.instanceId] ?? []);
  const conformanceHere = active === null ? [] : (conformanceByHost[active.instanceId] ?? []);

  return (
    /*
     * One pane at a time on a phone, both side by side from `md` up.
     *
     * The desktop layout is a fixed 300px sidebar, which on a 390pt phone is
     * three quarters of the screen — so below `md` the two panes stack and
     * exactly one is shown: the session list until something is open, then the
     * session, with a back arrow to return. That is the ordinary phone pattern
     * and it needs no new state, because "is a session open" is already the
     * thing that decides it.
     */
    <div
      data-testid="app"
      className="grid h-full grid-cols-1 md:grid-cols-[300px_1fr]"
      data-pane={active === null ? 'list' : 'session'}
    >
      <aside
        className={`bg-panel border-line safe-top min-h-0 flex-col border-r md:flex ${
          pane === 'hosts' && active === null ? 'flex' : 'hidden'
        }`}
      >
        {/* Wraps as whole controls, never inside one.

            Relabelling `?` to `Guide` cost more width than a 300px column had,
            and the row answered by breaking `Attach host…` across two lines
            inside its own button — a control split mid-word reads as damage
            rather than as a tight fit. `flex-wrap` with `shrink-0` on the group
            moves a button down intact instead. */}
        <header className="border-line flex flex-wrap items-center justify-between gap-y-2 border-b p-4">
          <h1 className="text-base tracking-wide">Agbrte</h1>
          {/* The group itself wraps too. It gained an About button and with
              four controls it is wider than the 300px column, and a group that
              can neither shrink nor wrap pokes past the sidebar border into
              the main pane. Buttons still move down intact, never mid-word. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2 whitespace-nowrap">
            {/* §11: the durable record of what the notifier could not deliver —
                while focused, in a browser, or with the app closed entirely. */}
            <Inbox
              entries={inbox}
              onMarkRead={() => void useAgbrte.getState().markInboxRead()}
              onOpen={(entry) => void store.openSession(entry.sessionId, entry.instanceId)}
            />
            <button
              className="btn px-2 md:hidden"
              data-testid="show-main"
              title="Back to sessions"
              onClick={() => setPane('main')}
            >
              ‹
            </button>
            {/* "Guide", not "?".

                Its neighbours are `Inbox` and `Attach host…`; a bare glyph
                between two words is the one control on the bar that cannot be
                read, and its meaning lived only in a `title` — which a touch
                screen never shows and a keyboard user reaches after pressing it.
                A label costs eight pixels of a bar that has room. */}
            <button
              className="btn"
              data-testid="show-guide"
              title="How Agbrte is used"
              aria-pressed={view === 'guide'}
              onClick={() => setView((open) => (open === 'guide' ? 'none' : 'guide'))}
            >
              Guide
            </button>
            {/* The menu bar used to be the one place an About lived; with the
                bar gone this button is its whole surface. */}
            <button
              className="btn"
              data-testid="show-about"
              title="Version and license"
              aria-pressed={view === 'about'}
              onClick={() => setView((open) => (open === 'about' ? 'none' : 'about'))}
            >
              About
            </button>
            <button
              className="btn"
              data-testid="add-host"
              onClick={() => setAttaching((open) => (open === false ? 'local' : false))}
            >
              {attaching !== false ? 'Cancel' : 'Attach host…'}
            </button>
          </div>

          {/* The one primary action in the app, on its own line.

              `basis-full` rather than a fifth control in the group above: at
              300px that row already wraps, and a button that matters more than
              its neighbours cannot say so from the end of a queue of four. It
              is the accent because this is where a person acts — the same rule
              that colours a session needing attention.

              The `data-testid` is unique to this one; the Welcome screen's copy
              of the same action carries `welcome-new-session`, because two
              elements sharing a testid is a strict-mode failure in every test
              that reaches for it while both are on screen. */}
          <button
            className="btn text-accent basis-full"
            data-testid="new-session-oneshot"
            title="Pick a folder and start working in it"
            disabled={starting !== null}
            onClick={() => void newSessionOneShot()}
          >
            {starting !== null ? 'Starting…' : 'New session'}
          </button>
        </header>

        {/* Below the header rather than in it: a fleet-wide search is a thing you
            do occasionally and deliberately, and a box in the toolbar competes
            for attention with the sessions list every second it is not in use. */}
        <div className="border-line border-b px-4 py-3">
          <Search onOpen={(sessionId, instanceId) => void store.openSession(sessionId, instanceId)} />
        </div>

        {attaching !== false && (
          <AttachHost
            key={attaching}
            initialMode={attaching}
            onDone={() => setAttaching(false)}
          />
        )}

        {/* `overflow-x-hidden`: at fractional display scales (150% Windows) the
            aside's 1px border rounds the nav's content box to 299px while its
            children lay out at 300, and that 1px of phantom overflow paints a
            full-width horizontal scrollbar across the sidebar. Nothing here is
            meant to scroll sideways, so hide the axis rather than chase the
            rounding. */}
        <nav className="grid min-h-0 content-start gap-4 overflow-x-hidden overflow-y-auto p-2">
          {hosts.length === 0 && (
            <p className="text-muted p-2 text-xs">No hosts attached yet.</p>
          )}
          {hosts.map((host) => (
            <HostGroup
              key={host.instanceId}
              host={host}
              sessions={sessions.filter((s) => s.instanceId === host.instanceId)}
              unloaded={onDisk.filter(
                (d) =>
                  d.instanceId === host.instanceId &&
                  !sessions.some((s) => s.sessionId === d.sessionId),
              )}
              activeId={active?.sessionId ?? null}
              /*
               * On the dashboard these rows are the dashboard, printed again in
               * a 300px column: the same four titles, the same four states, in a
               * different order. Rams' "as little design as possible" is not
               * about sparseness — it is about not saying a thing twice.
               *
               * They come back the moment a session is open, because then this
               * is the only way to reach another one and nothing else on screen
               * is saying it.
               *
               * Only the *loaded* ones. `unloaded` sessions live on disk and are
               * absent from the dashboard entirely, so hiding those would not
               * remove a duplicate — it would remove the only route to them.
               */
              showLoaded={active !== null}
            />
          ))}
        </nav>
      </aside>

      <main
        className={`safe-bottom relative min-h-0 min-w-0 flex-col md:flex ${
          pane === 'hosts' && active === null ? 'hidden md:flex' : 'flex'
        }`}
      >
        {error !== null && (
          <div
            role="alert"
            data-testid="error"
            className="border-state-fail mx-4 mt-3 flex items-center justify-between gap-3 rounded-[2px] border bg-panel px-3 py-3"
          >
            <span>{error}</span>
            <button className="btn" onClick={() => store.dismissError()}>
              dismiss
            </button>
          </div>
        )}

        {starting !== null && (
          /* One line for the whole sequence, in the pane the session will land
             in. Below the error banner, and it goes when the sequence stops —
             what a failure leaves behind is the banner above and the app's own
             state: a host now in the sidebar, or a session in its list. Those
             are durable answers to "how far did it get"; a line of text that
             outlives the attempt is not. */
          <p
            data-testid="new-session-progress"
            role="status"
            className="text-muted mx-4 mt-3 text-xs"
          >
            {starting}
          </p>
        )}

        {/* The hosts pane holds the only way to attach a machine or start a
            session, and below `md` it is hidden. One control here rather than
            one inside each of the dashboard and the guide: it has to exist in
            both states, and the first version put it in the dashboard only —
            which left a phone with no sessions yet unable to make one. */}
        <button
          className="btn absolute right-3 top-3 z-10 px-2 md:hidden"
          data-testid="show-hosts"
          title="Hosts and new sessions"
          onClick={() => setPane('hosts')}
        >
          ☰
        </button>

        {update.phase === 'ready' && (
          /*
           * Shown only when there is something to press.
           *
           * Not while checking or downloading: those are the app's business and
           * a person can do nothing with either, so reporting them would be
           * three states of noise to reach one that matters. Not on failure
           * either — being offline is normal here, and a workbench that
           * complains about its own update while the work is fine has its
           * priorities backwards. `update.state()` still carries both for
           * anywhere that wants to ask.
           *
           * The accent is on the verb, because §6.4 makes this cheap and the
           * sentence should say so: hosts are detached, so restarting closes a
           * window and interrupts nothing that is running.
           */
          <div
            data-testid="update-ready"
            className="border-line mx-4 mt-3 flex items-center justify-between gap-3 rounded-[2px] border px-3 py-3 text-xs"
          >
            <span className="text-muted">
              Version {update.version} is downloaded. Sessions keep running while the app restarts.
            </span>
            <button
              className="btn text-accent"
              data-testid="update-install"
              onClick={() => void window.agbrte.update.installNow()}
            >
              Restart to update
            </button>
          </div>
        )}

        {notice !== null && (
          /* Not an error: nothing went wrong. Someone on another device
             answered a question this one was also showing, which is the
             feature working — but a prompt vanishing with no explanation
             looks like a bug, so it says what happened. */
          <div
            data-testid="notice"
            className="border-line mx-4 mt-3 flex items-center justify-between gap-3 rounded-[2px] border px-3 py-3 text-xs"
          >
            <span className="text-muted">{notice}</span>
            <button className="btn" onClick={() => store.dismissNotice()}>
              dismiss
            </button>
          </div>
        )}

        {view === 'about' ? (
          <About />
        ) : view === 'guide' ? (
          <StartGuide
            hasHosts={hosts.length > 0}
            onAttachLocal={() => {
              setView('none');
              setAttaching('local');
            }}
            onAttachRemote={() => {
              setView('none');
              setAttaching('remote');
            }}
          />
        ) : active === null && sessions.length > 0 ? (
          /* The dashboard once there is something to show, the welcome when
             there is not. An empty grid teaches nothing and a greeting is noise
             once you have sessions running — which of the two is useful is
             decided by whether any exist, not by a preference. */
          <Dashboard
            sessions={sessions}
            hosts={hosts}
            onOpen={(sessionId, instanceId) => void store.openSession(sessionId, instanceId)}
          />
        ) : active === null ? (
          /* A greeting, not the guide: the first screen greets, and the
             explanation waits under the button that names it (Welcome.tsx). */
          <Welcome
            hasHosts={hosts.length > 0}
            starting={starting !== null}
            onNewSession={() => void newSessionOneShot()}
            onAttachLocal={() => setAttaching('local')}
            onAttachRemote={() => setAttaching('remote')}
          />
        ) : (
          <>
            <SessionHeader
              session={active}
              host={hosts.find((h) => h.instanceId === active.instanceId) ?? null}
              onInterrupt={() => void store.interrupt()}
              onBack={() => store.closeSession()}
              /* Only once there is a seat: with zero agents the picker *is* the
                 pane, and a button that toggles a second copy of what is
                 already showing reads as broken. */
              {...(active.agents.length > 0
                ? { onToggleAgent: () => setChangingAgent((open) => !open), agentMenuOpen: changingAgent }
                : {})}
            />

            {/* §6.8. Remote only: a local dev server is already on localhost, and
                a button that does nothing visible teaches people the feature
                does nothing. */}
            <Preview
              sessionId={active.sessionId}
              instanceId={active.instanceId}
              remote={
                (hosts.find((h) => h.instanceId === active.instanceId)?.targetKind ?? 'local') !==
                'local'
              }
            />

            {active.agents.length === 0 ? (
              autoAdding === active.sessionId ? (
                /* The remembered default is being added; the form it replaces
                   stays hidden so the session lands in the chat, not on a form
                   filling itself in. Failure clears this and the picker below
                   is the fallback, with the error banner saying why. */
                <p className="text-muted m-auto p-6 text-xs" data-testid="auto-add">
                  Starting your usual agent…
                </p>
              ) : (
                <AgentPicker
                  /* Remounted per host: the model list it holds is that host's
                     answer, and §13 will not have one machine's endpoints shown
                     while an agent is added on another. */
                  key={active.instanceId}
                  runtimes={runtimesHere}
                  conformance={conformanceHere}
                  endpoints={hosts.find((h) => h.instanceId === active.instanceId)?.endpoints ?? []}
                  // Bound to the open session's host: "which models" is a question
                  // about a machine, and the picker does not know which one it is
                  // looking at.
                  listModels={() => window.agbrte.hosts.models(active.instanceId)}
                  // The expensive half of the same question (§3.3): asked for
                  // one model, when somebody is looking at it.
                  checkModel={(endpointId, modelId) =>
                    window.agbrte.hosts.modelCapabilities(active.instanceId, endpointId, modelId)
                  }
                  installModel={(endpointId, tag) =>
                    window.agbrte.hosts.installModel(active.instanceId, endpointId, tag)
                  }
                  installProgress={() => window.agbrte.hosts.installProgress(active.instanceId)}
                  // Remembering on success is what makes the *next* session
                  // skip this form entirely (agentDefaults.ts).
                  onAdd={addAgentRemembering}
                  busy={busy}
                />
              )
            ) : (
              <>
                {/* §13: a heterogeneous roster is gated heterogeneously, and the
                    UI must never imply otherwise. */}
                <Artifacts
                  events={events}
                  load={(sha256, mime) => store.loadBlob(sha256, mime)}
                />
                <Roster
                  agents={active.agents}
                  selected={focusedAgent}
                  onSelect={setFocusedAgent}
                  onEffort={(agentId, mode) => store.setReasoning(agentId, mode)}
                />
                {changingAgent && (
                  /* The same picker the empty session shows, folded in under
                     the roster it grows — Roster already renders any number of
                     seats, so "change the agent" is "add another seat" (§4.2).
                     Bounded and scrollable so an unfolded model browser cannot
                     crush the transcript below it (see SessionHeader on why
                     fixed rows around the transcript must hold their height). */
                  <div className="border-line max-h-[45%] shrink-0 overflow-y-auto border-b">
                    <AgentPicker
                      key={active.instanceId}
                      runtimes={runtimesHere}
                      conformance={conformanceHere}
                      endpoints={
                        hosts.find((h) => h.instanceId === active.instanceId)?.endpoints ?? []
                      }
                      listModels={() => window.agbrte.hosts.models(active.instanceId)}
                      checkModel={(endpointId, modelId) =>
                        window.agbrte.hosts.modelCapabilities(
                          active.instanceId,
                          endpointId,
                          modelId,
                        )
                      }
                      installModel={(endpointId, tag) =>
                        window.agbrte.hosts.installModel(active.instanceId, endpointId, tag)
                      }
                      installProgress={() => window.agbrte.hosts.installProgress(active.instanceId)}
                      // Success saves the choice as the new default and closes
                      // the form; failure leaves it open with the error banner.
                      onAdd={addAgentRemembering}
                      busy={busy}
                    />
                  </div>
                )}
                {rawAvailable && (
                  /* Only where a raw stream exists — a toggle to an empty pane
                     teaches people the feature does nothing. */
                  <div className="flex shrink-0 justify-end px-6 pt-2">
                    <button
                      className="btn text-[11px]"
                      data-testid="show-terminal"
                      title="Raw CLI output"
                      aria-pressed={terminal}
                      onClick={() => setTerminal((open) => !open)}
                    >
                      {terminal ? 'Chat' : 'Terminal'}
                    </button>
                  </div>
                )}
                {terminal && rawAvailable && rawAgentId !== null ? (
                  <TerminalView sessionId={active.sessionId} agentId={rawAgentId} />
                ) : (
                <Transcript
                  events={
                    focusedAgent === null
                      ? events
                      : /* Filtered rather than re-fetched: the unified timeline is
                           the truth and a pane is a view of it, so switching back
                           cannot show something different from what was there. */
                        events.filter((e) => e.agentId === focusedAgent)
                  }
                  renderRow={(e) => (
                    <EventRow key={e.seq} event={e} by={agentLabel(active.agents, e.agentId)} />
                  )}
                  /* Motion at the tail while the turn runs, so a long silence
                     reads as "busy" rather than "hung" (see WorkingDots). */
                  working={active.state === 'working'}
                />
                )}
                {pending.map((p) => (
                  <PermissionPrompt
                    key={p.requestId}
                    tool={p.tool}
                    args={summarize(p.args)}
                    onDecide={(allow) => void store.respond(p.requestId, allow)}
                  />
                ))}
                {/* Below the permission prompts on purpose. A tool call is
                    blocking a turn right now; a split proposal is a decision
                    about what to do next, and the thing already waiting should
                    be answered first (§4.3). */}
                {active.pendingSplits.map((p) => (
                  <SplitPrompt
                    key={p.proposalId}
                    proposal={p}
                    onDecide={(approved) => void store.respondSplit(p.proposalId, approved)}
                  />
                ))}
                {/* The newest thing an agent said, for reading aloud (§12.4).
                    Derived here rather than tracked in the store: it is a view
                    of the transcript already in hand, and a second copy of
                    "what was said last" is a second thing to keep in step. */}
                <Composer
                  onSend={(t, blocks) => void store.send(t, focusedAgent ?? undefined, blocks)}
                  disabled={active.state === 'working'}
                  queued={queued}
                  sessionId={active.sessionId}
                  {...(lastAgentText !== undefined ? { lastAgentText } : {})}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/**
 * The folder's own name, out of a path this process must not parse with `path`.
 *
 * The renderer is sandboxed — no Node built-ins — and even if it were not, the
 * separator belongs to the *host*, not to this window: a workspace reached over
 * ssh is posix while the app runs on Windows. So both separators, and empty
 * segments dropped, because a trailing slash would otherwise name the session
 * after nothing. `null` where there is no segment at all (`/`), which the caller
 * answers with the host's own label.
 */
function folderName(root: string): string | null {
  const parts = root.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  return parts.at(-1) ?? null;
}

/** One host and its sessions, with §10's target badge. */
function HostGroup({
  host,
  sessions,
  unloaded,
  activeId,
  showLoaded,
}: {
  host: HostInfo;
  sessions: Session[];
  unloaded: Array<{ sessionId: string; title: string }>;
  activeId: string | null;
  /** False while the dashboard is showing them. See the call site. */
  showLoaded: boolean;
}): JSX.Element {
  const store = useAgbrte();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [templates, setTemplates] = useState<SessionTemplateDto[]>([]);

  // Fetched when the form opens rather than on mount: a host that has none is
  // the common case, and asking every host on every render to populate a list
  // that is usually empty is work nobody sees.
  useEffect(() => {
    if (!adding) return;
    void window.agbrte.templates.list(host.instanceId).then(setTemplates, () => setTemplates([]));
  }, [adding, host.instanceId]);

  const submit = (): void => {
    if (title.trim() === '') return;
    void store.createSession(host.instanceId, title.trim(), title.trim());
    setTitle('');
    setAdding(false);
  };

  return (
    <section data-testid="host" data-instance={host.instanceId} data-label={host.label}>
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {/* The badge answers "where is this running" at a glance (§10). */}
          <span
            data-testid="host-badge"
            className={`${LABEL} ${host.targetKind === 'local' ? 'text-muted' : 'text-accent'}`}
          >
            {host.targetKind}
          </span>
          <span
            className="truncate-line text-xs"
            title={`${host.root}${host.targetKind === 'local' ? '' : ` on ${host.label}`}`}
          >
            {host.label}
          </span>
        </div>
        <div className="flex shrink-0 gap-1">
          {/* Kept, and not superseded. `new-session-oneshot` in the header is a
              fast path for one session in a folder you have not attached yet;
              this is how you get the *second* one in a workspace, a session
              named something other than its folder, or one built from a
              template. Removing it would trade a shortcut for a capability. */}
          <button
            className="btn px-2 py-1 text-xs"
            data-testid="new-session"
            title="Another session on this host"
            onClick={() => setAdding((v) => !v)}
          >
            +
          </button>
          <button
            className="btn px-2 py-1 text-xs"
            data-testid="stop-host"
            title="Stop this host — refuses while work is running"
            onClick={() => void store.shutdownHost(host.instanceId)}
          >
            ■
          </button>
          {/*
            Shown only when the host says it is running older code.

            `outdated` is three-valued and the third value is why this is a
            condition rather than an always-present button: `undefined` means
            *cannot be determined* — a host older than protocol v7, or one run
            unstamped from source — and offering a restart against a guess costs
            whoever is mid-turn on that machine. Absent is the honest rendering
            of "no claim".

            The accent, because unlike everything else in this column it is the
            one thing here asking for a decision.
          */}
          {host.outdated === true && (
            <button
              className="btn text-accent px-2 py-1 text-xs"
              data-testid="update-host"
              title="Restart this host onto this build — sessions resume from their log"
              onClick={() => void store.updateHost(host.instanceId)}
            >
              Update
            </button>
          )}
          <button
            className="btn px-2 py-1 text-xs"
            data-testid="remove-host"
            title="Detach this host — the run keeps going"
            onClick={() => void store.removeHost(host.instanceId)}
          >
            ×
          </button>
        </div>
      </div>

      {host.link === 'reconnecting' && (
        <p data-testid="host-reconnecting" className="text-state-paused mx-2 mb-1 text-[11px]">
          {/* Deliberately not phrased as a failure. The sessions are still on the
              other side and probably still running; what broke is our link to
              them, and telling the user the host is gone would be wrong at the
              exact moment it matters most. */}
          lost the link — reconnecting. Whatever is running there keeps running.
        </p>
      )}

      {host.movedFrom !== undefined && (
        /* Informational, not a warning. Nothing is wrong — the sessions are
           intact and this is the folder they are in now. It is said at all
           because a move changes how agents resume, and a behaviour change
           with no visible cause is the thing worth avoiding. */
        <p
          data-testid="host-moved"
          className="text-muted mx-2 mb-1 text-[11px]"
          title={`was ${host.movedFrom}`}
        >
          moved here — agents resume from the log rather than a vendor's token
        </p>
      )}

      {host.unavailableReason !== undefined && (
        <p
          data-testid="host-unavailable"
          className="text-state-paused mx-2 mb-1 text-[11px]"
          title={host.unavailableReason}
        >
          host unavailable — transcripts readable, nothing can run
        </p>
      )}

      {adding && (
        <form
          className="mb-1 grid gap-2 px-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            className="field"
            data-testid="new-title"
            autoFocus
            placeholder="Session title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="btn" data-testid="new-submit" type="submit" disabled={title.trim() === ''}>
            Create
          </button>

          {/* §17 Q12: templates are taken from sessions that worked, so this list
              is empty until somebody saves one — and says so rather than
              offering an empty picker. */}
          {templates.length > 0 && (
            <div className="grid gap-1">
              <span className={LABEL}>or from a template</span>
              {templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="btn text-left"
                  data-testid="template-apply"
                  title={`${t.roles.length} agent${t.roles.length === 1 ? '' : 's'}: ${t.roles
                    .map((r) => `${r.role} (${r.runtimeId})`)
                    .join(', ')}`}
                  onClick={() => {
                    void window.agbrte.templates
                      .apply({
                        instanceId: host.instanceId,
                        templateId: t.id,
                        ...(title.trim() === '' ? {} : { title: title.trim() }),
                      })
                      .then(() => {
                        setTitle('');
                        setAdding(false);
                      });
                  }}
                >
                  {t.name}
                  <span className="text-muted"> · {t.roles.length}</span>
                </button>
              ))}
            </div>
          )}
        </form>
      )}

      <div className="grid gap-1">
        {(showLoaded ? sessions : []).map((s) => (
          <button
            key={s.sessionId}
            data-testid="session"
            data-title={s.title}
            className={`grid gap-1 rounded-[2px] border px-3 py-2 text-left ${
              s.sessionId === activeId ? 'bg-raised border-line' : 'hover:border-line border-transparent'
            }`}
            onClick={() => void store.openSession(s.sessionId, host.instanceId)}
          >
            <span className="truncate-line">{s.title}</span>
            {/* Quiet: the sidebar is navigation, and the pane beside it has
                already said this. See `quietTone`. */}
            <span className={`${LABEL} ${quietTone(s.state)}`}>{s.state.replace(/_/g, ' ')}</span>
          </button>
        ))}

        {unloaded.map((d) => (
          <button
            key={d.sessionId}
            data-testid="session"
            data-title={d.title}
            className="hover:border-line grid gap-1 rounded-[2px] border border-transparent px-3 py-2 text-left"
            onClick={() => void store.openSession(d.sessionId, host.instanceId)}
          >
            <span className="truncate-line">{d.title}</span>
            {/* On disk only until opened — which is what proves the log is truth. */}
            <span className={`text-muted ${LABEL}`}>resume</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SessionHeader({
  session,
  host,
  onInterrupt,
  onBack,
  onToggleAgent,
  agentMenuOpen,
}: {
  session: Session;
  host: HostInfo | null;
  onInterrupt: () => void;
  /** Only reachable below `md`, where the session is the whole screen. */
  onBack: () => void;
  /** Folds the agent form in and out mid-session. Absent hides the button. */
  onToggleAgent?: () => void;
  agentMenuOpen?: boolean;
}): JSX.Element {
  return (
    /*
     * `shrink-0`, and on every fixed row the session column stacks around the
     * transcript. The transcript is the one child meant to give up height, but
     * a flex row squeezed past its minimum keeps *painting* its overflow — and
     * the roster's wrapped chip row is measured one line tall by the engine, so
     * under pressure it was compressed and the first transcript line (a red
     * failed-tool notice, typically) rendered on top of its chips.
     */
    <div className="border-line safe-top flex shrink-0 items-start justify-between gap-4 border-b px-4 py-4">
      <div className="flex min-w-0 items-start gap-2">
        {/* Hidden from `md` up, where the list is already on screen and a back
            arrow would point at nothing. */}
        <button
          className="btn shrink-0 px-2 py-1 md:hidden"
          data-testid="back-to-list"
          aria-label="Back to sessions"
          onClick={onBack}
        >
          ‹
        </button>
      <div className="min-w-0">
        {/* The testid is what lets a test know *which* session's pane it is
            looking at before it types into it — switching sessions leaves the
            old pane on screen for a beat, and a fill aimed at that vanishes. */}
        <h2 className="truncate-line text-[15px]" data-testid="session-title">
          {session.title}
        </h2>
        <p className="text-muted truncate-line mt-1 text-xs">
          {/* Which host, in the header too: with several attached, the sidebar
              grouping alone is easy to lose track of once you have scrolled. */}
          {host !== null && <span data-testid="active-host">{host.label} · </span>}
          {session.goal}
        </p>
      </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span data-testid="session-state" className={`${LABEL} ${stateTone(session.state)}`}>
          {session.state.replace(/_/g, ' ')}
          {/* The same pulse as the transcript tail: `working` carries no colour
              (see stateTone), so mid-turn this label is motion or nothing. The
              sidebar and dashboard stay quiet — here it is the sole indicator. */}
          {session.state === 'working' && <WorkingDots />}
        </span>
        {session.state === 'working' && (
          <button className="btn" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        {/* Quiet, like Export: adding a seat is occasional, and the defaults it
            changes are this client's, not the session's. */}
        {onToggleAgent !== undefined && (
          <button
            className="btn-quiet text-xs"
            data-testid="change-agent"
            title="Add another agent, or a different runtime and model"
            aria-pressed={agentMenuOpen === true}
            onClick={onToggleAgent}
          >
            Agent…
          </button>
        )}
        <button
          className="btn-quiet text-xs"
          data-testid="export-session"
          title="Save this session as a Markdown transcript"
          onClick={() => void saveTranscript(session)}
        >
          Export
        </button>
      </div>
    </div>
  );
}

/**
 * Save the transcript as a file the user can open anywhere (§15 Phase 8).
 *
 * A download rather than a native save dialog, because the same code serves the
 * browser client and `showSaveFilePicker` does not exist everywhere. The
 * document itself explains what it contains — that disclosure belongs in the
 * file, not in a toast the user closes before reading.
 */
async function saveTranscript(session: Session): Promise<void> {
  const markdown = await window.agbrte.sessions.exportMarkdown(session.sessionId);
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
  const link = document.createElement('a');
  link.href = url;
  // The title, so a folder of these is readable; the id, so two sessions with
  // the same title are two files.
  link.download = `${session.title.replace(/[^\w.-]+/g, '-')}-${session.sessionId.slice(0, 8)}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Display names for the runtimes this app knows about.
 *
 * Mirrored rather than carried: `RuntimeInfo` (§7's contract) is `{id, version,
 * model}` and the labels live with the fleet's runtime table in `main.ts`, so
 * widening the IPC surface to move a piece of prose across it would be a poor
 * trade. Anything unlisted falls back to its id, which is what was shown before
 * this map existed — so a runtime a host invents is offered, not hidden.
 */
const RUNTIME_LABELS: Readonly<Record<string, string>> = {
  'agbrte-harness': 'Agbrte harness',
  echo: 'Echo (no model)',
  'cli:claude-code': 'Claude Code (installed CLI)',
  'cli:gemini-cli': 'Gemini CLI (installed)',
};

function runtimeLabel(id: string): string {
  return RUNTIME_LABELS[id] ?? id;
}

/**
 * One thing a person can pick: what will run, with the runtime implied.
 *
 * The picker used to ask twice — runtime, then model — and the two questions
 * were not independent: the answer to the first decided whether the second one
 * existed, which meant you had to know which runtimes take a model before you
 * could answer either. Flattening them asks the question people actually have.
 * A runtime that needs a model contributes one entry per reachable model; one
 * that does not contributes exactly one entry.
 */
interface AgentChoice {
  /**
   * The select's value, and stable across refreshes.
   *
   * A bare runtime id where no model is involved — so `echo` stays addressable
   * as `echo`, by a person reading the DOM and by the e2e helpers.
   */
  value: string;
  runtimeId: string;
  /** What it will run, or `null`: no model at all, or one still to be typed. */
  modelId: string | null;
  endpointId?: string;
  /** The escape hatch. Reveals a field for a model the host did not list. */
  typed?: boolean;
  label: string;
  /** Secondary text — which recipient, or which runtime. */
  hint?: string;
  /**
   * What this model can do, as far as the host could say for free (§3.3).
   *
   * Absent for a runtime that takes no model, for the escape hatch, and for a
   * host older than protocol v14 — three different reasons that all mean the
   * same thing to a reader: nobody could tell, so nothing is claimed.
   */
  capabilities?: ModelCapabilityHint;
}

/**
 * The flat list, from what the host reports and what its endpoints serve.
 *
 * Pure, and outside the component, because the invariant worth keeping is
 * structural: **every runtime yields at least one entry**. A model list that
 * failed to load must not make a runtime unpickable, so a required-model runtime
 * always ends with its "another model…" entry whether or not anything was listed
 * — which is also the whole of the old manual-entry path, kept.
 */
function buildChoices(
  runtimes: RuntimeInfo[],
  answers: EndpointModelsDto[],
  endpoints: HostInfo['endpoints'],
): AgentChoice[] {
  const out: AgentChoice[] = [];
  for (const runtime of runtimes) {
    if (runtime.model !== 'required') {
      // `optional` lands here with `none`: an installed CLI has its own model
      // configured where it lives, and asking again in this window offered a
      // second answer to a question the CLI had already settled.
      out.push({
        value: runtime.id,
        runtimeId: runtime.id,
        modelId: null,
        label: runtimeLabel(runtime.id),
      });
      continue;
    }
    for (const answer of answers) {
      for (const model of answer.models) {
        // Matched by name because that is what the host keyed it by. Absent is
        // ordinary — an endpoint that does not self-describe, a host too old to
        // carry the field, a model past the host's describe limit — and every
        // one of those renders as unknown rather than as a missing badge.
        const hint = answer.capabilities?.find((c) => c.modelId === model);
        out.push({
          value: `${runtime.id}::${answer.endpointId}::${model}`,
          runtimeId: runtime.id,
          modelId: model,
          endpointId: answer.endpointId,
          label: model,
          ...(hint !== undefined ? { capabilities: hint } : {}),
          /*
           * The recipient, on the entry itself.
           *
           * §13 wants where the code goes legible at the moment of choosing, and
           * with two endpoints the same model name appears twice in this list
           * meaning two different things — one of them possibly the network.
           */
          hint: endpoints.find((e) => e.id === answer.endpointId)?.label ?? answer.endpointId,
        });
      }
    }
    out.push({
      value: `${runtime.id}::__type__`,
      runtimeId: runtime.id,
      modelId: null,
      typed: true,
      label: 'Another model…',
      hint: runtimeLabel(runtime.id),
    });
  }
  return out;
}

/**
 * What the selected model can do, before it is chosen (§3.3, §3.5).
 *
 * The panel form of the badges on each row, and it exists because a row has
 * space for two words and the consequence of `no tools` is a sentence: an agent
 * on a model that cannot call tools **can only chat**. Nobody was told that, and
 * the way it presented was four ignored requests to search.
 *
 * Three states are kept apart here and they are the whole design:
 *
 *  - **probed** — the model was run once and behaved this way;
 *  - **declared** — the server said so, which small models routinely get wrong;
 *  - **unknown** — nobody asked, which is neither a yes nor a no.
 *
 * `onCheck` is absent where there is nothing to ask — the escape hatch has no
 * model id yet — and the button is hidden once a claim is probed, because
 * re-probing spends a request to re-learn what the host already cached.
 */
function ModelCapabilities({
  hint,
  busy,
  note,
  onCheck,
}: {
  hint: ModelCapabilityHint | undefined;
  busy: boolean;
  note: string | null;
  onCheck?: () => void;
}): JSX.Element {
  const warning = toolWarning(hint);
  return (
    <div className="grid gap-1" data-testid="model-capabilities">
      <div className="flex flex-wrap items-center gap-1">
        <CapabilityBadges badges={panelBadges(hint)} />
        {busy ? (
          <span className="text-muted text-[11px]">checking…</span>
        ) : onCheck !== undefined && worthChecking(hint) ? (
          <button
            type="button"
            className="btn-quiet text-[11px]"
            data-testid="check-model"
            /* Said on the control, because the cost is not obvious: this runs
               the model twice, and on a paid endpoint that is somebody's
               money. It is why the check is a button there and automatic on a
               local server (§3.3). */
            title="Ask this model to call a tool and report what came back. Runs two short requests."
            onClick={onCheck}
          >
            Check
          </button>
        ) : null}
      </div>

      {warning !== null && (
        <p className="text-state-fail m-0 text-[11px]" data-testid="capability-warning">
          {warning}
        </p>
      )}

      {note !== null && (
        <p className="text-muted m-0 text-[11px]" data-testid="capability-note">
          {note}
        </p>
      )}
    </div>
  );
}

function AgentPicker({
  runtimes,
  conformance,
  endpoints,
  listModels,
  checkModel,
  installModel,
  installProgress,
  onAdd,
  busy,
}: {
  runtimes: RuntimeInfo[];
  /** The support matrix for this host, so the choice is informed (§3.13). */
  conformance: MatrixCell[];
  endpoints: HostInfo['endpoints'];
  /** Asks the host this picker belongs to what its endpoints serve now (§3.8). */
  listModels: () => Promise<EndpointModelsDto[]>;
  /**
   * Establishes what *one* model can do, paying the probe (§3.3).
   *
   * `null` means this host cannot be asked at all — it predates the command —
   * which is a different sentence from a hint that could establish nothing, and
   * has a different remedy: update the host rather than choose another model.
   */
  checkModel: (endpointId: string, modelId: string) => Promise<ModelCapabilityHint | null>;
  installModel: (endpointId: string, tag: string) => Promise<void>;
  installProgress: () => Promise<ModelInstallDto[]>;
  onAdd: (runtimeId: string, modelId: string | null, endpointId?: string) => Promise<void>;
  busy: boolean;
}): JSX.Element {
  /**
   * The chosen entry's `value`, or `null` while nobody has chosen.
   *
   * `null` rather than seeding it with the first option, because the list grows
   * under us: models arrive a round trip after this opens, and a value written
   * on mount pins the selection to whatever was offerable before the host
   * answered — which is the "another model…" entry, i.e. an empty text field
   * where a list of ready models was about to appear. Untouched means "the first
   * entry", recomputed every render; one click makes it a real choice and it
   * stops moving.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  /** The escape hatch's field: a model the host did not list. */
  const [typedModel, setTypedModel] = useState('qwen2.5:7b');
  /** Which recipient a *typed* model goes to. Listed ones carry their own. */
  const [endpointId, setEndpointId] = useState('');
  /**
   * What the host says its endpoints serve, verbatim.
   *
   * Kept per endpoint rather than flattened to a name list: the endpoint is half
   * of what an entry means (§13), and `canInstall` / `installHint` come from the
   * same answer.
   */
  const [answers, setAnswers] = useState<EndpointModelsDto[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [installs, setInstalls] = useState<ModelInstallDto[]>([]);
  /** One list per mounted picker. See the effect below. */
  const asked = useRef(false);
  /**
   * Probes this picker has paid for, keyed `endpoint::model`.
   *
   * Held here rather than merged into `answers`, so the two sources stay
   * distinguishable: `answers` is what the host volunteered for free, this is
   * what was established by running the model. They are shown the same way but
   * they are not the same claim, and the badge says which (§3.3).
   */
  const [probed, setProbed] = useState<Record<string, ModelCapabilityHint>>({});
  /** The `endpoint::model` currently being checked, if any. */
  const [checking, setChecking] = useState<string | null>(null);
  /**
   * Why nothing could be checked — chiefly, a host that predates the command.
   *
   * Carries the model it is about, because the selection moves. A note left over
   * from the previous entry sits under the new one's badges and reads as being
   * about it, which is a wrong sentence rather than a stale one.
   */
  const [checkNote, setCheckNote] = useState<{ key: string; text: string } | null>(null);
  /**
   * Keys already asked about, so an automatic check fires once.
   *
   * A ref rather than state: re-rendering on it would be the thing that
   * re-triggers the effect, and StrictMode runs effects twice on purpose.
   */
  const attempted = useRef(new Set<string>());

  /**
   * Failures are reported in place rather than raised.
   *
   * An endpoint being unreachable is ordinary — a laptop away from the machine
   * running its Ollama — the other endpoints still answered, and the "another
   * model…" entry still takes a typed id. A host too old to answer is a
   * *different* sentence from "no models", and has to read as one.
   */
  const refreshModels = async (): Promise<void> => {
    setModelsBusy(true);
    try {
      const found = await listModels();
      setAnswers(found);
      const count = new Set(found.flatMap((a) => a.models)).size;
      const failed = found.filter((a) => a.error !== undefined);
      setModelsNote(
        failed.length > 0
          ? `${count} found. ${failed.map((f) => `${f.endpointId}: ${f.error}`).join('; ')}`
          : count > 0
            ? `${count} reachable from that host.`
            : 'That host reported no models. Type one if you know it is there.',
      );
    } catch (err) {
      setModelsNote(err instanceof Error ? err.message : String(err));
    } finally {
      setModelsBusy(false);
    }
  };

  /*
   * Ask once, when this picker opens and a model could be part of the answer.
   *
   * The old rule — ask when a model-taking runtime is *selected* — was written
   * when the runtime came first and the model second. With one list the models
   * are the list, so waiting for a selection would mean opening on a dropdown
   * that does not yet contain the thing you came to choose.
   *
   * The cost is unchanged in practice: the harness was the first runtime and so
   * the default selection, which made the old rule fire on mount anyway. And
   * this form is only ever on screen because somebody is adding an agent — the
   * roster reads fine without it.
   *
   * Guarded by a ref, not by the dependency list: `runtimes` is rebuilt on every
   * host push, and a fresh array identity is not a new question.
   */
  const wantsModels = runtimes.some((r) => r.model === 'required');
  useEffect(() => {
    if (!wantsModels || asked.current) return;
    asked.current = true;
    void refreshModels();
    // `refreshModels` is redefined every render; listing it would ask on each.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsModels]);

  /*
   * Poll only while the menu is open.
   *
   * A pull is minutes long and nobody is watching a closed panel; polling
   * regardless would be a request every two seconds for the lifetime of the app,
   * to learn something nothing is displaying.
   */
  useEffect(() => {
    if (!browsing) return;
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const p = await installProgress();
        if (live) setInstalls(p);
      } catch {
        // The host may be older than v9, or gone. Neither is worth a banner
        // while somebody is reading a list of models.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 2000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [browsing, installProgress]);

  const choices = useMemo(
    () => buildChoices(runtimes, answers, endpoints),
    [runtimes, answers, endpoints],
  );
  // Falls back to the first entry both while untouched and if a chosen model
  // disappears from a later refresh — the list is the authority on what is
  // there, and a selection pointing at nothing is a disabled button with no
  // explanation.
  const value = chosen !== null && choices.some((c) => c.value === chosen) ? chosen : (choices[0]?.value ?? '');
  const current = choices.find((c) => c.value === value);
  /** Whether the chosen entry involves a model at all. */
  const needsModel = current !== undefined && (current.typed === true || current.modelId !== null);
  /** The recipient this add would use: the entry's own, or the typed one's. */
  const endpoint =
    current?.endpointId !== undefined
      ? endpoints.find((e) => e.id === current.endpointId)
      : (endpoints.find((e) => e.id === endpointId) ?? endpoints[0]);

  /**
   * The best claim about one model: what was probed here, else what the host
   * volunteered. Never merged — a probed answer replaces a declared one whole,
   * because the two disagree exactly when the declaration was wrong.
   */
  const hintOf = (choice: AgentChoice | undefined): ModelCapabilityHint | undefined => {
    if (choice === undefined || choice.modelId === null) return undefined;
    return probed[`${choice.endpointId ?? ''}::${choice.modelId}`] ?? choice.capabilities;
  };

  /**
   * The selected entry, when it names something a probe could be run against.
   *
   * Narrowed once here rather than inside the markup, and it covers the escape
   * hatch too: a model typed into that field is exactly the case where nothing
   * is known — `/v1/models` is optional, so a server that cannot list what it
   * serves cannot describe it either — and leaving the one entry with no answer
   * unable to *get* one would make the honest path the least informed one.
   */
  const checkable = ((): { endpointId: string; modelId: string } | null => {
    if (current === undefined) return null;
    const modelId = current.typed === true ? typedModel.trim() : current.modelId;
    const from = current.endpointId ?? endpoint?.id;
    if (modelId === null || modelId === '' || from === undefined) return null;
    return { endpointId: from, modelId };
  })();

  const currentHint =
    checkable !== null
      ? (probed[`${checkable.endpointId}::${checkable.modelId}`] ?? current?.capabilities)
      : undefined;

  /**
   * Pay for one probe, for the model in front of somebody.
   *
   * Deliberately per model and never per list: this makes real requests to the
   * endpoint, which is why §3.13 refused to do it on host attach. The answer is
   * cached on the host, in the same provider the run will use — so the turn that
   * follows does not pay for it again.
   */
  const check = async (endpointIdOf: string, modelId: string): Promise<void> => {
    const key = `${endpointIdOf}::${modelId}`;
    if (checking !== null) return;
    attempted.current.add(key);
    setChecking(key);
    setCheckNote(null);
    try {
      const hint = await checkModel(endpointIdOf, modelId);
      if (hint === null) {
        // Not "this model cannot" — "this host cannot be asked". Different
        // sentence, different remedy, and collapsing them would blame a model
        // for an out-of-date host.
        setCheckNote({
          key,
          text: 'This host is too old to check what a model can do. Update it to find out.',
        });
        return;
      }
      setProbed((was) => ({ ...was, [key]: hint }));
      if (hint.error !== undefined) setCheckNote({ key, text: hint.error });
    } catch (err) {
      setCheckNote({ key, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setChecking(null);
    }
  };

  /*
   * Check the selected model automatically — but only where it is free.
   *
   * The incident this feature exists for happened to somebody who had no reason
   * to press anything, so waiting for a click would leave it half-fixed. But a
   * probe is two real requests, and firing those at a *paid* endpoint because a
   * menu opened would spend somebody's money and send a prompt over the network
   * without them asking. `authenticated` is the honest proxy for "this costs
   * something", and it is the same flag the recipient line below reads.
   *
   * Skipped when the claim is already probed: the host caches, but a round trip
   * per render is still a round trip.
   */
  useEffect(() => {
    if (current === undefined || current.typed === true || current.modelId === null) return;
    if (current.endpointId === undefined) return;
    if (endpoint === undefined || endpoint.authenticated) return;
    const key = `${current.endpointId}::${current.modelId}`;
    if (attempted.current.has(key) || !worthChecking(hintOf(current))) return;
    void check(current.endpointId, current.modelId);
    // `check` and `hintOf` are redefined every render; listing them would make
    // this fire on each. The keys below are what actually decide — `checking`
    // included, so a selection made while another probe is in flight is picked
    // up when that one finishes rather than dropped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.value, endpoint?.id, endpoint?.authenticated, checking]);

  const knownModels = useMemo(
    () => [...new Set(answers.flatMap((a) => a.models))],
    [answers],
  );
  /** The one endpoint that can take an install, if exactly one can. */
  const installTarget = answers.find((e) => e.canInstall === true);

  /**
   * "Use" in the catalogue: select the entry for that tag, or type it in.
   *
   * Scoped to the runtime already chosen where it can be — with two
   * model-driven runtimes the same tag appears twice, and picking a model out
   * of a catalogue is not a request to change which runtime runs it.
   */
  const chooseModel = (tag: string): void => {
    const mine = (c: AgentChoice): boolean => c.runtimeId === current?.runtimeId;
    const listed = choices.filter((c) => c.modelId === tag);
    const pick = listed.find(mine) ?? listed[0];
    if (pick !== undefined) {
      setChosen(pick.value);
      return;
    }
    setTypedModel(tag);
    const typed = choices.filter((c) => c.typed === true);
    const hatch = typed.find(mine) ?? typed[0];
    if (hatch !== undefined) setChosen(hatch.value);
  };

  return (
    <div className="m-auto grid w-full max-w-md gap-3 p-6" data-testid="picker">
      <h3 className="text-sm">Add an agent</h3>

      {runtimes.length === 0 ? (
        <p className="text-muted text-xs">
          This host has not reported any runtimes. If it failed to start, nothing can run here.
        </p>
      ) : (
        <>
          <label className="text-muted grid gap-1 text-xs">
            What will run
            <RuntimeSelect
              value={value}
              onChange={setChosen}
              options={choices.map((c) => ({
                value: c.value,
                label: c.label,
                ...(c.hint !== undefined ? { hint: c.hint } : {}),
                runtimeId: c.runtimeId,
                modelId: c.modelId,
                ...(c.typed === true ? { typed: true } : {}),
                /*
                 * Only on the entries a badge can be true of.
                 *
                 * A runtime that runs no model of ours — an installed CLI, echo
                 * — has no per-model answer to give, and the escape hatch has no
                 * model yet. Painting `tools: unknown` on those would be four
                 * words of noise on a row whose capabilities §3.13's matrix
                 * below already covers.
                 */
                ...(c.modelId !== null ? { badges: rowBadges(hintOf(c)) } : {}),
              }))}
            />
          </label>

          {/* §3.13: the choice shows what its runtime can actually do here. Bound
              to the *entry's* runtime, which is now something a person picks
              without naming — all the more reason to keep saying it. */}
          <SupportMatrix cells={conformance} runtimeId={current?.runtimeId ?? ''} />

          {/*
            What the *chosen* model can do, in full (§3.3, §3.5).

            Beside the matrix rather than inside it, because they answer
            different questions with different evidence: that one is per runtime
            and comes from conformance runs, this one is per model and comes
            from a probe or the server's own account of itself. Folding a
            per-model claim into a per-runtime grid is precisely the bug §3.3
            calls out — "keying on `runtimeId` alone is the bug that makes a 3B
            model inherit a frontier model's declared abilities".
          */}
          {needsModel && (
            <ModelCapabilities
              hint={currentHint}
              busy={checkable !== null && checking === `${checkable.endpointId}::${checkable.modelId}`}
              note={
                checkable !== null &&
                checkNote?.key === `${checkable.endpointId}::${checkable.modelId}`
                  ? checkNote.text
                  : null
              }
              {...(checkable !== null
                ? { onCheck: () => void check(checkable.endpointId, checkable.modelId) }
                : {})}
            />
          )}

          {/* Only where a model is part of the answer. Under the one select
              rather than beside a second one: refreshing and installing are
              things you do *to the list*, and a person choosing an installed CLI
              is not looking at a list of local models. */}
          {needsModel && (
            <div className="text-muted grid gap-1 text-xs">
              {current?.typed === true && (
                /*
                  The escape hatch, and the whole reason a closed list is honest.

                  `/v1/models` is optional in the OpenAI-compatible shape, so a
                  server that does not implement it would otherwise be unusable
                  through a UI that had merely failed to ask.
                */
                <input
                  className="field"
                  data-testid="model-id"
                  placeholder="e.g. qwen2.5-coder:7b"
                  value={typedModel}
                  onChange={(e) => setTypedModel(e.target.value)}
                />
              )}

              <div className="flex items-baseline gap-2">
                <small className="text-muted min-w-0 grow text-[11px]">
                  {modelsNote ??
                    'An Ollama or other OpenAI-compatible model reachable from that host.'}
                </small>
                <button
                  type="button"
                  className="btn-quiet shrink-0 text-xs"
                  data-testid="refresh-models"
                  title="Ask this host what its endpoints serve now"
                  disabled={modelsBusy}
                  onClick={() => void refreshModels()}
                >
                  {modelsBusy ? '…' : 'Refresh'}
                </button>
              </div>

              <button
                type="button"
                className="btn-quiet justify-self-start text-xs"
                data-testid="browse-models"
                onClick={() => {
                  setBrowsing((open) => !open);
                  if (knownModels.length === 0) void refreshModels();
                }}
              >
                {browsing ? 'Hide models' : 'Browse models…'}
              </button>

              {browsing && (
                <div className="border-line bg-panel grid gap-2 rounded-[2px] border p-3">
                  {/*
                    The list is a starting point, not a boundary.

                    Every tag here was checked against the registry when the
                    catalogue was generated — one invented entry was caught that
                    way — but "another model…" still takes anything, because the
                    catalogue is there to save somebody knowing that "a good
                    small coding model" is spelled `qwen2.5-coder:7b`.
                  */}
                  <span className={`${LABEL} text-muted`}>
                    Suggested models · verified {CATALOGUE.verifiedAt}
                  </span>

                  {installTarget === undefined ? (
                    /*
                      Said rather than shown as a dead button.

                      vLLM, llama.cpp and NIM all take their model at launch, so
                      "install" against them is not a slow operation — it is not
                      an operation. The reason comes from the host, which is the
                      only side that knows which runner it is talking to.
                    */
                    <p className="text-muted m-0 text-[11px]">
                      {answers.find((e) => e.installHint !== undefined)?.installHint ??
                        'Refresh to find out whether this host can install models.'}
                    </p>
                  ) : null}

                  <div className="grid gap-1">
                    {CATALOGUE.models.map((m) => {
                      const here = knownModels.includes(m.tag);
                      const run = installs.find((i) => i.tag === m.tag);
                      const pct =
                        run !== undefined && run.total > 0
                          ? Math.round((run.completed / run.total) * 100)
                          : null;
                      return (
                        <div
                          key={m.tag}
                          data-testid="catalogue-row"
                          data-tag={m.tag}
                          className="flex items-baseline justify-between gap-3"
                        >
                          <span className="min-w-0">
                            <span className="truncate-line">{m.label}</span>
                            <span className="text-muted text-[11px]"> · {m.note}</span>
                          </span>
                          <span className="text-muted flex shrink-0 items-baseline gap-2 text-[11px]">
                            <span className="tabular-nums">
                              {(m.bytes / 1e9).toFixed(1)} GB
                            </span>
                            {here ? (
                              <button
                                type="button"
                                className="btn-quiet text-[11px]"
                                onClick={() => chooseModel(m.tag)}
                              >
                                Use
                              </button>
                            ) : run !== undefined && !run.done ? (
                              <span className="text-accent tabular-nums">
                                {pct === null ? run.status : `${pct}%`}
                              </span>
                            ) : run?.error !== undefined ? (
                              <span className="text-state-fail">failed</span>
                            ) : installTarget !== undefined ? (
                              <button
                                type="button"
                                className="btn-quiet text-accent text-[11px]"
                                data-testid="install-model"
                                onClick={() => {
                                  void installModel(installTarget.endpointId, m.tag).catch(
                                    (err: unknown) =>
                                      setModelsNote(
                                        err instanceof Error ? err.message : String(err),
                                      ),
                                  );
                                }}
                              >
                                Install
                              </button>
                            ) : null}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Only for a typed model: a listed one already names its endpoint
                  in the entry that was chosen, and offering to override it would
                  be a second answer to a question already settled. */}
              {current?.typed === true && endpoints.length > 1 && (
                <label className="text-muted mt-1 grid gap-1 text-xs">
                  Sent to
                  <select
                    className="field"
                    data-testid="endpoint"
                    value={endpoint?.id ?? ''}
                    onChange={(e) => setEndpointId(e.target.value)}
                  >
                    {endpoints.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label} — {e.provider}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {endpoint !== undefined && (
                /*
                 * Named before the first turn, not after. §13 requires that
                 * adding a provider never quietly change where source code is
                 * transmitted, and a picker that shows only a model name is
                 * exactly that quiet change — the recipient has to be legible at
                 * the moment of choosing, which is the only moment it can still
                 * be reconsidered. Collapsing two dropdowns into one does not
                 * get to collapse this.
                 */
                <small
                  data-testid="endpoint-provider"
                  className={endpoint.authenticated ? 'text-state-paused text-[11px]' : 'text-muted text-[11px]'}
                >
                  {endpoint.authenticated
                    ? `Your code and prompts go to ${endpoint.provider}, over the network.`
                    : `Stays on the host — ${endpoint.provider}.`}
                </small>
              )}
            </div>
          )}

          <button
            className="btn"
            data-testid="add-agent"
            disabled={
              busy || current === undefined || (current.typed === true && typedModel.trim() === '')
            }
            onClick={() => {
              if (current === undefined) return;
              void onAdd(
                current.runtimeId,
                current.typed === true ? typedModel.trim() : current.modelId,
                // Unchanged contract: the store drops this when the model is
                // null, so a no-model runtime is unaffected either way.
                needsModel ? endpoint?.id : undefined,
              );
            }}
          >
            Add agent
          </button>
        </>
      )}
    </div>
  );
}
