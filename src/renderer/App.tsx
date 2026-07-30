/**
 * Single-session text view (DESIGN.md §15, Phase 1).
 *
 * Deliberately plain. Phase 1's criterion is that a text session edits a real
 * repo and its transcript survives a restart, so this shows the transcript, a
 * composer, the permission prompt, and enough session state to tell whether the
 * agent is working or waiting on you. The dashboard, the Needs-you rail, and the
 * multi-agent panes are Phase 4 and Phase 6.
 *
 * ## Two conventions
 *
 * **`data-testid` marks anything a test drives.** Styling classes are Tailwind
 * utilities and change whenever the design does; a test that selects on
 * `.composer` breaks on a purely visual edit and reports it as a failure.
 *
 * **The permission prompt is inline, not a modal.** §14 specifies Radix for
 * dialogs, and the reasoning there — no hand-rolled focus management — is right
 * for dialogs. This is not one: it appears *during* a run, unprompted, and a
 * modal that steals focus mid-sentence is the wrong shape for that. Inline needs
 * no focus trap to be correct, so Radix's value does not apply.
 */

// React 19 no longer declares a global `JSX` namespace; it is exported instead.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { RuntimeSelect } from './RuntimeSelect.js';
import { useLoom } from './store.js';
import type { LoomEvent, SessionState } from '../shared/types/index.js';

/** Session-state colour, by what the state *means* (§4.1). */
function stateTone(state: SessionState): string {
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

const LABEL = 'text-[10px] uppercase tracking-wider';

export function App(): JSX.Element {
  const store = useLoom();
  const { workspace, runtimes, sessions, onDisk, active, events, pending, error, busy } = store;

  useEffect(() => {
    void store.boot();

    const offEvents = window.loom.on.events((b) => useLoom.getState().applyBatch(b));
    const offSession = window.loom.on.session((s) => useLoom.getState().applySession(s));
    const offPermission = window.loom.on.permission((r) => useLoom.getState().applyPermission(r));

    // Without these the listeners accumulate on every remount and events render
    // twice — a duplication bug, not a crash, which is why it is easy to miss.
    return () => {
      offEvents();
      offSession();
      offPermission();
    };
  }, []);

  const unloaded = useMemo(
    () => onDisk.filter((d) => !sessions.some((s) => s.sessionId === d.sessionId)),
    [onDisk, sessions],
  );

  return (
    <div data-testid="app" className="grid h-full grid-cols-[280px_1fr]">
      <aside className="bg-panel border-line flex min-h-0 flex-col border-r">
        <header className="border-line border-b p-3.5">
          <h1 className="mb-1 text-base tracking-wide">Loom</h1>
          <p
            data-testid="workspace-path"
            className="text-muted truncate-line mb-2 text-[11px]"
            title={workspace?.root ?? ''}
          >
            {workspace?.root ?? 'no workspace'}
          </p>
          <button
            className="btn"
            onClick={() => void window.loom.workspace.choose().then(() => store.boot())}
          >
            Change folder…
          </button>
        </header>

        <NewSession />

        <nav className="grid min-h-0 content-start gap-1 overflow-y-auto p-2">
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              data-testid="session"
              data-title={s.title}
              className={`grid gap-0.5 rounded-md border px-2.5 py-1.5 text-left ${
                s.sessionId === active?.sessionId
                  ? 'bg-raised border-line'
                  : 'border-transparent hover:border-line'
              }`}
              onClick={() => void store.openSession(s.sessionId)}
            >
              <span className="truncate-line">{s.title}</span>
              <span className={`${LABEL} ${stateTone(s.state)}`}>
                {s.state.replace(/_/g, ' ')}
              </span>
            </button>
          ))}

          {unloaded.length > 0 && (
            <>
              {/* The restart path, made visible: these exist only on disk until
                  opened, which is what proves the log is the source of truth. */}
              <p className={`text-muted mx-1.5 mt-3 mb-0.5 ${LABEL}`}>On disk</p>
              {unloaded.map((d) => (
                <button
                  key={d.sessionId}
                  data-testid="session"
                  data-title={d.title}
                  className="hover:border-line grid gap-0.5 rounded-md border border-transparent px-2.5 py-1.5 text-left"
                  onClick={() => void store.openSession(d.sessionId)}
                >
                  <span className="truncate-line">{d.title}</span>
                  <span className={`text-muted ${LABEL}`}>resume</span>
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>

      <main className="flex min-h-0 min-w-0 flex-col">
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

        {active === null ? (
          <p className="text-muted m-auto max-w-md p-6">
            Create a session, or open one from disk.
          </p>
        ) : (
          <>
            <div className="border-line flex items-start justify-between gap-4 border-b px-4.5 py-3.5">
              <div className="min-w-0">
                <h2 className="truncate-line text-[15px]">{active.title}</h2>
                <p className="text-muted truncate-line mt-0.5 text-xs">{active.goal}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2.5">
                <span
                  data-testid="session-state"
                  className={`${LABEL} ${stateTone(active.state)}`}
                >
                  {active.state.replace(/_/g, ' ')}
                </span>
                {active.state === 'working' && (
                  <button className="btn" onClick={() => void store.interrupt()}>
                    Interrupt
                  </button>
                )}
              </div>
            </div>

            {active.agents.length === 0 ? (
              <AgentPicker runtimes={runtimes} onAdd={store.addAgent} busy={busy} />
            ) : (
              <>
                <Transcript events={events} />
                {pending.map((p) => (
                  <PermissionPrompt
                    key={p.requestId}
                    tool={p.tool}
                    args={p.args}
                    onDecide={(allow) => void store.respond(p.requestId, allow)}
                  />
                ))}
                <Composer
                  onSend={(t) => void store.send(t)}
                  disabled={active.state === 'working'}
                />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function NewSession(): JSX.Element {
  const create = useLoom((s) => s.createSession);
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');

  const submit = (): void => {
    if (title.trim() === '') return;
    void create(title.trim(), goal.trim() || title.trim());
    setTitle('');
    setGoal('');
  };

  return (
    <form
      className="border-line grid gap-1.5 border-b px-3.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        className="field"
        data-testid="new-title"
        placeholder="Session title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <input
        className="field"
        data-testid="new-goal"
        placeholder="Goal (optional)"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <button className="btn" data-testid="new-submit" type="submit" disabled={title.trim() === ''}>
        New session
      </button>
    </form>
  );
}

function AgentPicker({
  runtimes,
  onAdd,
  busy,
}: {
  runtimes: Array<{ id: string; version: string; requiresModel: boolean }>;
  onAdd: (runtimeId: string, modelId: string | null) => Promise<void>;
  busy: boolean;
}): JSX.Element {
  const [runtimeId, setRuntimeId] = useState(runtimes[0]?.id ?? '');
  const [modelId, setModelId] = useState('qwen2.5:7b');
  const selected = runtimes.find((r) => r.id === runtimeId);

  // `runtimes` arrives asynchronously from the host handshake, so the initial
  // state is often an empty list. Without this the picker stays unselected and
  // "Add agent" is permanently disabled.
  useEffect(() => {
    if (runtimeId === '' && runtimes.length > 0) setRuntimeId(runtimes[0]!.id);
  }, [runtimes, runtimeId]);

  return (
    <div className="m-auto grid w-full max-w-md gap-3 p-6" data-testid="picker">
      <h3 className="text-sm">Add an agent</h3>

      <label className="text-muted grid gap-1 text-xs">
        Runtime
        <RuntimeSelect
          value={runtimeId}
          onChange={setRuntimeId}
          options={runtimes.map((r) => ({ value: r.id, label: `${r.id} (${r.version})` }))}
        />
      </label>

      {/* Shown only when the runtime is LoomHarness. A wrapped harness brings its
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
            An Ollama or other OpenAI-compatible model on localhost.
          </small>
        </label>
      )}

      <button
        className="btn"
        data-testid="add-agent"
        disabled={busy || runtimeId === ''}
        onClick={() => void onAdd(runtimeId, selected?.requiresModel === true ? modelId : null)}
      >
        Add agent
      </button>
    </div>
  );
}

function Transcript({ events }: { events: LoomEvent[] }): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Follow the tail only when already at the bottom. Scrolling unconditionally
  // yanks the view away the moment you scroll up to read something.
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [events]);

  return (
    <div
      data-testid="transcript"
      className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto p-4.5"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events.map((e) => (
        <EventRow key={e.seq} event={e} />
      ))}
      <div ref={endRef} />
    </div>
  );
}

const META_ROW = 'text-muted flex items-baseline gap-2 text-xs';
const CODE = 'text-accent rounded bg-[#202029] px-1.5 py-px font-mono text-[11px]';

function EventRow({ event }: { event: LoomEvent }): JSX.Element | null {
  switch (event.type) {
    case 'user.turn':
      return (
        <div
          data-testid="row-user"
          className="bg-user-bubble border-user-edge max-w-[78%] justify-self-end rounded-[10px_10px_2px_10px] border px-3 py-2"
        >
          {event.content.map((block, i) =>
            block.type === 'text' ? (
              <p key={i} className="wrap-anywhere">
                {block.text}
              </p>
            ) : (
              <p key={i}>[{block.type}]</p>
            ),
          )}
        </div>
      );

    case 'agent.text':
      return (
        <div
          data-testid="row-agent"
          className="bg-panel border-line max-w-[82%] rounded-[10px_10px_10px_2px] border px-3 py-2"
        >
          <p className="wrap-anywhere">{event.text}</p>
        </div>
      );

    case 'agent.tool_use':
      return (
        <div data-testid="row-tool" className={META_ROW}>
          <code className={CODE}>{event.tool}</code>
          <span className="truncate-line font-mono text-[11px]">{summarize(event.args)}</span>
        </div>
      );

    case 'agent.tool_result':
      return (
        <div
          data-testid={event.ok ? 'row-result' : 'row-result-failed'}
          className={`${META_ROW} ${event.ok ? '' : 'text-state-fail'}`}
        >
          <span className="truncate-line">{event.summary}</span>
        </div>
      );

    case 'permission.decided':
      // Shown because §13 requires every decision be recorded; a transcript that
      // hides the allows reads as though the gate was never consulted.
      return (
        <div data-testid="row-decision" className={META_ROW}>
          <code className={CODE}>{event.tool}</code>
          <span>
            {event.decision.result} via {event.via}
          </span>
        </div>
      );

    case 'agent.stopped':
      return (
        <div
          data-testid="row-stopped"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          <span>{event.stop.kind.replace(/_/g, ' ')}</span>
        </div>
      );

    case 'session.state':
      return (
        <div
          data-testid="row-state"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          <span>
            {event.from} → {event.to}
            {event.reason !== undefined ? ` (${event.reason})` : ''}
          </span>
        </div>
      );

    // Everything else is bookkeeping — usage, checkpoints, agent lifecycle. It
    // is in the log and reachable, just not worth a line in the conversation.
    default:
      return null;
  }
}

function PermissionPrompt({
  tool,
  args,
  onDecide,
}: {
  tool: string;
  args: unknown;
  onDecide: (allow: boolean) => void;
}): JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={`Permission requested for ${tool}`}
      data-testid="prompt"
      className="border-state-paused mx-4.5 flex items-center justify-between gap-4 rounded-lg border bg-[#2a2418] px-3.5 py-3"
    >
      <div className="grid min-w-0 gap-0.5">
        <strong data-testid="prompt-tool">{tool}</strong>
        <span className="text-muted truncate-line font-mono text-[11px]">{summarize(args)}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <button className="btn" data-testid="prompt-allow" onClick={() => onDecide(true)}>
          Allow once
        </button>
        <button
          className="btn hover:border-state-fail border-state-fail"
          data-testid="prompt-deny"
          onClick={() => onDecide(false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

function Composer({
  onSend,
  disabled,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
}): JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (text.trim() === '') return;
    onSend(text);
    setText('');
  };

  return (
    <form
      className="border-line flex items-end gap-2.5 border-t px-4.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        className="field max-h-44 min-h-[42px] resize-y"
        data-testid="composer-input"
        value={text}
        placeholder={disabled ? 'Working…' : 'Ask the agent to do something'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter newlines — the convention for this shape of
          // input, and worth matching so muscle memory works.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        className="btn"
        data-testid="composer-send"
        type="submit"
        disabled={disabled || text.trim() === ''}
      >
        Send
      </button>
    </form>
  );
}

/** A one-line rendering of tool arguments. Never the whole object. */
function summarize(args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args);
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
  });
  const joined = parts.join(' ');
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}
