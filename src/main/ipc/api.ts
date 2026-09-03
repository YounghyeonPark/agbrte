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
  type TranscriptDto,
  type VoiceStatusDto,
  type CaptureResultDto,
  type DetectedPortDto,
  type ForwardDto,
  type CaptureSourceInfo,
  type AboutInfo,
  type SendRequest,
  type SessionSnapshot,
  type ShellChunk,
  type ShellDto,
  type ShellExitDto,
  type ServerKind,
  type SetupPlanDto,
  type SetupProgressDto,
  type SshHostInfo,
  type UpdateState,
} from '@shared/ipc/contract.js';
import type { PreviewForwards } from '../preview/forwards.js';
import type {
  ReasoningRequest,
  AgentId,
  InstanceId,
  McpServerConfig,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  Session,
  SessionId,
  Sha256,
  ShellProgram,
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
import { forgetMachine, rememberMachine } from '../attachedMachines.js';
import type { RestoreState } from '../restoreMachines.js';
import { PendingFrames } from '../capture/pending.js';
import { scaleToFit, sizeOf } from '../content/pixels.js';
import { scaleAnnotations, splitRedactions } from '../content/annotate.js';
import type { Rect } from '../content/redact.js';
import { findEngine, transcribe, wavDurationMs, type SpeechEngine } from '../voice/stt.js';
import type { ClipStore } from '../voice/clips.js';
import type { Speaker } from '../voice/tts.js';
import { buildMatrix } from '@main/conformance.js';
import { exportSessionMarkdown } from '@main/store/exportSession.js';
import type { ConformanceReport, MatrixCell, Workflow } from '@shared/types/index.js';
import { readSshHosts } from '../host/sshConfig.js';
import { assertSafeAlias, discoverRemoteWorkspaces } from '../host/discoverWorkspaces.js';
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
   * The startup reattach, when there is one (`restoreMachines.ts`).
   *
   * Optional and absent everywhere but the desktop app: reaching for the
   * machines somebody's window was attached to is a policy of *that* process,
   * and a browser client asking what it is doing gets an empty list rather than
   * another client's list.
   */
  restorer?: { restoring: () => RestoreState[] };
  /**
   * Native folder picker, when there is one.
   *
   * Absent in a browser, and `hosts.add` says so rather than throwing something
   * shaped like a bug — an API that exists and fails opaquely is worse than one
   * that explains why it cannot.
   */
  pickFolder?: () => Promise<string | null>;
  /**
   * The app's own updater, when there is one.
   *
   * A getter rather than the handle, because the updater is built after the
   * first window exists — an update check must never be the reason a workbench
   * takes longer to appear — and this API is registered before that. Passing the
   * value would capture `undefined` forever.
   *
   * Absent in the web bridge, whose client is a browser tab with no standing to
   * replace the program it is looking at.
   */
  updates?: () => { state(): UpdateState; installNow(): void } | undefined;
  /**
   * The bundle version this client would deploy, for comparing hosts against.
   *
   * Injected because this module also backs the web bridge, where there is no
   * Electron to ask. Absent means no comparison is made and every host reports
   * `outdated: undefined` — which is the honest answer for a client that does
   * not know what it ships.
   */
  shippingVersion?: string;
  /**
   * What the About page shows: name, version, license (§7).
   *
   * Injected for the same reason `shippingVersion` is — this module also backs
   * the web bridge, where there is no Electron to ask. Absent means the caller
   * had nothing better than the fallback below, which says so honestly rather
   * than inventing a version.
   */
  about?: AboutInfo;
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
  /**
   * Where dictated clips are kept, on this machine (§12.4).
   *
   * Absent means this client cannot record — there is nowhere local to keep the
   * clip, and keeping it anywhere else is the thing that section rules out.
   */
  clips?: ClipStore;
  /**
   * This machine's speakers (§12.4).
   *
   * Client-only for the same reason `screen` and `clips` are: a browser reaching
   * a headless server must not be able to make the *server* talk to an empty
   * room.
   */
  speaker?: Speaker;
  /**
   * Open port forwards for previews (§6.8).
   *
   * Client-only: what it hands back is a `127.0.0.1` URL, which names the
   * machine that opened the tunnel. A browser reaching a headless server would
   * be told to open a port on the *server* — a URL pointing at the wrong
   * computer, which is worse than an absent button.
   */
  previews?: PreviewForwards;
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
  // *Which folder* is a separate question, and the sidebar answers it from
  // `root` rather than by crowding it in here: this string also ends up in
  // sentences about the machine ("a terminal on cbk_ws_one is not available"),
  // where a folder would be noise.
  return target.alias ?? target.host ?? target.distro ?? basename(host.workspaceRoot);
}

/**
 * The version this client would deploy, so a host can be compared against it.
 *
 * Injected rather than read from `app.getVersion()` here, because this module is
 * also what the web bridge serves and there is no Electron on that side. The two
 * numbers being the same is the point: it is the same value `connectRemoteHost`
 * stamps onto an uploaded bundle.
 */
function isOutdated(host: AttachedHost, shipping: string | undefined): boolean | undefined {
  // Unknown at either end is unknown, not stale. See `HostInfo.outdated`.
  if (host.bundleVersion === undefined || shipping === undefined) return undefined;
  return host.bundleVersion !== shipping;
}

function toInfo(host: AttachedHost, shipping?: string): HostInfo {
  const outdated = isOutdated(host, shipping);
  return {
    ...(outdated === undefined ? {} : { outdated }),
    root: host.workspaceRoot,
    lineageId: host.lineageId,
    instanceId: host.instanceId,
    ...(host.machineId !== undefined ? { machineId: host.machineId } : {}),
    targetKind: host.target.kind,
    label: labelFor(host),
    available: host.available,
    endpoints: host.endpoints,
    runtimeNotes: host.runtimeNotes,
    ...(host.bundleVersion !== undefined ? { bundleVersion: host.bundleVersion } : {}),
    ...(host.shells !== undefined ? { shells: host.shells } : {}),
    ...(host.shellsReason !== undefined ? { shellsReason: host.shellsReason } : {}),
    ...(host.movedFrom !== undefined ? { movedFrom: host.movedFrom } : {}),
    link: host.link,
    ...(host.unavailableReason !== undefined
      ? { unavailableReason: host.unavailableReason }
      : {}),
  };
}

/**
 * What these bytes are, from the bytes.
 *
 * `agent.tool_result` records a hash and no type, so for anything a tool
 * produced the mime is genuinely unknown here. Sniffing the magic number is
 * more honest than defaulting to `image/png` — a `data:` URL carrying the wrong
 * type renders as a broken image, which reads as "the file is corrupt" rather
 * than "we guessed".
 *
 * Anything unrecognised is `application/octet-stream`, which a browser declines
 * to render. Correct: we do not know that it is a picture.
 */
function sniffMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return 'application/octet-stream';
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
  const onHosts = (): void =>
    broadcast(PUSH.hosts, fleet.hosts().map((h) => toInfo(h, deps.shippingVersion)));

  /**
   * Terminals opened through *this* API host, and nothing else.
   *
   * The fleet is shared by every client — the window, and one `createApi` per
   * browser socket — so a shell push reaches all of them. That is right for a
   * session event, which describes something shared, and wrong for a terminal,
   * which describes one person's screen. So each API host keeps the ids it
   * opened and drops the rest.
   *
   * It is the second of two filters and neither is redundant: the host already
   * targets its `push.shell` at the one *connection* that opened the shell,
   * which is what keeps a second device out. This one separates clients that
   * share a connection — every browser tab and this window all speak through
   * main's single `HostConnection` per host.
   *
   * It is also the lifetime: `dispose` closes what is still open, so closing a
   * window or dropping a WebSocket takes its terminals with it rather than
   * leaving a shell running for a reader that no longer exists.
   */
  const ownShells = new Set<string>();

  const onShell = (shellId: string, data: string): void => {
    if (!ownShells.has(shellId)) return;
    const chunk: ShellChunk = { shellId, data };
    // Straight to the client. No batching, no watermark, no ack — see
    // `AgbrteApi.on.shell` for why routing this through `EventBridge` would
    // make both channels worse.
    broadcast(PUSH.shell, chunk);
  };
  const onShellExit = (shellId: string, exitCode: number, signal?: number): void => {
    if (!ownShells.delete(shellId)) return;
    const exit: ShellExitDto = { shellId, exitCode, ...(signal !== undefined ? { signal } : {}) };
    broadcast(PUSH.shellExit, exit);
  };

  fleet.on('event', onEvent);
  fleet.on('session', onSession);
  fleet.on('permission', onPermission);
  fleet.on('permission-resolved', onResolved);
  fleet.on('host', onHosts);
  fleet.on('detached', onHosts);
  fleet.on('shell', onShell);
  fleet.on('shell-exit', onShellExit);

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

  handle(CH.hostsList, () => fleet.hosts().map((h) => toInfo(h, deps.shippingVersion)));

  handle(CH.hostsAdd, async (root?: string) => {
    const chosen = root ?? (await pickLocalFolder());
    if (chosen === null) return null;
    return toInfo(
      await fleet.attach({ target: { kind: 'local' }, workspaceRoot: chosen }),
      deps.shippingVersion,
    );
  });

  handle(CH.hostsPickFolder, () => pickLocalFolder());

  /**
   * The native folder picker, or a sentence saying where to find one.
   *
   * A browser has no picker, and inventing a path field would be a worse answer
   * than saying so: the web client serves the workspaces its server already has,
   * and naming a new folder is a thing you do where the filesystem is.
   */
  async function pickLocalFolder(): Promise<string | null> {
    if (deps.pickFolder === undefined) {
      throw new Error('choose a folder from the desktop app — this client serves one workspace');
    }
    return deps.pickFolder();
  }

  handle(CH.hostsRemove, async (instanceId: string) => {
    /*
     * Removing a host is the one act that forgets a machine.
     *
     * Read before the detach, because afterwards there is no entry left to ask
     * which destination it was. A local host has no alias and nothing to forget:
     * the machine the app runs on is attached by construction.
     */
    const going = fleet.hosts().find((h) => h.instanceId === instanceId);
    const alias = going?.target.kind === 'ssh' ? going.target.alias : undefined;
    await fleet.detach(instanceId as InstanceId);
    if (alias !== undefined && going !== undefined) {
      await forgetMachine({ alias, workspaceRoot: going.workspaceRoot }).catch(() => undefined);
    }
  });

  handle(CH.hostsShutdown, (instanceId: string) => fleet.shutdownHost(instanceId as InstanceId));
  handle(CH.hostsUpdate, (instanceId: string) => fleet.updateHost(instanceId as InstanceId));
  handle(CH.hostsModels, (instanceId: string) => fleet.models(instanceId as InstanceId));
  handle(
    CH.hostsModelCapabilities,
    (instanceId: string, endpointId: string, modelId: string) =>
      fleet.modelCapabilities(instanceId as InstanceId, endpointId, modelId),
  );
  handle(CH.hostsInstallModel, (instanceId: string, endpointId: string, tag: string) =>
    fleet.installModel(instanceId as InstanceId, endpointId, tag),
  );
  handle(CH.hostsInstallProgress, (instanceId: string) =>
    fleet.installProgress(instanceId as InstanceId),
  );

  /**
   * Set a machine up, streaming each step (§6.4).
   *
   * The one handler in this file that broadcasts *while* it runs. It is a
   * minutes-long call — an Ollama install is about a gigabyte — and the
   * alternative shapes are both worse: returning a job id would make the
   * renderer poll something with no natural end, and returning nothing until it
   * finishes is a panel that looks hung for four minutes.
   *
   * **`plan` is never logged and never echoed.** Its `endpoint.apiKey` is the
   * only secret in this contract; it goes straight through to `Fleet`, and the
   * `SetupOutcomeDto` that comes back is structurally incapable of carrying it.
   * `describe(err)` below turns a failure into its message, which is why nothing
   * downstream interpolates a key into an error.
   */
  handle(CH.hostsSetUp, (instanceId: string, plan: SetupPlanDto) =>
    fleet.setUpHost(instanceId as InstanceId, plan, (step) =>
      deps.broadcast(PUSH.setup, { instanceId, step } satisfies SetupProgressDto),
    ),
  );

  /*
   * A read, so it is not gated the way `setUp` is (§3.8).
   *
   * It runs a handful of read-only probes and changes nothing, and knowing why a
   * box cannot serve is what somebody watching one most needs — refusing it
   * would make the answer available only to whoever can already change it.
   */
  handle(CH.hostsServerReadiness, (instanceId: string, server: ServerKind) =>
    fleet.serverReadiness(instanceId as InstanceId, server),
  );

  handle(CH.appAbout, (): AboutInfo =>
    deps.about ?? {
      // The honest fallback for a caller that supplied nothing: the name is a
      // constant, and "unknown" is a truthful version where inventing one
      // would put a number on an About page nobody can trace to a build.
      name: 'Agbrte',
      version: deps.shippingVersion ?? 'unknown',
      description: 'Durable agent sessions you attach to from anywhere.',
      license: 'Apache-2.0',
      homepage: 'https://github.com/YounghyeonPark/agbrte',
    },
  );

  handle(CH.updateState, () =>
    Promise.resolve(
      deps.updates?.()?.state() ?? {
        phase: 'unsupported' as const,
        reason: 'this client cannot update the application',
      },
    ),
  );
  handle(CH.updateInstall, () => {
    // Nothing else in this file closes the window, and this is the one call
    // that does. It is behind a person pressing a control that says so.
    deps.updates?.()?.installNow();
    return Promise.resolve();
  });

  handle(CH.hostsSsh, async (): Promise<SshHostInfo[]> =>
    (await readSshHosts()).map((h) => ({
      alias: h.alias,
      ...(h.hostName !== undefined ? { hostName: h.hostName } : {}),
      ...(h.user !== undefined ? { user: h.user } : {}),
      ...(h.port !== undefined ? { port: h.port } : {}),
    })),
  );

  /**
   * Ask a machine what is on it, before anything of ours is on it (§6.2).
   *
   * Follows `hostsSsh` exactly — a main-process capability the renderer calls,
   * not a session command — because at this point there is no host to ask: no
   * bundle, no private Node, no control socket. It is one `ssh` running one
   * bounded `find`.
   *
   * Available to the web client for the same reason `sshHosts` and `addRemote`
   * are: it names machines the *serving* user can already reach and already
   * attach, and lists directories they could list by attaching. It adds no
   * reach; it only removes the need to remember a path.
   */
  handle(CH.hostsDiscover, (alias: string) => discoverRemoteWorkspaces(alias));

  handle(CH.hostsAddRemote, async (alias: string, workspaceRoot: string) => {
    /*
     * The same guard discovery applies, applied here for the same reason.
     *
     * "Handed to `ssh` unchanged" is right about the *config* and wrong about
     * one shape: `ssh` reads its destination as a positional argument, so a
     * name beginning with `-` is an option, and `-oProxyCommand=…` in that
     * position runs a command **on this machine**. Nothing types that alias by
     * accident, which is exactly why it is worth refusing rather than passing
     * on.
     */
    assertSafeAlias(alias);
    const attached = await fleet.attach({
      // `useSystemConfig` is the point: the alias is handed to `ssh` unchanged,
      // so the user's own config decides everything about the connection.
      target: { kind: 'ssh', alias, host: alias, useSystemConfig: true },
      workspaceRoot,
    });
    /*
     * Remembered once it worked, and never awaited.
     *
     * After the attach, because a destination that could not be reached is not
     * one this app should dial unprompted at every launch. Not awaited, and its
     * failure swallowed, because the attach the caller asked for has already
     * happened - turning "the shortcut list could not be written" into a failed
     * attach would report the wrong thing about a host that is up.
     */
    void rememberMachine({ alias, workspaceRoot }).catch(() => undefined);
    return toInfo(attached, deps.shippingVersion);
  });

  /**
   * What the startup reattach is doing, for a panel rather than for a dialog.
   *
   * Empty where there is no restorer, which is every client but the window this
   * app opened.
   */
  handle(CH.hostsRestoring, (): RestoreState[] => deps.restorer?.restoring() ?? []);

  handle(CH.hostsRuntimes, (instanceId: string): RuntimeInfo[] =>
    fleet.runtimesOn(instanceId as InstanceId).map((r) => ({
      id: r.id,
      version: r.version,
      model: r.model,
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
  handle(CH.workflowsList, (instanceId: string) => fleet.workflows(instanceId as InstanceId));
  handle(CH.workflowsSave, (r: { instanceId: string; workflowId: string; workflow: Workflow }) =>
    fleet.saveWorkflow(r.instanceId as InstanceId, r.workflowId, r.workflow),
  );

  handle(CH.sessionsList, () => fleet.list());

  handle(CH.sessionsCreate, (r: CreateSessionRequest) =>
    fleet.createSession(r.instanceId as InstanceId, {
      title: r.title,
      goal: r.goal,
      ...(r.mcpServers !== undefined ? { mcpServers: r.mcpServers } : {}),
      ...(r.skills !== undefined ? { skills: r.skills } : {}),
    }),
  );

  handle(
    CH.sessionsRespondSplit,
    (sessionId: string, proposalId: string, decision: { approved: boolean; reason?: string }) =>
      fleet.respondSplit(sessionId as SessionId, proposalId, decision),
  );

  handle(CH.sessionsGroup, (sessionIds: string[], name: string, groupId?: string) =>
    fleet.group(sessionIds as SessionId[], name, groupId),
  );

  handle(CH.sessionsUngroup, (sessionId: string) => fleet.ungroup(sessionId as SessionId));
  // The config carries `env`, which is credentials: handed straight to the
  // fleet, never destructured, logged or echoed back (§13).
  handle(CH.sessionsAttachMcp, (sessionId: string, config: McpServerConfig) =>
    fleet.attachMcp(sessionId as SessionId, config),
  );

  handle(CH.sessionsRename, (sessionId: string, title: string) =>
    fleet.renameSession(sessionId as SessionId, title),
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
      // Carried through unread: the owner of the log decides what replacing a
      // seat means, and this layer is a wire (§4.2, §7).
      ...(r.replacing !== undefined ? { replacing: r.replacing } : {}),
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

  // --------------------------------------------------------------------- voice

  /**
   * The local engine, found once.
   *
   * Cached because `findEngine` touches the filesystem and the answer does not
   * change while the app runs — and because `voice.status` is asked on every
   * composer render, which is not a reason to stat four paths.
   */
  let engine: SpeechEngine | null | undefined;
  const speech = async (): Promise<SpeechEngine | null> => {
    if (engine === undefined) engine = await findEngine();
    return engine;
  };

  handle(CH.voiceStatus, async (): Promise<VoiceStatusDto> => {
    const found = await speech();
    if (found === null) {
      return {
        available: false,
        // Names the two things and why nothing else will happen. §12.4 has no
        // remote fallback *by design*, and a bare "unavailable" reads as a bug.
        reason:
          'no local speech engine — install whisper.cpp and a model, or set ' +
          'AGBRTE_WHISPER_BIN and AGBRTE_WHISPER_MODEL. Dictation is local only, ' +
          'because audio is never sent to a provider',
      };
    }
    return { available: true, engine: found.bin, model: found.model };
  });

  handle(
    CH.voiceTranscribe,
    async (r: { wavBase64: string; sessionId: string; locale?: string }): Promise<TranscriptDto> => {
      if (deps.clips === undefined) {
        throw new Error('this client cannot record — dictation needs somewhere local to keep the clip');
      }

      const wav = Buffer.from(r.wavBase64, 'base64');
      const spoken = await transcribe(wav, await speech(), {
        ...(r.locale !== undefined ? { locale: r.locale } : {}),
      });

      const durationMs = wavDurationMs(wav) ?? 0;
      // Stored here, on this client, and nowhere else — the clip is what makes a
      // mis-transcription recoverable, and it never crosses a network to do it.
      const clip = await deps.clips.put(wav, {
        transcript: spoken.text,
        durationMs,
        sessionId: r.sessionId,
        engine: spoken.engine,
        model: spoken.model,
      });

      return { text: spoken.text, sha256: clip.sha256, durationMs };
    },
  );

  handle(CH.voiceClips, async (sessionId?: string) =>
    deps.clips === undefined ? [] : deps.clips.list(sessionId),
  );

  handle(CH.voiceSpeak, async (text: string): Promise<boolean> => {
    if (deps.speaker === undefined || !deps.speaker.available) return false;
    await deps.speaker.speak(text);
    return true;
  });

  handle(CH.voiceStopSpeaking, () => {
    deps.speaker?.stop();
  });

  handle(CH.voiceForget, async (sha256: string) => {
    await deps.clips?.forget(sha256 as Sha256);
  });

  /**
   * Preview forwarding (§6.8).
   *
   * The target comes from the fleet rather than from the caller: which machine a
   * session runs on is the host's fact, and letting the renderer name it would
   * be letting it ask for a tunnel to somewhere the session is not.
   */
  const previewsFor = (): PreviewForwards => {
    if (deps.previews === undefined) {
      throw new Error('previews are opened by the app on this machine, not by this client');
    }
    return deps.previews;
  };

  handle(CH.templatesList, (instanceId: string) =>
    fleet.templates(instanceId as InstanceId),
  );

  handle(CH.templatesSave, (r: { instanceId: string; sessionId: string; name: string }) =>
    fleet.saveTemplate(r.instanceId as InstanceId, r.sessionId as SessionId, r.name),
  );

  handle(CH.templatesApply, (r: { instanceId: string; templateId: string; title?: string }) =>
    fleet.applyTemplate(r.instanceId as InstanceId, r.templateId, r.title),
  );

  handle(CH.templatesDelete, (r: { instanceId: string; templateId: string }) =>
    fleet.deleteTemplate(r.instanceId as InstanceId, r.templateId),
  );

  handle(CH.previewDetect, async (instanceId: string): Promise<DetectedPortDto[]> => {
    // Not client-only: this asks the *host* what it can see, which is a question
    // a browser is entitled to ask. Only the tunnel that would follow belongs to
    // the machine with the browser on it.
    const found = await fleet.previewPorts(instanceId as InstanceId);
    return found.map((p) => ({ port: p.port, address: p.address, loopbackOnly: p.loopbackOnly }));
  });

  handle(CH.previewServers, (r: { instanceId: string; sessionId?: string }) =>
    fleet.previewServers(r.instanceId as InstanceId, r.sessionId as SessionId | undefined),
  );

  handle(CH.previewStart, (r: { instanceId: string; sessionId: string; command: string }) =>
    fleet.startPreviewServer(r.instanceId as InstanceId, r.sessionId as SessionId, r.command),
  );

  handle(CH.previewStopServer, (r: { instanceId: string; serverId: string }) =>
    fleet.stopPreviewServer(r.instanceId as InstanceId, r.serverId),
  );

  handle(CH.previewServerLog, (r: { instanceId: string; serverId: string }) =>
    fleet.previewServerLog(r.instanceId as InstanceId, r.serverId),
  );

  handle(
    CH.previewOpen,
    async (r: { instanceId: string; sessionId: string; port: number }): Promise<ForwardDto> => {
      // The client-only check runs **first**. It was second, and a browser got
      // "no attached host i" — a refusal whose wording depended on an unrelated
      // lookup happening to fail, which is the sort of thing that later gets
      // "fixed" by reordering and quietly loses the refusal.
      const previews = previewsFor();
      const host = fleet.hosts().find((h) => h.instanceId === r.instanceId);
      if (host === undefined) throw new Error(`no attached host ${r.instanceId}`);
      return previews.forward(r.sessionId as SessionId, host.target, r.port);
    },
  );

  /*
   * The workspace on the machine that owns it (§6.6, §7).
   *
   * Not client-only, unlike `preview.open`: a listing is a fact about the host
   * and means the same thing wherever it is rendered, so a browser at
   * `agbrte web` gets the same sidebar the desktop app does. The tunnel next
   * door is the thing that names a *local* port and is therefore excluded by
   * type — this returns nothing that points at the machine asking.
   *
   * Forwarded without interpretation. `path` is checked where the root is, which
   * is the host: a check here would be a second opinion built from a workspace
   * root this process only has a copy of, and second opinions about a security
   * boundary are only ever wrong in the permissive direction. `Fleet` refuses a
   * host too old by name; the host refuses a path that escapes, a file over the
   * cap, and anything that is not text.
   *
   * Deliberately **no cancellation**: each call is one capped directory or one
   * capped file, so the longest is a single round trip, and a renderer that has
   * moved on just ignores the reply. A cancel token would be ceremony over a
   * request that cannot outlive a click.
   */
  handle(CH.filesList, (r: { instanceId: string; path: string; limit?: number }) =>
    fleet.listFiles(r.instanceId as InstanceId, r.path, r.limit),
  );

  handle(CH.filesRead, (r: { instanceId: string; path: string }) =>
    fleet.readFile(r.instanceId as InstanceId, r.path),
  );

  handle(CH.previewList, (sessionId: string): ForwardDto[] =>
    deps.previews === undefined ? [] : deps.previews.list(sessionId as SessionId),
  );

  handle(CH.previewClose, (r: { sessionId: string; port: number }) =>
    deps.previews === undefined ? false : deps.previews.close(r.sessionId as SessionId, r.port),
  );

  handle(CH.previewRecheck, (r: { sessionId: string; port: number }) =>
    deps.previews === undefined
      ? null
      : deps.previews.recheck(r.sessionId as SessionId, r.port),
  );

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

  handle(CH.sessionsSetReasoning, (sessionId: string, agentId: string, mode: ReasoningRequest['mode']) =>
    fleet.setReasoning(sessionId as SessionId, agentId as AgentId, { mode }),
  );

  /*
   * Turned into a `data:` URL here rather than in the renderer.
   *
   * The bytes cross one boundary either way; doing it here means the renderer
   * never holds an ArrayBuffer it has to remember to release, and a `data:` URL
   * needs no revoking the way `createObjectURL` does — a leak that only shows up
   * after a long session, which is exactly the kind this app must not have.
   */
  handle(CH.sessionsBlob, async (sessionId: string, sha256: string, mime?: string) => {
    const bytes = await fleet.blob(sessionId as SessionId, sha256 as Sha256, mime);
    if (bytes === null) return null;
    return `data:${mime ?? sniffMime(bytes)};base64,${bytes.toString('base64')}`;
  });

  handle(CH.sessionsSince, (sessionId: string, fromSeq: number) =>
    fleet.events(sessionId as SessionId, fromSeq),
  );

  handle(
    CH.sessionsExport,
    async (sessionId: string, opts?: { toolArgs?: 'full' | 'summary' }) => {
      const id = sessionId as SessionId;
      // Both from the owning host, in parallel: it holds the log and the record,
      // and serializing them shows as lag on a long session.
      const [session, events] = await Promise.all([fleet.get(id), fleet.events(id)]);
      return exportSessionMarkdown(session, events, {
        ...(opts?.toolArgs !== undefined ? { toolArgs: opts.toolArgs } : {}),
      });
    },
  );

  handle(CH.sessionsSearch, (query: string, limit?: number) => fleet.search(query, limit));
  handle(CH.sessionsRawLog, (sessionId: string, agentId: string) =>
    fleet.rawLog(sessionId as SessionId, agentId as AgentId),
  );

  // ----------------------------------------------------------------- terminal

  /*
   * The user's own terminal in the workspace (§7, §8).
   *
   * Four narrow methods, no generic escape hatch: no command, no argv, no cwd,
   * and nothing but an opaque id comes back. The one thing a client chooses is
   * *which* of the host's own programs to start, and it says so with a selector
   * the host resolves — so this handler forwards it without interpreting it.
   * `Fleet.openShell` refuses a remote host by name, the owning host refuses a
   * read-only client, and the owning host refuses a CLI it did not detect.
   *
   * These are handlers like any other, which is what makes the web client work
   * unchanged — the same map `ipcMain` drives is the map the WebSocket drives.
   * What differs per client is `ownShells` above, and that is the point.
   */
  handle(
    CH.shellOpen,
    async (r: {
      instanceId: string;
      sessionId: string;
      program?: ShellProgram;
      cols?: number;
      rows?: number;
    }): Promise<ShellDto> => {
      const handle = await fleet.openShell(r.instanceId as InstanceId, r.sessionId as SessionId, {
        ...(r.program !== undefined ? { program: r.program } : {}),
        ...(r.cols !== undefined ? { cols: r.cols } : {}),
        ...(r.rows !== undefined ? { rows: r.rows } : {}),
      });
      ownShells.add(handle.shellId);
      return handle;
    },
  );

  handle(CH.shellWrite, (shellId: string, data: string) =>
    // Refused rather than routed for an id this client did not open. The host
    // checks ownership too; this stops one client from even naming another's.
    ownShells.has(shellId) ? fleet.writeShell(shellId, data) : Promise.resolve(false),
  );

  handle(CH.shellResize, (shellId: string, cols: number, rows: number) =>
    ownShells.has(shellId) ? fleet.resizeShell(shellId, cols, rows) : Promise.resolve(false),
  );

  handle(CH.shellClose, async (shellId: string) => {
    if (!ownShells.delete(shellId)) return false;
    return fleet.closeShell(shellId);
  });

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
      // A voice that outlives the window it was started from is the one
      // failure mode of this feature that a user cannot stop.
      deps.speaker?.stop();
      /*
       * Terminals this client opened go with it.
       *
       * A window closing or a WebSocket dropping leaves a PTY with no reader —
       * a program blocked on a prompt nobody can answer. The owning host sweeps
       * on *its* connection dropping, which is a different and coarser event:
       * one browser tab closing does not close main's socket to the host.
       */
      for (const shellId of [...ownShells]) {
        ownShells.delete(shellId);
        void fleet.closeShell(shellId).catch(() => undefined);
      }
      fleet.off('shell', onShell);
      fleet.off('shell-exit', onShellExit);
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
