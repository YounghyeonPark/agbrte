/**
 * What the window shows: a terminal, in tabs (DESIGN.md §17 Q24, step 2).
 *
 * The app opens on a terminal — the person's shell with the agent in it
 * (`{kind:'terminal'}`), one tab per session — rather than on a dashboard with
 * a terminal somewhere inside it. Everything that is not a terminal is reached
 * the way a terminal reaches anything that is not a program: a command palette
 * (Ctrl+Shift+P), and keys for the tab operations every terminal has
 * (Ctrl+Shift+T new, Ctrl+Shift+W close, Ctrl+PageUp/PageDown move).
 *
 * ## The other interface, kept while it is still needed
 *
 * The sidebar, the session view, settings, the inbox and workflows are not
 * rebuilt for the terminal yet. They stay exactly as they were, as the
 * *classic* view the palette switches to, and `App` stays mounted behind the
 * terminal so its subscriptions and its state survive the switch — the store
 * it keeps is the one the tabs read hosts and sessions from. They leave one at
 * a time, as each becomes reachable from a tab.
 *
 * The classic view is also what a phone gets (a terminal at 390 points is a
 * terminal nobody can use) and what `?ui=classic` asks for, which is how the
 * end-to-end suite written against it keeps testing it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { App } from './App.js';
import { Shell } from './Shell.js';
import { useAgbrte } from './store.js';
import { loadAgentDefault, resolveAgentDefault } from './agentDefaults.js';
import type { HostInfo } from '@shared/ipc/contract.js';

interface Tab {
  /** Local to this window; a session can be open in two tabs and they are two terminals. */
  id: string;
  instanceId: string;
  sessionId: string;
  title: string;
}

const TABS_KEY = 'agbrte.tabs.v1';

/** Tabs from the last run, as a convenience: a missing or corrupt store is "no tabs". */
function loadTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is Tab =>
        typeof t === 'object' &&
        t !== null &&
        typeof (t as Tab).id === 'string' &&
        typeof (t as Tab).instanceId === 'string' &&
        typeof (t as Tab).sessionId === 'string' &&
        typeof (t as Tab).title === 'string',
    );
  } catch {
    return [];
  }
}

function saveTabs(tabs: Tab[]): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
  } catch {
    // Remembering tabs is a convenience; failing to is not worth a banner.
  }
}

function startingUi(): 'terminal' | 'classic' {
  const asked = new URLSearchParams(window.location.search).get('ui');
  if (asked === 'classic' || asked === 'terminal') return asked;
  /*
   * The browser client (`agbrte web`) keeps the classic view for now. It is
   * mostly a phone on a tailnet, and the terminal tabs have been exercised in
   * the app's window only; `?ui=terminal` still asks for them.
   */
  if (!navigator.userAgent.includes('Electron/')) return 'classic';
  return window.innerWidth < 768 ? 'classic' : 'terminal';
}

let counter = 0;
const newTabId = (): string => `tab-${Date.now().toString(36)}-${(counter += 1)}`;

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export function Root(): JSX.Element {
  const [ui, setUi] = useState<'terminal' | 'classic'>(startingUi);
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [activeTab, setActiveTab] = useState<string | null>(() => loadTabs()[0]?.id ?? null);
  const [palette, setPalette] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hosts = useAgbrte((s) => s.hosts);
  const sessions = useAgbrte((s) => s.sessions);
  const onDisk = useAgbrte((s) => s.onDisk);
  const runtimesByHost = useAgbrte((s) => s.runtimesByHost);

  useEffect(() => saveTabs(tabs), [tabs]);

  /*
   * Replies read aloud, per session, off until asked (Q24 step 4, §12.4).
   *
   * The agent's speech in the terminal is the speaker the classic view has,
   * moved to where the replies now appear: the same OS voice on this machine,
   * the same rule that it is never on by default and only for the session it
   * was turned on for, and the tab says it is on — a speaker is a device that
   * can be live with nothing else on screen saying so. Not remembered across
   * a restart, for the same reason: an app that starts talking when it opens
   * is one people mute once and never unmute.
   *
   * Spoken here, from the events, rather than by the host that writes the
   * replies into the terminal: the voice is this client's (a browser on a
   * phone must not make a headless server talk to an empty room), and the
   * host's terminal stream is bytes with no idea which of them were the agent.
   */
  const [reading, setReading] = useState<ReadonlySet<string>>(() => new Set());
  const readingRef = useRef(reading);
  readingRef.current = reading;
  useEffect(() => {
    const off = window.agbrte.on.events((batch) => {
      if (!readingRef.current.has(batch.sessionId)) return;
      const text = batch.events
        .flatMap((e) => (e.type === 'agent.text' ? [e.text] : []))
        .join('\n')
        .trim();
      if (text === '') return;
      void window.agbrte.voice.speak(text).then(
        (could) => {
          if (could) return;
          // No synthesiser here: said once, by turning the speaker off,
          // rather than silently doing nothing on every reply.
          setReading(new Set());
          setError('This machine has no speech synthesis, so replies cannot be read aloud.');
        },
        () => undefined,
      );
    });
    return () => {
      off();
      // A voice that outlives the window it was started from is the one
      // failure a person cannot chase down.
      void window.agbrte.voice.stopSpeaking();
    };
  }, []);

  const toggleReading = useCallback((sessionId: string): void => {
    setReading((was) => {
      const next = new Set(was);
      // Off stops mid-sentence: the reason to press it is usually that the
      // talking should end now.
      if (next.delete(sessionId)) void window.agbrte.voice.stopSpeaking();
      else next.add(sessionId);
      return next;
    });
  }, []);

  const hostLabel = useCallback(
    (instanceId: string): string =>
      hosts.find((h) => h.instanceId === instanceId)?.label ?? instanceId,
    [hosts],
  );

  /** Make sure the host has the session loaded: a tab from the last run may only be on disk. */
  const ensureLoaded = useCallback(async (instanceId: string, sessionId: string): Promise<void> => {
    const live = await window.agbrte.sessions.list();
    if (!live.some((s) => s.sessionId === sessionId))
      await window.agbrte.sessions.resume(instanceId, sessionId);
  }, []);

  const openTab = useCallback(
    async (instanceId: string, sessionId: string, title: string): Promise<void> => {
      try {
        await ensureLoaded(instanceId, sessionId);
        const tab: Tab = { id: newTabId(), instanceId, sessionId, title };
        setTabs((t) => [...t, tab]);
        setActiveTab(tab.id);
        setUi('terminal');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [ensureLoaded],
  );

  /**
   * A new session on `host`, in a new tab, with the agent this window last
   * seated there if it is still offerable (`agentDefaults.ts`) — the same rule
   * the classic view uses, so a tab and a session made the other way agree.
   * With nothing remembered the tab opens anyway: the shell works, and asking
   * the agent says that a seat is needed and where to choose one.
   */
  const newTab = useCallback(
    async (host: HostInfo): Promise<void> => {
      try {
        const title = `Terminal ${tabs.length + 1}`;
        const session = await window.agbrte.sessions.create({
          instanceId: host.instanceId,
          title,
          goal: title,
        });
        const remembered = loadAgentDefault(host.instanceId);
        const seat =
          remembered === null
            ? null
            : resolveAgentDefault(
                remembered,
                runtimesByHost[host.instanceId] ?? [],
                host.endpoints,
              );
        if (seat !== null) {
          await window.agbrte.sessions.addAgent({
            sessionId: session.sessionId,
            role: 'lead',
            runtimeId: seat.runtimeId,
            ...(seat.modelId !== null
              ? {
                  model: {
                    providerId: 'openai-compatible',
                    modelId: seat.modelId,
                    ...(seat.endpointId !== undefined ? { endpointId: seat.endpointId } : {}),
                  },
                }
              : {}),
          });
        }
        useAgbrte.setState({ sessions: await window.agbrte.sessions.list() });
        const tab: Tab = {
          id: newTabId(),
          instanceId: host.instanceId,
          sessionId: session.sessionId,
          title,
        };
        setTabs((t) => [...t, tab]);
        setActiveTab(tab.id);
        setUi('terminal');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [tabs.length, runtimesByHost],
  );

  const closeTab = useCallback((id: string): void => {
    setTabs((t) => {
      const at = t.findIndex((x) => x.id === id);
      const next = t.filter((x) => x.id !== id);
      // The last tab on a session takes its speaker with it.
      const closed = t[at];
      if (closed !== undefined && !next.some((x) => x.sessionId === closed.sessionId)) {
        setReading((was) => {
          if (!was.has(closed.sessionId)) return was;
          void window.agbrte.voice.stopSpeaking();
          const left = new Set(was);
          left.delete(closed.sessionId);
          return left;
        });
      }
      setActiveTab((current) =>
        current === id ? (next[Math.max(0, at - 1)]?.id ?? null) : current,
      );
      return next;
    });
  }, []);

  const localHost =
    hosts.find((h) => h.targetKind === 'local' && h.unavailableReason === undefined) ?? hosts[0];
  const current = tabs.find((t) => t.id === activeTab) ?? null;

  /*
   * The first tab, once there is a host to put it on: the tabs from last time
   * (those whose session still exists), or a new session on this machine. Once
   * per window, so closing the last tab leaves an empty window rather than one
   * that refills itself.
   */
  const started = useRef(false);
  useEffect(() => {
    if (started.current || ui !== 'terminal' || localHost === undefined) return;
    started.current = true;
    const known = new Set([...sessions, ...onDisk].map((s) => s.sessionId));
    const kept = tabs.filter(
      (t) => known.has(t.sessionId) && hosts.some((h) => h.instanceId === t.instanceId),
    );
    if (kept.length !== tabs.length) setTabs(kept);
    if (kept.length === 0) {
      void newTab(localHost);
      return;
    }
    if (!kept.some((t) => t.id === activeTab)) setActiveTab(kept[0]?.id ?? null);
    for (const t of kept) void ensureLoaded(t.instanceId, t.sessionId).catch(() => undefined);
  }, [ui, localHost, sessions, onDisk, tabs, hosts, activeTab, newTab, ensureLoaded]);

  /** Show `sessionId` in the classic view: for what a tab cannot do yet. */
  const classicFor = useCallback(async (tab: Tab | null): Promise<void> => {
    if (tab !== null) await useAgbrte.getState().openSession(tab.sessionId, tab.instanceId);
    setUi('classic');
  }, []);

  const commands = useMemo((): Command[] => {
    const list: Command[] = [];
    if (ui === 'classic')
      list.push({
        id: 'terminal',
        label: 'Back to the terminal',
        run: () => setUi('terminal'),
      });
    for (const h of hosts) {
      list.push({
        id: `new:${h.instanceId}`,
        label: hosts.length === 1 ? 'New tab' : `New tab on ${h.label}`,
        hint: 'Ctrl+Shift+T',
        run: () => void newTab(h),
      });
    }
    if (current !== null) {
      list.push({
        id: 'close',
        label: 'Close tab',
        hint: 'Ctrl+Shift+W',
        run: () => closeTab(current.id),
      });
      list.push({
        id: 'read-aloud',
        label: reading.has(current.sessionId)
          ? 'Stop reading replies aloud'
          : 'Read replies aloud in this tab',
        hint: 'off by default',
        run: () => toggleReading(current.sessionId),
      });
      list.push({
        id: 'agent',
        label: 'Choose the agent for this tab…',
        hint: 'in the classic view',
        run: () => void classicFor(current),
      });
    }
    const open = new Set(tabs.map((t) => t.sessionId));
    const seen = new Set<string>();
    for (const s of [...sessions, ...onDisk]) {
      if (seen.has(s.sessionId) || open.has(s.sessionId)) continue;
      seen.add(s.sessionId);
      list.push({
        id: `open:${s.sessionId}`,
        label: `Open session: ${s.title}`,
        hint: hostLabel(s.instanceId),
        run: () => void openTab(s.instanceId, s.sessionId, s.title),
      });
    }
    list.push(
      {
        id: 'classic',
        label: 'Sessions, inbox and settings…',
        hint: 'the classic view',
        run: () => void classicFor(null),
      },
      {
        id: 'attach',
        label: 'Attach a host…',
        hint: 'the classic view',
        run: () => void classicFor(null),
      },
    );
    return list;
  }, [
    ui,
    hosts,
    current,
    tabs,
    sessions,
    onDisk,
    newTab,
    closeTab,
    classicFor,
    openTab,
    hostLabel,
    reading,
    toggleReading,
  ]);

  /*
   * The terminal keys, taken before the emulator sees them. Capture phase, so
   * a focused terminal does not receive Ctrl+Shift+T as a key for the shell:
   * none of these is something a shell or a full-screen program binds.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const key = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && key === 'p') {
        e.preventDefault();
        e.stopPropagation();
        setPalette((p) => !p);
        return;
      }
      if (ui !== 'terminal') return;
      if (e.ctrlKey && e.shiftKey && key === 't') {
        e.preventDefault();
        e.stopPropagation();
        const host = hosts.find((h) => h.instanceId === current?.instanceId) ?? localHost;
        if (host !== undefined) void newTab(host);
        return;
      }
      if (e.ctrlKey && e.shiftKey && key === 'w' && current !== null) {
        e.preventDefault();
        e.stopPropagation();
        closeTab(current.id);
        return;
      }
      if (e.ctrlKey && (e.key === 'PageDown' || e.key === 'PageUp') && tabs.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        const at = tabs.findIndex((t) => t.id === activeTab);
        const step = e.key === 'PageDown' ? 1 : -1;
        setActiveTab(tabs[(at + step + tabs.length) % tabs.length]?.id ?? null);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ui, hosts, current, localHost, tabs, activeTab, newTab, closeTab]);

  const showTerminal = ui === 'terminal';

  return (
    <>
      {/* Mounted either way: its subscriptions keep the store current for the tabs. */}
      <div className={showTerminal ? 'hidden' : 'contents'}>
        <App />
      </div>
      {/* Hidden rather than unmounted in the classic view, for the same reason
          a background tab is: unmounting a pane ends its shell, and a trip to
          the classic view to seat an agent came back to a fresh shell with
          whatever had been running in it gone. */}
      <div
        data-testid="terminal-app"
        className={showTerminal ? 'bg-bg text-ink fixed inset-0 flex flex-col' : 'hidden'}
      >
        <TabBar
          tabs={tabs}
          active={activeTab}
          hostLabel={(t) => (hosts.length > 1 ? hostLabel(t.instanceId) : null)}
          reading={reading}
          onReading={toggleReading}
          onSelect={setActiveTab}
          onClose={closeTab}
          onNew={() => {
            const host = hosts.find((h) => h.instanceId === current?.instanceId) ?? localHost;
            if (host !== undefined) void newTab(host);
          }}
          onPalette={() => setPalette(true)}
        />
        {error !== null && (
          <p
            data-testid="terminal-error"
            className="text-state-fail border-line border-b px-4 py-1 text-xs"
          >
            {error}{' '}
            <button type="button" className="btn-quiet text-xs" onClick={() => setError(null)}>
              dismiss
            </button>
          </p>
        )}
        <div className="relative min-h-0 flex-1">
          {tabs.length === 0 && (
            <p data-testid="terminal-empty" className="text-muted p-6 text-sm">
              {localHost === undefined
                ? 'Starting this machine’s host…'
                : 'No tabs. Ctrl+Shift+T opens one; Ctrl+Shift+P for everything else.'}
            </p>
          )}
          {tabs.map((t) => (
            /*
             * Every tab stays mounted, hidden rather than unmounted, because
             * unmounting a pane ends its terminal — and a tab you switched away
             * from is still running whatever you left in it.
             */
            <div
              key={t.id}
              data-testid="terminal-tab-pane"
              data-active={t.id === activeTab ? 'true' : undefined}
              className={t.id === activeTab ? 'absolute inset-0 flex flex-col' : 'hidden'}
            >
              <Shell
                sessionId={t.sessionId}
                instanceId={t.instanceId}
                program={{ kind: 'terminal' }}
                hostLabel={hostLabel(t.instanceId)}
                bare
              />
            </div>
          ))}
        </div>
      </div>

      {palette && <Palette commands={commands} onClose={() => setPalette(false)} />}
    </>
  );
}

function TabBar({
  tabs,
  active,
  hostLabel,
  reading,
  onReading,
  onSelect,
  onClose,
  onNew,
  onPalette,
}: {
  tabs: Tab[];
  active: string | null;
  hostLabel: (t: Tab) => string | null;
  /** Sessions whose replies are being read aloud. */
  reading: ReadonlySet<string>;
  onReading: (sessionId: string) => void;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onPalette: () => void;
}): JSX.Element {
  return (
    <div data-testid="tab-bar" className="border-line flex shrink-0 items-stretch border-b text-xs">
      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.map((t) => {
          const where = hostLabel(t);
          return (
            <div
              key={t.id}
              data-testid="tab"
              data-active={t.id === active ? 'true' : undefined}
              className={`border-line flex shrink-0 items-center gap-2 border-r px-3 py-1 font-mono ${
                t.id === active ? 'bg-accent text-bg' : 'text-ink'
              }`}
            >
              <button type="button" className="cursor-pointer" onClick={() => onSelect(t.id)}>
                {t.title}
                {where !== null && <span className="opacity-70"> · {where}</span>}
              </button>
              {reading.has(t.sessionId) && (
                <button
                  type="button"
                  data-testid="tab-reading"
                  aria-label={`Stop reading ${t.title} aloud`}
                  title="Replies are read aloud. Press to stop."
                  className="cursor-pointer"
                  onClick={() => onReading(t.sessionId)}
                >
                  🔊
                </button>
              )}
              <button
                type="button"
                aria-label={`Close ${t.title}`}
                data-testid="tab-close"
                className="cursor-pointer opacity-70 hover:opacity-100"
                onClick={() => onClose(t.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          type="button"
          data-testid="tab-new"
          aria-label="New tab"
          title="New tab (Ctrl+Shift+T)"
          className="btn-quiet shrink-0 px-3 font-mono"
          onClick={onNew}
        >
          +
        </button>
      </div>
      <button
        type="button"
        data-testid="palette-open"
        title="Everything else (Ctrl+Shift+P)"
        className="btn-quiet border-line shrink-0 border-l px-3 font-mono"
        onClick={onPalette}
      >
        ≡ Ctrl+Shift+P
      </button>
    </div>
  );
}

/**
 * The command palette: type to filter, arrows to move, Enter to run.
 *
 * A list rather than a menu tree, because the thing a person knows is a word —
 * "settings", the name of a session — not where it was filed.
 */
function Palette({ commands, onClose }: { commands: Command[]; onClose: () => void }): JSX.Element {
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const shown = commands.filter((c) =>
    `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [query]);
  const run = (c: Command | undefined): void => {
    if (c === undefined) return;
    onClose();
    c.run();
  };
  return (
    <div
      data-testid="palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-panel border-line w-full max-w-xl border">
        <input
          ref={input}
          data-testid="palette-input"
          className="border-line text-ink placeholder:text-muted w-full border-b bg-transparent px-3 py-2 font-mono text-sm outline-none"
          placeholder="Type a command or a session’s name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((n) => Math.min(shown.length - 1, n + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((n) => Math.max(0, n - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(shown[at]);
            }
          }}
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {shown.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                data-testid="palette-item"
                data-command={c.id}
                className={`flex w-full items-baseline justify-between gap-3 px-3 py-1 text-left text-sm ${
                  i === at ? 'bg-accent text-bg' : 'text-ink'
                }`}
                onMouseEnter={() => setAt(i)}
                onClick={() => run(c)}
              >
                <span>{c.label}</span>
                {c.hint !== undefined && (
                  <span className="shrink-0 text-xs opacity-70">{c.hint}</span>
                )}
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="text-muted px-3 py-2 text-sm">Nothing matches.</li>}
        </ul>
      </div>
    </div>
  );
}
