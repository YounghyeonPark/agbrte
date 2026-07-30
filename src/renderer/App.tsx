/**
 * Single-session text view (DESIGN.md §15, Phase 1).
 *
 * Deliberately plain. Phase 1's criterion is that a text session edits a real
 * repo and its transcript survives a restart, so this shows the transcript, a
 * composer, the permission prompt, and enough session state to tell whether the
 * agent is working or waiting on you. The dashboard, the Needs-you rail, and the
 * multi-agent panes are Phase 4 and Phase 6.
 *
 * §14 specifies Radix primitives for dialogs. The permission prompt here is
 * inline rather than a modal, which is not a shortcut: a modal that steals focus
 * mid-typing is the wrong shape for something that fires during a run, and an
 * inline prompt needs no focus trap to be correct.
 */

// React 19 no longer declares a global `JSX` namespace; it is exported instead.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLoom } from './store.js';
import type { LoomEvent } from '../shared/types/index.js';

export function App(): JSX.Element {
  const store = useLoom();
  const {
    workspace,
    runtimes,
    sessions,
    onDisk,
    active,
    events,
    pending,
    error,
    busy,
  } = store;

  useEffect(() => {
    void store.boot();

    const offEvents = window.loom.on.events((b) => useLoom.getState().applyBatch(b));
    const offSession = window.loom.on.session((s) => useLoom.getState().applySession(s));
    const offPermission = window.loom.on.permission((r) =>
      useLoom.getState().applyPermission(r),
    );

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
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Loom</h1>
          <p className="path" title={workspace?.root ?? ''}>
            {workspace?.root ?? 'no workspace'}
          </p>
          <button onClick={() => void window.loom.workspace.choose().then(() => store.boot())}>
            Change folder…
          </button>
        </header>

        <NewSession />

        <nav>
          {sessions.map((s) => (
            <button
              key={s.sessionId}
              className={s.sessionId === active?.sessionId ? 'session active' : 'session'}
              onClick={() => void store.openSession(s.sessionId)}
            >
              <span className="title">{s.title}</span>
              <span className={`state ${s.state}`}>{s.state.replace(/_/g, ' ')}</span>
            </button>
          ))}

          {unloaded.length > 0 && (
            <>
              {/* The restart path, made visible: these exist only on disk until
                  opened, which is what proves the log is the source of truth. */}
              <p className="group">On disk</p>
              {unloaded.map((d) => (
                <button
                  key={d.sessionId}
                  className="session"
                  onClick={() => void store.openSession(d.sessionId)}
                >
                  <span className="title">{d.title}</span>
                  <span className="state">resume</span>
                </button>
              ))}
            </>
          )}
        </nav>
      </aside>

      <main>
        {error !== null && (
          <div className="error" role="alert">
            <span>{error}</span>
            <button onClick={() => store.dismissError()}>dismiss</button>
          </div>
        )}

        {active === null ? (
          <div className="empty">
            <p>Create a session, or open one from disk.</p>
          </div>
        ) : (
          <>
            <div className="session-head">
              <div>
                <h2>{active.title}</h2>
                <p className="goal">{active.goal}</p>
              </div>
              <div className="head-right">
                <span className={`state ${active.state}`}>{active.state.replace(/_/g, ' ')}</span>
                {active.state === 'working' && (
                  <button onClick={() => void store.interrupt()}>Interrupt</button>
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
                <Composer onSend={(t) => void store.send(t)} disabled={active.state === 'working'} />
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
      className="new-session"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input placeholder="Session title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input placeholder="Goal (optional)" value={goal} onChange={(e) => setGoal(e.target.value)} />
      <button type="submit" disabled={title.trim() === ''}>
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
  const [modelId, setModelId] = useState('qwen2.5-coder:7b');
  const selected = runtimes.find((r) => r.id === runtimeId);

  return (
    <div className="picker">
      <h3>Add an agent</h3>
      <label>
        Runtime
        <select value={runtimeId} onChange={(e) => setRuntimeId(e.target.value)}>
          {runtimes.map((r) => (
            <option key={r.id} value={r.id}>
              {r.id} ({r.version})
            </option>
          ))}
        </select>
      </label>

      {/* Shown only when the runtime is LoomHarness. A wrapped harness brings its
          own model, and offering a field it ignores invites a silent no-op. */}
      {selected?.requiresModel === true && (
        <label>
          Model
          <input value={modelId} onChange={(e) => setModelId(e.target.value)} />
          <small>An Ollama or other OpenAI-compatible model on localhost.</small>
        </label>
      )}

      <button
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
      className="transcript"
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

function EventRow({ event }: { event: LoomEvent }): JSX.Element | null {
  switch (event.type) {
    case 'user.turn':
      return (
        <div className="row user">
          {event.content.map((block, i) =>
            block.type === 'text' ? <p key={i}>{block.text}</p> : <p key={i}>[{block.type}]</p>,
          )}
        </div>
      );

    case 'agent.text':
      return (
        <div className="row agent">
          <p>{event.text}</p>
        </div>
      );

    case 'agent.tool_use':
      return (
        <div className="row tool">
          <code>{event.tool}</code>
          <span className="args">{summarize(event.args)}</span>
        </div>
      );

    case 'agent.tool_result':
      return (
        <div className={event.ok ? 'row result' : 'row result failed'}>
          <span>{event.summary}</span>
        </div>
      );

    case 'permission.decided':
      // Shown because §13 requires every decision be recorded; a transcript that
      // hides the allows reads as though the gate was never consulted.
      return (
        <div className="row decision">
          <code>{event.tool}</code>
          <span>
            {event.decision.result} via {event.via}
          </span>
        </div>
      );

    case 'agent.stopped':
      return (
        <div className="row stopped">
          <span>{event.stop.kind.replace(/_/g, ' ')}</span>
        </div>
      );

    case 'session.state':
      return (
        <div className="row state-change">
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
    <div className="prompt" role="alertdialog">
      <div>
        <strong>{tool}</strong>
        <span className="args">{summarize(args)}</span>
      </div>
      <div className="prompt-actions">
        <button onClick={() => onDecide(true)}>Allow once</button>
        <button className="deny" onClick={() => onDecide(false)}>
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
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
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
      <button type="submit" disabled={disabled || text.trim() === ''}>
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
