/**
 * The session host process (DESIGN.md §6.4, §8).
 *
 * A standalone Node process, one per workspace, that owns the sessions in it.
 * Started detached by an app and outliving that app on purpose: closing a window
 * is not a reason to stop work.
 *
 * ```
 *   app(s)  ──socket──▶  hostMain  ──fork──▶  agent host
 *   render, command      sessions,            agent loops,
 *   no session state     log, gate            tools
 * ```
 *
 * The fork matters. This process owns the event log, so an adapter crashing in
 * here would take down the thing that makes a detached session worth having. §8
 * puts loops in their own process for exactly that reason, and the boundary is
 * the same one the app used to hold — only the parent changed.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { HostSupervisor } from '@main/host/supervisor.js';
import { openWorkspace } from '@main/store/identity.js';
import { listen, hostSocketPath } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { HostCommand, HostMessage, MainSideChannel } from '@shared/host/protocol.js';
import { SessionHostServer } from './sessionServer.js';
import { decideRole, loadAccessPolicy } from './accessPolicy.js';
import { localIdentity } from './identity.js';
import { clearHostRecord, writeHostRecord } from './discovery.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Runtimes the forked agent host is expected to register. */
const RUNTIMES = [
  { id: 'gilmok-harness', label: 'Gilmok harness (local model)', version: '0.0.1', requiresModel: true },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', requiresModel: false },
];

/** Quiet time with no client and no work before exiting. */
const DEFAULT_LINGER_MS = 5 * 60_000;

/** A channel over a forked agent host, mirroring the utilityProcess one. */
class ForkedAgentChannel implements MainSideChannel {
  private handler: ((m: HostMessage) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private readonly backlog: HostMessage[] = [];
  private dead = false;
  private exitReason: string | undefined;

  constructor(private readonly child: ChildProcess) {
    child.on('message', (message: HostMessage) => {
      if (this.handler === null) {
        this.backlog.push(message);
        return;
      }
      this.handler(message);
    });
    child.on('exit', (code) => {
      this.dead = true;
      this.exitReason = `agent host exited with code ${code}`;
      this.closeHandler?.(this.exitReason);
    });
  }

  post(message: HostCommand): void {
    if (this.dead) return;
    this.child.send(message);
  }

  onMessage(handler: (m: HostMessage) => void): void {
    this.handler = handler;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
    // A child that exited before this was wired must still be reported, or the
    // client waits forever for a handshake that is never coming.
    if (this.dead) handler(this.exitReason);
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    this.child.kill();
  }
}

export interface StartHostOptions {
  workspaceRoot: string;
  lingerMs?: number;
  /** Overridable so a test can point at a built agent-host bundle. */
  agentHostEntry?: string;
}

export interface RunningHost {
  socket: string;
  stop(): Promise<void>;
}

export async function startSessionHost(opts: StartHostOptions): Promise<RunningHost> {
  const workspaceRoot = resolve(opts.workspaceRoot);
  // The host owns the workspace, so the host is what records where it is.
  const identity = await openWorkspace(workspaceRoot, { record: true });
  const socket = hostSocketPath(identity.instanceId);

  const agentEntry = opts.agentHostEntry ?? resolve(HERE, 'agentHost.js');

  const supervisor = new HostSupervisor({
    spawn: () => ({
      channel: new ForkedAgentChannel(
        fork(agentEntry, [], {
          // Piped rather than inherited: this process is detached and usually
          // has nowhere to write, and an inherited stdio would keep a handle on
          // the terminal the app was launched from.
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, GILMOK_WORKSPACE_ROOT: workspaceRoot },
        }),
      ),
    }),
    runtimes: RUNTIMES,
  });

  const registry = new RuntimeRegistry();
  for (const entry of supervisor.runtimes()) {
    registry.register(entry.runtime, { label: entry.label, requiresModel: entry.requiresModel });
  }

  const manager = new SessionManager({
    // Threaded from `openWorkspace`, which is the only thing that can tell: a
    // moved workspace is byte-identical to one that never moved, so detection
    // depends on the path this checkout was last opened at being written down.
    ...(identity.origin === 'relocated' && identity.movedFrom !== undefined
      ? { relocatedFrom: identity.movedFrom }
      : {}),
    registry,
    workspaceRoot,
    instanceId: identity.instanceId,
  });

  // Reconcile against what the agent host actually registered. Failing to start
  // it must not stop the host: transcripts still load and read, which is the
  // whole reason the log is the source of truth.
  let available: string[] = [];
  let endpoints: Awaited<ReturnType<typeof supervisor.endpoints>> = [];
  let unavailableReason: string | undefined;
  try {
    available = await supervisor.advertised();
    endpoints = await supervisor.endpoints();
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }

  // Read before listening, so a malformed policy stops the host instead of
  // being discovered by the first client it silently over-grants.
  const accessPolicy = await loadAccessPolicy(workspaceRoot);
  const identityOf = localIdentity();

  let server!: SessionHostServer;
  let listener!: Server;

  const stop = async (): Promise<void> => {
    server.stop('host stopping');
    supervisor.dispose();
    listener.close();
    await clearHostRecord(workspaceRoot);
  };

  server = new SessionHostServer({
    manager,
    identity: {
      instanceId: identity.instanceId,
      lineageId: identity.lineageId,
      workspaceRoot,
      runtimes: available,
      endpoints,
      ...(identity.origin === 'relocated' && identity.movedFrom !== undefined
        ? { movedFrom: identity.movedFrom }
        : {}),
      ...(unavailableReason !== undefined ? { unavailableReason } : {}),
    },
    grantRole: (requested, client) => ({
      role: decideRole(accessPolicy, requested, client, identityOf.ceiling),
      actor: identityOf.actor,
    }),
    lingerMs: opts.lingerMs ?? DEFAULT_LINGER_MS,
    // Whatever the reason — the idle timer, or a client asking — the process
    // goes. A host that stops serving but keeps its socket is worse than one
    // that never stopped: the next client finds it and believes it is live.
    onStopped: () => {
      void stop().then(() => process.exit(0));
    },
  });

  listener = await listen<SessionMessage, SessionCommand>(socket, (channel) =>
    server.accept(channel),
  );

  // Written only once we are actually listening. A record pointing at a socket
  // nobody answers sends every client down the stale path for no reason.
  await writeHostRecord(workspaceRoot, {
    pid: process.pid,
    socket,
    startedAt: new Date().toISOString(),
    instanceId: identity.instanceId,
  });

  return { socket, stop };
}

/**
 * Entry point when run as its own process.
 *
 * Guarded so importing this module — which the tests do — does not start a host
 * as a side effect.
 */
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const workspaceRoot = process.argv[2] ?? process.env['GILMOK_WORKSPACE_ROOT'];
  if (workspaceRoot === undefined) {
    process.stderr.write('usage: gilmok-host <workspace-root>\n');
    process.exit(2);
  }

  const lingerEnv = Number(process.env['GILMOK_HOST_LINGER_MS']);

  startSessionHost({
    workspaceRoot,
    ...(Number.isFinite(lingerEnv) ? { lingerMs: lingerEnv } : {}),
  })
    .then((host) => {
      process.stderr.write(`gilmok-host listening on ${host.socket}\n`);
      const shutdown = (): void => {
        void host.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err: unknown) => {
      process.stderr.write(`gilmok-host failed to start: ${String(err)}\n`);
      process.exit(1);
    });

  // A failing adapter must not take down the process that owns the log.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`gilmok-host unhandled rejection: ${String(reason)}\n`);
  });
}
