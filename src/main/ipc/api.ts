/**
 * The API behind `window.agbrte`, with no transport (DESIGN.md §7).
 *
 * Split from `register.ts` for one concrete reason: that file imports `electron`,
 * and an ESM import is evaluated when the module loads, not when it is used. A
 * headless web server that merely wanted these handlers crashed on
 *
 *   SyntaxError: Named export 'BrowserWindow' not found
 *
 * before a single line ran. "It does not call Electron" is not the same as "it
 * does not import Electron", and only the second one lets this run under plain
 * Node.
 *
 * So everything here is a channel name, a `Fleet`, and functions. The two things
 * that genuinely need a window — broadcasting a push, and opening a folder
 * picker — arrive as dependencies, which is why the same map serves an Electron
 * window and a browser over a WebSocket without either knowing about the other.
 */

import {
  CH,
  DEFAULT_WINDOW,
  PUSH,
  type AddAgentRequest,
  type CreateSessionRequest,
  type EventBatch,
  type HostInfo,
  type RuntimeInfo,
  type CaptureCommitDto,
  type CapturePreviewDto,
  type CaptureRequestDto,
  type CaptureResultDto,
  type CaptureSourceInfo,
  type SendRequest,
  type SessionSnapshot,
  type SshHostInfo,
} from '@shared/ipc/contract.js';
import type {
  AgentId,
  InstanceId,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
} from '@shared/types/index.js';
import { basename } from 'node:path';
import {
  captureScreen,
  CaptureUnavailable,
  listSources,
  screenForDisplay,
  storeFrame,
  takeFrame,
  type ScreenBackend,
} from '../capture/client.js';
import { PendingFrames } from '../capture/pending.js';
import { scaleToFit, sizeOf } from '../content/pixels.js';
import { scaleAnnotations, splitRedactions } from '../content/annotate.js';
import type { Rect } from '../content/redact.js';
import { buildMatrix } from '@main/conformance.js';
import type { ConformanceReport, MatrixCell } from '@shared/types/index.js';
import { readSshHosts } from '../host/sshConfig.js';
import type { AttachedHost, Fleet, FleetRuntime } from '../fleet.js';
import { EventBridge } from './eventBridge.js';

export interface IpcDeps {
  fleet: Fleet;
  /** Runtime metadata, for describing what a host offers. */
  runtimes: FleetRuntime[];
  /**
   * The conformance report that shipped with this build (§3.13).
   *
   * A function rather than a value so a rebuilt report is picked up without a
   * restart, and injectable so a test does not need one on disk. Returning
   * `null` is ordinary: it means nothing has been run here, which the matrix
   * renders honestly rather than treating as an error.
   */
  loadConformance: () => Promise<ConformanceReport | null>;
  /** How a push reaches clients. Electron sends to windows; the web sends to a socket. */
  broadcast: (channel: string, payload: unknown) => void;
  /**
   * Native folder picker, when there is one.
   *
   * Absent in a browser, and `hosts.add` says so rather than throwing something
   * shaped like a bug — an API that exists and fails opaquely is worse than one
   * that explains why it cannot.
   */
  pickFolder?: () => Promise<string | null>;
  /**
   * The screen, when this client has one (§12.1).
   *
   * Absent in a browser, and the handlers below say so rather than throwing
   * something shaped like a bug — the same choice `pickFolder` makes, for the
   * same reason. Injected rather than imported because `capture/electron.ts`
   * imports `electron`, and an ESM import is evaluated at load: a single one
   * here would make this file unloadable under plain Node, which is the whole
   * reason it is a separate file from `register.ts`.
   */
  screen?: ScreenBackend;
  /**
   * Show §12.1's region overlay and wait for a rectangle.
   *
   * Separate from `screen` because it is a *window*, not a capture source, and
   * a client can plausibly have one without the other — a headless host with a
   * virtual display could grab pixels and has nowhere to draw a selector.
   * `null` means the user cancelled.
   */
  selectRegion?: () => Promise<{ displayId: string; region: Rect } | null>;
}

/** The transport-free API: a channel map, an ack sink, and its teardown. */
export interface AgbrteApiHost {
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
  ack(sessionId: string, seq: number): void;
  dispose(): void;
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
  const target = host.target as {
    kind: string;
    alias?: string;
    host?: string;
    distro?: string;
  };
  // For a remote the machine is the useful identifier — and the alias over the
  // hostname, because the alias is what the user chose and what they would type.
  return target.alias ?? target.host ?? target.distro ?? basename(host.workspaceRoot);
}

function toInfo(host: AttachedHost): HostInfo {
  return {
    root: host.workspaceRoot,
    lineageId: host.lineageId,
    instanceId: host.instanceId,
    targetKind: host.target.kind,
    label: labelFor(host),
    available: host.available,
    endpoints: host.endpoints,
    ...(host.movedFrom !== undefined ? { movedFrom: host.movedFrom } : {}),
    link: host.link,
    ...(host.unavailableReason !== undefined
      ? { unavailableReason: host.unavailableReason }
      : {}),
  };
}

export function createApi(deps: IpcDeps): AgbrteApiHost {
  const { fleet } = deps;

  // ------------------------------------------------------------- push channels

  const broadcast = deps.broadcast;

  const bridge = new EventBridge({
    send: (batch: EventBatch) => broadcast(PUSH.events, batch),
  });

  const onEvent = (instanceId: string, sessionId: string, event: AgbrteEvent): void =>
    bridge.push(instanceId, sessionId, event);
  const onSession = (_instanceId: string, session: Session): void =>
    broadcast(PUSH.session, session);
  const onPermission = (_instanceId: string, request: PermissionRequest): void =>
    broadcast(PUSH.permission, request);
  const onResolved = (_instanceId: string, resolved: unknown): void =>
    broadcast(PUSH.permissionResolved, resolved);
  const onHosts = (): void => broadcast(PUSH.hosts, fleet.hosts().map(toInfo));

  fleet.on('event', onEvent);
  fleet.on('session', onSession);
  fleet.on('permission', onPermission);
  fleet.on('permission-resolved', onResolved);
  fleet.on('host', onHosts);
  fleet.on('detached', onHosts);

  // ----------------------------------------------------------------- handlers

  // Collected rather than registered. Electron drives this map through
  // `ipcMain`, and the web server drives the same map over a WebSocket — one
  // definition, two transports. Two sets of handlers would have been quicker to
  // write and would have drifted the first time either side gained a method.
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const handle = <A extends unknown[], R>(
    channel: string,
    fn: (...args: A) => Promise<R> | R,
  ): void => {
    handlers.set(channel, async (...args: unknown[]) => {
      try {
        return await fn(...(args as A));
      } catch (err) {
        throw describe(err);
      }
    });
  };

  handle(CH.hostsList, () => fleet.hosts().map(toInfo));

  handle(CH.hostsAdd, async () => {
    // A browser has no native folder picker, and inventing a path field would be
    // a worse answer than saying so: the web client serves one workspace, and
    // attaching another is a thing you do where the filesystem is.
    if (deps.pickFolder === undefined) {
      throw new Error('choose a folder from the desktop app — this client serves one workspace');
    }
    const chosen = await deps.pickFolder();
    if (chosen === null) return null;
    return toInfo(await fleet.attach({ target: { kind: 'local' }, workspaceRoot: chosen }));
  });

  handle(CH.hostsRemove, (instanceId: string) => fleet.detach(instanceId as InstanceId));

  handle(CH.hostsShutdown, (instanceId: string) => fleet.shutdownHost(instanceId as InstanceId));

  handle(CH.hostsSsh, async (): Promise<SshHostInfo[]> =>
    (await readSshHosts()).map((h) => ({
      alias: h.alias,
      ...(h.hostName !== undefined ? { hostName: h.hostName } : {}),
      ...(h.user !== undefined ? { user: h.user } : {}),
      ...(h.port !== undefined ? { port: h.port } : {}),
    })),
  );

  handle(CH.hostsAddRemote, async (alias: string, workspaceRoot: string) =>
    toInfo(
      await fleet.attach({
        // `useSystemConfig` is the point: the alias is handed to `ssh` unchanged,
        // so the user's own config decides everything about the connection.
        target: { kind: 'ssh', alias, host: alias, useSystemConfig: true },
        workspaceRoot,
      }),
    ),
  );

  handle(CH.hostsRuntimes, (instanceId: string): RuntimeInfo[] =>
    fleet.runtimesOn(instanceId as InstanceId).map((r) => ({
      id: r.id,
      version: r.version,
      requiresModel: r.requiresModel,
    })),
  );

  handle(CH.hostsConformance, async (instanceId: string): Promise<MatrixCell[]> => {
    const offered = fleet.runtimesOn(instanceId as InstanceId);
    const runtimes = await Promise.all(
      offered.map(async (r) => {
        // Asked per runtime and allowed to come back empty. A host whose model
        // endpoint is down still has a matrix worth reading; it just cannot say
        // what its harness declares.
        const caps = await fleet.capabilitiesOn(instanceId as InstanceId, r.id);
        return {
          runtimeId: r.id,
          adapterVersion: r.version,
          ...(caps !== null ? { capabilities: caps } : {}),
        };
      }),
    );
    return buildMatrix(runtimes, await deps.loadConformance());
  });

  handle(CH.inboxList, (limit?: number) => fleet.inbox(limit));
  handle(CH.inboxMarkRead, () => fleet.markInboxRead());

  handle(CH.sessionsList, () => fleet.list());

  handle(CH.sessionsCreate, (r: CreateSessionRequest) =>
    fleet.createSession(r.instanceId as InstanceId, { title: r.title, goal: r.goal }),
  );

  handle(
    CH.sessionsRespondSplit,
    (sessionId: string, proposalId: string, decision: { approved: boolean; reason?: string }) =>
      fleet.respondSplit(sessionId as SessionId, proposalId, decision),
  );

  handle(CH.sessionsListOnDisk, () => fleet.listOnDisk());

  handle(CH.sessionsResume, (instanceId: string, sessionId: string) =>
    fleet.resumeSession(instanceId as InstanceId, sessionId as SessionId),
  );

  handle(CH.sessionsSnapshot, async (sessionId: string, windowSize?: number) => {
    const id = sessionId as SessionId;
    // One round trip each, in parallel: the host owns all four answers, and
    // serializing them would show as lag every time a session is opened.
    const [session, projection, all, queued] = await Promise.all([
      fleet.get(id),
      fleet.projection(id),
      fleet.events(id),
      fleet.queueDepth(id),
    ]);
    const size = windowSize ?? DEFAULT_WINDOW;
    // A window over the tail, never the whole log (§7). A week-long session
    // must not become a renderer-side heap problem.
    const recent = all.slice(-size);
    const snapshot: SessionSnapshot = {
      session,
      projection,
      recent,
      windowFromSeq: recent[0]?.seq ?? 0,
      queued,
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
    fleet.send(r.sessionId as SessionId, r.agentId as AgentId, r.text, r.blocks),
  );

  // ------------------------------------------------------------------- capture

  handle(CH.captureSources, async (): Promise<CaptureSourceInfo[]> =>
    (await listSources(deps.screen ?? null)).map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      ...(source.displayId !== undefined ? { displayId: source.displayId } : {}),
      ...(source.thumbnailPng !== undefined
        ? {
            // Encoded here rather than shipped as a Buffer: the same payload has
            // to survive Electron's structured clone *and* a JSON WebSocket
            // frame, and only one of those carries a Buffer.
            thumbnailDataUrl: `data:image/png;base64,${source.thumbnailPng.toString('base64')}`,
          }
        : {}),
    })),
  );

  handle(CH.captureGrab, async (r: CaptureRequestDto): Promise<CaptureResultDto> => {
    const sessionId = r.sessionId as SessionId;
    const { block, scanned } = await captureScreen(
      deps.screen ?? null,
      {
        sourceId: r.sourceId,
        ...(r.region !== undefined ? { region: r.region } : {}),
        ...(r.redactions !== undefined ? { redactions: r.redactions } : {}),
        ...(r.windowTitle !== undefined ? { windowTitle: r.windowTitle } : {}),
        ...(r.displayId !== undefined ? { displayId: r.displayId } : {}),
      },
      // The sink is the owning host's store, whichever machine that is — a local
      // write next door or §6.7's chunked transfer over ssh. `captureScreen`
      // does not know which, for the same reason `send` does not.
      (redacted, mime) => fleet.putBlob(sessionId, redacted, mime),
    );
    return { block, scanned };
  });

  /**
   * Frames taken and not yet stored (§12.1).
   *
   * Per API host rather than per client, so a browser refresh mid-annotation
   * does not strand a screenshot of somebody's desktop in a map nobody can
   * reach. The TTL would catch it eventually; losing the handle should not mean
   * losing the ability to drop it early.
   */
  const pending = new PendingFrames();

  /** How big a preview may be. Large enough to draw accurately on, small enough
   * to cross an IPC boundary as a data URL without being felt. */
  const PREVIEW_EDGE = 1100;

  async function heldPreview(
    frame: Buffer,
    meta: { windowTitle?: string; displayId?: string },
  ): Promise<CapturePreviewDto> {
    const stored = sizeOf(frame);
    const shown = await scaleToFit(frame, PREVIEW_EDGE);
    const size = sizeOf(shown);
    return {
      pendingId: pending.put(frame, { ...meta, previewWidth: size.width }),
      preview: {
        dataUrl: `data:image/png;base64,${shown.toString('base64')}`,
        width: size.width,
        height: size.height,
      },
      stored,
    };
  }

  handle(CH.capturePreview, async (r: {
    sourceId?: string;
    region?: boolean;
    windowTitle?: string;
    displayId?: string;
  }): Promise<CapturePreviewDto | null> => {
    const meta = {
      ...(r.windowTitle !== undefined ? { windowTitle: r.windowTitle } : {}),
      ...(r.displayId !== undefined ? { displayId: r.displayId } : {}),
    };

    if (r.region === true) {
      if (deps.selectRegion === undefined) {
        throw new CaptureUnavailable(
          'this client cannot draw a region — use the desktop app, or capture a whole ' +
            'screen or window',
        );
      }
      const chosen = await deps.selectRegion();
      if (chosen === null) return null;

      const sources = await listSources(deps.screen ?? null, null);
      const source = screenForDisplay(sources, chosen.displayId);
      if (source === null) {
        throw new CaptureUnavailable(
          `no capture source for display ${chosen.displayId}; it may have been ` +
            'disconnected while the overlay was open',
        );
      }
      const frame = await takeFrame(deps.screen ?? null, {
        sourceId: source.id,
        region: chosen.region,
        displayId: chosen.displayId,
      });
      return heldPreview(frame, { ...meta, displayId: chosen.displayId });
    }

    if (r.sourceId === undefined) throw new Error('capture.preview needs a sourceId or region');
    const frame = await takeFrame(deps.screen ?? null, { sourceId: r.sourceId, ...meta });
    return heldPreview(frame, meta);
  });

  handle(CH.captureCommit, async (r: CaptureCommitDto): Promise<CaptureResultDto> => {
    // Consumed: the unredacted frame stops existing at the moment the redacted
    // one starts, rather than lingering for whatever comes next to forget.
    const { frame, meta } = pending.take(r.pendingId);

    // Marks arrive in preview pixels; the frame may be larger. The same
    // conversion the region overlay needs, done on the side that knows both
    // numbers — a renderer scaling its own would be one refactor away from
    // scaling twice. `previewWidth` is the width that was actually sent, not a
    // recomputed guess at it.
    const { previewWidth, ...frameMeta } = meta;
    const drawn = scaleAnnotations(r.annotations ?? [], sizeOf(frame).width / previewWidth);

    /**
     * Blackouts leave the vector model here and never come back (§12.3).
     *
     * They are painted into the bytes before the store, because deferring one
     * would leave the secret in a content-addressed index that §6.7 pushes on
     * request. Everything else stays editable, which is what that section
     * promises for the marks that are not hiding anything.
     */
    const { redactions, editable } = splitRedactions(drawn);

    const result = await storeFrame(
      frame,
      { redactions, ...frameMeta },
      (redacted, mime) => fleet.putBlob(r.sessionId as SessionId, redacted, mime),
    );

    return {
      ...result,
      block: {
        ...result.block,
        ...(editable.length > 0 ? { annotations: editable } : {}),
      },
    };
  });

  handle(CH.captureDiscard, (pendingId: string) => {
    pending.drop(pendingId);
  });

  handle(CH.captureRegion, async (sessionId: string): Promise<CaptureResultDto | null> => {
    if (deps.selectRegion === undefined) {
      throw new CaptureUnavailable(
        'this client cannot draw a region — use the desktop app, or capture a whole ' +
          'screen or window',
      );
    }

    const chosen = await deps.selectRegion();
    // Escape. An ordinary answer: opening the overlay and changing your mind is
    // a thing people do, and an error here would be a red banner for a decision.
    if (chosen === null) return null;

    // Ids only — rendering every desktop at preview size to look up a number
    // would be the expensive way to answer this.
    const sources = await listSources(deps.screen ?? null, null);
    const source = screenForDisplay(sources, chosen.displayId);
    if (source === null) {
      throw new CaptureUnavailable(
        `no capture source for display ${chosen.displayId}; it may have been ` +
          'disconnected while the overlay was open',
      );
    }

    const { block, scanned } = await captureScreen(
      deps.screen ?? null,
      {
        sourceId: source.id,
        region: chosen.region,
        displayId: chosen.displayId,
      },
      (redacted, mime) => fleet.putBlob(sessionId as SessionId, redacted, mime),
    );
    return { block, scanned };
  });

  handle(CH.sessionsInterrupt, (sessionId: string, agentId?: string) =>
    fleet.interrupt(sessionId as SessionId, agentId as AgentId | undefined),
  );

  handle(CH.sessionsSince, (sessionId: string, fromSeq: number) =>
    fleet.events(sessionId as SessionId, fromSeq),
  );

  handle(CH.permissionsPending, async () =>
    (await fleet.pendingPermissions()).map((p) => p.request),
  );

  handle(CH.permissionsRespond, (requestId: string, decision: PermissionDecision) =>
    fleet.respondPermission(requestId, decision),
  );

  return {
    handlers,
    // `ack` is one-way on purpose: it has no reply, and making the renderer
    // await one per batch would serialize rendering behind the round trip.
    ack: (sessionId: string, seq: number) => bridge.ack(sessionId, seq),
    dispose: () => {
      // Held frames are unstored screenshots of somebody's desktop. Nothing
      // outlives the API host that took them.
      pending.clear();
      fleet.off('event', onEvent);
      fleet.off('session', onSession);
      fleet.off('permission', onPermission);
      fleet.off('permission-resolved', onResolved);
      fleet.off('host', onHosts);
      fleet.off('detached', onHosts);
      bridge.releaseAll();
    },
  };
}
