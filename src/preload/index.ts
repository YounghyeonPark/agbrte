/**
 * Preload (DESIGN.md §7).
 *
 * The entire privileged surface the renderer gets. `contextBridge` deep-clones
 * across the boundary, so nothing here can hand the renderer a live reference
 * into main — only data and these functions.
 *
 * Two properties worth stating because they are easy to lose in a later edit:
 *
 *  - **`ipcRenderer` is never exposed, directly or wrapped.** Exposing even a
 *    constrained `invoke(channel, ...)` would let the renderer reach any channel
 *    main registers, which defeats the point of enumerating them.
 *
 *  - **Every subscription returns an unsubscribe.** A React effect that cannot
 *    remove its listener leaks one per remount, and the symptom is duplicated
 *    events rather than a crash — which is much harder to notice.
 *
 * Built as CommonJS: a sandboxed preload is not an ES module.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  CH,
  PUSH,
  type AddAgentRequest,
  type CaptureCommitDto,
  type CaptureRequestDto,
  type CreateSessionRequest,
  type EventBatch,
  type HostInfo,
  type AgbrteApi,
  type SendRequest,
} from '../shared/ipc/contract.js';
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionResolved,
  Session,
} from '../shared/types/index.js';

/** Wire one push channel to a callback, returning its unsubscribe. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: AgbrteApi = {
  hosts: {
    list: () => ipcRenderer.invoke(CH.hostsList),
    add: () => ipcRenderer.invoke(CH.hostsAdd),
    remove: (instanceId: string) => ipcRenderer.invoke(CH.hostsRemove, instanceId),
    shutdown: (instanceId: string) => ipcRenderer.invoke(CH.hostsShutdown, instanceId),
    runtimes: (instanceId: string) => ipcRenderer.invoke(CH.hostsRuntimes, instanceId),
    conformance: (instanceId: string) => ipcRenderer.invoke(CH.hostsConformance, instanceId),
    sshHosts: () => ipcRenderer.invoke(CH.hostsSsh),
    addRemote: (alias: string, workspaceRoot: string) =>
      ipcRenderer.invoke(CH.hostsAddRemote, alias, workspaceRoot),
  },
  inbox: {
    list: (limit?: number) => ipcRenderer.invoke(CH.inboxList, limit),
    markRead: () => ipcRenderer.invoke(CH.inboxMarkRead),
  },
  capture: {
    sources: () => ipcRenderer.invoke(CH.captureSources),
    grab: (r: CaptureRequestDto) => ipcRenderer.invoke(CH.captureGrab, r),
    region: (sessionId: string) => ipcRenderer.invoke(CH.captureRegion, sessionId),
    preview: (r: Parameters<AgbrteApi['capture']['preview']>[0]) =>
      ipcRenderer.invoke(CH.capturePreview, r),
    commit: (r: CaptureCommitDto) => ipcRenderer.invoke(CH.captureCommit, r),
    discard: (pendingId: string) => ipcRenderer.invoke(CH.captureDiscard, pendingId),
  },
  voice: {
    status: () => ipcRenderer.invoke(CH.voiceStatus),
    transcribe: (r: { wavBase64: string; sessionId: string; locale?: string }) =>
      ipcRenderer.invoke(CH.voiceTranscribe, r),
    clips: (sessionId?: string) => ipcRenderer.invoke(CH.voiceClips, sessionId),
    forget: (sha256: string) => ipcRenderer.invoke(CH.voiceForget, sha256),
    speak: (text: string) => ipcRenderer.invoke(CH.voiceSpeak, text),
    stopSpeaking: () => ipcRenderer.invoke(CH.voiceStopSpeaking),
  },
  templates: {
    list: (instanceId: string) => ipcRenderer.invoke(CH.templatesList, instanceId),
    save: (r: { instanceId: string; sessionId: string; name: string }) =>
      ipcRenderer.invoke(CH.templatesSave, r),
    apply: (r: { instanceId: string; templateId: string; title?: string }) =>
      ipcRenderer.invoke(CH.templatesApply, r),
    remove: (r: { instanceId: string; templateId: string }) =>
      ipcRenderer.invoke(CH.templatesDelete, r),
  },
  preview: {
    detect: (instanceId: string) => ipcRenderer.invoke(CH.previewDetect, instanceId),
    servers: (r: { instanceId: string; sessionId?: string }) =>
      ipcRenderer.invoke(CH.previewServers, r),
    start: (r: { instanceId: string; sessionId: string; command: string }) =>
      ipcRenderer.invoke(CH.previewStart, r),
    stopServer: (r: { instanceId: string; serverId: string }) =>
      ipcRenderer.invoke(CH.previewStopServer, r),
    serverLog: (r: { instanceId: string; serverId: string }) =>
      ipcRenderer.invoke(CH.previewServerLog, r),
    open: (r: { instanceId: string; sessionId: string; port: number }) =>
      ipcRenderer.invoke(CH.previewOpen, r),
    list: (sessionId: string) => ipcRenderer.invoke(CH.previewList, sessionId),
    close: (r: { sessionId: string; port: number }) => ipcRenderer.invoke(CH.previewClose, r),
    recheck: (r: { sessionId: string; port: number }) => ipcRenderer.invoke(CH.previewRecheck, r),
  },
  sessions: {
    list: () => ipcRenderer.invoke(CH.sessionsList),
    create: (r: CreateSessionRequest) => ipcRenderer.invoke(CH.sessionsCreate, r),
    respondSplit: (
      sessionId: string,
      proposalId: string,
      decision: { approved: boolean; reason?: string },
    ) => ipcRenderer.invoke(CH.sessionsRespondSplit, sessionId, proposalId, decision),
    listOnDisk: () => ipcRenderer.invoke(CH.sessionsListOnDisk),
    resume: (instanceId: string, sessionId: string) =>
      ipcRenderer.invoke(CH.sessionsResume, instanceId, sessionId),
    snapshot: (sessionId: string, windowSize?: number) =>
      ipcRenderer.invoke(CH.sessionsSnapshot, sessionId, windowSize),
    addAgent: (r: AddAgentRequest) => ipcRenderer.invoke(CH.sessionsAddAgent, r),
    send: (r: SendRequest) => ipcRenderer.invoke(CH.sessionsSend, r),
    interrupt: (sessionId: string, agentId?: string) =>
      ipcRenderer.invoke(CH.sessionsInterrupt, sessionId, agentId),
    exportMarkdown: (sessionId: string, opts?: { toolArgs?: 'full' | 'summary' }) =>
      ipcRenderer.invoke(CH.sessionsExport, sessionId, opts),
    search: (query: string, limit?: number) => ipcRenderer.invoke(CH.sessionsSearch, query, limit),
    since: (sessionId: string, fromSeq: number) =>
      ipcRenderer.invoke(CH.sessionsSince, sessionId, fromSeq),
  },
  permissions: {
    pending: () => ipcRenderer.invoke(CH.permissionsPending),
    respond: (requestId: string, decision: PermissionDecision) =>
      ipcRenderer.invoke(CH.permissionsRespond, requestId, decision),
  },
  on: {
    events: (cb: (b: EventBatch) => void) => subscribe(PUSH.events, cb),
    session: (cb: (s: Session) => void) => subscribe(PUSH.session, cb),
    permission: (cb: (r: PermissionRequest) => void) => subscribe(PUSH.permission, cb),
    permissionResolved: (cb: (r: PermissionResolved) => void) =>
      subscribe(PUSH.permissionResolved, cb),
    hosts: (cb: (h: HostInfo[]) => void) => subscribe(PUSH.hosts, cb),
  },
  ack: (sessionId: string, seq: number) => ipcRenderer.send(CH.ack, sessionId, seq),
};

contextBridge.exposeInMainWorld('agbrte', api);
