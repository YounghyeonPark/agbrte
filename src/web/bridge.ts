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

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

function connect(): {
  call: (channel: string, args: unknown[]) => Promise<unknown>;
  fire: (channel: string, args: unknown[]) => void;
  on: (push: string, cb: (payload: unknown) => void) => () => void;
} {
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const outbox: string[] = [];
  let socket: WebSocket | null = null;
  let nextId = 0;
  let backoff = 250;

  const open = (): void => {
    const url = new URL('/__agbrte/socket', location.href);
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const next = new WebSocket(url);
    socket = next;

    next.onopen = () => {
      backoff = 250;
      for (const frame of outbox.splice(0)) next.send(frame);
    };
    next.onmessage = (e: MessageEvent) => {
      const message = JSON.parse(String(e.data)) as {
        id?: number;
        value?: unknown;
        error?: string;
        push?: string;
        payload?: unknown;
      };
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
    sshHosts: call(CH.hostsSsh),
    addRemote: call(CH.hostsAddRemote),
    remove: call(CH.hostsRemove),
    shutdown: call(CH.hostsShutdown),
    runtimes: call(CH.hostsRuntimes),
    conformance: call(CH.hostsConformance),
    update: call(CH.hostsUpdate),
    models: call(CH.hostsModels),
    installModel: call(CH.hostsInstallModel),
    installProgress: call(CH.hostsInstallProgress),
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
  sessions: {
    list: call(CH.sessionsList),
    create: call(CH.sessionsCreate),
    respondSplit: call(CH.sessionsRespondSplit),
    setReasoning: call(CH.sessionsSetReasoning),
    listOnDisk: call(CH.sessionsListOnDisk),
    resume: call(CH.sessionsResume),
    snapshot: call(CH.sessionsSnapshot),
    addAgent: call(CH.sessionsAddAgent),
    send: call(CH.sessionsSend),
    interrupt: call(CH.sessionsInterrupt),
    since: call(CH.sessionsSince),
    exportMarkdown: call(CH.sessionsExport),
    search: call(CH.sessionsSearch),
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
    // Never pushed to a browser: there is no updater on this side. A no-op
    // unsubscribe rather than an absent method, so the renderer's cleanup is
    // the same shape everywhere.
    update: () => () => undefined,
  },
};

(globalThis as unknown as { agbrte: AgbrteApi }).agbrte = api;
