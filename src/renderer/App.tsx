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
import { NewSession } from './NewSession.js';
import { Dashboard } from './Dashboard.js';
import { SupportMatrix } from './SupportMatrix.js';
import { Inbox } from './Inbox.js';
import { Search } from './Search.js';
import { Artifacts } from './Artifacts.js';
import { Roster } from './Roster.js';
import { McpAttached, McpServerFields } from './McpServers.js';
import { firstProblem, toConfigs, type McpDraft } from './mcpConfig.js';
import { Group } from './Group.js';
import { agentLabel } from './attribution.js';
import { StartGuide } from './StartGuide.js';
import { Welcome } from './Welcome.js';
import { About } from './About.js';
import { RuntimeSelect } from './RuntimeSelect.js';
import { EMPTY_ENDPOINT, SetUpEndpoint, SetupProgress, type EndpointDraft } from './SetUpMachine.js';
import {
  actionLabel,
  buildEntries,
  entryNote,
  type AgentEntry,
} from './setupRoutes.js';
import { CapabilityBadges } from './CapabilityBadges.js';
import { panelBadges, rowBadges, toolWarning, worthChecking } from './modelCapabilities.js';
import { useAgbrte } from './store.js';
import { Composer, EventRow, PermissionPrompt, SplitPrompt, Transcript, WorkingDots, summarize } from './Transcript.js';
import { Preview } from './Preview.js';
import { TerminalView } from './TerminalView.js';
import { Shell, type ShellChoice } from './Shell.js';
import { FileBrowser, FileViewer, VIEWER_DEFAULT } from './FileBrowser.js';
import type {
  EndpointModelsDto,
  ModelInstallDto,
  SessionTemplateDto,
  SetupOutcomeDto,
  SetupPlanDto,
} from '@shared/ipc/contract.js';
import CATALOGUE from '../shared/models/catalogue.json' with { type: 'json' };
import type { HostInfo, RuntimeInfo } from '../shared/ipc/contract.js';
import type {
  MatrixCell,
  ModelCapabilityHint,
  Session,
  SessionState,
  ShellProgram,
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
  /**
   * Whether the "where should this work" panel is open (§8).
   *
   * Separate state from `attaching` and not a mode of it, because they are two
   * different questions asked at two different times: naming a machine is a fact
   * about somebody's setup, and choosing a folder is the start of a piece of
   * work. Folding them into one flag would put them back in one form, which is
   * the thing that changed.
   */
  const [creating, setCreating] = useState(false);
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
   * Whether the mid-session model form is open (§4.2).
   *
   * View state, like `focusedAgent`: which forms are unfolded is a way of
   * looking at a session, not a fact about it.
   */
  const [changingAgent, setChangingAgent] = useState(false);
  /*
   * Which of three panes the session column is showing.
   *
   * ## Three-way rather than a second toggle, and rather than a split
   *
   * `raw` and `shell` are easy to confuse and must never be confused, so they
   * are mutually exclusive choices in one control that names all three. A second
   * independent toggle beside the first would produce four states, two of which
   * are the same screen, and would leave "Terminal" meaning two different things
   * one button apart.
   *
   * Side by side was the other candidate and was rejected on layout: both panes
   * replace the transcript in a single column that already carries a roster, a
   * group strip, permission prompts and a composer, and the transcript is the
   * one child allowed to give up height (see `Group`). Two half-height monospace
   * panes would make both unusable rather than one useful.
   *
   *  - `chat`  — the transcript. The durable record, and the default.
   *  - `raw`   — what the CLI *printed* while a model drove it (§3.12).
   *              Read-only, and only where a seat has a raw side at all.
   *  - `shell` — a PTY **you** type into. Not an agent, not in the log, not
   *              gated by §13. Offered wherever the host can run one.
   *
   * View state like `focusedAgent`: which pane is showing is a way of looking,
   * not a fact about the session, and two devices must not fight over it.
   */
  const [sessionPane, setSessionPane] = useState<'chat' | 'raw' | 'shell'>('chat');
  /**
   * The two right-hand rails: whether the tree is showing, and which file the
   * viewer is holding.
   *
   * Two pieces of state rather than one, because they answer different
   * questions and either rail can be collapsed on its own: a person can browse
   * with the transcript still on screen, and can read a file with the tree put
   * away to give its width back. Collapsing them into one would make hiding the
   * tree close the file, which is the opposite of what somebody comparing a file
   * against a transcript wants.
   *
   * `openFile` *is* the viewer rail's open/closed state rather than a third
   * boolean beside it — a rail with no file in it has nothing to show, so a
   * second flag could only ever disagree with this one.
   *
   * View state like `focusedAgent` and `sessionPane`: where somebody is looking
   * is not a fact about the session, so it is never sent anywhere and two
   * devices cannot fight over it.
   */
  /**
   * Which sessions have the ports row open, keyed by session.
   *
   * ## Why it is folded at all
   *
   * §6.8 is a real feature and was permanently expanded: every session on a
   * remote host opened with *Preview a port on that machine*, a port field, a
   * Forward button, `Run a dev server there`, and — on a shared build box — six
   * detected ports, most of them somebody else's services. That row sat above
   * the roster and the transcript whether or not the session had anything to do
   * with a web server. The feature is right; being permanently on screen for
   * everybody is what was wrong, so it now works the way `Files` and the
   * Chat/Terminal toggle already work in that pane: nothing until asked for.
   *
   * ## Nothing announced while it is folded
   *
   * A count of *detected* ports is the noise the fold exists to remove — they
   * are other people's services on a machine this session happens to share, and
   * a badge saying `6` would move that noise into the header rather than delete
   * it. A count of *our own* forwards would be defensible, and is not free: the
   * numbers come from a 4-second poll that only runs while the panel is
   * mounted, so a badge would mean polling a machine forever to render a digit
   * for a panel nobody has opened — the same trade §6.8 already refused. What it
   * would announce is also something the person did deliberately, seconds
   * earlier, in this panel. So: silence, and `aria-pressed` on the control.
   *
   * ## Per session, and view state
   *
   * Keyed by session so somebody doing web work does not reopen it every turn,
   * and a session that has nothing to do with ports does not inherit the fold
   * from the one before it. View state like `focusedAgent`: where somebody is
   * looking is not a fact about the session, so it is never sent anywhere and
   * two devices cannot fight over it.
   */
  const [portsOpen, setPortsOpen] = useState<Record<string, boolean>>({});
  const [filesOpen, setFilesOpen] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  /**
   * How wide the viewer rail is, in pixels.
   *
   * Held here rather than in `FileViewer` because it has to outlive the file:
   * the component unmounts every time a file is closed, and a rail that snapped
   * back to its default on each close would be a control that forgets what it
   * was told, which is worse than not having it. It is a fact about this window,
   * not about the session or the file, so it survives both a session switch and
   * a host switch — and, being view state, it is never sent anywhere.
   *
   * Not persisted: `agentDefaults` earns its `localStorage` entry by saving a
   * *decision* somebody made in a form, and a column width nudged with an arrow
   * key is not that. If it turns out people re-drag it at every launch, that is
   * the evidence for storing it, and there is no evidence yet.
   */
  const [viewerWidth, setViewerWidth] = useState(VIEWER_DEFAULT);
  /**
   * What the terminal pane runs, once somebody has said — `null` until then.
   *
   * `null` rather than eagerly resolving the default, because the default is
   * derived from things that arrive after the first render: the host handshake
   * says which CLIs exist, and the session says whether it has a CLI seat. A
   * `useState(derive())` would freeze whichever of those had landed first, and
   * the visible symptom would be a pane that opens a shell on exactly the
   * machines where the CLI took longest to detect.
   *
   * View state like `focusedAgent`: which program a person is driving on their
   * own screen is not a fact about the session, and two devices must not fight
   * over it.
   */
  const [shellProgram, setShellProgram] = useState<ShellProgram | null>(null);
  /*
   * Whether the seat has a raw side at all (§3.12).
   *
   * Availability is probed rather than inferred from the runtime id — the
   * owner answers `null` for a seat with no raw stream (harness, echo, an old
   * host), and branching on runtime identity here is exactly the leakage the
   * probe exists to avoid.
   */
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

  /**
   * The seats this session actually runs (§4.2).
   *
   * One, in every session created since the roster was capped; two in the ones
   * that predate it. A seat retired by a model change stays in `agents` so the
   * transcript can name the rows it wrote, and it is excluded from every
   * question about *now*: who to send to, whose terminal to show, whether there
   * is anything to filter between.
   */
  const liveAgents = active?.agents.filter((a) => a.status !== 'retired') ?? [];

  /**
   * The seat the transcript is filtered to, or `null` for the whole log.
   *
   * `focusedAgent` is a wish; this is whether it can be granted. With one live
   * seat there is nothing to filter between — and a stale focus left over from a
   * seat that has since been replaced would filter the pane down to a dead
   * agent's rows with no `Everyone` button on screen to escape it, because
   * `Roster` does not draw one for a single seat.
   */
  const paneAgent = liveAgents.length > 1 ? focusedAgent : null;

  /*
   * Whose raw side the pane shows: the seat being read, not seat zero.
   *
   * `agents[0]` was wrong the moment a session had two seats — a CLI worker
   * added beside a harness lead had a terminal nobody could reach, because the
   * probe and the pane both asked about the lead. `paneAgent` is the seat the
   * transcript is already filtered to, so the raw view follows the reading, and
   * falls back to the live seat rather than to a retired one.
   */
  const rawAgentId = paneAgent ?? liveAgents[0]?.agentId ?? null;
  const rawAgentStatus =
    active?.agents.find((a) => a.agentId === rawAgentId)?.status ?? null;

  /*
   * A pane filter belongs to the session it was chosen in.
   *
   * Carried across a session switch it filters the new transcript to an agentId
   * that is not in it — an empty pane that looks like a session with no history
   * — and after a model change it points at a retired seat, whose raw side the
   * host now refuses to answer for. Cleared on the session, not on `rawAgentId`,
   * which is derived from this.
   */
  useEffect(() => {
    setFocusedAgent(null);
  }, [active?.sessionId]);

  // A different seat is a different question, so the answer is thrown away and
  // the pane returns to chat. The only place availability goes back to false.
  //
  // It also ends the shell, by unmounting `Shell` — deliberate: a terminal is a
  // view of one workspace, and carrying one across a session switch would leave
  // a PTY open on a machine the user has navigated away from.
  useEffect(() => {
    setSessionPane('chat');
    setRawAvailable(false);
    // The open file goes too, which closes the viewer rail with it. A path is
    // relative to *a* workspace, and the next session may be on another machine
    // entirely — carrying it over would ask one host for a file that only exists
    // on another, and the refusal would arrive with no explanation a person
    // could act on. The tree rail's own open/closed state is a habit rather than
    // a fact about a workspace, and its width is a fact about the window, so
    // both stay.
    setOpenFile(null);
    // And the terminal's program goes back to being derived. A choice is about
    // *this* session's tools — a session with a Claude Code seat and one with a
    // Gemini seat should not inherit each other's pane — and carrying it across
    // would be a stale answer to a question nobody asked again.
    setShellProgram(null);
  }, [active?.sessionId, rawAgentId]);

  /*
   * Asked whenever the seat could have printed something, not only mid-turn.
   *
   * `SessionManager.rawLog` used to answer `null` both for a seat with no raw
   * side and for one *between turns*, because the tail lived on the handle and
   * `runTurn` releases the handle when the turn ends. That forced this probe to
   * chase a live turn — and it still lost, because in the shipped topology the
   * handle is a proxy to the agent host and never had a tail at all. The tail is
   * now kept by the session, so a seat that has ever printed answers at any
   * time, and the ordinary case is that the very first ask succeeds.
   *
   * Still polled while a turn runs, for the one case that remains: a seat whose
   * first line has not been printed yet. `working` is watched as well as the
   * seat's own `running` because of the order `runTurn` does things in, and one
   * poll landing in a gap should not cost the toggle for the whole turn.
   *
   * Latched: a seat that has shown a raw stream once has a raw side, and taking
   * the toggle away would close the pane out from under a reader.
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

  /**
   * What to do about a session parked on a credential (§3.11, §4.1).
   *
   * Read back out of the log rather than carried on `Session`, because the
   * sentence belongs to the transition that produced it: the owner composed it
   * knowing which machine it runs on and which CLI refused, and neither of those
   * is knowable here — a browser tab watching a session on a build box must not
   * tell anyone to log in on the laptop it happens to be running on.
   *
   * Only while the session is actually parked. An old auth pause that somebody
   * already fixed is history, and history belongs in the transcript.
   */
  const lastStateRow = [...events].reverse().find((e) => e.type === 'session.state');
  const credentialsAdvice =
    active?.state === 'awaiting_credentials' && lastStateRow?.to === 'awaiting_credentials'
      ? lastStateRow.reason
      : undefined;

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
   * Seat this session's model and, if it landed, remember the choice.
   *
   * One function for both the empty session and the change, because it is one
   * call to the host (§4.2): the seat that is there, if any, is retired and this
   * one takes over. Success is the filter — a runtime that failed to start, a
   * model the host refused, or a seat the host would not replace because
   * somebody else changed it first must not become what every future session
   * silently reaches for.
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
  /**
   * Start a session, which begins by asking where it should work (§8).
   *
   * This used to be a folder picker and nothing else, because a folder was the
   * only thing a session could be started in on this machine — the *machine* was
   * decided when a host was attached. Both halves are now asked here, in
   * `NewSession`, because a host is one per machine and a session names its own
   * folder: picking only a folder would have quietly meant "on this computer",
   * which is exactly the assumption the change removed.
   *
   * A full-pane page would otherwise cover the session this is about to open,
   * and below `md` the main pane is where the progress line and the error banner
   * live — the sidebar this may have been pressed from is not.
   */
  const newSessionOneShot = (): void => {
    setView('none');
    setPane('main');
    setStarting(null);
    setCreating(true);
  };

  const runtimesHere = active === null ? [] : (runtimesByHost[active.instanceId] ?? []);
  const conformanceHere = active === null ? [] : (conformanceByHost[active.instanceId] ?? []);
  /*
   * From the host record rather than a second fetch.
   *
   * `hosts` is already pushed on every attach, every link change and every
   * reconnect, so the explanation follows a host being replaced by one with a
   * different set of tools installed — for free, and by the same route the
   * runtime list itself takes.
   */
  const notesHere =
    active === null
      ? []
      : (hosts.find((h) => h.instanceId === active.instanceId)?.runtimeNotes ?? []);

  const activeHost = active === null ? undefined : hosts.find((h) => h.instanceId === active.instanceId);
  /**
   * Whether this host can give you a terminal.
   *
   * **The host's own answer**, because only the host knows. This used to be
   * `targetKind === 'local'`, which was true of the world it was written in — a
   * remote was two bundled `.js` files with no `node_modules` beside them, so
   * the module that opens a pty was genuinely not there. It stopped being true
   * when the pty module started being deployed with them, and it was wrong the
   * other way round all along: a cross-built arm64 artifact ships without the
   * prebuild, so a *local* host can be one that cannot open a terminal.
   *
   * The fallback is the same inference, used only where the host is too old to
   * say — which describes that host correctly, since a host that predates the
   * field also predates the deployment. The button stays either way, disabled
   * and naming the host, rather than vanishing and looking like a feature that
   * does not exist.
   */
  const shellHere = activeHost?.shells ?? activeHost?.targetKind === 'local';
  /**
   * Whether this session's workspace is on another machine (§6.8).
   *
   * The one condition the ports row has ever had, and the reason is unchanged:
   * a local dev server is already on `localhost` at a port the person chose, so
   * offering to forward it is a button that does nothing visible — which teaches
   * people the feature does nothing.
   */
  const remoteHere = activeHost !== undefined && activeHost.targetKind !== 'local';
  /** Whether *this* session's ports row is unfolded. Folded is the default. */
  const portsShowing = active !== null && portsOpen[active.sessionId] === true;

  /*
   * What the terminal pane can run on this host, and what it opens by default.
   *
   * ## The list is the host's, not a list kept beside the host's
   *
   * `available` is what the owning host said it will admit — the same array the
   * agent picker draws from and the same one `admit()` consults. Filtering it to
   * the `cli:` ids is the whole derivation: a CLI the picker offers is a CLI the
   * pane can open, and one it does not is refused by the host with the sentence
   * `runtimeNotes` already shows. Maintaining a second list here would be one
   * more thing to keep in step with a machine three time zones away, which is
   * how the picker and the admission gate disagreed once already.
   *
   * ## Why the seat decides the default
   *
   * A session with a Claude Code seat is a session where somebody has already
   * said which tool this work uses, so opening the pane on a shell prompt asks
   * the question again and answers it wrongly. The shell stays one click away
   * because it is what somebody needs when the CLI is the broken thing: a PATH
   * to fix, a `git status` to read, a `claude` that will not start.
   *
   * ## And why a seat with no vendor CLI gets ours
   *
   * A harness seat on a local model has no interface of its own to open: there
   * is no binary, so `{kind:'cli'}` has nothing to name and the pane could only
   * ever offer a prompt. `{kind:'agbrte'}` is the answer — our own CLI, attached
   * to *this* session, which is a real client of the same host rather than a
   * program beside it. So it is the default exactly when the seat is not a
   * vendor CLI, and it is offered **always**, including on a Claude Code seat,
   * because "drive this session from a keyboard" is a thing somebody may want
   * whatever the seat happens to be.
   *
   * So the row offers exactly two things, in the order of how much of *this
   * session* each one is: the session's own interface — the seat's CLI, or ours
   * where the seat has none — and then the machine's shell.
   */
  const clisHere = (activeHost?.available ?? []).filter((id) => id.startsWith('cli:'));
  /*
   * The seat that is *running*, not every seat this session ever had.
   *
   * A session holds one agent (§4.2) and changing the model retires the old one,
   * which stays in the roster so the transcript's older rows keep a name. This
   * read every entry, so a session moved from Claude Code to a local model went
   * on offering a Claude Code button — the retired seat, still answering for a
   * tool the live one does not use. Reported from a real session.
   */
  const seatCli =
    active?.agents
      .filter((a) => a.status !== 'retired')
      .map((a) => a.spec.runtimeId)
      .find((id) => id.startsWith('cli:') && clisHere.includes(id)) ?? null;

  /*
   * Two buttons: **this agent's CLI**, and the shell.
   *
   * It was one per detected CLI plus ours, which is a list of everything the
   * machine happens to have rather than an answer to what somebody wants. A
   * session has one seat (§4.2) and that seat has one interface: a Claude Code
   * seat's is Claude Code, and a seat on a local model has none of its own — so
   * ours stands in, attached to this session, which is what it was built for.
   * Either way that is *one* button, and which of them it is says something true
   * about the session rather than about the machine's PATH.
   *
   * The other installed CLIs did not disappear so much as stop being offered
   * here: they are not this session's tool, and starting one from a session's
   * own row implied a relationship it does not have. The shell is one click
   * away and can start anything by hand — which is the sentence its own hint has
   * always carried.
   */
  const agentCli: ShellChoice =
    seatCli !== null
      ? {
          key: seatCli,
          label: terminalLabel(seatCli),
          program: { kind: 'cli' as const, cliId: seatCli.slice(4) },
          hint:
            `${runtimeLabel(seatCli)}, the tool this session's seat uses — run it yourself, ` +
            'interactively. Nothing here enters the session log',
        }
      : {
          key: 'agbrte',
          label: 'Agbrte CLI',
          program: { kind: 'agbrte' as const },
          // The one hint that promises the opposite of the other's, because this
          // is a client of this session rather than a program beside it.
          hint:
            'Agbrte’s own interface, attached to this session — send turns, answer permission ' +
            'prompts, watch the transcript. Unlike a vendor CLI it is a real client: what you ' +
            'send here appears in the chat pane and in the session log',
        };
  /*
   * And the default is that same button.
   *
   * There used to be a separate ladder — the seat's CLI, else ours, else the
   * first detected CLI, else a prompt — computed beside a list of buttons that
   * could disagree with it. One definition instead: whatever this session's CLI
   * is, is both what the row offers first and what the pane opens on.
   */
  const defaultShellProgram: ShellProgram = agentCli.program;
  const shellChoices: ShellChoice[] = [
    agentCli,
    {
      key: 'shell',
      label: 'Shell',
      program: { kind: 'shell' as const },
      hint: `The login shell on ${activeHost?.label ?? 'this host'} — for fixing a PATH, reading a git status, or starting a CLI by hand`,
    },
  ];

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

        {creating && (
          <NewSession onOpened={() => setCreating(false)} onClose={() => setCreating(false)} />
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
          {byMachine(hosts).map((machine) => (
            <HostGroup
              key={machine.key}
              machine={machine}
              sessions={sessions.filter((s) =>
                machine.workspaces.some((w) => w.instanceId === s.instanceId),
              )}
              unloaded={onDisk.filter(
                (d) =>
                  machine.workspaces.some((w) => w.instanceId === d.instanceId) &&
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
            /* On disk counts: a session nobody has resumed this launch is
               still a session, and it is listed in the sidebar as one. */
            hasSessions={sessions.length > 0 || onDisk.length > 0}
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

            {active.state === 'awaiting_credentials' && (
              <CredentialsNotice advice={credentialsAdvice} />
            )}

            {/*
              Above the seat, not beside it (§17 Q20, §3.5).

              It answers the same question the roster does — what this session
              is and what it can reach — but it has to answer it *earlier*: the
              servers attached when the session was created, which is before a
              model has been chosen. Rendered inside the seated branch it would
              have been invisible on exactly the screen somebody lands on after
              filling the form, so a server that failed to start would go
              unmentioned until a model was picked. Renders nothing at all where
              no server was named.
            */}
            <McpAttached {...(active.mcp !== undefined ? { servers: active.mcp } : {})} />

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
                /*
                  The one scroll region on this screen, and the reason it exists.

                  With a host that has just been set up, this column holds the
                  set-up panel *and* its progress, the detection notes, the
                  runtime select, the conformance matrix, the capability badges,
                  the model field and a twelve-entry catalogue with a description
                  on every row: 1215 px of content. Rendered straight into
                  `main`'s flex column that is 722 px tall on a 1180x820 window,
                  and a flex item's `min-height: auto` means it does not shrink,
                  so nothing scrolled — `main` measured 1274 against a 781 px
                  viewport and the last model's row ended 387 px below the window
                  edge, unreachable. At 481 px tall it was 832 px below it.

                  `grow min-h-0 overflow-y-auto` rather than a `max-h` on the
                  catalogue, because the catalogue's descriptions are the reason
                  it is worth the space and a scrollbox inside a scrollbox is the
                  thing that made the attach panel confusing. It takes only free
                  space, so the `shrink-0` rows above it keep their height
                  exactly as before: the session header measures 60 px with this
                  wrapper and 60 px without it, at every size tested.

                  A flex column so the picker's own `m-auto` still centres it
                  when the host needs nothing and the form is short: auto margins
                  resolve to zero once free space is negative, which is why this
                  is safe here and `justify-center` would clip the top.
                */
                <div
                  className="flex min-h-0 min-w-0 grow flex-col overflow-y-auto"
                  data-testid="picker-scroll"
                >
                  <AgentPicker
                    /* Remounted per host: the model list it holds is that host's
                       answer, and §13 will not have one machine's endpoints shown
                       while an agent is added on another. */
                    key={active.instanceId}
                    runtimes={runtimesHere}
                    notes={notesHere}
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
                    machine={machineFor(active.instanceId, activeHost)}
                    // Remembering on success is what makes the *next* session
                    // skip this form entirely (agentDefaults.ts).
                    say={store.say}
                    onAdd={addAgentRemembering}
                    busy={busy}
                  />
                </div>
              )
            ) : (
              <>
                <Artifacts
                  events={events}
                  load={(sha256, mime) => store.loadBlob(sha256, mime)}
                />
                {/*
                  The pane, with the workspace sidebar beside it.

                  A **row**, and that is the load-bearing bit of this layout. The
                  session column stacks fixed rows around one transcript that is
                  the only child allowed to give up height (see `SessionHeader`),
                  so a rail added to that stack would cost the transcript height
                  on every session whether or not anybody was browsing. Here the
                  rails cost width and no height at all, and `min-h-0` +
                  `overflow-hidden` keep a 500-entry directory scrolling inside
                  itself rather than stretching the row.

                  Left to right: the pane, the tree, the file. The pane is the
                  only `flex-1` child, so it is the one that gives up width when
                  a rail opens and the one that gets it back when a rail closes.

                  `lg:min-w-44` is the floor under it, and it is what the viewer
                  rail's drag runs into rather than a percentage cap on the rail
                  itself: past 176px the transcript stops being a column of text,
                  and *that* is the limit worth stating — a cap on the file would
                  also have applied when the tree was closed and nobody was
                  reading the transcript at all. The tree is `shrink-0` at a fixed
                  224 and the viewer shrinks, so when the three minima meet on a
                  narrow window it is the file that gives way, never the layout.

                  Below `lg` the two rails become overlays and take the column
                  one at a time; the breakpoint lives entirely in their own class
                  lists (see `RAIL_OVERLAY`), so nothing here has to know it.
                */}
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:min-w-44">
                    {sessionPane === 'raw' && rawAvailable && rawAgentId !== null ? (
                      <TerminalView sessionId={active.sessionId} agentId={rawAgentId} />
                    ) : sessionPane === 'shell' && shellHere ? (
                      /* Keyed by session so switching sessions is a new terminal in
                         the new workspace rather than a stale one pointed at the
                         old — the PTY's `cwd` belongs to a workspace, not to a
                         window. */
                      <Shell
                        key={active.sessionId}
                        sessionId={active.sessionId}
                        instanceId={active.instanceId}
                        program={shellProgram ?? defaultShellProgram}
                        hostLabel={activeHost?.label ?? active.instanceId}
                      />
                    ) : (
                    <Transcript
                      events={
                        paneAgent === null
                          ? events
                          : /* Filtered rather than re-fetched: the unified timeline is
                               the truth and a pane is a view of it, so switching back
                               cannot show something different from what was there. */
                            events.filter((e) => e.agentId === paneAgent)
                      }
                      renderRow={(e) => (
                        <EventRow key={e.seq} event={e} by={agentLabel(active.agents, e.agentId)} />
                      )}
                      /* Motion at the tail while the turn runs, so a long silence
                         reads as "busy" rather than "hung" (see WorkingDots). */
                      working={active.state === 'working'}
                    />
                    )}
                  </div>
                  {filesOpen && (
                    <FileBrowser
                      /* Keyed by host: a tree of paths belongs to one workspace,
                         and reusing the component across a switch would render
                         one machine's folders under another machine's root. */
                      key={active.instanceId}
                      instanceId={active.instanceId}
                      selected={openFile}
                      onOpenFile={setOpenFile}
                      onClose={() => setFilesOpen(false)}
                    />
                  )}
                  {openFile !== null && (
                    /* Keyed by path as well as by host, so opening a second file
                       is a fresh read rather than the previous file's text left
                       on screen under the new name while the request is in
                       flight. */
                    <FileViewer
                      key={`${active.instanceId}:${openFile}`}
                      instanceId={active.instanceId}
                      path={openFile}
                      width={viewerWidth}
                      onWidth={setViewerWidth}
                      /* Closing gives the width back to the transcript and
                         leaves the tree exactly as it was — the two rails
                         collapse independently, which is the whole reason they
                         are two pieces of state. */
                      onClose={() => setOpenFile(null)}
                    />
                  )}
                </div>
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
                {/*
                  One column, the width of the transcript above it.

                  The rows and the composer used to run edge to edge while the
                  conversation sat in the middle of the window, so a maximised
                  screen showed a line of text with controls stranded at both
                  margins. Sharing one width is what makes the session read as a
                  single conversation — the same reason the transcript's cap came
                  back (see `Transcript`).
                */}
                <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-6 pb-4">
                {/*
                  Everything about *this* session, at the end of it (§7).
                
                  These rows — the seat and its effort, the group, the pane
                  chooser, the ports and files — used to sit between the header
                  and the transcript, which put four rows of settings above the
                  first line of what was said and pushed the conversation down
                  the screen on every session. They are read rarely and changed
                  rarely; the transcript is read constantly and the composer is
                  where the hands already are, so the controls belong beside the
                  composer rather than above the reading.
                
                  The stacking rule is unchanged and is what makes the move safe:
                  every row here is `shrink-0` and the pane above is the only
                  child allowed to give up height, so moving fixed rows from one
                  end of the column to the other costs the transcript nothing.
                */}
                {changingAgent && (
                  /* The same picker the empty session shows, folded in under
                     the seat it replaces. A session holds one agent (§4.2), so
                     choosing here retires the current seat and admits the new
                     one — one call, decided by the host, both halves in the
                     transcript. Bounded and scrollable so an unfolded model
                     browser cannot crush the transcript below it (see
                     SessionHeader on why fixed rows around the transcript must
                     hold their height). */
                  <div className="border-line max-h-[45%] shrink-0 overflow-y-auto border-b">
                    <AgentPicker
                      key={active.instanceId}
                      runtimes={runtimesHere}
                      notes={notesHere}
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
                      machine={machineFor(active.instanceId, activeHost)}
                      // Success saves the choice as the new default and closes
                      // the form; failure leaves it open with the error banner.
                      say={store.say}
                      onAdd={addAgentRemembering}
                      submitLabel="Change model"
                      busy={busy}
                    />
                  </div>
                )}
                {portsShowing && (
                  /*
                    Directly under the control that opened it (§6.8).

                    It used to sit above the roster, between the header and
                    everything else, on every remote session — so the first thing
                    a person saw about a session was six ports on a shared build
                    box. Here it is a fixed row that exists only while somebody is
                    looking at it, and it costs the transcript no height at all
                    until then.
                  */
                  <Preview
                    sessionId={active.sessionId}
                    instanceId={active.instanceId}
                    remote={remoteHere}
                  />
                )}
                {/* The newest thing an agent said, for reading aloud (§12.4).
                    Derived here rather than tracked in the store: it is a view
                    of the transcript already in hand, and a second copy of
                    "what was said last" is a second thing to keep in step. */}
                <Composer
                  onSend={(t, blocks) => void store.send(t, paneAgent ?? undefined, blocks)}
                  disabled={active.state === 'working'}
                  queued={queued}
                  sessionId={active.sessionId}
                  {...(lastAgentText !== undefined ? { lastAgentText } : {})}
                  meta={
                    <>
                        {/* §13: a heterogeneous roster is gated heterogeneously, and the
                            UI must never imply otherwise. */}
                        <Roster
                          agents={active.agents}
                          selected={paneAgent}
                          onSelect={setFocusedAgent}
                          onEffort={(agentId, mode) => store.setReasoning(agentId, mode)}
                        />
                        {/* §17 Q22. Folded by default: a group is a handful of lines in
                            a session that may run for days, and the transcript — above
                            these rows now — is the only child of this column allowed to
                            give up height. */}
                        <Group
                          session={active}
                          sessions={sessions}
                          events={events}
                          onGroup={(sessionId, name) => void store.groupWith(sessionId, name)}
                          onLeave={() => void store.leaveGroup()}
                          onOpen={(sessionId) => void store.openSession(sessionId)}
                        />
                    </>
                  }
                  tools={
                    <>
                        {/* Named choices rather than one button whose label changes:
                            `raw` and `shell` are easy to confuse and must not be, so
                            both are visible at once with the difference spelled out in
                            their titles. `Raw output` appears only where a seat has one
                            — a toggle to an empty pane teaches people the feature does
                            nothing. `Terminal` is offered wherever the host can run one,
                            and says why when it cannot.

                            **Three, and it names only what is in the main pane.** There
                            was a fourth, `File`, back when opening a file replaced the
                            transcript; the file now has a rail of its own to the right,
                            so the mode it needed is gone rather than left as an entry
                            that switches to a pane nobody moved. This row's whole job is
                            to answer "what am I looking at" about one box, and it is
                            only trustworthy while that stays one box.

                            `Files` is not a mode and is set apart with `ml-auto`,
                            at the *right* end of the row because that is the side its
                            column opens on — the control and the thing it opens should
                            not be at opposite ends of the same screen. */}
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            className="btn text-[11px]"
                            data-testid="show-chat"
                            title="The transcript — the durable record of this session"
                            aria-pressed={sessionPane === 'chat'}
                            onClick={() => setSessionPane('chat')}
                          >
                            Chat
                          </button>
                          {rawAvailable && (
                            <button
                              className="btn text-[11px]"
                              data-testid="show-terminal"
                              title="What the CLI printed while the agent drove it — read-only"
                              aria-pressed={sessionPane === 'raw'}
                              onClick={() => setSessionPane('raw')}
                            >
                              Raw output
                            </button>
                          )}
                          {/*
                            One button per program, not one button and then a
                            choice.

                            `Terminal` opened a pane that then asked which of
                            three things to run, so reaching the CLI you meant
                            was two decisions and a wait in between — and the
                            first of them, "terminal", is not a thing anybody
                            wants. It is the *category*. What people want is
                            Claude Code, or their shell, or Agbrte attached to
                            this session, and each of those is now a button that
                            starts it.

                            Disabled rather than hidden where the host cannot run
                            one, with the reason in the title: a control that
                            vanishes teaches people the feature does not exist
                            (§6.8's rule, applied to a row rather than to a port).
                          */}
                          {shellChoices.map((choice) => (
                            <button
                              key={choice.key}
                              className="btn text-[11px]"
                              data-testid="show-shell"
                              data-choice={choice.key}
                              title={
                                shellHere
                                  ? choice.hint
                                  : /* The host's own sentence where it gave one:
                                       "no terminal here" is a fact and "the
                                       prebuild for this architecture is not in
                                       the package" is something a person can act
                                       on (§6.8). The fallback is for a host too
                                       old to say anything at all. */
                                    `A terminal on ${activeHost?.label ?? 'this host'} is not available: ` +
                                    (activeHost?.shellsReason ??
                                      'terminals run on the machine that owns the workspace, and that ' +
                                        'one has no pty module')
                              }
                              aria-pressed={
                                sessionPane === 'shell' &&
                                (shellProgram ?? defaultShellProgram).kind === choice.program.kind &&
                                (choice.program.kind !== 'cli' ||
                                  (shellProgram ?? defaultShellProgram).kind !== 'cli' ||
                                  ((shellProgram ?? defaultShellProgram) as { cliId: string })
                                    .cliId === choice.program.cliId)
                              }
                              disabled={!shellHere}
                              onClick={() => {
                                // Both, and in this order: choosing a program
                                // while the transcript is showing has to *open*
                                // the pane, or the press does nothing visible.
                                setShellProgram(choice.program);
                                setSessionPane('shell');
                              }}
                            >
                              {choice.label}
                            </button>
                          ))}
                          {/* At the far end with `Files`, and for the same reason: it
                              chooses nothing about the main pane, so grouping it with
                              the three modes would say it was a fourth one. Remote only
                              — a local dev server is already on localhost, and a button
                              that does nothing visible teaches people the feature does
                              nothing (§6.8). */}
                          {remoteHere && (
                            <button
                              className="btn ml-auto text-[11px]"
                              data-testid="toggle-ports"
                              title="Forward a port from that machine to this one, and run a dev server there that outlives the turn"
                              aria-pressed={portsShowing}
                              onClick={() =>
                                setPortsOpen((was) => ({
                                  ...was,
                                  [active.sessionId]: was[active.sessionId] !== true,
                                }))
                              }
                            >
                              Ports
                            </button>
                          )}
                          {/* Not grouped with the three above: grouping it there would
                              say it is a fourth mode, and it chooses nothing about the
                              main pane at all. `ml-auto` moved to `Ports` when that
                              joined it at this end, so the pair stays together and the
                              modes stay together. */}
                          <button
                            className={`btn text-[11px] ${remoteHere ? '' : 'ml-auto'}`}
                            data-testid="toggle-files"
                            title="The files in this workspace, listed by the machine that owns it"
                            aria-pressed={filesOpen}
                            onClick={() => setFilesOpen((open) => !open)}
                          >
                            Files
                          </button>
                        </div>
                    </>
                  }
                />
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/** One host and its sessions, with §10's target badge. */
function HostGroup({
  machine,
  sessions,
  unloaded,
  activeId,
  showLoaded,
}: {
  machine: MachineRow;
  sessions: Session[];
  unloaded: Array<{
    sessionId: string;
    title: string;
    instanceId: string;
    group?: { groupId: string; name: string };
  }>;
  activeId: string | null;
  /** False while the dashboard is showing them. See the call site. */
  showLoaded: boolean;
}): JSX.Element {
  const store = useAgbrte();
  /**
   * The workspace this row's *acts* go to.
   *
   * Stopping, updating and opening a terminal are things done to a **host**,
   * and a host is one process per machine (§8) — so any of its workspaces
   * routes to the same place and the first one is as good as any. Kept as a
   * named thing rather than inlined, because "which workspace" is exactly the
   * question this row stopped asking when it became a machine.
   */
  const host = machine.workspaces[0]!;
  /** Shown per session only where there is something to tell apart. */
  const manyFolders = machine.workspaces.length > 1;
  const folderOf = (instanceId: string): string | null => {
    if (!manyFolders) return null;
    const found = machine.workspaces.find((w) => w.instanceId === instanceId);
    return found === undefined ? null : folderName(found.root);
  };
  const [adding, setAdding] = useState(false);
  /**
   * Which of the machine's folders a session without one of its own goes into.
   *
   * A row is a machine and a machine can hold several workspaces (§8), so "in
   * this workspace" stopped being answerable by the row itself. Defaulted to the
   * first and shown only where there is a choice, because a select with one
   * option is a question with one answer.
   */
  const [intoWorkspace, setIntoWorkspace] = useState('');
  const [title, setTitle] = useState('');
  /**
   * A folder of this session's own, made beside the one this host has open.
   *
   * **Filled from the title rather than left empty**, because a rule that is
   * offered is not a rule. One session, one folder (§8) — and an optional
   * field meant the default was still "another session in whatever folder this
   * host has open", so a machine attached to `~/Desktop` kept putting sessions
   * on top of somebody's desktop and the field looked like a feature nobody
   * needed. Reported twice from a real server, which is twice more than it
   * should have taken.
   *
   * Editable and clearable: emptying it is how you say "in this workspace",
   * which is a real thing to want when several sessions work on one project.
   * `touched` keeps typing a name from being overwritten by the next keystroke
   * in the title.
   */
  const [folder, setFolder] = useState('');
  const [folderTouched, setFolderTouched] = useState(false);
  const [templates, setTemplates] = useState<SessionTemplateDto[]>([]);
  /*
   * The MCP servers this session is being given (§17 Q20).
   *
   * Held here rather than in the store, and for one keystroke longer than
   * strictly needed, because `env` values are credentials: they live in this
   * component's state, go into the create call, and are dropped in `submit`.
   * Nothing puts them in the store, in a template, or in a log.
   */
  const [mcpDrafts, setMcpDrafts] = useState<McpDraft[]>([]);

  // Fetched when the form opens rather than on mount: a host that has none is
  // the common case, and asking every host on every render to populate a list
  // that is usually empty is work nobody sees.
  useEffect(() => {
    if (!adding) return;
    void window.agbrte.templates.list(host.instanceId).then(setTemplates, () => setTemplates([]));
  }, [adding, host.instanceId]);

  /** The first unsendable MCP row, shown under the fields rather than swallowed. */
  const mcpProblem = firstProblem(mcpDrafts);

  /**
   * Where this session's work goes, when it is asked for a folder of its own.
   *
   * A **sibling** of the folder this host has open, not a child: a workspace
   * inside a workspace nests one `.agbrte` in another and puts a session's store
   * inside somebody's project. The separator comes from the path rather than
   * from this machine, since the field may name a folder on a Linux box while
   * the app runs on Windows.
   */
  const newFolderTarget = ((): string => {
    const name = folder.trim().replace(/^[\\/]+/, '');
    if (name === '') return '';
    const sep = host.root.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/';
    const parent = host.root.replace(/[\\/]+$/, '').split(sep).slice(0, -1).join(sep);
    return `${parent === '' ? host.root : parent}${sep}${name}`;
  })();

  const submit = (): void => {
    if (title.trim() === '') return;
    // Refused here as well as by the host: the host's refusal is the boundary,
    // and this one keeps a typo from costing a round trip and a session that
    // was never made.
    if (mcpProblem !== null) return;
    const configs = toConfigs(mcpDrafts);
    if (newFolderTarget !== '') {
      /*
       * One session, one folder (§8), from the button that says "another one".
       *
       * This form only ever made a session *in the workspace already open*,
       * because that is what a host row is about — and it is where most sessions
       * get made, so the rule was easy to keep everywhere except the place it
       * mattered. Opening a folder is what makes a workspace, so asking for one
       * here means attaching it first; the session is then created in the host
       * that answers for it, which may be this same process serving a second
       * folder (§8).
       */
      void (async () => {
        const opened =
          host.targetKind === 'local'
            ? await store.attachLocalHost(newFolderTarget)
            : await store.attachRemoteHost(host.label, newFolderTarget);
        if (opened === null) return;
        await store.createSession(opened.instanceId, title.trim(), title.trim(), configs);
      })();
      setFolder('');
      setFolderTouched(false);
      setTitle('');
      setMcpDrafts([]);
      setAdding(false);
      return;
    }
    const into =
      machine.workspaces.find((w) => w.instanceId === intoWorkspace)?.instanceId ??
      host.instanceId;
    void store.createSession(into, title.trim(), title.trim(), configs);
    setTitle('');
    /*
     * Cleared before the create resolves, deliberately.
     *
     * These drafts hold env values, which §13 calls credentials, and holding
     * them "in case it failed" would keep a secret in renderer state for as long
     * as the window is open. A failed create says so in the error banner and the
     * fields are retyped — the cheaper of the two mistakes.
     */
    setMcpDrafts([]);
    setAdding(false);
  };

  return (
    /*
     * `data-label` is the machine now, and `data-instance` is the workspace its
     * acts route to — which is the first one it holds (§8). A test looking for
     * "the section for this folder" was looking for the wrong thing the moment
     * a machine could hold two.
     */
    <section data-testid="host" data-instance={host.instanceId} data-label={machine.label}>
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
            /* The bundle too, because "no Update button" says two different
               things — this host is current, or it is too old to say — and which
               one it is decides what somebody does next. */
            title={
              `${machine.workspaces.map((w) => w.root).join('\n')}` +
              `\nrunning: ${host.bundleVersion ?? 'a build too old to say'}`
            }
          >
            {/*
              The folder first, the machine after it (§8).
              
              A row used to show the machine alone, which was right while a host
              was one per machine. One machine can hold several workspaces now,
              so every row on a build box read `cbk_ws_one` — two folders, two
              identical rows, and no way to tell which was which. Reported as
              "the remote sessions are gone" about a row that was a *different*
              folder, with the one holding the sessions no longer attached.
              
              Folder first because it is what differs between rows; machine
              second because it is what differs between groups of them. A local
              host shows the folder alone — "this machine" is what the badge
              beside it already says.
            */}
            {machine.label}
            {manyFolders && (
              <span className="text-muted"> · {machine.workspaces.length} folders</span>
            )}
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
            onClick={() =>
              setAdding((open) => {
                // Closing the form forgets what was typed into it, because some
                // of what was typed into it is a credential (§13, §17 Q20).
                // Keeping a token in renderer state for as long as the window is
                // open, on the chance the form is reopened, is the wrong trade.
                if (open) setMcpDrafts([]);
                /*
                 * And each opening starts over on the folder.
                 *
                 * `folderTouched` stops the title from overwriting a name
                 * somebody typed, and it is per *form* rather than per session —
                 * so clearing the field once, to put one session in the open
                 * workspace, silently withdrew the offer for every session after
                 * it. A decision about one session must not become a setting.
                 */
                setFolder('');
                setFolderTouched(false);
                return !open;
              })
            }
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
            onClick={() => {
              // Every folder it holds, because the row is the machine now (§8):
              // letting go of one checkout and leaving the row behind is not
              // what "stop watching this machine" means.
              for (const workspace of machine.workspaces) void store.removeHost(workspace.instanceId);
            }}
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
            onChange={(e) => {
              setTitle(e.target.value);
              if (!folderTouched) setFolder(folderSlug(e.target.value));
            }}
          />
          {manyFolders && newFolderTarget === '' && (
            /* Only where there is a choice: this machine holds more than one
               folder, and "in this workspace" no longer names itself. */
            <select
              className="field text-xs"
              data-testid="new-workspace"
              value={intoWorkspace === '' ? host.instanceId : intoWorkspace}
              onChange={(e) => setIntoWorkspace(e.target.value)}
            >
              {machine.workspaces.map((w) => (
                <option key={w.instanceId} value={w.instanceId}>
                  {folderName(w.root)}
                </option>
              ))}
            </select>
          )}
          {/* Optional, and empty means what this form has always done: another
              session in a folder already open. A name means a folder of its
              own, shown before it is created because a directory appearing on a
              machine is a change to it. */}
          <input
            className="field"
            data-testid="new-folder"
            placeholder="New folder for it"
            value={folder}
            onChange={(e) => {
              setFolderTouched(true);
              setFolder(e.target.value);
            }}
          />
          <span className="text-muted wrap-anywhere text-[11px]" data-testid="new-folder-target">
            {newFolderTarget === ''
              ? `in ${
                  machine.workspaces.find((w) => w.instanceId === intoWorkspace)?.root ?? host.root
                }`
              : `will create ${newFolderTarget}`}
          </span>
          {/* §17 Q20: what this session may reach, decided by the person making
              it, going straight into its own log. Above the button because it is
              part of the same decision, and folded because most sessions attach
              nothing. */}
          <McpServerFields drafts={mcpDrafts} onChange={setMcpDrafts} />
          <button
            className="btn"
            data-testid="new-submit"
            type="submit"
            disabled={title.trim() === '' || mcpProblem !== null}
          >
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
          <SessionRow
            key={s.sessionId}
            data-testid="session"
            data-title={s.title}
            className={`grid w-full gap-1 rounded-[2px] border px-3 py-2 text-left ${
              s.sessionId === activeId ? 'bg-raised border-line' : 'hover:border-line border-transparent'
            }`}
            title={s.title}
            onOpen={() => void store.openSession(s.sessionId, host.instanceId)}
            onRename={(title) => void store.renameSession(s.sessionId, title)}
          >
            {/* Quiet: the sidebar is navigation, and the pane beside it has
                already said this. See `quietTone`. */}
            <span className={`${LABEL} flex min-w-0 gap-2`}>
              <span className={quietTone(s.state)}>{s.state.replace(/_/g, ' ')}</span>
              <FolderTag name={folderOf(s.instanceId)} />
              {s.group !== undefined && <GroupTag name={s.group.name} />}
            </span>
          </SessionRow>
        ))}

        {unloaded.map((d) => (
          /* Renamed without being opened, which is the case that makes this
             worth having: a folder full of sessions from last month is exactly
             the list somebody wants to tidy, and opening each one to do it
             would start a host per row. */
          <SessionRow
            key={d.sessionId}
            data-testid="session"
            data-title={d.title}
            className="hover:border-line grid w-full gap-1 rounded-[2px] border border-transparent px-3 py-2 text-left"
            title={d.title}
            onOpen={() => void store.openSession(d.sessionId, host.instanceId)}
            onRename={(title) => void store.renameSession(d.sessionId, title)}
          >
            {/* On disk only until opened — which is what proves the log is truth. */}
            <span className={`${LABEL} flex min-w-0 gap-2`}>
              <span className="text-muted">resume</span>
              <FolderTag name={folderOf(d.instanceId)} />
              {/*
                From `session.json` rather than from the log, because this row is
                a session nobody has opened and folding every log on the machine
                to label it would be a page load per sidebar. A hint that is
                stale corrects itself the moment the session is opened, and one
                that is absent shows nothing — "the file does not say" is not
                "no group" (§17 Q22).
              */}
              {d.group !== undefined && <GroupTag name={d.group.name} />}
            </span>
          </SessionRow>
        ))}
      </div>
    </section>
  );
}

/**
 * One row per **machine**, not per workspace (§8).
 *
 * A host is one process per machine and has been since v21 — but the sidebar
 * still drew one section per *workspace*, because that is what the fleet's
 * entries are: a binding of one checkout on one host. Two folders on one build
 * box therefore appeared as two sections with the same name, the same buttons
 * and different contents, and "my remote sessions are gone" turned out to be a
 * person looking at the other one. Reported from a real server.
 *
 * So the machine is the row and the workspace is a property of the sessions
 * under it. What that buys beyond clarity: **Stop** and **Update** are machine
 * acts and now say so once instead of per folder, and detaching means letting
 * go of the machine rather than of one of its checkouts.
 *
 * Grouped by `machineId`, which the host mints and reports (§5.2). A host too
 * old to send one gets a row of its own keyed by its target: absence means
 * *cannot tell*, and merging two hosts that never claimed to be the same machine
 * would be inventing the fact this grouping depends on.
 */
export interface MachineRow {
  key: string;
  /** What to call it: the alias for a remote, and the machine itself for local. */
  label: string;
  targetKind: string;
  /** Every workspace open on it, in the order they were attached. */
  workspaces: HostInfo[];
}

export function byMachine(hosts: HostInfo[]): MachineRow[] {
  const rows = new Map<string, MachineRow>();
  for (const host of hosts) {
    const key = host.machineId ?? `${host.targetKind}:${host.label}:${host.instanceId}`;
    const existing = rows.get(key);
    if (existing === undefined) {
      rows.set(key, {
        key,
        label: host.targetKind === 'local' ? 'This machine' : host.label,
        targetKind: host.targetKind,
        workspaces: [host],
      });
    } else {
      existing.workspaces.push(host);
    }
  }
  return [...rows.values()];
}

/** The last segment of a path, whichever separator it uses. */
function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
}

/**
 * A folder name from a session title.
 *
 * Lowercase words joined by hyphens, and nothing else: this becomes a directory
 * on somebody's machine — possibly across ssh — so what a person typed as prose
 * has to survive a shell, a path separator and a filesystem that may not accept
 * what theirs does. Built from an allow-list rather than by removing what is
 * dangerous, which is the same rule template names follow (§17 Q12): a deny-list
 * is a promise to have thought of everything.
 *
 * Bounded, because a title can be a sentence and a path component cannot.
 */
function folderSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * A session's name in the sidebar, and the way to change it.
 *
 * **Not a double-click, and the first attempt is why.** A row is a `<button>`
 * that opens the session, and a double-click delivers two ordinary clicks
 * before it — so the gesture opened the very session it was meant to rename,
 * which for a row that is only *on disk* means starting a host to rename a
 * folder's worth of last month's work. Cancelling the open on a timer would put
 * a delay on every session anybody opens to save the rare rename a click.
 *
 * So it is its own control, and it lives *beside* the row rather than inside
 * it: a button inside a button is invalid, and a field inside one is not
 * typeable (the trap `Roster.tsx` hit with a `<select>`). Hidden until the row
 * is hovered or something in it has focus, so the list stays a list of names
 * and the control is still reachable from a keyboard.
 *
 * Enter saves, Escape cancels, blur saves: leaving a field is "done" in every
 * list that works this way, and losing what was typed because somebody clicked
 * elsewhere is the outcome worth ruling out. An empty name cancels rather than
 * erroring — the host would refuse it, and a banner about a blank field is
 * noise about something nobody meant.
 */
function SessionRow({
  title,
  onRename,
  onOpen,
  children,
  ...rest
}: {
  title: string;
  onRename: (title: string) => void;
  onOpen: () => void;
  children: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  'data-title'?: string;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  const save = (): void => {
    setEditing(false);
    const wanted = draft.trim();
    if (wanted !== '' && wanted !== title) onRename(wanted);
  };

  return (
    <div className="group/row relative min-w-0">
      <button {...rest} onClick={onOpen}>
        {editing ? (
          <input
            className="field min-w-0 px-1 py-0 text-sm"
            data-testid="session-rename"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // The row opens on click and this field is inside it, so a click to
            // place the cursor would otherwise open the session being renamed.
            onClick={(e) => e.stopPropagation()}
            onBlur={save}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
        ) : (
          <span className="truncate-line" data-testid="session-name">
            {title}
          </span>
        )}
        {children}
      </button>
      {!editing && (
        <button
          type="button"
          className="btn-quiet absolute top-1 right-1 px-1 py-0 text-[11px] opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          data-testid="session-rename-start"
          title={`Rename ${title}`}
          aria-label={`Rename ${title}`}
          onClick={(e) => {
            e.stopPropagation();
            setDraft(title);
            setEditing(true);
          }}
        >
          rename
        </button>
      )}
    </div>
  );
}

/**
 * Which folder a session is in, where one machine holds several (§8).
 *
 * Absent where it would say the same thing on every row: a machine with one
 * workspace open has nothing to tell apart, and a label repeated down a column
 * is noise that makes the column harder to read rather than easier.
 */
function FolderTag({ name }: { name: string | null }): JSX.Element | null {
  if (name === null) return null;
  return (
    <span className="truncate-line text-muted min-w-0" data-testid="session-folder" title={name}>
      {name}
    </span>
  );
}

/**
 * Which group a session is in, in the sidebar (§17 Q22).
 *
 * Named rather than coloured: a group is a set with a name people chose, two
 * groups may share one, and nothing routes on it — so a swatch would invent a
 * meaning the model does not have. Truncated with the row, because a long group
 * name must not be the thing that widens a 300px column.
 */
function GroupTag({ name }: { name: string }): JSX.Element {
  return (
    <span
      className="text-accent truncate-line min-w-0"
      data-testid="session-group"
      data-group={name}
      title={`in the group ${name}`}
    >
      · {name}
    </span>
  );
}

/**
 * A session holding still because a credential will not work (§3.11, §4.1).
 *
 * It exists because "awaiting credentials" in the header is a *diagnosis* and
 * what this pause needs is an *instruction*. A Claude Code seat that has not
 * been logged in ends its turn with the CLI saying so in what looks like
 * ordinary assistant text; the only visible route out was the Terminal view,
 * which by design observes and cannot type (§3.11 keeps Agbrte out of the
 * vendor's auth path), so the one control on screen was the one that cannot
 * help. The advice comes from the owner, which is the only party that knows
 * which machine the credential has to be fixed on.
 *
 * No button, and that is the design rather than an omission. There is nothing
 * for Agbrte to *do* here: it must not proxy, store, or replay a vendor session
 * token, so the remedy is a command in the user's own terminal. What it can
 * promise is the part that makes waiting safe — the work is held, and sending
 * again picks the turn up.
 */
function CredentialsNotice({ advice }: { advice: string | undefined }): JSX.Element {
  return (
    <div
      role="status"
      data-testid="credentials-notice"
      className="border-state-paused mx-4 mt-3 grid shrink-0 gap-1 rounded-[2px] border bg-panel px-4 py-3"
    >
      <strong className={`${LABEL} text-state-paused`}>Waiting on a login</strong>
      <p className="text-xs">
        {/* The fallback is for a runtime that reported `auth` with nothing to
            say (§3.9 allows it): vague and true beats a confident sentence
            about a machine and a command nobody established. */}
        {advice ??
          'This agent’s credential cannot be used right now. Fix it where that agent runs, then send again — the session is holding its work.'}
      </p>
    </div>
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
        {/* Quiet, like Export: changing the model is occasional, and the
            defaults it changes are this client's, not the session's. */}
        {onToggleAgent !== undefined && (
          <button
            className="btn-quiet text-xs"
            data-testid="change-agent"
            title={
              'Change this session’s model. A session runs one agent (§4.2): the seat you have ' +
              'now is retired and the new one takes over, and the transcript records both — ' +
              'earlier turns stay, labelled with the model that produced them. To have two ' +
              'models work together, start a second session and group them.'
            }
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
/**
 * The same tools, named for a button rather than for a picker.
 *
 * `RUNTIME_LABELS` says what a runtime *is* — "Claude Code (installed CLI)" —
 * which is the right answer in a list of runtimes to choose a seat from, and
 * three words too many in a row of buttons beside the composer. The suffix
 * there is doing the work of a sentence nobody needs twice: the button's title
 * already says it is the tool installed on this machine, run by you, outside the
 * transcript.
 */
const TERMINAL_LABELS: Readonly<Record<string, string>> = {
  'cli:claude-code': 'Claude Code',
  'cli:gemini-cli': 'Gemini CLI',
};

function terminalLabel(id: string): string {
  return TERMINAL_LABELS[id] ?? runtimeLabel(id);
}

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

/**
 * How the picker reaches the machine behind a host (§6.4).
 *
 * A tiny adapter rather than three props, because two of the three are the same
 * `window.agbrte` call at both call sites and the third — naming the machine —
 * is the one that is easy to get subtly wrong. `label` is the ssh alias for a
 * remote, which is exactly what a refusal from `runSetup` will name; for a local
 * host it is the workspace's folder, which would read as "could not install
 * Claude Code on my-project". `this machine` is both truthful and the string
 * main passes to the provisioner for that case, so the two sides agree.
 *
 * The progress subscription is **filtered by host**. Setting up two machines at
 * once is unusual and entirely possible, and an unfiltered listener would show
 * one machine's steps under the other's name — a wrong sentence, not a missing
 * one.
 */
function machineFor(
  instanceId: string,
  host: HostInfo | undefined,
): {
  where: string;
  setUp: (plan: SetupPlanDto) => Promise<SetupOutcomeDto>;
  subscribeProgress: (cb: (step: string) => void) => () => void;
} {
  return {
    where: host === undefined || host.targetKind === 'local' ? 'this machine' : host.label,
    setUp: (plan) => window.agbrte.hosts.setUp(instanceId, plan),
    subscribeProgress: (cb) =>
      window.agbrte.on.setup((p) => {
        if (p.instanceId === instanceId) cb(p.step);
      }),
  };
}

/**
 * The whole of "Add an agent": one list, one button.
 *
 * ## Three questions that were one question
 *
 * This screen used to carry a set-up panel with its own routes, a "what will
 * run" dropdown, and a catalogue of models with their own Install buttons. All
 * three answered *what should run this session*, and choosing between them
 * required knowing which of our mechanisms applied to you: that Ollama is a
 * model server, that a CLI brings its own model, that a catalogue installs into
 * an endpoint. None of that is the user's problem.
 *
 * So there is one list. An entry names the concrete thing that will run —
 * `qwen2.5:7b · Agbrte harness` — and the list is grouped by the only
 * distinction that changes what pressing the button costs: whether it is
 * already there, or has to be fetched first. `buildEntries` in
 * `setupRoutes.ts` is that list, pure and tested, including its order.
 *
 * ## One button that does whatever it takes
 *
 * `go()` is the whole of it. A ready model is seated immediately. A catalogue
 * model installs Ollama if the machine has no model server, pulls the model,
 * waits for the pull, then seats the agent. A vendor CLI is installed and then
 * seated. *Use a model API…* reveals the four fields a key needs, and the same
 * button writes the endpoint and re-asks the host what it can now reach.
 *
 * The one thing that is *not* absorbed is the sign-in a CLI ends with: the app
 * cannot do it, an agent seated without it cannot run, and the pane it was
 * printed in is gone the moment the agent is seated. So it is also raised as a
 * notice, which survives landing in the chat.
 */
function AgentPicker({
  runtimes,
  notes,
  conformance,
  endpoints,
  listModels,
  checkModel,
  installModel,
  installProgress,
  machine,
  onAdd,
  submitLabel,
  busy,
  say,
}: {
  runtimes: RuntimeInfo[];
  /**
   * What this host looked for and did not find (§3.12).
   *
   * Carried onto the entry for the CLI it is about, rather than listed
   * separately: "`claude` could not be started … or not on the PATH this host
   * was started with" is the difference between installing a second copy and
   * fixing a PATH, and it belongs on the row that offers the install.
   */
  notes: HostInfo['runtimeNotes'];
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
  /** Begins a pull. Resolves when it has *started*; `installProgress` watches. */
  installModel: (endpointId: string, tag: string) => Promise<void>;
  installProgress: () => Promise<ModelInstallDto[]>;
  /**
   * The machine behind this host, and how to change it (§6.4).
   *
   * Passed in rather than reached for, like every other capability this
   * component uses: the picker is the screen that *notices* a machine has
   * nothing on it, and putting the remedy anywhere else means somebody has to
   * know to go looking for it. `where` is what a refusal will name, so it comes
   * from the same place the host record does.
   */
  machine: {
    where: string;
    setUp: (plan: SetupPlanDto) => Promise<SetupOutcomeDto>;
    subscribeProgress: (cb: (step: string) => void) => () => void;
  };
  onAdd: (runtimeId: string, modelId: string | null, endpointId?: string) => Promise<void>;
  /**
   * What the submit button says when nothing has to be installed first.
   *
   * The same form seats the first agent and changes the model of a session that
   * already has one (§4.2), and those are different sentences: "Add agent"
   * above a session that is about to *retire* one would describe the opposite of
   * what the click does. When work is needed the label names the work instead.
   */
  submitLabel?: string;
  busy: boolean;
  /** Raises a sentence that has to outlive this pane. See `go()`. */
  say: (notice: string) => void;
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
  /**
   * What the host says its endpoints serve, verbatim.
   *
   * Kept per endpoint rather than flattened to a name list: the endpoint is half
   * of what an entry means (§13), and `canInstall` comes from the same answer —
   * which is what decides whether a pull needs a model server put there first.
   */
  const [answers, setAnswers] = useState<EndpointModelsDto[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [modelsBusy, setModelsBusy] = useState(false);
  /** One list per mounted picker. See the effect below. */
  const asked = useRef(false);

  /** The endpoint draft, revealed by the *Use a model API…* entry. */
  const [draft, setDraft] = useState<EndpointDraft>(EMPTY_ENDPOINT);

  /* Work in flight, and what the machine said about it. */
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<SetupOutcomeDto | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

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
   *
   * Returns what it found, because `go()` needs the answer *now*: a model server
   * installed a second ago is not in `answers` until this resolves, and reading
   * state that a `set` has not committed yet is how a pull ends up with nowhere
   * to go.
   */
  const refreshModels = async (): Promise<EndpointModelsDto[]> => {
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
            ? `${count} ready on ${machine.where}.`
            : null,
      );
      return found;
    } catch (err) {
      setModelsNote(err instanceof Error ? err.message : String(err));
      return [];
    } finally {
      setModelsBusy(false);
    }
  };

  /*
   * Ask once, when this picker opens and a model could be part of the answer.
   *
   * With one list the models *are* the list, so waiting for a selection would
   * mean opening on a dropdown that does not yet contain the thing you came to
   * choose. Guarded by a ref, not by the dependency list: `runtimes` is rebuilt
   * on every host push, and a fresh array identity is not a new question.
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
   * The host's own account of what it is doing, while it is doing it.
   *
   * Subscribed only while something runs: this push arrives for *every* host, so
   * an unfiltered listener in a two-host app shows one machine's steps under the
   * other's name, and a list nobody is watching is one a later render shows
   * stale.
   */
  useEffect(() => {
    if (!running) return;
    return machine.subscribeProgress((step) => setSteps((was) => [...was, step]));
  }, [running, machine]);

  const entries = useMemo(
    () =>
      buildEntries(
        runtimes,
        answers,
        endpoints,
        CATALOGUE.models,
        notes,
        runtimeLabel,
      ),
    [runtimes, answers, endpoints, notes],
  );

  // Falls back to the first entry both while untouched and if a chosen model
  // disappears from a later refresh — the list is the authority on what is
  // there, and a selection pointing at nothing is a disabled button with no
  // explanation.
  const value = chosen !== null && entries.some((c) => c.value === chosen) ? chosen : (entries[0]?.value ?? '');
  const current = entries.find((c) => c.value === value);
  /** Whether the chosen entry involves a model at all. */
  const needsModel = current !== undefined && (current.typed === true || current.modelId !== null);
  /** The recipient this add would use. */
  const endpoint =
    current?.endpointId !== undefined
      ? endpoints.find((e) => e.id === current.endpointId)
      : endpoints[0];

  /**
   * The best claim about one model: what was probed here, else what the host
   * volunteered. Never merged — a probed answer replaces a declared one whole,
   * because the two disagree exactly when the declaration was wrong.
   */
  const hintOf = (entry: AgentEntry | undefined): ModelCapabilityHint | undefined => {
    if (entry === undefined || entry.modelId === null || entry.endpointId === undefined) {
      return undefined;
    }
    return (
      probed[`${entry.endpointId}::${entry.modelId}`] ??
      answers
        .find((a) => a.endpointId === entry.endpointId)
        ?.capabilities?.find((c) => c.modelId === entry.modelId)
    );
  };

  /**
   * The selected entry, when it names something a probe could be run against.
   *
   * Narrowed once here rather than inside the markup, and it covers the escape
   * hatch too: a model typed into that field is exactly the case where nothing
   * is known — `/v1/models` is optional, so a server that cannot list what it
   * serves cannot describe it either — and leaving the one entry with no answer
   * unable to *get* one would make the honest path the least informed one.
   *
   * A model that is not on the machine yet is not probeable by definition, so an
   * install entry answers `null` and the panel below says unknown.
   */
  const checkable = ((): { endpointId: string; modelId: string } | null => {
    if (current === undefined || current.plan.kind === 'pull') return null;
    const modelId = current.typed === true ? typedModel.trim() : current.modelId;
    const from = current.endpointId ?? endpoint?.id;
    if (modelId === null || modelId === '' || from === undefined) return null;
    return { endpointId: from, modelId };
  })();

  const currentHint =
    checkable !== null
      ? (probed[`${checkable.endpointId}::${checkable.modelId}`] ?? hintOf(current))
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
   */
  useEffect(() => {
    if (current === undefined || current.typed === true || current.modelId === null) return;
    if (current.plan.kind !== 'ready' || current.endpointId === undefined) return;
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

  /**
   * Watch a pull to the end, reporting it as it goes.
   *
   * `installModel` resolves when the pull has *started* — a model is gigabytes —
   * so the only honest end of this route is polling until the host says done.
   * The percentage replaces its own line rather than accumulating, because a
   * download that reports every two seconds for six minutes would bury the
   * install steps above it in 180 lines of the same sentence.
   */
  const awaitPull = async (endpointId: string, tag: string): Promise<void> => {
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const all = await installProgress().catch(() => [] as ModelInstallDto[]);
      const mine = all.find((i) => i.tag === tag && i.endpointId === endpointId);
      if (mine === undefined) continue;
      if (mine.error !== undefined) throw new Error(mine.error);
      const pct = mine.total > 0 ? Math.round((mine.completed / mine.total) * 100) : null;
      setSteps((was) => {
        const line = `pulling ${tag}${pct === null ? ` — ${mine.status}` : ` — ${pct}%`}`;
        const kept = was.filter((s) => !s.startsWith(`pulling ${tag}`));
        return [...kept, line];
      });
      if (mine.done) return;
    }
  };

  /**
   * The one button, and everything it might have to do first.
   *
   * Ordered by what the machine is missing rather than by what the user picked:
   * a model with nowhere to live needs a server first, and a server with no
   * model in it runs nothing. Each step reports itself through the same progress
   * area, and any refusal — read-only client, a transport that cannot hold a
   * process open, a client with no provisioner — arrives from main as a sentence
   * and is printed verbatim.
   */
  const go = async (): Promise<void> => {
    const entry = current;
    if (entry === undefined) return;
    setRunning(true);
    setSteps([]);
    setOutcome(null);
    setFailure(null);
    try {
      switch (entry.plan.kind) {
        case 'ready':
        case 'typed':
          await onAdd(
            entry.runtimeId,
            entry.typed === true ? typedModel.trim() : entry.modelId,
            // Unchanged contract: the store drops this when the model is null,
            // so a no-model runtime is unaffected either way.
            needsModel ? (entry.endpointId ?? endpoint?.id) : undefined,
          );
          return;

        case 'endpoint': {
          const result = await machine.setUp({
            kind: 'endpoint',
            endpoint: {
              id: draft.id.trim(),
              provider: draft.provider.trim(),
              baseUrl: draft.baseUrl.trim(),
              // Omitted rather than sent empty, so "no credential" is a shape
              // the host can see rather than a string it has to interpret.
              ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
            },
          });
          setOutcome(result);
          // Cleared on success only. A key that was rejected — a typo, a wrong
          // URL — must survive so the fix is an edit rather than a retype from a
          // password manager.
          setDraft((was) => ({ ...was, apiKey: '' }));
          // The endpoint exists; what it serves is the next question, and it is
          // the list itself that answers it.
          await refreshModels();
          setChosen(null);
          return;
        }

        case 'cli': {
          const result = await machine.setUp({ kind: 'cli', cli: entry.plan.cli });
          setOutcome(result);
          if (!result.redetected) return;
          // The sign-in this app cannot do, carried out of a pane that is about
          // to be replaced by the chat.
          if (result.followUp !== undefined) say(result.followUp);
          await onAdd(entry.runtimeId, null);
          return;
        }

        case 'pull': {
          let target = answers.find((a) => a.canInstall === true)?.endpointId;
          if (target === undefined) {
            const result = await machine.setUp({ kind: 'ollama' });
            setOutcome(result);
            target = (await refreshModels()).find((a) => a.canInstall === true)?.endpointId;
          }
          if (target === undefined) {
            // Said rather than shown as a spinner that never ends: the server
            // went on and the app still has nowhere to put a model, which is a
            // different problem from a failed download.
            setFailure(
              `${machine.where} has no model server that takes an install, so ${entry.plan.tag} has nowhere to go.`,
            );
            return;
          }
          await installModel(target, entry.plan.tag);
          await awaitPull(target, entry.plan.tag);
          await refreshModels();
          await onAdd(entry.runtimeId, entry.plan.tag, target);
          return;
        }
      }
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  const note = current === undefined ? null : entryNote(current, machine.where);
  const working = busy || running;

  return (
    <div className="m-auto grid w-full max-w-md gap-3 p-6" data-testid="picker">
      <h3 className="text-sm">Add an agent</h3>

      {runtimes.length === 0 && (
        <p className="text-muted text-xs">
          This host has not reported any runtimes. If it failed to start, nothing can run here.
        </p>
      )}

      <label className="text-muted grid gap-1 text-xs">
        What will run
        {/*
          The only control on this screen, and the only list.

          Grouped by whether anything has to happen first, which is the one
          distinction that changes what the button costs. Ready entries stay at
          the top, where a returning user's choice lives.
        */}
        <RuntimeSelect
          value={value}
          onChange={setChosen}
          groups={[
            { id: 'ready', label: 'Ready to use', options: [] },
            { id: 'install', label: 'Will be installed first', options: [] },
          ].map((group) => ({
            ...group,
            options: entries
              .filter((e) => e.group === group.id)
              .map((e) => ({
                value: e.value,
                label: e.label,
                ...(e.hint !== undefined ? { hint: e.hint } : {}),
                ...(e.note !== undefined ? { note: e.note } : {}),
                plan: e.plan.kind,
                /*
                 * Only what the host actually advertised.
                 *
                 * `data-runtime` / `data-model` say "this machine offers this",
                 * which is the one thing an install entry does not mean — and
                 * the e2e helper that selects a model by those attributes would
                 * otherwise pick a gigabyte download by accident.
                 */
                ...(e.group === 'ready' ? { runtimeId: e.runtimeId, modelId: e.modelId } : {}),
                ...(e.typed === true ? { typed: true } : {}),
                /*
                 * Only on the entries a badge can be true of.
                 *
                 * A runtime that runs no model of ours — an installed CLI, echo
                 * — has no per-model answer to give; the escape hatch has no
                 * model yet; and a model that is not on the machine cannot have
                 * been probed. Painting `tools: unknown` on those would be four
                 * words of noise on a row §3.13's matrix below already covers.
                 */
                ...(e.modelId !== null && e.plan.kind === 'ready'
                  ? { badges: rowBadges(hintOf(e)) }
                  : {}),
              })),
          }))}
        />
      </label>

      {note !== null && (
        /*
          The description, and what the choice will cost.

          One line, for the selected entry, under the control: the same text is
          the second line of the row itself, and it is repeated here because the
          popper closes over exactly this space — once it is shut, the trigger
          shows `model · runtime` and nothing else.
        */
        <p className="text-muted m-0 text-[11px]" data-testid="entry-note">
          {note}
        </p>
      )}

      {current?.typed === true && (
        /*
          The escape hatch, and the whole reason a closed list is honest.

          `/v1/models` is optional in the OpenAI-compatible shape, so a server
          that does not implement it would otherwise be unusable through a UI
          that had merely failed to ask.
        */
        <input
          className="field"
          data-testid="model-id"
          placeholder="e.g. qwen2.5-coder:7b"
          value={typedModel}
          onChange={(e) => setTypedModel(e.target.value)}
        />
      )}

      {current?.plan.kind === 'endpoint' && (
        <SetUpEndpoint where={machine.where} value={draft} onChange={setDraft} />
      )}

      {/* §3.13: the choice shows what its runtime can actually do here. Bound to
          the *entry's* runtime, which is now something a person picks without
          naming — all the more reason to keep saying it. */}
      <SupportMatrix cells={conformance} runtimeId={current?.runtimeId ?? ''} />

      {needsModel && (
        /*
          What the *chosen* model can do, in full (§3.3, §3.5).

          Beside the matrix rather than inside it, because they answer different
          questions with different evidence: that one is per runtime and comes
          from conformance runs, this one is per model and comes from a probe or
          the server's own account of itself. Folding a per-model claim into a
          per-runtime grid is precisely the bug §3.3 calls out.
        */
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

      {endpoint !== undefined && needsModel && (
        /*
         * Named before the first turn, not after. §13 requires that adding a
         * provider never quietly change where source code is transmitted, and a
         * picker that shows only a model name is exactly that quiet change — the
         * recipient has to be legible at the moment of choosing, which is the
         * only moment it can still be reconsidered. Collapsing three screens
         * into one does not get to collapse this.
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

      <button
        className="btn text-accent"
        data-testid="add-agent"
        disabled={
          working ||
          current === undefined ||
          (current.typed === true && typedModel.trim() === '') ||
          (current.plan.kind === 'endpoint' &&
            (draft.id.trim() === '' || draft.baseUrl.trim() === ''))
        }
        onClick={() => void go()}
      >
        {working && running
          ? 'Working…'
          : current === undefined
            ? (submitLabel ?? 'Add agent')
            : actionLabel(current.plan, submitLabel)}
      </button>

      <SetupProgress
        where={machine.where}
        busy={running}
        steps={steps}
        failure={failure}
        outcome={outcome}
      />

      {modelsNote !== null && (
        /* What the host answered when asked what it can reach, verbatim: an
           endpoint that refused is the difference between "no models" and
           "this one machine is unreachable from here". */
        <small className="text-muted text-[11px]" data-testid="models-note">
          {modelsNote}
          {modelsBusy && ' …'}
        </small>
      )}
    </div>
  );
}
