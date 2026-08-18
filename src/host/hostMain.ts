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

import { closeSync, openSync, readSync } from 'node:fs';
import { fork, type ChildProcess } from 'node:child_process';
import type { ModelNeed } from '@main/runtime/registry.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { HostSupervisor } from '@main/host/supervisor.js';
import { openWorkspace } from '@main/store/identity.js';
import { listen, hostSocketPath } from '@shared/host/socketChannel.js';
import { listenLoopback, newControlToken } from '@shared/host/loopback.js';
import { PreviewServers } from '@main/preview/servers.js';
import { Shells } from '@main/terminal/shell.js';
import { TerminalPrograms } from '@main/terminal/programs.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { HostCommand, HostMessage, MainSideChannel } from '@shared/host/protocol.js';
import { SessionHostServer, type ShellOwner } from './sessionServer.js';
import { decideRole, loadAccessPolicy } from './accessPolicy.js';
import { localIdentity } from './identity.js';
import { clearHostRecord, writeHostRecord } from './discovery.js';
import { addEndpoint } from './endpoints.js';
import { addManagedToolsToPath } from './managedTools.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Runtimes the forked agent host is expected to register, before it has said.
 *
 * A floor, not the list. Everything here can be named without asking the
 * machine — the harness and echo ship in the bundle — and everything §3.12
 * *detects* cannot be, which is precisely what this constant used to leave out:
 * the registry below was built from these two ids alone, so `admit()` refused
 * `cli:claude-code` on a host whose own handshake had just offered it. The
 * advertised list is folded in as soon as the agent host answers.
 */
const RUNTIMES: Array<{ id: string; label: string; version: string; model: ModelNeed }> = [
  { id: 'agbrte-harness', label: 'Agbrte harness (local model)', version: '0.0.1', model: 'required' },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', model: 'none' },
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
  /**
   * How clients reach this host (§6.2).
   *
   * `'socket'` is the default and stays the default everywhere it works: a unix
   * socket or named pipe is authenticated by the OS, and a loopback port is
   * reachable by every process on the machine. `'loopback'` exists for the
   * transports that cannot carry a socket across their boundary — WSL2, a
   * container, a pod — and pays for the difference with a bearer token.
   */
  control?: 'socket' | 'loopback';
  /**
   * What to do when the host stops serving. Defaults to ending the process.
   *
   * The default is the correct behaviour and stays it: a host that stops serving
   * but keeps its socket is worse than one that never stopped, because the next
   * client finds it and believes it is live. But `process.exit` in a function
   * that is also `import`-able makes it untestable in process — a test that
   * calls `stop()` takes the runner down with it — so the exit is injected
   * rather than assumed. Both real callers get it by omission.
   */
  onStopped?: (reason: string) => void;
}

export interface RunningHost {
  socket: string;
  /** Set when `control: 'loopback'`. The token is not returned — read the record. */
  port?: number;
  stop(): Promise<void>;
}

export async function startSessionHost(opts: StartHostOptions): Promise<RunningHost> {
  /*
   * Before anything is forked, because the fork copies this.
   *
   * A CLI installed by "Set up this machine" lands in `~/.agbrte/npm/bin`, which
   * nothing puts on a PATH: a host is started by `ssh <alias> '<command>'`, a
   * non-interactive non-login shell that sources no profile. So `detectCli`
   * would spawn `claude`, get `ENOENT`, and report "not installed" about a
   * binary this program had just installed — the failure the whole feature
   * exists to remove, reappearing one layer down.
   *
   * **Appended, never prepended**, which is §6.8's rule for preview commands and
   * right for the same reason: if the machine has its own `claude`, that is the
   * one the user means, and shadowing it would be exactly the "we changed your
   * machine" the private prefix exists to avoid. The Node directory goes on too,
   * because Gemini CLI's shim is a `#!/usr/bin/env node` script — installing it
   * beside a machine's only Node and then not being able to find that Node is a
   * failure that shows up as a runtime detected and unrunnable.
   */
  addManagedToolsToPath(process.env);

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
          env: { ...process.env, AGBRTE_WORKSPACE_ROOT: workspaceRoot },
        }),
      ),
    }),
    runtimes: RUNTIMES,
  });

  const registry = new RuntimeRegistry();
  for (const entry of supervisor.runtimes()) {
    registry.register(entry.runtime, { label: entry.label, model: entry.model });
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

  /*
   * Reconcile against what the agent host actually registered.
   *
   * **Registering, not just listing.** This used to read `advertised()` into
   * `available` and stop there, so the ids went out on every handshake while the
   * registry three lines above stayed at the two constants — and `admit()`,
   * which is the only thing that decides whether an agent may be created, reads
   * the registry. A user with Claude Code installed was therefore offered
   * `cli:claude-code` by a picker doing its job and refused by the host that had
   * advertised it, with `runtime "cli:claude-code" is not registered`.
   *
   * `available` is then taken from the registry rather than from the wire, which
   * makes the picker and the gate the same list by construction. An id this
   * process could not build a façade for is not offered — and §17 Q16's rule
   * applies: not offering it degrades to the screen that shipped before, while
   * offering it degrades to a refusal nobody can act on.
   *
   * Failing to start the agent host must not stop this one: transcripts still
   * load and read, which is the whole reason the log is the source of truth.
   */
  let available: string[] = [];
  let endpoints: Awaited<ReturnType<typeof supervisor.endpoints>> = [];
  let runtimeNotes: Array<{ id: string; label: string; reason: string }> = [];
  let unavailableReason: string | undefined;
  try {
    for (const entry of await supervisor.advertisedRuntimes()) {
      registry.register(entry.runtime, { label: entry.label, model: entry.model });
    }
    available = (await supervisor.advertised()).filter((id) => registry.has(id));
    runtimeNotes = await supervisor.detectionNotes();
    endpoints = await supervisor.endpoints();
  } catch (err) {
    unavailableReason = err instanceof Error ? err.message : String(err);
  }

  // Read before listening, so a malformed policy stops the host instead of
  // being discovered by the first client it silently over-grants.
  const accessPolicy = await loadAccessPolicy(workspaceRoot);
  const bundleVersion = readOwnBundleVersion();
  const identityOf = localIdentity();

  // Declared here rather than beside the listener below: the server closes over
  // `port` to exclude its own control channel from the preview list, and a `let`
  // declared after the closure is written is legal but reads like a bug.
  let port: number | undefined;
  let token: string | undefined;

  let server!: SessionHostServer;
  let listener!: Server;

  // §6.8: preview servers belong to the host, not to a turn — that is the
  // whole point of §3.12's reaping being something to work around.
  const servers = new PreviewServers(workspaceRoot);

  /**
   * The user's own terminals, in this workspace, on this machine.
   *
   * Here rather than in main for the reason §6.8 gives for preview servers: the
   * host is the process that owns the workspace, so `cwd` is the workspace by
   * construction and a host on another machine gives you *that* machine's
   * shell. It is also the process that can afford to drain a PTY — §8's rule is
   * that main must never block, and a terminal is the loudest thing in the app.
   *
   * The output sink posts to exactly one client's channel. Every other push in
   * this protocol is broadcast because it describes the session, which is
   * shared; this one describes one person's screen, and a second device
   * receiving it would be a leak rather than a feature.
   */
  const shells = new Shells<ShellOwner>(workspaceRoot, {
    /*
     * What a pane may open, built from what this host already decided.
     *
     * Not a second detection pass. `available` is the list `admit()` consults
     * and the list the picker draws, and `runtimeNotes` is the sentence the
     * picker shows beside a CLI it cannot offer — so a pane can open exactly the
     * CLIs the picker offers, and refuses the rest with the wording already on
     * screen, by construction. Detecting again here would have been two answers
     * to one question about one machine, which is how the runtime list and the
     * admission gate disagreed once already (see the note above `available`).
     */
    programs: new TerminalPrograms({ runtimeIds: available, notes: runtimeNotes }),
    onData: (shellId, data, owner) => owner.post({ t: 'push.shell', shellId, data }),
    onExit: (exit, owner) =>
      owner.post({
        t: 'push.shellExit',
        shellId: exit.shellId,
        exitCode: exit.exitCode,
        ...(exit.signal !== undefined ? { signal: exit.signal } : {}),
      }),
  });

  const stop = async (): Promise<void> => {
    // Before the listener closes: a preview server outliving the host that
    // started it is a port answering with nothing to explain it, and nothing
    // left that knows how to stop it.
    servers.stopAll();
    // And every terminal, for the stronger reason: a shell survives its reader
    // only as a process blocked on a prompt nobody can answer.
    shells.closeAll();
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
      ...(runtimeNotes.length > 0 ? { runtimeNotes } : {}),
      endpoints,
      ...(identity.origin === 'relocated' && identity.movedFrom !== undefined
        ? { movedFrom: identity.movedFrom }
        : {}),
      ...(unavailableReason !== undefined ? { unavailableReason } : {}),
      ...(bundleVersion === null ? {} : { bundleVersion }),
    },
    // Live, not from the handshake: `ollama pull` happens while this runs.
    models: () => supervisor.models(),
    // The expensive question, asked per model rather than per list (§3.3).
    modelCapabilities: (endpointId, modelId) =>
      supervisor.modelCapabilities(endpointId, modelId),
    installModel: (endpointId, tag) => supervisor.installModel(endpointId, tag),
    installProgress: () => supervisor.installProgress(),
    /*
     * The credential boundary, one function wide (§6.5, §13).
     *
     * This process is where a key stops. It arrives on the control channel,
     * goes into `addEndpoint`, and lands in a `0600` file under `~/.agbrte`;
     * `SessionHostServer` holds no reference to it, the reply carries none, and
     * the agent host — which is what actually makes requests — reads it from
     * that file at its next start rather than being handed it.
     *
     * Which is also why adding one does not take effect until the host
     * restarts: `loadEndpoints` runs once, in the forked agent host, and
     * re-reading it live would mean a turn mid-flight changing where it is
     * being sent. `Fleet.setUpHost` restarts the host afterwards and says so.
     */
    addEndpoint: (input) => addEndpoint(input),
    grantRole: (requested, client) => ({
      role: decideRole(accessPolicy, requested, client, identityOf.ceiling),
      actor: identityOf.actor,
    }),
    // Read when asked rather than captured now: the listener has not bound yet,
    // so the port does not exist at this line. Offering to forward the channel a
    // request arrived on would be offering a loop.
    servers,
    shells,
    controlPort: () => port,
    lingerMs: opts.lingerMs ?? DEFAULT_LINGER_MS,
    // Whatever the reason — the idle timer, or a client asking — the process
    // goes. A host that stops serving but keeps its socket is worse than one
    // that never stopped: the next client finds it and believes it is live.
    onStopped: (reason) => {
      if (opts.onStopped !== undefined) {
        void stop().then(() => opts.onStopped?.(reason));
        return;
      }
      void stop().then(() => process.exit(0));
    },
  });

  /**
   * Authentication happens below `accept`, whichever transport is used.
   *
   * `listenLoopback` calls back only for connections that presented the token,
   * so `SessionHostServer` sees the same thing either way: a channel belonging
   * to somebody entitled to it. That is what makes the loopback path a
   * substitute rather than a second, weaker door — the alternative, checking a
   * token inside `hello`, would leave a connection that never says hello able to
   * issue `session.list` and `session.events`.
   */
  if (opts.control === 'loopback') {
    token = newControlToken();
    const bound = await listenLoopback<SessionMessage, SessionCommand>(token, (channel) =>
      server.accept(channel),
    );
    listener = bound.server;
    port = bound.port;
  } else {
    listener = await listen<SessionMessage, SessionCommand>(socket, (channel) =>
      server.accept(channel),
    );
  }

  // Written only once we are actually listening. A record pointing at a socket
  // nobody answers sends every client down the stale path for no reason.
  await writeHostRecord(workspaceRoot, {
    pid: process.pid,
    socket,
    startedAt: new Date().toISOString(),
    instanceId: identity.instanceId,
    ...(port !== undefined ? { port } : {}),
    ...(token !== undefined ? { token } : {}),
  });

  return { socket, ...(port !== undefined ? { port } : {}), stop };
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
  const workspaceRoot = process.argv[2] ?? process.env['AGBRTE_WORKSPACE_ROOT'];
  if (workspaceRoot === undefined) {
    process.stderr.write('usage: agbrte-host <workspace-root>\n');
    process.exit(2);
  }

  const lingerEnv = Number(process.env['AGBRTE_HOST_LINGER_MS']);

  /**
   * How this host is reached, set by whatever started it (§6.2).
   *
   * Not a user-facing switch: choosing loopback where a socket works trades an
   * OS-enforced permission for a bearer token, which is strictly worse. It is
   * set by a transport that has no choice — a WSL distribution, a container, a
   * pod, or a **Windows machine**, where the alternative is a named pipe and
   * `ssh -L` cannot forward one.
   *
   * **This line is why the loopback channel existed and could not be used.** It
   * was written when that channel was built and never reached the file — a
   * find-and-replace that matched nothing and said nothing about it — so
   * `control` kept its default, and the only way to get a loopback host was to
   * call `startSessionHost` in process, which is exactly what its tests do. The
   * channel had thirteen tests and the binary that ships had no way to turn it
   * on. Found by trying to use it for real from the Windows bootstrap, which is
   * the only thing that would have found it.
   */
  const control = process.env['AGBRTE_HOST_CONTROL'] === 'loopback' ? 'loopback' : 'socket';

  startSessionHost({
    workspaceRoot,
    control,
    ...(Number.isFinite(lingerEnv) ? { lingerMs: lingerEnv } : {}),
  })
    .then((host) => {
      // The port, never the token: this line goes to a log file on the remote.
      process.stderr.write(
        `agbrte-host listening on ${
          host.port === undefined ? host.socket : `127.0.0.1:${host.port}`
        }\n`,
      );
      const shutdown = (): void => {
        void host.stop().then(() => process.exit(0));
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    })
    .catch((err: unknown) => {
      process.stderr.write(`agbrte-host failed to start: ${String(err)}\n`);
      process.exit(1);
    });

  // A failing adapter must not take down the process that owns the log.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(`agbrte-host unhandled rejection: ${String(reason)}\n`);
  });
}

/**
 * Which bundle this host is executing, from its own first line.
 *
 * The build stamps `// agbrte-bundle: <version>` onto `agbrteHost.js`, and
 * `uploadHostBundle` stamps a deployed copy the same way, so every host can
 * answer the question the remote probe was already asking about files on disk:
 * *is this the current code?* A running host keeps executing the bundle it
 * started with, which is precisely why deploying a newer one changes nothing
 * until someone restarts it — and why a client needs to be told.
 *
 * Read from `process.argv[1]` rather than baked in at compile time. A constant
 * would be the version of the source that was *built*, which is the same number
 * right up until the interesting case: a bundle deployed to a remote machine by
 * one client and inspected by another. The file itself is the artefact both are
 * talking about.
 *
 * `null` for anything unstamped — a `tsx src/host/hostMain.ts` during
 * development, or a bundle from before this existed. Absent rather than
 * guessed: a wrong version here would make a current host look stale, and the
 * offered remedy is to restart it.
 */
function readOwnBundleVersion(): string | null {
  const self = process.argv[1];
  if (self === undefined) return null;
  try {
    // Only the first line is needed and the bundle is megabytes; reading all of
    // it to look at 30 bytes is work every host would do at every start.
    const handle = openSync(self, 'r');
    try {
      const head = Buffer.alloc(256);
      const read = readSync(handle, head, 0, head.length, 0);
      const first = head.subarray(0, read).toString('utf8').split('\n', 1)[0] ?? '';
      const match = /^\/\/ agbrte-bundle: (.+)$/.exec(first.trim());
      return match?.[1]?.trim() ?? null;
    } finally {
      closeSync(handle);
    }
  } catch {
    // Unreadable is the same answer as unstamped: nothing can be claimed.
    return null;
  }
}
