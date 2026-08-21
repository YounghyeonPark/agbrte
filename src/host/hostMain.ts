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
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import type { ModelNeed } from '@main/runtime/registry.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { HostSupervisor } from '@main/host/supervisor.js';
import { openWorkspace, peekIdentity } from '@main/store/identity.js';
import { listen, hostSocketPath } from '@shared/host/socketChannel.js';
import { listenLoopback, newControlToken } from '@shared/host/loopback.js';
import { PreviewServers } from '@main/preview/servers.js';
import { Shells } from '@main/terminal/shell.js';
import { TerminalPrograms } from '@main/terminal/programs.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { HostCommand, HostMessage, MainSideChannel } from '@shared/host/protocol.js';
import { SessionHostServer, type HostWorkspace, type ShellOwner } from './sessionServer.js';
import { decideRole, loadAccessPolicy } from './accessPolicy.js';
import { localIdentity } from './identity.js';
import { machineIdentity } from './machine.js';
import type { AccessRole } from '@shared/types/index.js';
import { clearHostRecord, clearMachineRecord, writeHostRecord, writeMachineRecord } from './discovery.js';
import { refuseIfHeldElsewhere } from './legacyHost.js';
import { readKnownWorkspaces, writeKnownWorkspaces } from './workspaces.js';
import { addEndpoint } from './endpoints.js';
import { addManagedToolsToPath } from './managedTools.js';

/**
 * No console window for anything this host starts (§6.2).
 *
 * The host is spawned `detached`, and on Windows that means it has **no console
 * of its own** — so when it starts a child that is a console program, Windows
 * gives that child a brand new console, and on Windows 11 the thing that draws
 * one is a Windows Terminal window. One per agent host: a test run that starts
 * nineteen hosts opened nineteen windows over whatever the developer was doing,
 * and a user whose session forks an agent got one too.
 *
 * Counted rather than reasoned about, after two wrong theories: 19 windows from
 * `hostUpdate.test.ts`, 7 from `detachedHost`, 3 from `machineHost`, 0 from
 * every suite that starts no host. Putting the flag on the *host's own* spawn
 * cannot help — `CREATE_NO_WINDOW` is ignored when `DETACHED_PROCESS` is set —
 * so it belongs here, on what the detached process starts.
 *
 * Typed wider than `ForkOptions` because @types/node leaves `windowsHide` off
 * it, while `fork` forwards its options to `spawn`, which honours it.
 */
const noConsoleWindow: ForkOptions & { windowsHide: boolean } = { windowsHide: true };

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
  /**
   * The workspace this host is started for.
   *
   * Still one path, and still required, because a host is always started
   * *because of* a folder — somebody opened one. It is no longer the whole of
   * what the host serves: everything this machine has served before is restored
   * beside it, and clients open more with `workspace.open` (§8).
   */
  workspaceRoot: string;
  /**
   * Where this machine's own directory is. Defaults to the real `~/.agbrte`.
   *
   * Injectable for one reason and it is not tidiness: the machine registry and
   * the machine host record are *global*, so a test that used the real one would
   * make every other test's temporary workspace a folder this host tries to
   * reopen — and would consume §5.3 relocation signals in the developer's own
   * projects. A global with no seam is a global every test shares.
   */
  home?: string;
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
  // Minted on first start and read every time after. A machine's identity is
  // not a workspace's: see `machineIdentity`.
  const machine = await machineIdentity();
  /*
   * Keyed by the machine, which is what makes two hosts on one machine
   * impossible rather than merely discouraged (§8).
   *
   * Every host on this machine computes this same path, so the second one loses
   * the bind — and `listen` then asks the only question that settles it: is
   * anything actually there. Something answering is a live host and this one
   * refuses to start, saying so; nothing answering is debris from an unclean
   * death and is removed. That handling is §17 Q9's and is unchanged by the
   * move; only what the path is derived from changed.
   */
  const socket = hostSocketPath(machine.machineId);

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
          ...noConsoleWindow,
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

  const bundleVersion = readOwnBundleVersion();
  const identityOf = localIdentity();
  const home = opts.home;

  // Declared here rather than beside the listener below: the server closes over
  // `port` to exclude its own control channel from the preview list, and a `let`
  // declared after the closure is written is legal but reads like a bug.
  let port: number | undefined;
  let token: string | undefined;

  let server!: SessionHostServer;
  let listener!: Server;
  /**
   * Whether the socket is bound yet.
   *
   * The pointer record a workspace gets names the socket, so it cannot be
   * written before there is one to name — and a record pointing at a socket
   * nobody answers sends every client down the stale path for no reason (§6.4).
   * So opening a workspace before the listener is up registers it and defers the
   * record; the bind writes them all.
   */
  let listening = false;

  /**
   * The workspaces this host holds, keyed by resolved path (§8).
   *
   * Keyed by path here and by `instanceId` in the manager, and the difference is
   * deliberate: this map answers "which folder did the client name", which is a
   * path question, while the manager answers "where does this session write",
   * which must survive a move and therefore cannot be.
   */
  const held = new Map<string, HostWorkspace>();

  /**
   * The user's own terminals, in one workspace, on this machine.
   *
   * Here rather than in main for the reason §6.8 gives for preview servers: the
   * host is the process that owns the workspace, so `cwd` is the workspace by
   * construction and a host on another machine gives you *that* machine's
   * shell. It is also the process that can afford to drain a PTY — §8's rule is
   * that main must never block, and a terminal is the loudest thing in the app.
   *
   * One supervisor per workspace, because `cwd` is the whole of what it is for:
   * a single one for a machine holding four repositories would open every
   * terminal in whichever folder happened to be first.
   *
   * The output sink posts to exactly one client's channel. Every other push in
   * this protocol is broadcast because it describes the session, which is
   * shared; this one describes one person's screen, and a second device
   * receiving it would be a leak rather than a feature.
   */
  const shellsFor = (root: string): Shells<ShellOwner> =>
    new Shells<ShellOwner>(root, {
      /*
       * What a pane may open, built from what this host already decided.
       *
       * Not a second detection pass. `available` is the list `admit()` consults
       * and the list the picker draws, and `runtimeNotes` is the sentence the
       * picker shows beside a CLI it cannot offer — so a pane can open exactly
       * the CLIs the picker offers, and refuses the rest with the wording
       * already on screen, by construction. Detecting again here would have been
       * two answers to one question about one machine, which is how the runtime
       * list and the admission gate disagreed once already.
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

  /**
   * The pointer record, left in a workspace this host has opened (§8).
   *
   * Not for us — we know where we are listening. For the two readers who cannot
   * be told any other way: a **released client**, which knows only how to look
   * in the workspace and would otherwise start its own host here, and a
   * **current client** about to open this folder, which has to be able to tell
   * an older per-workspace host from one of ours. `machineId` is what says
   * which, and it is the field `legacyHost.ts` reads.
   */
  const publish = async (workspace: HostWorkspace): Promise<void> => {
    await writeHostRecord(workspace.info.root, {
      pid: process.pid,
      socket,
      startedAt: new Date().toISOString(),
      instanceId: workspace.info.instanceId,
      machineId: machine.machineId,
      ...(port !== undefined ? { port } : {}),
      ...(token !== undefined ? { token } : {}),
    });
  };

  /**
   * Open a folder and start serving it.
   *
   * Idempotent by path, and the recording is not: §5.3 says writing
   * `lastKnownPath` *consumes* the relocation signal and only an owner may spend
   * it, so a client asking for a folder records and a startup restore does not.
   * A workspace already held is therefore still passed through `addWorkspace`
   * when a client asks, which is what spends the signal at the moment somebody
   * is there to be told about the move.
   */
  const openHostWorkspace = async (
    root: string,
    o: { record: boolean },
  ): Promise<HostWorkspace> => {
    const key = resolve(root);
    // Before anything is created or registered. A second writer on one log is
    // the failure this check exists for, and a gate a client can skip is not a
    // gate (§13) — so it is here, in the host, as well as in the client.
    await refuseIfHeldElsewhere(key, { socket, machineId: machine.machineId });

    const workspace = await manager.addWorkspace(key, { record: o.record });
    const already = held.get(key);
    if (already !== undefined) return already;

    /*
     * A workspace that moved is re-keyed, not held twice (§5.3).
     *
     * The manager resolves one checkout turning up at a second path — a rename
     * rather than a copy — and this map is keyed by path, so the old key would
     * otherwise sit here pointing at a directory that is gone. Its preview
     * servers and terminals go with it, because their `cwd` is that directory:
     * a shell whose working directory has been renamed out from under it is a
     * process blocked in a place that no longer exists, and keeping it would be
     * keeping the appearance of a terminal rather than one.
     */
    for (const [oldKey, entry] of held) {
      if (entry.info.instanceId !== workspace.instanceId) continue;
      entry.servers?.stopAll();
      entry.shells?.closeAll();
      held.delete(oldKey);
      await clearHostRecord(entry.info.root).catch(() => undefined);
    }

    // Read before it is served, so a malformed policy refuses the workspace
    // rather than being discovered by the first client it silently over-grants.
    const policy = await loadAccessPolicy(workspace.root);
    const lineage = (await peekIdentity(workspace.root))?.lineageId ?? identity.lineageId;
    const entry: HostWorkspace = {
      info: {
        instanceId: workspace.instanceId,
        lineageId: lineage,
        root: workspace.root,
        ...(workspace.relocatedFrom !== undefined ? { movedFrom: workspace.relocatedFrom } : {}),
      },
      // §6.8: preview servers belong to the host, not to a turn — that is the
      // whole point of §3.12's reaping being something to work around.
      servers: new PreviewServers(workspace.root),
      shells: shellsFor(workspace.root),
      grantRole: (requested: AccessRole, client: string) => ({
        role: decideRole(policy, requested, client, identityOf.ceiling),
        actor: identityOf.actor,
      }),
    };
    held.set(key, entry);
    await writeKnownWorkspaces(
      [...held.values()].map((w) => ({ root: w.info.root, instanceId: w.info.instanceId })),
      home,
    );
    if (listening) await publish(entry);
    return entry;
  };

  // The workspace this host was started for, opened before it listens: a host
  // that accepts a connection and then cannot say what it holds is a host that
  // answers `welcome` with nothing in it.
  await openHostWorkspace(workspaceRoot, { record: true });

  /*
   * Everything this machine has served before, restored as a *hint* (§8).
   *
   * The requirement is that sessions in a folder nobody has opened this launch
   * are still findable, and `listOnDisk` is what answers it — which it can only
   * do for folders the manager knows about. Restored with `record: false`,
   * because reading a list is not a person asking for a folder, and failures are
   * skipped rather than fatal: a deleted folder, an unmounted volume and a
   * workspace held by an older host are all ordinary, and none of them is a
   * reason a host should not start.
   */
  for (const known of await readKnownWorkspaces(home)) {
    if (held.has(resolve(known.root))) continue;
    try {
      await openHostWorkspace(known.root, { record: false });
    } catch {
      // Reported by absence: it is not in `workspace.list`, which is the honest
      // answer to "what is this host holding".
    }
  }

  const stop = async (): Promise<void> => {
    /*
     * The listener goes first, before anything slow.
     *
     * A host answers `{stopped:true}` and then runs this on the next tick, so
     * everything in between is a window where it still *accepts* — and a client
     * restarting it dials in that window and is handed a whole handshake by the
     * process it just retired. It then reports the update a success against the
     * old code: on a machine whose bundle had gone missing, `updateHost`
     * resolved where it had to refuse. Closing here makes the socket answer
     * `ECONNREFUSED`, which the connect probe already reads as "nothing there",
     * so the replacement is spawned or the failure is named.
     *
     * This used to sit below the teardown, under a comment about a preview
     * server outliving its host. That reason is real and is about the *process*
     * finishing its work — not about the door staying open while it does.
     */
    listener.close();
    // A preview server outliving the host that started it is a port answering
    // with nothing to explain it, and nothing left that knows how to stop it.
    for (const workspace of held.values()) {
      workspace.servers?.stopAll();
      // And every terminal, for the stronger reason: a shell survives its reader
      // only as a process blocked on a prompt nobody can answer.
      workspace.shells?.closeAll();
    }
    server.stop('host stopping');
    supervisor.dispose();
    // Every pointer as well as the machine's own record. A pointer left behind
    // is what sends the next client to a socket nobody answers — and worse, on
    // the released build, is indistinguishable from a host that is alive.
    await clearMachineRecord(home);
    await Promise.all([...held.values()].map((w) => clearHostRecord(w.info.root)));
  };

  server = new SessionHostServer({
    manager,
    identity: {
      // Which machine, as distinct from which checkout (§5.2). Read from
      // `~/.agbrte/machine.json` at start rather than per handshake: it does not
      // change while a host runs, and a file read per connection would be work
      // done once per client to answer a constant.
      machineId: machine.machineId,
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
    /*
     * The machine's answer, for a connection bound to no workspace.
     *
     * A bound connection gets the *workspace's* policy instead (§8.2):
     * `.agbrte/access.json` is per workspace and always has been, because "the
     * phone watches this repository" is a sentence about a repository. This one
     * is what a client attaching the machine gets, and it is the identity the
     * socket already proved rather than a second, weaker door.
     */
    grantRole: (requested, client) => ({
      role: decideRole(null, requested, client, identityOf.ceiling),
      actor: identityOf.actor,
    }),
    // Asked live rather than captured, because `workspace.open` changes the set
    // while this host runs and a snapshot would make every later handshake
    // describe the machine as it was when it started.
    workspaces: () => [...held.values()],
    openWorkspace: (root) => openHostWorkspace(root, { record: true }),
    controlPort: () => port,
    lingerMs: opts.lingerMs ?? DEFAULT_LINGER_MS,
    // Whatever the reason — the idle timer, or a client asking — the process
    // goes. A host that stops serving but keeps its socket is worse than one
    // that never stopped: the next client finds it and believes it is live.
    /*
     * Stop accepting the instant a stop is agreed (§6.3).
     *
     * `stop()` below closes the listener too, but it runs on the next tick and
     * a loaded process can take much longer than that to reach it — which is
     * exactly when a client restarting this host dials and is welcomed by the
     * process it just retired. Closing here is idempotent with the close in
     * `stop()`, and cheap: it refuses new connections and touches nothing that
     * is already running.
     */
    onAgreedToStop: () => listener.close(),
    onStopped: (reason) => {
      if (opts.onStopped !== undefined) {
        void stop().then(() => opts.onStopped?.(reason));
        return;
      }
      void stop().then(() => process.exit(0));
    },
  });

  /*
   * Every record, written the moment there is something true to say.
   *
   * The order used to be "listen, then record", on the rule that a record
   * pointing at a socket nobody answers sends every client down the stale path.
   * That rule is about a record left by a *dead* host, and §6.4 already answers
   * it a better way: the record is a hint and every reader probes the socket, so
   * a record that is briefly early costs a client one failed probe and a retry.
   *
   * A record that is briefly **late** costs more, and that is the asymmetry.
   * The workspace pointer exists so a client from before v21 finds this host
   * instead of starting its own (§8), and in the window between the socket
   * opening and the pointer landing that client sees an empty folder and spawns
   * a second writer onto one log. Narrow, and the one failure §5.1 does not
   * survive. It also made a test flaky, which is how it was noticed: a client
   * can connect the instant the socket accepts, and reading the pointer then
   * found nothing.
   *
   * So the records go out as early as each transport allows. A socket path is
   * known before the bind, so those are written first and cleared if the bind
   * fails. A loopback port is not known until it is bound, so that one keeps the
   * old order and keeps the old window — stated rather than hidden, and it is
   * the transport a released client cannot reach anyway (§6.2).
   */
  const writeRecords = async (): Promise<void> => {
    await writeMachineRecord(
      {
        pid: process.pid,
        socket,
        startedAt: new Date().toISOString(),
        instanceId: identity.instanceId,
        machineId: machine.machineId,
        ...(port !== undefined ? { port } : {}),
        ...(token !== undefined ? { token } : {}),
      },
      home,
    );
    // The machine's own first, because that is the one a current client looks
    // for; the per-workspace pointers after it, for the released client that
    // knows only how to look in a folder.
    for (const workspace of held.values()) await publish(workspace);
  };

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
    listening = true;
    await writeRecords();
  } else {
    // Before the bind, so no client can arrive ahead of the pointer that tells
    // an older one not to start its own host here. Cleared if the bind fails, so
    // a host that never came up leaves nothing claiming it did.
    listening = true;
    await writeRecords();
    try {
      listener = await listen<SessionMessage, SessionCommand>(socket, (channel) =>
        server.accept(channel),
      );
    } catch (err) {
      await clearMachineRecord(home);
      await Promise.all([...held.values()].map((w) => clearHostRecord(w.info.root)));
      throw err;
    }
  }

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
