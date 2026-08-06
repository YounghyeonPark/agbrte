/**
 * IPC handler registration (DESIGN.md §7).
 *
 * The bridge between the Electron shell and the headless core. All policy,
 * persistence, and orchestration decisions live in `SessionManager`; routing
 * between hosts lives in `Fleet`; this file only translates.
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
 *    and are used as opaque keys — the fleet rejects unknown ones.
 *
 * Registered once for the life of the app rather than per workspace: with a
 * fleet, attaching a host is no longer a reason to rebuild the IPC surface, and
 * the push subscriptions follow the fleet rather than any one manager.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import {
  CH,
  DEFAULT_WINDOW,
  PUSH,
  type AddAgentRequest,
  type CreateSessionRequest,
  type EventBatch,
  type HostInfo,
  type RuntimeInfo,
  type SendRequest,
  type SessionSnapshot,
} from '@shared/ipc/contract.js';
import type {
  AgentId,
  InstanceId,
  LoomEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
} from '@shared/types/index.js';
import { basename } from 'node:path';
import type { AttachedHost, Fleet, FleetRuntime } from '../fleet.js';
import { EventBridge } from './eventBridge.js';

export interface IpcDeps {
  fleet: Fleet;
  /** Runtime metadata, for describing what a host offers. */
  runtimes: FleetRuntime[];
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

/**
 * A short label for §10's target badge.
 *
 * For a remote target the machine is the useful identifier; for a local one it
 * is the folder, since "local" repeated across four cards says nothing.
 */
function labelFor(host: AttachedHost): string {
  const target = host.target as { kind: string; host?: string; distro?: string };
  return target.host ?? target.distro ?? basename(host.workspaceRoot);
}

function toInfo(host: AttachedHost): HostInfo {
  return {
    root: host.workspaceRoot,
    lineageId: host.lineageId,
    instanceId: host.instanceId,
    targetKind: host.target.kind,
    label: labelFor(host),
    available: host.available,
    ...(host.unavailableReason !== undefined
      ? { unavailableReason: host.unavailableReason }
      : {}),
  };
}

export function registerIpc(deps: IpcDeps): { dispose: () => void } {
  const { fleet } = deps;

  // ------------------------------------------------------------- push channels

  const windows = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed());

  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of windows()) win.webContents.send(channel, payload);
  };

  const bridge = new EventBridge({
    send: (batch: EventBatch) => broadcast(PUSH.events, batch),
  });

  const onEvent = (instanceId: string, sessionId: string, event: LoomEvent): void =>
    bridge.push(instanceId, sessionId, event);
  const onSession = (_instanceId: string, session: Session): void =>
    broadcast(PUSH.session, session);
  const onPermission = (_instanceId: string, request: PermissionRequest): void =>
    broadcast(PUSH.permission, request);
  const onHosts = (): void => broadcast(PUSH.hosts, fleet.hosts().map(toInfo));

  fleet.on('event', onEvent);
  fleet.on('session', onSession);
  fleet.on('permission', onPermission);
  fleet.on('host', onHosts);
  fleet.on('detached', onHosts);

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

  handle(CH.hostsList, () => fleet.hosts().map(toInfo));

  handle(CH.hostsAdd, async () => {
    const win = windows()[0];
    const result = await dialog.showOpenDialog(win ?? new BrowserWindow({ show: false }), {
      title: 'Attach a workspace',
      properties: ['openDirectory', 'createDirectory'],
    });
    const root = result.filePaths[0];
    if (result.canceled || root === undefined) return null;

    // Attaching does not replace anything: several hosts stay attached (§8).
    return toInfo(await fleet.attach(root));
  });

  handle(CH.hostsRemove, (instanceId: string) => fleet.detach(instanceId as InstanceId));

  handle(CH.hostsRuntimes, (instanceId: string): RuntimeInfo[] =>
    fleet.runtimesOn(instanceId as InstanceId).map((r) => ({
      id: r.id,
      version: r.version,
      requiresModel: r.requiresModel,
    })),
  );

  handle(CH.sessionsList, () => fleet.list());

  handle(CH.sessionsCreate, (r: CreateSessionRequest) =>
    fleet.createSession(r.instanceId as InstanceId, { title: r.title, goal: r.goal }),
  );

  handle(CH.sessionsListOnDisk, () => fleet.listOnDisk());

  handle(CH.sessionsResume, (instanceId: string, sessionId: string) =>
    fleet.resumeSession(instanceId as InstanceId, sessionId as SessionId),
  );

  handle(CH.sessionsSnapshot, async (sessionId: string, windowSize?: number) => {
    const id = sessionId as SessionId;
    const projection = await fleet.projection(id);
    const size = windowSize ?? DEFAULT_WINDOW;
    const all = await fleet.events(id);
    // A window over the tail, never the whole log (§7). A week-long session
    // must not become a renderer-side heap problem.
    const recent = all.slice(-size);
    const session = fleet.get(id);
    const snapshot: SessionSnapshot = {
      session,
      projection,
      recent,
      windowFromSeq: recent[0]?.seq ?? 0,
      queued: session.agents.reduce(
        (total, agent) => total + fleet.queueDepth(id, agent.agentId),
        0,
      ),
    };
    return snapshot;
  });

  handle(CH.sessionsAddAgent, (r: AddAgentRequest) =>
    fleet.addAgent(r.sessionId as SessionId, {
      role: r.role,
      runtimeId: r.runtimeId,
      ...(r.systemPrompt !== undefined ? { systemPrompt: r.systemPrompt } : {}),
      ...(r.model !== undefined ? { model: r.model } : {}),
      ...(r.maxTurns !== undefined ? { limits: { maxTurns: r.maxTurns } } : {}),
    }),
  );

  handle(CH.sessionsSend, (r: SendRequest) =>
    fleet.send(r.sessionId as SessionId, r.agentId as AgentId, {
      content: [{ type: 'text', text: r.text }],
    }),
  );

  handle(CH.sessionsInterrupt, (sessionId: string, agentId?: string) =>
    fleet.interrupt(sessionId as SessionId, agentId as AgentId | undefined),
  );

  handle(CH.sessionsSince, (sessionId: string, fromSeq: number) =>
    fleet.events(sessionId as SessionId, fromSeq),
  );

  handle(CH.permissionsPending, () => fleet.pendingPermissions().map((p) => p.request));

  handle(CH.permissionsRespond, (requestId: string, decision: PermissionDecision) =>
    fleet.respondPermission(requestId, decision),
  );

  // `send`, not `handle`: an ack has no reply, and making the renderer await one
  // per batch would serialize rendering behind the IPC round trip.
  ipcMain.on(CH.ack, (_e, sessionId: string, seq: number) => bridge.ack(sessionId, seq));

  return {
    dispose: () => {
      fleet.off('event', onEvent);
      fleet.off('session', onSession);
      fleet.off('permission', onPermission);
      fleet.off('host', onHosts);
      fleet.off('detached', onHosts);
      bridge.releaseAll();
      for (const channel of Object.values(CH)) ipcMain.removeHandler(channel);
      ipcMain.removeAllListeners(CH.ack);
    },
  };
}
