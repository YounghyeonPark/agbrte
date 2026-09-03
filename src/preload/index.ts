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
  type ServerKind,
  type SetupPlanDto,
  type SetupProgressDto,
  type ShellChunk,
  type ShellExitDto,
  type UpdateState,
} from '../shared/ipc/contract.js';
import type { ReasoningMode } from '../shared/ipc/contract.js';
import type { Workflow } from '../shared/types/index.js';
import type {
  McpServerConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionResolved,
  Session,
  ShellProgram,
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
    add: (root?: string) => ipcRenderer.invoke(CH.hostsAdd, root),
    pickFolder: () => ipcRenderer.invoke(CH.hostsPickFolder),
    remove: (instanceId: string) => ipcRenderer.invoke(CH.hostsRemove, instanceId),
    shutdown: (instanceId: string) => ipcRenderer.invoke(CH.hostsShutdown, instanceId),
    runtimes: (instanceId: string) => ipcRenderer.invoke(CH.hostsRuntimes, instanceId),
    conformance: (instanceId: string) => ipcRenderer.invoke(CH.hostsConformance, instanceId),
    sshHosts: () => ipcRenderer.invoke(CH.hostsSsh),
    discoverWorkspaces: (alias: string) => ipcRenderer.invoke(CH.hostsDiscover, alias),
    addRemote: (alias: string, workspaceRoot: string) =>
      ipcRenderer.invoke(CH.hostsAddRemote, alias, workspaceRoot),
    restoring: () => ipcRenderer.invoke(CH.hostsRestoring),
    update: (instanceId: string) => ipcRenderer.invoke(CH.hostsUpdate, instanceId),
    models: (instanceId: string) => ipcRenderer.invoke(CH.hostsModels, instanceId),
    modelCapabilities: (instanceId: string, endpointId: string, modelId: string) =>
      ipcRenderer.invoke(CH.hostsModelCapabilities, instanceId, endpointId, modelId),
    installModel: (instanceId: string, endpointId: string, tag: string) =>
      ipcRenderer.invoke(CH.hostsInstallModel, instanceId, endpointId, tag),
    installProgress: (instanceId: string) => ipcRenderer.invoke(CH.hostsInstallProgress, instanceId),
    setUp: (instanceId: string, plan: SetupPlanDto) =>
      ipcRenderer.invoke(CH.hostsSetUp, instanceId, plan),
    serverReadiness: (instanceId: string, server: ServerKind) =>
      ipcRenderer.invoke(CH.hostsServerReadiness, instanceId, server),
    setEndpointChain: (instanceId: string, order: string[]) =>
      ipcRenderer.invoke(CH.hostsSetEndpointChain, instanceId, order),
  },
  app: {
    about: () => ipcRenderer.invoke(CH.appAbout),
  },
  update: {
    state: () => ipcRenderer.invoke(CH.updateState),
    installNow: () => ipcRenderer.invoke(CH.updateInstall),
  },
  inbox: {
    list: (limit?: number) => ipcRenderer.invoke(CH.inboxList, limit),
    markRead: () => ipcRenderer.invoke(CH.inboxMarkRead),
  },
  workflows: {
    list: (instanceId: string) => ipcRenderer.invoke(CH.workflowsList, instanceId),
    save: (instanceId: string, workflowId: string, workflow: Workflow) =>
      ipcRenderer.invoke(CH.workflowsSave, { instanceId, workflowId, workflow }),
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
  /*
   * The workspace, seen from the machine that owns it (§7).
   *
   * Two methods, both reads, neither generic. There is no `readAbsolute`, no
   * `write`, no `delete` and no path that means anything outside a workspace the
   * renderer already has attached — so the widest request expressible through
   * this surface is "list or show me something under a root you already opened",
   * and the host refuses anything that resolves outside it. A general
   * `fs.read(path)` would have been fewer lines and would have handed a
   * sandboxed renderer the filesystem of a build box.
   */
  files: {
    list: (r: { instanceId: string; path: string; limit?: number }) =>
      ipcRenderer.invoke(CH.filesList, r),
    read: (r: { instanceId: string; path: string }) => ipcRenderer.invoke(CH.filesRead, r),
  },
  sessions: {
    list: () => ipcRenderer.invoke(CH.sessionsList),
    create: (r: CreateSessionRequest) => ipcRenderer.invoke(CH.sessionsCreate, r),
    respondSplit: (
      sessionId: string,
      proposalId: string,
      decision: { approved: boolean; reason?: string },
    ) => ipcRenderer.invoke(CH.sessionsRespondSplit, sessionId, proposalId, decision),
    group: (sessionIds: string[], name: string, groupId?: string) =>
      ipcRenderer.invoke(CH.sessionsGroup, sessionIds, name, groupId),
    ungroup: (sessionId: string) => ipcRenderer.invoke(CH.sessionsUngroup, sessionId),
    rename: (sessionId: string, title: string) =>
      ipcRenderer.invoke(CH.sessionsRename, sessionId, title),
    attachMcp: (sessionId: string, config: McpServerConfig) =>
      ipcRenderer.invoke(CH.sessionsAttachMcp, sessionId, config),
    listOnDisk: () => ipcRenderer.invoke(CH.sessionsListOnDisk),
    resume: (instanceId: string, sessionId: string) =>
      ipcRenderer.invoke(CH.sessionsResume, instanceId, sessionId),
    snapshot: (sessionId: string, windowSize?: number) =>
      ipcRenderer.invoke(CH.sessionsSnapshot, sessionId, windowSize),
    addAgent: (r: AddAgentRequest) => ipcRenderer.invoke(CH.sessionsAddAgent, r),
    send: (r: SendRequest) => ipcRenderer.invoke(CH.sessionsSend, r),
    interrupt: (sessionId: string, agentId?: string) =>
      ipcRenderer.invoke(CH.sessionsInterrupt, sessionId, agentId),
    setReasoning: (sessionId: string, agentId: string, mode: ReasoningMode) =>
      ipcRenderer.invoke(CH.sessionsSetReasoning, sessionId, agentId, mode),
    blob: (sessionId: string, sha256: string, mime?: string) =>
      ipcRenderer.invoke(CH.sessionsBlob, sessionId, sha256, mime),
    exportMarkdown: (sessionId: string, opts?: { toolArgs?: 'full' | 'summary' }) =>
      ipcRenderer.invoke(CH.sessionsExport, sessionId, opts),
    search: (query: string, limit?: number) => ipcRenderer.invoke(CH.sessionsSearch, query, limit),
    rawLog: (sessionId: string, agentId: string) =>
      ipcRenderer.invoke(CH.sessionsRawLog, sessionId, agentId),
    since: (sessionId: string, fromSeq: number) =>
      ipcRenderer.invoke(CH.sessionsSince, sessionId, fromSeq),
  },
  /*
   * The user's own terminal (§7).
   *
   * Four methods, each purpose-specific, none of them generic: there is no
   * `exec`, no path, and no argv here, because a method that took one would let
   * the renderer widen its own reach through an API that only looks like a
   * terminal. `program` is the single thing the renderer chooses and it is a
   * selector over a set the *host* defines — a `cliId` it detected, or the shell
   * — so the widest thing sayable through this method is "the CLI you already
   * offer me as a runtime, started the way a person would start it". What
   * crosses back is an opaque `shellId` and bytes.
   */
  shell: {
    open: (r: {
      instanceId: string;
      sessionId: string;
      program?: ShellProgram;
      cols?: number;
      rows?: number;
    }) => ipcRenderer.invoke(CH.shellOpen, r),
    write: (shellId: string, data: string) => ipcRenderer.invoke(CH.shellWrite, shellId, data),
    resize: (shellId: string, cols: number, rows: number) =>
      ipcRenderer.invoke(CH.shellResize, shellId, cols, rows),
    close: (shellId: string) => ipcRenderer.invoke(CH.shellClose, shellId),
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
    setup: (cb: (p: SetupProgressDto) => void) => subscribe(PUSH.setup, cb),
    update: (cb: (s: UpdateState) => void) => subscribe(PUSH.update, cb),
    // Its own channel, never `events`. Terminal bytes are not durable, are
    // never acked, and must not be delayed by a batch window a person can feel.
    shell: (cb: (c: ShellChunk) => void) => subscribe(PUSH.shell, cb),
    shellExit: (cb: (e: ShellExitDto) => void) => subscribe(PUSH.shellExit, cb),
  },
  ack: (sessionId: string, seq: number) => ipcRenderer.send(CH.ack, sessionId, seq),
};

contextBridge.exposeInMainWorld('agbrte', api);
