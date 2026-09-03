/**
 * `window.agbrte`, over a WebSocket (DESIGN.md §7, §17 Q13).
 *
 * The preload's counterpart. Electron's version forwards each method to
 * `ipcRenderer.invoke`; this one forwards to a socket. Both are the same shape
 * because both implement one interface, which is the entire reason the renderer
 * did not have to change to run in a browser.
 *
 * ## Calls are queued, not failed, while the socket is down
 *
 * A phone sleeps, a train enters a tunnel, wifi hands over. Rejecting every call
 * the moment the socket drops would make the UI feel broken for the several
 * seconds it takes to come back, and the *session* is not affected at all —
 * it is on the server, still running. So calls wait for the socket, the socket
 * reconnects on its own, and only the wait is visible.
 *
 * That is the same reasoning the main process applies to a dropped host link,
 * arrived at independently at a different layer: losing a connection is not
 * losing the work.
 */

import type { AgbrteApi } from '../shared/ipc/contract.js';
import { CH, PUSH } from '../shared/ipc/contract.js';
import { askForHost, dismissAsk, reportAskFailure } from './askForHost.js';
import { resolveHost, socketUrl, type HostAddress } from './hostAddress.js';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/** Where the address is remembered, so a reload does not need the link again. */
const ADDRESS_KEY = 'agbrte:host';

/**
 * The origin `agbrte web` stamped on the tag that loaded this file.
 *
 * Read from the script element rather than from an inline script, because the
 * page's CSP is `script-src 'self'` — an inline one would be blocked, and
 * loosening the policy to pass a single string is the wrong trade. Read
 * *synchronously*, because `document.currentScript` is only this tag while this
 * file is executing.
 *
 * Absent means the page was not served by a host: static hosting, an opened
 * file, anything that is not `agbrte web`. That is a real state and not an
 * error — it is what a published copy of this app looks like before somebody
 * says where their host is.
 */
const SERVED_BY = document.currentScript?.getAttribute('data-agbrte-host') ?? undefined;

/**
 * The address, out of the link and then out of the way.
 *
 * The token arrives in the **fragment** (`#t=…`), which is the one part of a URL
 * a browser never sends anywhere: not to the server, not into an access log, not
 * in a `Referer` to whatever the page links to next. A query string would have
 * been in the host's own log the first time anybody opened the page. `#h=` rides
 * beside it so a host can hand out one string that names itself and admits the
 * bearer.
 *
 * Stripped from the address bar once read, so a screenshot or a shoulder does
 * not carry it.
 *
 * ## Where it is kept, and why that differs by case
 *
 * A page **served by a host** keeps the token in `sessionStorage`: per tab, gone
 * with the tab. The address is not worth keeping — it is wherever the page came
 * from, every time.
 *
 * A **published** page has to keep the pair in `localStorage`, or the second
 * visit is the first visit again and the person is back at the terminal for a
 * link they already used. That is a credential living longer than a tab, which
 * is a real cost and the honest one to pay here: the alternative is a client
 * nobody can bookmark. It is scoped to the page's own origin, cleared by
 * `disconnect`, and never sent anywhere but to the host it names.
 */
function readAddress(): HostAddress | null {
  const store = SERVED_BY === undefined ? localStorage : sessionStorage;
  let stored: HostAddress | undefined;
  try {
    const raw = store.getItem(ADDRESS_KEY);
    if (raw !== null) stored = JSON.parse(raw) as HostAddress;
  } catch {
    // Unreadable or refused. Treated as nothing remembered, which lands the
    // visitor on the same screen a first visit gets.
  }

  const resolved = resolveHost({
    served: SERVED_BY,
    hash: location.hash,
    ...(stored !== undefined ? { stored } : {}),
  });
  if (resolved === null) return null;

  try {
    // The pair, always. Storing a token without the origin that minted it is
    // what would let one host's credential be offered to another.
    store.setItem(ADDRESS_KEY, JSON.stringify(resolved));
    if (location.hash !== '') history.replaceState(null, '', location.pathname + location.search);
  } catch {
    // A browser that refuses storage still works for this tab; only a reload
    // would send the person back to the link.
  }
  return resolved;
}

/** What `window.agbrte` forwards through: one socket, reconnecting on its own. */
type Link = {
  call: (channel: string, args: unknown[]) => Promise<unknown>;
  fire: (channel: string, args: unknown[]) => void;
  on: (push: string, cb: (payload: unknown) => void) => () => void;
};

function connect(): Link {
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const outbox: string[] = [];
  let socket: WebSocket | null = null;
  let nextId = 0;
  let backoff = 250;
  /** Whether this socket has been through the handshake yet. */
  let admitted = false;
  const open = (): void => {
    /*
     * Resolved on every attempt rather than once at boot.
     *
     * A page that started with no host — a published copy, before anybody said
     * where theirs is — has to become one that has a host without a reload, and
     * the reconnect loop is already the thing that runs when there is nothing to
     * talk to. So `connect` waits here instead of failing, and the screen below
     * fills the gap in by writing the address and letting this find it.
     */
    const address = readAddress();
    if (address === null) {
      askForHost(() => open());
      return;
    }
    const next = new WebSocket(socketUrl(address));
    socket = next;

    next.onopen = () => {
      backoff = 250;
      dismissAsk();
      /*
       * The token first, and nothing else until it is acknowledged.
       *
       * §6.2's handshake, which the host's own control channel already speaks:
       * the server wires no API to this socket until a frame proves who is on
       * it. Flushing the outbox here instead would send every queued call into
       * a connection that is about to be closed.
       */
      admitted = false;
      next.send(JSON.stringify({ t: 'auth', token: address.token }));
    };
    next.onmessage = (e: MessageEvent) => {
      const message = JSON.parse(String(e.data)) as {
        t?: string;
        id?: number;
        value?: unknown;
        error?: string;
        push?: string;
        payload?: unknown;
      };
      if (!admitted) {
        // Anything before the acknowledgement is not ours to read.
        if (message.t !== 'auth-ok') return;
        admitted = true;
        for (const frame of outbox.splice(0)) next.send(frame);
        return;
      }
      if (message.push !== undefined) {
        for (const cb of listeners.get(message.push) ?? []) cb(message.payload);
        return;
      }
      if (message.id === undefined) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error !== undefined) waiter?.reject(new Error(message.error));
      else waiter?.resolve(message.value);
    };
    next.onclose = () => {
      socket = null;
      // In-flight calls fail rather than hang: their replies are gone with the
      // socket. Anything queued but unsent still goes on the next one.
      for (const [, waiter] of pending) waiter.reject(new Error('lost the connection'));
      pending.clear();

      /*
       * An address that never worked is a different thing from a link that
       * dropped, and only the first is worth interrupting somebody about.
       *
       * `admitted` is the test: a socket that opened and was refused, or never
       * opened at all, has not proved the address. On a **published** page that
       * means the person typed something this cannot reach, and silently
       * retrying it forever would leave them looking at an empty app with no
       * hint and no field. On a page a host served, the address cannot be wrong
       * — that case keeps the old behaviour, which is to wait for the host to
       * come back.
       */
      if (!admitted && SERVED_BY === undefined) {
        askForHost(() => open());
        reportAskFailure();
      }

      setTimeout(open, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    };
    next.onerror = () => next.close();
  };

  open();

  const send = (frame: string): void => {
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(frame);
    else outbox.push(frame);
  };

  return {
    call: (channel, args) =>
      new Promise((resolve, reject) => {
        const id = (nextId += 1);
        pending.set(id, { resolve, reject });
        send(JSON.stringify({ id, channel, args }));
      }),
    fire: (channel, args) => send(JSON.stringify({ channel, args })),
    on: (push, cb) => {
      const set = listeners.get(push) ?? new Set();
      set.add(cb);
      listeners.set(push, set);
      return () => set.delete(cb);
    },
  };
}

const link = connect();

const call =
  (channel: string) =>
  (...args: unknown[]): Promise<never> =>
    link.call(channel, args) as Promise<never>;

const api: AgbrteApi = {
  hosts: {
    list: call(CH.hostsList),
    add: call(CH.hostsAdd),
    pickFolder: call(CH.hostsPickFolder),
    sshHosts: call(CH.hostsSsh),
    discoverWorkspaces: call(CH.hostsDiscover),
    addRemote: call(CH.hostsAddRemote),
    restoring: call(CH.hostsRestoring),
    remove: call(CH.hostsRemove),
    shutdown: call(CH.hostsShutdown),
    runtimes: call(CH.hostsRuntimes),
    conformance: call(CH.hostsConformance),
    update: call(CH.hostsUpdate),
    models: call(CH.hostsModels),
    modelCapabilities: call(CH.hostsModelCapabilities),
    installModel: call(CH.hostsInstallModel),
    installProgress: call(CH.hostsInstallProgress),
    setUp: call(CH.hostsSetUp),
    serverReadiness: call(CH.hostsServerReadiness),
    setEndpointChain: call(CH.hostsSetEndpointChain),
  },

  // Routed to the server: what the About page describes is the program serving
  // this page, and the server is the only side that knows what it is running.
  app: {
    about: call(CH.appAbout),
  },

  /*
   * A browser cannot update the application it is looking at.
   *
   * `agbrte web` serves this page from a machine somewhere; the thing that would
   * need replacing is the program on *that* machine, and a tab has no standing
   * to close it. Reported as unsupported with the reason rather than left
   * missing, so the renderer shows one sentence instead of a control that fails.
   *
   * Host updates are a different question and do work from here — those restart
   * a session host, which is exactly the kind of thing a remote client is for.
   */
  update: {
    state: () =>
      Promise.resolve({
        phase: 'unsupported' as const,
        reason:
          'this is the web client; the desktop application updates itself on the machine it runs on',
      }),
    installNow: () => Promise.resolve(),
  },
  inbox: {
    list: call(CH.inboxList),
    markRead: call(CH.inboxMarkRead),
  },
  workflows: {
    list: call(CH.workflowsList),
    save: (instanceId, workflowId, workflow) =>
      call(CH.workflowsSave)({ instanceId, workflowId, workflow }),
  },
  /**
   * Routed to the server like everything else, which is what makes the honest
   * answer possible (§12.1).
   *
   * The server has no screen backend when it is serving a browser, so
   * `sources` comes back empty and `grab` comes back with a sentence naming the
   * remedy. Short-circuiting here instead would have been one line shorter and
   * would have put the refusal in two places — and the browser is not the only
   * client that can reach a screenless host.
   */
  capture: {
    sources: call(CH.captureSources),
    grab: call(CH.captureGrab),
    region: call(CH.captureRegion),
    preview: call(CH.capturePreview),
    commit: call(CH.captureCommit),
    discard: call(CH.captureDiscard),
  },
  voice: {
    status: call(CH.voiceStatus),
    transcribe: call(CH.voiceTranscribe),
    clips: call(CH.voiceClips),
    forget: call(CH.voiceForget),
    speak: call(CH.voiceSpeak),
    stopSpeaking: call(CH.voiceStopSpeaking),
  },
  /**
   * Routed like everything else, and the server has no `previews` to route it
   * to — `preview.open` says so and `preview.list` answers empty. The refusal
   * lives on the server rather than here because the browser cannot be trusted
   * to know what the server is holding, and because a method that exists and
   * explains itself beats one that is silently absent.
   */
  templates: {
    list: call(CH.templatesList),
    save: call(CH.templatesSave),
    apply: call(CH.templatesApply),
    remove: call(CH.templatesDelete),
  },
  preview: {
    detect: call(CH.previewDetect),
    servers: call(CH.previewServers),
    start: call(CH.previewStart),
    stopServer: call(CH.previewStopServer),
    serverLog: call(CH.previewServerLog),
    open: call(CH.previewOpen),
    list: call(CH.previewList),
    close: call(CH.previewClose),
    recheck: call(CH.previewRecheck),
  },
  /*
   * Routed to the server like everything else, which is what makes a browser
   * see the same workspace the desktop app does — the host answers, and the
   * host is where the files are either way (§8.1).
   */
  files: {
    list: call(CH.filesList),
    read: call(CH.filesRead),
  },
  sessions: {
    list: call(CH.sessionsList),
    create: call(CH.sessionsCreate),
    respondSplit: call(CH.sessionsRespondSplit),
    group: call(CH.sessionsGroup),
    ungroup: call(CH.sessionsUngroup),
    rename: call(CH.sessionsRename),
    attachMcp: call(CH.sessionsAttachMcp),
    setReasoning: call(CH.sessionsSetReasoning),
    blob: call(CH.sessionsBlob),
    listOnDisk: call(CH.sessionsListOnDisk),
    resume: call(CH.sessionsResume),
    snapshot: call(CH.sessionsSnapshot),
    addAgent: call(CH.sessionsAddAgent),
    send: call(CH.sessionsSend),
    interrupt: call(CH.sessionsInterrupt),
    since: call(CH.sessionsSince),
    exportMarkdown: call(CH.sessionsExport),
    search: call(CH.sessionsSearch),
    rawLog: call(CH.sessionsRawLog),
  },
  /**
   * The user's own terminal, routed like everything else (§7).
   *
   * Which means a phone gets a real shell on the machine `agbrte web` is
   * serving from, and that is worth stating rather than sliding past. The token
   * on the socket says *who is admitted*, not *what they may do*; what makes
   * this defensible is that a `read-write` web client can already start an agent with
   * a shell tool on that same machine and answer its own permission prompt from
   * the same screen. This is a shorter path to reach a person already has, not a
   * new one — and it is refused in exactly the places the desktop client is
   * refused: the host declines a `read-only` client (which is what
   * `.agbrte/access.json` exists to pin a phone to), and the fleet declines a
   * remote host by name. Putting either refusal here instead would be a second
   * copy that can disagree with the authoritative one.
   *
   * Unlike `preview.open`, this is *not* excluded by type. That exclusion exists
   * because a forward hands back a `127.0.0.1` URL naming the wrong computer; a
   * terminal on the host is the machine the browser actually wants.
   */
  shell: {
    open: call(CH.shellOpen),
    write: call(CH.shellWrite),
    resize: call(CH.shellResize),
    close: call(CH.shellClose),
  },
  permissions: {
    pending: call(CH.permissionsPending),
    respond: call(CH.permissionsRespond),
  },
  // One-way, exactly as in the preload: an ack has no reply, and awaiting one
  // per batch would serialize rendering behind the round trip.
  ack: (sessionId: string, seq: number) => link.fire(CH.ack, [sessionId, seq]),
  on: {
    events: (cb) => link.on(PUSH.events, cb as (p: unknown) => void),
    session: (cb) => link.on(PUSH.session, cb as (p: unknown) => void),
    permission: (cb) => link.on(PUSH.permission, cb as (p: unknown) => void),
    permissionResolved: (cb) => link.on(PUSH.permissionResolved, cb as (p: unknown) => void),
    hosts: (cb) => link.on(PUSH.hosts, cb as (p: unknown) => void),
    setup: (cb) => link.on(PUSH.setup, cb as (p: unknown) => void),
    shell: (cb) => link.on(PUSH.shell, cb as (p: unknown) => void),
    shellExit: (cb) => link.on(PUSH.shellExit, cb as (p: unknown) => void),
    // Never pushed to a browser: there is no updater on this side. A no-op
    // unsubscribe rather than an absent method, so the renderer's cleanup is
    // the same shape everywhere.
    update: () => () => undefined,
  },
};

(globalThis as unknown as { agbrte: AgbrteApi }).agbrte = api;
