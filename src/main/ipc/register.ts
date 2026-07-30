/**
 * IPC handler registration (DESIGN.md §7).
 *
 * The bridge between the Electron shell and the headless `SessionManager`. All
 * policy, persistence, and orchestration decisions live in the manager; this
 * file only translates.
 *
 * Two rules it enforces:
 *
 * 1. **Every handler is wrapped.** An unhandled rejection in an `ipcMain.handle`
 *    callback reaches the renderer as an opaque `Error invoking remote method`
 *    with the real message buried, so each handler reports failures as a
 *    structured message the UI can display.
 *
 * 2. **Nothing here trusts its arguments.** A renderer is not a security
 *    boundary against itself, but a compromised or buggy one must not be able to
 *    make main throw in a way that takes down the window. Ids arrive as strings
 *    and are used as opaque keys — the manager rejects unknown ones.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  CH,
  DEFAULT_WINDOW,
  PUSH,
  type AddAgentRequest,
  type CreateSessionRequest,
  type EventBatch,
  type RuntimeInfo,
  type SendRequest,
  type SessionSnapshot,
  type WorkspaceInfo,
} from '@shared/ipc/contract.js';
import type {
  AgentId,
  LoomEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
} from '@shared/types/index.js';
import { SessionManager } from '../sessionManager.js';
import { EventBridge } from './eventBridge.js';

export interface IpcDeps {
  manager: SessionManager;
  workspace: WorkspaceInfo;
  /** Called when the user picks a different workspace; the app reloads it. */
  onChooseWorkspace: (root: string) => Promise<WorkspaceInfo>;
  runtimes: () => RuntimeInfo[];
}

/**
 * A failure the renderer can actually render.
 *
 * Electron serializes a thrown `Error` across IPC by name and message only, so
 * `AdmissionRefused.failures` — the list of reasons an agent was refused — is
 * lost. Flattening it into the message keeps the diagnosis reachable.
 */
function describe(err: unknown): Error {
  if (err instanceof Error) {
    const failures = (err as { failures?: ReadonlyArray<{ detail: string }> }).failures;
    if (Array.isArray(failures) && failures.length > 0) {
      return new Error(`${err.message} — ${failures.map((f) => f.detail).join('; ')}`);
    }
    return err;
  }
  return new Error(String(err));
}

export function registerIpc(deps: IpcDeps): { dispose: () => void } {
  let workspace = deps.workspace;
  const { manager } = deps;

  // ------------------------------------------------------------- push channels

  const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of windows()) win.webContents.send(channel, payload);
  };

  const bridge = new EventBridge({
    send: (batch: EventBatch) => broadcast(PUSH.events, batch),
  });

  const onEvent = (sessionId: string, event: LoomEvent): void => bridge.push(sessionId, event);
  const onSession = (session: Session): void => broadcast(PUSH.session, session);
  const onPermission = (request: PermissionRequest): void => broadcast(PUSH.permission, request);

  manager.on('event', onEvent);
  manager.on('session', onSession);
  manager.on('permission', onPermission);

  // ----------------------------------------------------------------- handlers

  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => Promise<R> | R,
  ): void => {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...(args as A));
      } catch (err) {
        throw describe(err);
      }
    });
  };

  handle(CH.workspaceCurrent, () => workspace);

  handle(CH.workspaceChoose, async () => {
    const win = windows()[0];
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Choose a workspace folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    const root = result.filePaths[0];
    if (result.canceled || root === undefined) return null;

    workspace = await deps.onChooseWorkspace(root);
    return workspace;
  });

  handle(CH.runtimesList, () => deps.runtimes());

  handle(CH.sessionsList, () => manager.list());

  handle(CH.sessionsCreate, (r: CreateSessionRequest) =>
    manager.createSession({ title: r.title, goal: r.goal }),
  );

  handle(CH.sessionsListOnDisk, () => manager.listOnDisk());

  handle(CH.sessionsResume, (sessionId: string) => manager.resumeSession(sessionId as SessionId));

  handle(CH.sessionsSnapshot, async (sessionId: string, windowSize?: number) => {
    const id = sessionId as SessionId;
    const projection = await manager.projection(id);
    const size = windowSize ?? DEFAULT_WINDOW;
    const all = await manager.events(id);
    // A window over the tail, never the whole log (§7). A week-long session
    // must not become a renderer-side heap problem.
    const recent = all.slice(-size);
    const snapshot: SessionSnapshot = {
      session: manager.get(id),
      projection,
      recent,
      windowFromSeq: recent[0]?.seq ?? 0,
    };
    return snapshot;
  });

  handle(CH.sessionsAddAgent, (r: AddAgentRequest) =>
    manager.addAgent(r.sessionId as SessionId, {
      role: r.role,
      runtimeId: r.runtimeId,
      ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.maxTurns !== undefined ? { limits: { maxTurns: r.maxTurns } } : {}),
    }),
  );

  handle(CH.sessionsSend, (r: SendRequest) =>
    manager.send(r.sessionId as SessionId, r.agentId as AgentId, {
      content: [{ type: 'text', text: r.text }],
    }),
  );

  handle(CH.sessionsInterrupt, (sessionId: string, agentId?: string) =>
    manager.interrupt(sessionId as SessionId, agentId as AgentId | undefined),
  );

  handle(CH.sessionsSince, (sessionId: string, fromSeq: number) =>
    manager.events(sessionId as SessionId, fromSeq),
  );

  handle(CH.permissionsPending, () => manager.pendingPermissions());

  handle(CH.permissionsRespond, (requestId: string, decision: PermissionDecision) =>
    manager.respondPermission(requestId, decision),
  );

  // `send`, not `handle`: an ack has no reply, and making the renderer await one
  // per batch would serialize rendering behind the IPC round trip.
  ipcMain.on(CH.ack, (_e, sessionId: string, seq: number) => bridge.ack(sessionId, seq));

  return {
    dispose: () => {
      manager.off('event', onEvent);
      manager.off('session', onSession);
      manager.off('permission', onPermission);
      bridge.releaseAll();
      for (const channel of Object.values(CH)) ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(CH.ack);
    },
  };
}
