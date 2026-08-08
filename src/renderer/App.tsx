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
import { StartGuide } from './StartGuide.js';
import { RuntimeSelect } from './RuntimeSelect.js';
import { useGilmok } from './store.js';
import { Composer, EventRow, PermissionPrompt, Transcript, summarize } from './Transcript.js';
import type { HostInfo, RuntimeInfo } from '../shared/ipc/contract.js';
import type { Session, SessionState } from '../shared/types/index.js';

/** Session-state colour, by what the state *means* (§4.1). */
export function stateTone(state: SessionState): string {
  switch (state) {
    case 'working':
      return 'text-accent';
    case 'failed':
      return 'text-state-fail';
    case 'done':
      return 'text-state-done';
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

export const LABEL = 'text-[10px] uppercase tracking-wider';

export function App(): JSX.Element {
  const store = useGilmok();
  const [attaching, setAttaching] = useState<false | 'local' | 'remote'>(false);
  // Toggled open even with a session showing, because a guide you can only
  // reach from an empty window is unreachable exactly when it is wanted.
  const [guide, setGuide] = useState(false);
  const { hosts, runtimesByHost, sessions, onDisk, active, events, pending, queued, error, notice, busy } =
    store;

  useEffect(() => {
    void store.boot();

    const offEvents = window.gilmok.on.events((b) => useGilmok.getState().applyBatch(b));
    const offSession = window.gilmok.on.session((s) => useGilmok.getState().applySession(s));
    const offPermission = window.gilmok.on.permission((r) => useGilmok.getState().applyPermission(r));
    const offResolved = window.gilmok.on.permissionResolved((r) =>
      useGilmok.getState().applyPermissionResolved(r),
    );
    const offHosts = window.gilmok.on.hosts((h) => useGilmok.getState().applyHosts(h));

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
          active === null ? 'flex' : 'hidden'
        }`}
      >
        <header className="border-line flex items-center justify-between border-b p-3.5">
          <h1 className="text-base tracking-wide">Gilmok</h1>
          <div className="flex gap-1.5">
            <button
              className="btn px-2"
              data-testid="show-guide"
              title="How Gilmok is used"
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
        className={`safe-bottom min-h-0 min-w-0 flex-col md:flex ${
          active === null ? 'hidden md:flex' : 'flex'
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

        {active === null || guide ? (
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

            {active.agents.length === 0 ? (
              <AgentPicker
                runtimes={runtimesHere}
                endpoints={hosts.find((h) => h.instanceId === active.instanceId)?.endpoints ?? []}
                onAdd={store.addAgent}
                busy={busy}
              />
            ) : (
              <>
                <Transcript events={events} renderRow={(e) => <EventRow key={e.seq} event={e} />} />
                {pending.map((p) => (
                  <PermissionPrompt
                    key={p.requestId}
                    tool={p.tool}
                    args={summarize(p.args)}
                    onDecide={(allow) => void store.respond(p.requestId, allow)}
                  />
                ))}
                <Composer
                  onSend={(t) => void store.send(t)}
                  disabled={active.state === 'working'}
                  queued={queued}
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
  const store = useGilmok();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

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
            <span className={`${LABEL} ${stateTone(s.state)}`}>{s.state.replace(/_/g, ' ')}</span>
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
      </div>
    </div>
  );
}

function AgentPicker({
  runtimes,
  endpoints,
  onAdd,
  busy,
}: {
  runtimes: RuntimeInfo[];
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

          {/* Only when the runtime is GilmokHarness. A wrapped harness brings its
              own model, and offering a field it ignores invites a silent no-op. */}
          {selected?.requiresModel === true && (
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
                selected?.requiresModel === true ? modelId : null,
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
