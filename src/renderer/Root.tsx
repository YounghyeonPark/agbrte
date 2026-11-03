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
 * ## The other interface, kept for what is left of it
 *
 * Settings, the inbox, workflows, attaching a machine, opening a folder, the
 * agent's set-up forms and the fleet search were the *classic* view — the
 * sidebar and session pane the palette switched the window to. Each is now a
 * sheet over the tabs (`TerminalSheets.tsx`) or a list in the palette, so none
 * of them takes the person out of the terminal. What remains of the classic
 * view on the desktop is a session's record — its transcript, files, agents and
 * a run's graph — reached from the palette until a tab can show it.
 *
 * `App` stays mounted behind the terminal so its subscriptions and its state
 * survive — the store it keeps is the one the tabs read hosts and sessions
 * from — with its auto-seating off while the terminal shows, since the tabs
 * seat their own sessions and the two raced on a session made from a sheet.
 *
 * The classic view is also what a phone gets (a terminal at 390 points is a
 * terminal nobody can use), what the browser client gets, and what
 * `?ui=classic` asks for, which is how the end-to-end suite written against it
 * keeps testing it.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { AgentPicker, App, machineFor, runtimeLabel } from './App.js';
import { Shell } from './Shell.js';
import { useAgbrte } from './store.js';
import { loadAgentDefault, resolveAgentDefault, saveAgentDefault } from './agentDefaults.js';
import { AttachHost } from './AttachHost.js';
import { NewSession } from './NewSession.js';
import { Settings } from './Settings.js';
import { Search } from './Search.js';
import { SAYS } from './Inbox.js';
import { Sheet, WorkflowsSheet } from './TerminalSheets.js';
import type { GrantRequestDto, HostInfo, UpdateState } from '@shared/ipc/contract.js';

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
  /**
   * A second list the palette shows in place of this one, as a terminal's
   * palette narrows "Select theme…" to the themes. When set, `run` is not called.
   */
  then?: () => Promise<Command[]>;
  /**
   * A line to type rather than a list to pick from — a folder's path — and
   * what to do with it on Enter. When set, `run` is not called.
   */
  ask?: { placeholder: string; submit: (text: string) => void };
}

/** A form opened over the tabs (`TerminalSheets.tsx`), or none. */
type SheetOpen =
  | { kind: 'settings' }
  | { kind: 'workflows' }
  | { kind: 'search' }
  | { kind: 'attach' }
  | { kind: 'folder' }
  /** The classic picker's forms, for one tab: a model to install, an API key. */
  | { kind: 'agent'; tab: Tab };

export function Root(): JSX.Element {
  const [ui, setUi] = useState<'terminal' | 'classic'>(startingUi);
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [activeTab, setActiveTab] = useState<string | null>(() => loadTabs()[0]?.id ?? null);
  const [palette, setPalette] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Sessions this window has tried to seat with the remembered agent (below). */
  const seatTried = useRef(new Set<string>());
  const hosts = useAgbrte((s) => s.hosts);
  const sessions = useAgbrte((s) => s.sessions);
  const onDisk = useAgbrte((s) => s.onDisk);
  const runtimesByHost = useAgbrte((s) => s.runtimesByHost);
  const conformanceByHost = useAgbrte((s) => s.conformanceByHost);
  const inbox = useAgbrte((s) => s.inbox);
  /*
   * The store's own sentences — a refused open, a folder that could not be
   * attached, a seat somebody else changed. The forms now open over the tabs
   * report through the store as they did in the classic view, whose banner is
   * hidden while the terminal shows; without these lines a failure in a sheet
   * said nothing at all.
   */
  const storeError = useAgbrte((s) => s.error);
  const storeNotice = useAgbrte((s) => s.notice);
  const active = useAgbrte((s) => s.active);
  const [sheet, setSheet] = useState<SheetOpen | null>(null);
  /** This installation's update, for the settings sheet; `App` keeps its own copy. */
  const [update, setUpdate] = useState<UpdateState>({ phase: 'idle' });
  useEffect(() => {
    const off = window.agbrte.on.update(setUpdate);
    void window.agbrte.update.state().then(setUpdate, () => undefined);
    return off;
  }, []);
  /** Whether the agent sheet's add is in flight. */
  const [seating, setSeating] = useState(false);

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
          // Seated here, so the open-tab seating below must not add a second.
          // Only here: marked with nothing to seat, the tab was never seated
          // when a choice was made later, which is the bug that seating fixes.
          seatTried.current.add(session.sessionId);
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

  /**
   * Show a session in the classic view: its record — the transcript, the files,
   * the agents, a run's graph — which is the one part of that view no tab or
   * sheet has taken over yet.
   */
  const classicFor = useCallback(
    async (session: { sessionId: string; instanceId: string } | null): Promise<void> => {
      if (session !== null)
        await useAgbrte.getState().openSession(session.sessionId, session.instanceId);
      setSheet(null);
      setUi('classic');
    },
    [],
  );

  /*
   * A session the folder sheet opened, put in a tab.
   *
   * The form ends by making a session the store's open one — that is how the
   * classic view showed it — and says only that it did. It is not always
   * finished saying so when it closes: choosing a session already on disk
   * starts the open and closes without waiting. So the sheet remembers which
   * session was open when it was opened, and the first different one is the
   * answer. Closing the sheet by hand stops waiting, or the next session the
   * classic view opened would turn up as a tab nobody asked for.
   */
  const openedFrom = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (openedFrom.current === undefined || active === null) return;
    if (active.sessionId === openedFrom.current) return;
    openedFrom.current = undefined;
    const there = tabs.find((t) => t.sessionId === active.sessionId);
    if (there !== undefined) {
      setActiveTab(there.id);
      setUi('terminal');
    } else void openTab(active.instanceId, active.sessionId, active.title);
  }, [active, tabs, openTab]);

  const openSheet = useCallback((open: SheetOpen): void => {
    openedFrom.current =
      open.kind === 'folder' ? (useAgbrte.getState().active?.sessionId ?? null) : undefined;
    setSheet(open);
    setUi('terminal');
  }, []);
  const closeSheet = useCallback((): void => {
    openedFrom.current = undefined;
    setSheet(null);
  }, []);

  /** Open `sessionId` in a tab, or go to the tab it is already open in. */
  const goTo = useCallback(
    (instanceId: string, sessionId: string, title: string): void => {
      setSheet(null);
      const there = tabs.find((t) => t.sessionId === sessionId);
      if (there === undefined) {
        void openTab(instanceId, sessionId, title);
        return;
      }
      setActiveTab(there.id);
      setUi('terminal');
    },
    [tabs, openTab],
  );

  /**
   * Seat `choice` in `tab`'s session, taking over the seat that is there, and
   * remember it for the host as the classic view's picker does.
   *
   * This went through the classic view, and the owner's first try at talking to
   * the agent was there: the picker, then a composer under a shell, so `?` opened
   * a chat box beside the terminal rather than a line in it. Choosing here keeps
   * the person in the tab they were choosing for.
   */
  const seat = useCallback(
    async (
      tab: Tab,
      runtimeId: string,
      modelId: string | null,
      endpointId?: string,
    ): Promise<boolean> => {
      try {
        const snap = await window.agbrte.sessions.snapshot(tab.sessionId);
        // An id the host checks rather than "replace whatever is there", as
        // `store.addAgent` sends it: a seat somebody else changed is refused.
        const incumbent = snap.session.agents.find((a) => a.status !== 'retired');
        const model =
          modelId !== null
            ? {
                providerId: 'openai-compatible',
                modelId,
                ...(endpointId !== undefined ? { endpointId } : {}),
              }
            : null;
        await window.agbrte.sessions.addAgent({
          sessionId: tab.sessionId,
          role: 'lead',
          runtimeId,
          ...(incumbent !== undefined ? { replacing: incumbent.agentId } : {}),
          ...(model !== null ? { model } : {}),
        });
        saveAgentDefault(tab.instanceId, { runtimeId, model });
        useAgbrte.setState({ sessions: await window.agbrte.sessions.list() });
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [],
  );

  /*
   * A tab whose session has no agent gets the one this window remembers for its
   * host — the classic view's auto-add (§4.2), for every open tab rather than
   * the one session on screen.
   *
   * Only new tabs were seated, at creation. The owner opened tabs, chose an
   * agent in one of them, and the others went on answering "no agent yet":
   * the choice was remembered and nothing applied it to a tab that already
   * existed — nor to one restored from last time whose session never had a seat.
   * Once per session per window, marked before the call, so a failed add is not
   * retried in a loop; never a workflow run, which has no agent of its own.
   */
  useEffect(() => {
    if (ui !== 'terminal') return;
    for (const t of tabs) {
      if (seatTried.current.has(t.sessionId)) continue;
      const s = sessions.find((x) => x.sessionId === t.sessionId);
      // Not loaded yet: this runs again when the list changes.
      if (s === undefined) continue;
      if (s.workflow !== undefined || s.agents.some((a) => a.status !== 'retired')) continue;
      const host = hosts.find((h) => h.instanceId === t.instanceId);
      const runtimes = runtimesByHost[t.instanceId];
      if (host === undefined || runtimes === undefined) continue;
      const remembered = loadAgentDefault(t.instanceId);
      if (remembered === null) continue;
      const args = resolveAgentDefault(remembered, runtimes, host.endpoints);
      if (args === null) continue;
      seatTried.current.add(t.sessionId);
      void seat(t, args.runtimeId, args.modelId, args.endpointId);
    }
  }, [ui, tabs, sessions, hosts, runtimesByHost, seat]);

  /**
   * What `tab`'s host can seat, one line each: a runtime that takes no model,
   * and every model its endpoints serve for one that does. Anything that needs
   * a form — installing a model, an API key, an endpoint — is the classic
   * picker's form, opened over the tab from the last line.
   */
  const agentChoices = useCallback(
    async (tab: Tab): Promise<Command[]> => {
      const host = hosts.find((h) => h.instanceId === tab.instanceId);
      const runtimes = runtimesByHost[tab.instanceId] ?? [];
      const [served, snap] = await Promise.all([
        runtimes.some((r) => r.model !== 'none')
          ? window.agbrte.hosts.models(tab.instanceId).catch(() => [])
          : Promise.resolve([]),
        window.agbrte.sessions.snapshot(tab.sessionId).catch(() => null),
      ]);
      const now = snap?.session.agents.find((a) => a.status !== 'retired')?.spec;
      const isNow = (runtimeId: string, modelId: string | null): boolean =>
        now !== undefined && now.runtimeId === runtimeId && (now.model?.modelId ?? null) === modelId;
      const list: Command[] = [];
      for (const r of runtimes) {
        if (r.model !== 'required') {
          list.push({
            id: `seat:${r.id}`,
            label: runtimeLabel(r.id),
            hint: isNow(r.id, null) ? 'in this tab now' : r.model === 'none' ? 'no model' : 'its own model',
            run: () => void seat(tab, r.id, null),
          });
        }
        if (r.model === 'none') continue;
        for (const e of served) {
          const endpoint = host?.endpoints.find((x) => x.id === e.endpointId);
          for (const m of e.models) {
            list.push({
              id: `seat:${r.id}:${e.endpointId}:${m}`,
              label: `${runtimeLabel(r.id)} · ${m}`,
              hint: isNow(r.id, m) ? 'in this tab now' : (endpoint?.label ?? e.endpointId),
              run: () => void seat(tab, r.id, m, e.endpointId),
            });
          }
        }
      }
      list.push({
        id: 'seat:more',
        label: 'Install a model, add an API key…',
        hint: 'a form',
        run: () => openSheet({ kind: 'agent', tab }),
      });
      return list;
    },
    [hosts, runtimesByHost, seat, openSheet],
  );

  /**
   * The inbox (§11) as a list in the palette: what finished, failed or asked
   * while nobody was looking, newest first, each line going to its session's
   * tab. Read when the list is opened, which is the classic dropdown's rule
   * moved one step earlier: there it was marked read on closing, so the
   * highlighting lasted while the list was up; here the list is built before
   * the mark, from the entries as they were, so it lasts the same.
   */
  const inboxChoices = useCallback(async (): Promise<Command[]> => {
    const entries = useAgbrte.getState().inbox;
    if (entries.some((e) => e.unread)) void useAgbrte.getState().markInboxRead();
    if (entries.length === 0)
      return [
        {
          id: 'inbox:empty',
          label: 'Nothing yet — finished runs, refused tools and quota windows land here',
          run: () => undefined,
        },
      ];
    return entries.map((e) => ({
      id: `inbox:${e.sessionId}:${e.at}:${e.trigger}`,
      label: `${e.unread ? '● ' : ''}${e.sessionTitle} ${SAYS[e.trigger]}${
        e.detail !== undefined ? ` — ${e.detail}` : ''
      }`,
      hint: new Date(e.at).toLocaleString(),
      run: () => goTo(e.instanceId, e.sessionId, e.sessionTitle),
    }));
  }, [goTo]);

  /**
   * The folders granted on a tab's machine, each one a line that takes it back,
   * and a line to grant another by typing its path (§17 Q24 step 6). Typed, not
   * picked from a dialog: the machine may be across ssh, and this window's file
   * picker shows this machine's disk.
   */
  const grantChoices = useCallback(
    async (instanceId: string): Promise<Command[]> => {
      const held = await window.agbrte.grants.list(instanceId);
      const list: Command[] = [
        {
          id: 'grant:add',
          label: 'Let the agent read and write another folder…',
          hint: 'type its path',
          run: () => undefined,
          ask: {
            placeholder: `A folder on ${hostLabel(instanceId)}, by its full path`,
            submit: (path) =>
              void window.agbrte.grants.add(instanceId, path).catch((err: unknown) =>
                setError(err instanceof Error ? err.message : String(err)),
              ),
          },
        },
      ];
      if (held === null) {
        list.push({ id: 'grant:old', label: 'This host is too old to keep folder grants', run: () => undefined });
        return list;
      }
      for (const folder of held) {
        list.push({
          id: `grant:remove:${folder}`,
          label: `Stop letting the agent reach ${folder}`,
          run: () =>
            void window.agbrte.grants.remove(instanceId, folder).catch((err: unknown) =>
              setError(err instanceof Error ? err.message : String(err)),
            ),
        });
      }
      return list;
    },
    [hostLabel],
  );

  /*
   * `agbrte grant` typed in one of this window's tabs (§17 Q24 step 6). The
   * host sent it here and nowhere else, and it grants nothing until somebody
   * presses Allow — the step that keeps the agent, which can run the command
   * but not press the button, from widening its own reach.
   */
  const [granting, setGranting] = useState<GrantRequestDto | null>(null);
  /*
   * One at a time, and the first one stays. A second request replacing an
   * open dialog was a way to change the path under a cursor already on
   * Allow — a harmless folder, then `C:\` a moment later; found by the review
   * of folder grants. A request that arrives meanwhile is dropped, and can be
   * typed again.
   */
  useEffect(() => window.agbrte.on.grantRequest((request) => setGranting((was) => was ?? request)), []);

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
        run: () => undefined,
        then: () => agentChoices(current),
      });
      list.push({
        id: 'grants',
        label: 'Folders the agent may reach…',
        hint: hostLabel(current.instanceId),
        run: () => undefined,
        then: () => grantChoices(current.instanceId),
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
    /*
     * What used to be "the classic view" for all of it. Each is now a sheet
     * over the tabs or a list in this palette, and the one line left that
     * switches views is a session's record, which nothing here draws yet.
     */
    const unread = inbox.filter((e) => e.unread).length;
    list.push(
      {
        id: 'inbox',
        label: 'Inbox…',
        hint: unread > 0 ? `${unread} unread` : 'what happened while you were away',
        run: () => undefined,
        then: inboxChoices,
      },
      {
        id: 'folder',
        label: 'Open a folder in a new tab…',
        hint: 'this machine or one attached',
        run: () => openSheet({ kind: 'folder' }),
      },
      {
        id: 'attach',
        label: 'Attach a machine over ssh…',
        run: () => openSheet({ kind: 'attach' }),
      },
      {
        id: 'search',
        label: 'Search every session…',
        hint: 'what was said and run',
        run: () => openSheet({ kind: 'search' }),
      },
      {
        id: 'workflows',
        label: 'Workflows…',
        hint: 'run, edit, schedule',
        run: () => openSheet({ kind: 'workflows' }),
      },
      {
        id: 'settings',
        label: 'Settings…',
        hint: 'what this client remembers, updates, about',
        run: () => openSheet({ kind: 'settings' }),
      },
    );
    if (current !== null)
      list.push({
        id: 'record',
        label: 'This tab’s session record — transcript, files, agents…',
        hint: 'the classic view',
        run: () => void classicFor(current),
      });
    return list;
  }, [
    ui,
    hosts,
    current,
    tabs,
    sessions,
    onDisk,
    inbox,
    newTab,
    closeTab,
    classicFor,
    openSheet,
    openTab,
    hostLabel,
    reading,
    toggleReading,
    agentChoices,
    grantChoices,
    inboxChoices,
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
      // Not under a sheet: Ctrl+Shift+W would close a tab nobody can see.
      if (ui !== 'terminal' || sheet !== null) return;
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
  }, [ui, sheet, hosts, current, localHost, tabs, activeTab, newTab, closeTab]);

  const showTerminal = ui === 'terminal';

  return (
    <>
      {/* Mounted either way: its subscriptions keep the store current for the tabs. */}
      <div className={showTerminal ? 'hidden' : 'contents'}>
        <App seats={!showTerminal} />
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
          unread={inbox.filter((e) => e.unread).length}
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
        {storeError !== null && (
          <p
            data-testid="terminal-store-error"
            role="alert"
            className="text-state-fail border-line border-b px-4 py-1 text-xs"
          >
            {storeError}{' '}
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => useAgbrte.getState().dismissError()}
            >
              dismiss
            </button>
          </p>
        )}
        {storeNotice !== null && (
          <p data-testid="terminal-notice" className="text-muted border-line border-b px-4 py-1 text-xs">
            {storeNotice}{' '}
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => useAgbrte.getState().dismissNotice()}
            >
              dismiss
            </button>
          </p>
        )}
        <div className="relative min-h-0 flex-1">
          {sheet !== null && (
            <OpenSheet
              sheet={sheet}
              hosts={hosts}
              sessions={sessions}
              update={update}
              conformanceByHost={conformanceByHost}
              runtimesByHost={runtimesByHost}
              seating={seating}
              onClose={closeSheet}
              onOpened={() => setSheet(null)}
              onFolder={() => openSheet({ kind: 'folder' })}
              onGoTo={goTo}
              onRecord={(sessionId, instanceId) => void classicFor({ sessionId, instanceId })}
              onSeat={async (tab, runtimeId, modelId, endpointId) => {
                setSeating(true);
                // Left open on a refusal, with the reason above it: the form
                // is where the next try is made.
                const landed = await seat(tab, runtimeId, modelId, endpointId).finally(() =>
                  setSeating(false),
                );
                if (landed) setSheet(null);
              }}
            />
          )}
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
      {granting !== null && (
        <GrantDialog
          request={granting}
          host={hostLabel(granting.instanceId)}
          onAllow={() => {
            const asked = granting;
            setGranting(null);
            void window.agbrte.grants.add(asked.instanceId, asked.path).catch((err: unknown) =>
              setError(err instanceof Error ? err.message : String(err)),
            );
          }}
          onDeny={() => setGranting(null)}
        />
      )}
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
  unread,
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
  /**
   * Unread inbox entries. The classic sidebar had a badge for them, and a
   * count that only the palette shows is one nobody opens the palette to see.
   */
  unread: number;
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
        {unread > 0 && (
          <span
            data-testid="tab-bar-unread"
            title={`${unread} unread in the inbox`}
            className="bg-accent text-bg ml-2 rounded-full px-2"
          >
            {unread}
          </span>
        )}
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
  /** The second list a command opened, or `null` for the commands themselves. */
  const [inner, setInner] = useState<{ title: string; list: Command[] | null } | null>(null);
  /** A line being typed for a command that asked for one. */
  const [typing, setTyping] = useState<NonNullable<Command['ask']> | null>(null);
  const source = typing !== null ? [] : inner === null ? commands : (inner.list ?? []);
  const shown = source.filter((c) =>
    `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  useEffect(() => input.current?.focus(), []);
  useEffect(() => setAt(0), [query, inner]);
  // Back to the input whenever a level opens: picked with the mouse, the click
  // left focus on the button, and Esc and typing went nowhere.
  useEffect(() => input.current?.focus(), [inner, typing]);
  const run = (c: Command | undefined): void => {
    if (c === undefined) return;
    if (c.ask !== undefined) {
      setTyping(c.ask);
      setQuery('');
      return;
    }
    if (c.then !== undefined) {
      const opened = { title: c.label.replace(/…$/u, ''), list: null };
      setInner(opened);
      setQuery('');
      void c.then().then(
        (list) => setInner((was) => (was === opened ? { ...opened, list } : was)),
        () => setInner((was) => (was === opened ? { ...opened, list: [] } : was)),
      );
      return;
    }
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
          placeholder={
            typing !== null
              ? typing.placeholder
              : inner === null
                ? 'Type a command or a session’s name'
                : `${inner.title} — type to narrow`
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              // Out of the second list first, as a palette backs out a level.
              if (typing !== null) {
                setTyping(null);
                setQuery('');
              } else if (inner !== null) {
                setInner(null);
                setQuery('');
              } else onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((n) => Math.min(shown.length - 1, n + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((n) => Math.max(0, n - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (typing !== null) {
                if (query.trim() === '') return;
                onClose();
                typing.submit(query.trim());
              } else run(shown[at]);
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
          {inner !== null && inner.list === null && (
            <li data-testid="palette-loading" className="text-muted px-3 py-2 text-sm">
              Asking the host…
            </li>
          )}
          {typing !== null && (
            <li className="text-muted px-3 py-2 text-sm">Enter to go on, Esc to go back.</li>
          )}
          {typing === null && shown.length === 0 && (inner === null || inner.list !== null) && (
            <li className="text-muted px-3 py-2 text-sm">Nothing matches.</li>
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * Whether the agent may read and write a folder, asked because `agbrte grant`
 * was typed in a tab. Not Allow by default and not on Enter: the one key a
 * person is most likely to be pressing anyway must not be the one that widens
 * what an agent can touch.
 */
function GrantDialog({
  request,
  host,
  onAllow,
  onDeny,
}: {
  request: GrantRequestDto;
  host: string;
  onAllow: () => void;
  onDeny: () => void;
}): JSX.Element {
  const deny = useRef<HTMLButtonElement>(null);
  useEffect(() => deny.current?.focus(), []);
  /*
   * Allow waits a moment after the dialog appears, so a click already on its
   * way — at whatever the dialog came up over — is not taken as the answer.
   */
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 700);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      data-testid="grant-dialog"
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDeny();
      }}
    >
      <div className="bg-panel border-line w-full max-w-xl border p-4 text-sm">
        <p className="text-ink">Let the agent read and write this folder on {host}?</p>
        <p data-testid="grant-path" className="text-ink my-2 font-mono break-all">
          {request.path}
        </p>
        <p className="text-muted text-xs">
          Asked by <code>agbrte grant</code> in a tab. Every agent on {host} can reach it from its next
          message, until you take it back in the palette (Folders the agent may reach).
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button ref={deny} type="button" data-testid="grant-deny" className="btn-quiet" onClick={onDeny}>
            Not now
          </button>
          <button type="button" data-testid="grant-allow" className="btn" disabled={!armed} onClick={onAllow}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The form a sheet holds (`TerminalSheets.tsx`). Each is the classic view's
 * component as it was; what changes is where it ends — in a tab, not in the
 * classic view's session pane.
 */
function OpenSheet({
  sheet,
  hosts,
  sessions,
  update,
  conformanceByHost,
  runtimesByHost,
  seating,
  onClose,
  onOpened,
  onFolder,
  onGoTo,
  onRecord,
  onSeat,
}: {
  sheet: SheetOpen;
  hosts: HostInfo[];
  sessions: ReturnType<typeof useAgbrte.getState>['sessions'];
  update: UpdateState;
  conformanceByHost: ReturnType<typeof useAgbrte.getState>['conformanceByHost'];
  runtimesByHost: ReturnType<typeof useAgbrte.getState>['runtimesByHost'];
  seating: boolean;
  onClose: () => void;
  /** The folder sheet made or opened a session; `Root` puts it in a tab. */
  onOpened: () => void;
  onFolder: () => void;
  onGoTo: (instanceId: string, sessionId: string, title: string) => void;
  /** A workflow run's record, which has a graph no tab draws. */
  onRecord: (sessionId: string, instanceId: string) => void;
  onSeat: (tab: Tab, runtimeId: string, modelId: string | null, endpointId?: string) => Promise<void>;
}): JSX.Element {
  switch (sheet.kind) {
    case 'settings':
      return (
        <Sheet name="settings" title="Settings" onClose={onClose}>
          <Settings hosts={hosts} update={update} />
        </Sheet>
      );
    case 'workflows':
      return (
        <Sheet name="workflows" title="Workflows" onClose={onClose}>
          <WorkflowsSheet hosts={hosts} sessions={sessions} onClose={onClose} onOpenRun={onRecord} />
        </Sheet>
      );
    case 'search':
      return (
        <Sheet name="search" title="Search every session" onClose={onClose}>
          <div className="mx-auto w-full max-w-2xl p-4">
            <Search
              onOpen={(sessionId, instanceId) =>
                onGoTo(
                  instanceId,
                  sessionId,
                  sessions.find((s) => s.sessionId === sessionId)?.title ?? 'Session',
                )
              }
            />
          </div>
        </Sheet>
      );
    case 'attach':
      return (
        <Sheet name="attach" title="Attach a machine" onClose={onClose}>
          <div className="mx-auto w-full max-w-2xl">
            <AttachHost initialMode="remote" onDone={onClose} onOpenFolder={onFolder} />
          </div>
        </Sheet>
      );
    case 'folder':
      return (
        <Sheet name="folder" title="Open a folder" onClose={onClose}>
          <div className="mx-auto w-full max-w-2xl">
            <NewSession onOpened={onOpened} onClose={onClose} />
          </div>
        </Sheet>
      );
    case 'agent': {
      const { tab } = sheet;
      const host = hosts.find((h) => h.instanceId === tab.instanceId);
      return (
        <Sheet name="agent" title={`The agent for ${tab.title}`} onClose={onClose}>
          <div className="flex min-h-0 min-w-0 grow flex-col" data-testid="picker-scroll">
            <AgentPicker
              runtimes={runtimesByHost[tab.instanceId] ?? []}
              notes={host?.runtimeNotes ?? []}
              conformance={conformanceByHost[tab.instanceId] ?? []}
              endpoints={host?.endpoints ?? []}
              endpointChain={host?.endpointChain ?? []}
              setEndpointChain={(order) => window.agbrte.hosts.setEndpointChain(tab.instanceId, order)}
              listModels={() => window.agbrte.hosts.models(tab.instanceId)}
              checkModel={(endpointId, modelId) =>
                window.agbrte.hosts.modelCapabilities(tab.instanceId, endpointId, modelId)
              }
              installModel={(endpointId, tag) =>
                window.agbrte.hosts.installModel(tab.instanceId, endpointId, tag)
              }
              installProgress={() => window.agbrte.hosts.installProgress(tab.instanceId)}
              machine={machineFor(tab.instanceId, host)}
              onAdd={(runtimeId, modelId, endpointId) => onSeat(tab, runtimeId, modelId, endpointId)}
              submitLabel="Seat in this tab"
              busy={seating}
              say={(notice) => useAgbrte.getState().say(notice)}
            />
          </div>
        </Sheet>
      );
    }
  }
}
