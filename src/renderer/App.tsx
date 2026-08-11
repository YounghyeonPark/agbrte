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
import { useEffect, useMemo, useState, type JSX } from 'react';
import { AttachHost } from './AttachHost.js';
import { Dashboard } from './Dashboard.js';
import { SupportMatrix } from './SupportMatrix.js';
import { Inbox } from './Inbox.js';
import { Search } from './Search.js';
import { Roster } from './Roster.js';
import { agentLabel } from './attribution.js';
import { StartGuide } from './StartGuide.js';
import { RuntimeSelect } from './RuntimeSelect.js';
import { useAgbrte } from './store.js';
import { Composer, EventRow, PermissionPrompt, SplitPrompt, Transcript, summarize } from './Transcript.js';
import { Preview } from './Preview.js';
import type { SessionTemplateDto } from '@shared/ipc/contract.js';
import type { HostInfo, RuntimeInfo } from '../shared/ipc/contract.js';
import type { MatrixCell, Session, SessionState } from '../shared/types/index.js';

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
  // Toggled open even with a session showing, because a guide you can only
  // reach from an empty window is unreachable exactly when it is wanted.
  const [guide, setGuide] = useState(false);
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
  /**
   * Which agent's pane is open, or `null` for the unified timeline (§4.2).
   *
   * Local to the view, not to the session: it is a way of *looking*, and two
   * devices attached to one session should not fight over what each is reading.
   */
  const [focusedAgent, setFocusedAgent] = useState<string | null>(null);
  const { hosts, runtimesByHost, conformanceByHost, inbox, sessions, onDisk, active, events, pending, queued, error, notice, busy } =
    store;

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

    // Without these the listeners accumulate on every remount and events render
    // twice — a duplication bug, not a crash, which is why it is easy to miss.
    return () => {
      offEvents();
      offSession();
      offPermission();
      offResolved();
      offHosts();
    };
  }, []);

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
        <header className="border-line flex items-center justify-between border-b p-3.5">
          <h1 className="text-base tracking-wide">Agbrte</h1>
          <div className="flex items-center gap-1.5">
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
            <button
              className="btn px-2"
              data-testid="show-guide"
              title="How Agbrte is used"
              aria-pressed={guide}
              onClick={() => setGuide((open) => !open)}
            >
              ?
            </button>
            <button
              className="btn"
              data-testid="add-host"
              onClick={() => setAttaching((open) => (open === false ? 'local' : false))}
            >
              {attaching !== false ? 'Cancel' : 'Attach host…'}
            </button>
          </div>
        </header>

        {/* Below the header rather than in it: a fleet-wide search is a thing you
            do occasionally and deliberately, and a box in the toolbar competes
            for attention with the sessions list every second it is not in use. */}
        <div className="border-line border-b px-3.5 py-2.5">
          <Search onOpen={(sessionId, instanceId) => void store.openSession(sessionId, instanceId)} />
        </div>

        {attaching !== false && (
          <AttachHost
            key={attaching}
            initialMode={attaching}
            onDone={() => setAttaching(false)}
          />
        )}

        <nav className="grid min-h-0 content-start gap-4 overflow-y-auto p-2">
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
            className="border-state-fail mx-4.5 mt-3 flex items-center justify-between gap-3 rounded-md border bg-[#2a1a20] px-3 py-2.5"
          >
            <span>{error}</span>
            <button className="btn" onClick={() => store.dismissError()}>
              dismiss
            </button>
          </div>
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

        {notice !== null && (
          /* Not an error: nothing went wrong. Someone on another device
             answered a question this one was also showing, which is the
             feature working — but a prompt vanishing with no explanation
             looks like a bug, so it says what happened. */
          <div
            data-testid="notice"
            className="border-line mx-4.5 mt-3 flex items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-xs"
          >
            <span className="text-muted">{notice}</span>
            <button className="btn" onClick={() => store.dismissNotice()}>
              dismiss
            </button>
          </div>
        )}

        {active === null && !guide && sessions.length > 0 ? (
          /* The dashboard once there is something to show, the guide when there
             is not. An empty grid teaches nothing and a guide is noise once you
             have sessions running — which of the two is useful is decided by
             whether any exist, not by a preference. */
          <Dashboard
            sessions={sessions}
            hosts={hosts}
            onOpen={(sessionId, instanceId) => void store.openSession(sessionId, instanceId)}
          />
        ) : active === null || guide ? (
          <StartGuide
            hasHosts={hosts.length > 0}
            onAttachLocal={() => {
              setGuide(false);
              setAttaching('local');
            }}
            onAttachRemote={() => {
              setGuide(false);
              setAttaching('remote');
            }}
          />
        ) : (
          <>
            <SessionHeader
              session={active}
              host={hosts.find((h) => h.instanceId === active.instanceId) ?? null}
              onInterrupt={() => void store.interrupt()}
              onBack={() => store.closeSession()}
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
              <AgentPicker
                runtimes={runtimesHere}
                conformance={conformanceHere}
                endpoints={hosts.find((h) => h.instanceId === active.instanceId)?.endpoints ?? []}
                onAdd={store.addAgent}
                busy={busy}
              />
            ) : (
              <>
                {/* §13: a heterogeneous roster is gated heterogeneously, and the
                    UI must never imply otherwise. */}
                <Roster
                  agents={active.agents}
                  selected={focusedAgent}
                  onSelect={setFocusedAgent}
                />
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
                />
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

/** One host and its sessions, with §10's target badge. */
function HostGroup({
  host,
  sessions,
  unloaded,
  activeId,
}: {
  host: HostInfo;
  sessions: Session[];
  unloaded: Array<{ sessionId: string; title: string }>;
  activeId: string | null;
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
      <div className="mb-1 flex items-center justify-between gap-2 px-1.5">
        <div className="flex min-w-0 items-baseline gap-1.5">
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
          <button
            className="btn px-1.5 py-0.5 text-xs"
            data-testid="new-session"
            title="New session on this host"
            onClick={() => setAdding((v) => !v)}
          >
            +
          </button>
          <button
            className="btn px-1.5 py-0.5 text-xs"
            data-testid="stop-host"
            title="Stop this host — refuses while work is running"
            onClick={() => void store.shutdownHost(host.instanceId)}
          >
            ■
          </button>
          <button
            className="btn px-1.5 py-0.5 text-xs"
            data-testid="remove-host"
            title="Detach this host — the run keeps going"
            onClick={() => void store.removeHost(host.instanceId)}
          >
            ×
          </button>
        </div>
      </div>

      {host.link === 'reconnecting' && (
        <p data-testid="host-reconnecting" className="text-state-paused mx-1.5 mb-1 text-[11px]">
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
          className="text-muted mx-1.5 mb-1 text-[11px]"
          title={`was ${host.movedFrom}`}
        >
          moved here — agents resume from the log rather than a vendor's token
        </p>
      )}

      {host.unavailableReason !== undefined && (
        <p
          data-testid="host-unavailable"
          className="text-state-paused mx-1.5 mb-1 text-[11px]"
          title={host.unavailableReason}
        >
          host unavailable — transcripts readable, nothing can run
        </p>
      )}

      {adding && (
        <form
          className="mb-1 grid gap-1.5 px-1.5"
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
        {sessions.map((s) => (
          <button
            key={s.sessionId}
            data-testid="session"
            data-title={s.title}
            className={`grid gap-0.5 rounded-md border px-2.5 py-1.5 text-left ${
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
            className="hover:border-line grid gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 text-left"
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
}: {
  session: Session;
  host: HostInfo | null;
  onInterrupt: () => void;
  /** Only reachable below `md`, where the session is the whole screen. */
  onBack: () => void;
}): JSX.Element {
  return (
    <div className="border-line safe-top flex items-start justify-between gap-4 border-b px-4.5 py-3.5">
      <div className="flex min-w-0 items-start gap-2">
        {/* Hidden from `md` up, where the list is already on screen and a back
            arrow would point at nothing. */}
        <button
          className="btn shrink-0 px-2 py-0.5 md:hidden"
          data-testid="back-to-list"
          aria-label="Back to sessions"
          onClick={onBack}
        >
          ‹
        </button>
      <div className="min-w-0">
        <h2 className="truncate-line text-[15px]">{session.title}</h2>
        <p className="text-muted truncate-line mt-0.5 text-xs">
          {/* Which host, in the header too: with several attached, the sidebar
              grouping alone is easy to lose track of once you have scrolled. */}
          {host !== null && <span data-testid="active-host">{host.label} · </span>}
          {session.goal}
        </p>
      </div>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">
        <span data-testid="session-state" className={`${LABEL} ${stateTone(session.state)}`}>
          {session.state.replace(/_/g, ' ')}
        </span>
        {session.state === 'working' && (
          <button className="btn" onClick={onInterrupt}>
            Interrupt
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

function AgentPicker({
  runtimes,
  conformance,
  endpoints,
  onAdd,
  busy,
}: {
  runtimes: RuntimeInfo[];
  /** The support matrix for this host, so the choice is informed (§3.13). */
  conformance: MatrixCell[];
  endpoints: HostInfo['endpoints'];
  onAdd: (runtimeId: string, modelId: string | null, endpointId?: string) => Promise<void>;
  busy: boolean;
}): JSX.Element {
  const [runtimeId, setRuntimeId] = useState('');
  const [modelId, setModelId] = useState('qwen2.5:7b');
  const [endpointId, setEndpointId] = useState('');
  const endpoint = endpoints.find((e) => e.id === endpointId) ?? endpoints[0];
  const selected = useMemo(() => runtimes.find((r) => r.id === runtimeId), [runtimes, runtimeId]);

  // Runtimes arrive asynchronously per host, so the initial list is often empty.
  // Without this the picker stays unselected and "Add agent" is permanently
  // disabled — and the list differs per host, so it can change under us.
  useEffect(() => {
    if (runtimes.length === 0) return;
    if (!runtimes.some((r) => r.id === runtimeId)) setRuntimeId(runtimes[0]!.id);
  }, [runtimes, runtimeId]);

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
            Runtime
            <RuntimeSelect
              value={runtimeId}
              onChange={setRuntimeId}
              options={runtimes.map((r) => ({ value: r.id, label: `${r.id} (${r.version})` }))}
            />
          </label>

          {/* §3.13: choosing a runtime shows what it can actually do here. Beside
              the picker rather than on a settings page, because this is the one
              moment the answer changes a decision. */}
          <SupportMatrix cells={conformance} runtimeId={runtimeId} />

          {/* Shown unless the runtime takes no model at all. A wrapped harness
              that ignores the field invites a silent no-op — but an installed
              CLI takes one *optionally*, and hiding the field there made the
              choice unreachable rather than unavailable (§3.12). */}
          {selected !== undefined && selected.model !== 'none' && (
            <label className="text-muted grid gap-1 text-xs">
              Model
              <input
                className="field"
                data-testid="model-id"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
              />
              <small className="text-muted text-[11px]">
                An Ollama or other OpenAI-compatible model reachable from that host.
              </small>
              {endpoints.length > 1 && (
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
                 * be reconsidered.
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
            </label>
          )}

          <button
            className="btn"
            data-testid="add-agent"
            disabled={busy || runtimeId === ''}
            onClick={() =>
              void onAdd(
                runtimeId,
                selected !== undefined && selected.model !== 'none' ? modelId : null,
                endpoint?.id,
              )
            }
          >
            Add agent
          </button>
        </>
      )}
    </div>
  );
}
