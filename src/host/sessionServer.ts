/**
 * The session host (DESIGN.md §6.4, §8).
 *
 * Owns a workspace's `SessionManager`, and therefore its event log, its
 * permission gate, and its turn queues. Serves any number of connected clients.
 *
 * This is what makes "the session keeps running when the app closes" true.
 * Detaching a process is not enough on its own: if the app still owned the log,
 * a running agent's events would have nowhere to go the moment it quit — the
 * work would continue and the transcript would not, which is worse than
 * stopping.
 *
 * ## One owner, many clients
 *
 * Every connection gets the same `SessionManager`. That is what makes two
 * devices see one session rather than two copies of it, and why the turn queue
 * and the pending-permission set live here rather than in a client.
 *
 * A client leaving is uneventful by construction: it holds no session state to
 * lose. Work in flight belongs to this process.
 *
 * ## Transport-free
 *
 * Takes channels, never sockets. The tests drive it over an in-memory pair, and
 * the same class serves a unix socket, a named pipe, or an SSH stream in Phase 5.
 */

import { listListeningPorts, type ListeningPort } from '@main/preview/ports.js';
import type { EndpointModels, ModelInstallProgress } from '@shared/host/protocol.js';
import type { PreviewServers } from '@main/preview/servers.js';
import type { Shells } from '@main/terminal/shell.js';
import {
  deleteTemplate,
  fromSession,
  listTemplates,
  readTemplate,
  saveTemplate,
} from '@main/store/templates.js';
import {
  AccessDenied,
  newAgentId,
  type AccessRole,
  type Actor,
  type AgentId,
  type AgentSpec,
  type InstanceId,
  type LineageId,
  type PermissionRequest,
  type Session,
  type ModelCapabilityHint,
  type RuntimeCapabilities,
  type SessionId,
  type Sha256,
} from '@shared/types/index.js';
import { BlobIntake } from '@main/store/blobTransfer.js';
import { listDirectory, readTextFile } from '@main/workspace/files.js';
import { searchWorkspace } from '@main/store/searchSessions.js';
import { resolve } from 'node:path';
import {
  MIN_CLIENT_PROTOCOL,
  SESSION_PROTOCOL_VERSION,
  type EndpointAdded,
  type HostIdentity,
  type HostSideSessionChannel,
  type RequestId,
  type SessionCommand,
  type WorkspaceInfo,
} from '@shared/host/sessionProtocol.js';
import type { SessionManager } from '@main/sessionManager.js';

/**
 * One workspace this host holds, with what belongs to it (§8, §9).
 *
 * A host is one per machine and holds several folders, so everything that was a
 * property of "the workspace" is now a property of *a* workspace and lives here:
 * its identity, its preview servers, its terminals, and the access policy that
 * decided what a client connecting for it may do. Grouped in one object rather
 * than four parallel maps because they are created and discarded together, and
 * four maps is four chances to leave one entry behind.
 */
export interface HostWorkspace {
  info: WorkspaceInfo;
  /** Runs preview servers for this folder (§6.8). Absent means it will not. */
  servers?: PreviewServers;
  /** The user's own terminals in this folder. Absent means it will not open one. */
  shells?: Shells<ShellOwner>;
  /**
   * What role a client connecting *for this workspace* gets (§8.2).
   *
   * Per workspace because `.agbrte/access.json` is per workspace and always has
   * been: "the phone watches this repository" is a sentence about a repository.
   * A client bound to no workspace falls back to the host-level function, which
   * is the machine's own answer.
   */
  grantRole?: (requested: AccessRole, client: string) => { role: AccessRole; actor: Actor };
}

/**
 * What a host says about itself, minus what only it can fill in.
 *
 * Machine-level facts plus **the workspace it was started with**. The second
 * half is kept in this shape — rather than a `workspaces` array — because every
 * caller that constructs a host directly (`agbrte serve`, the smoke run, and
 * every test) has exactly one folder to give, and a host that holds exactly one
 * has nothing to disambiguate. `hostMain` supplies the real table through
 * `workspaces` and this becomes the default binding.
 */
export interface HostSelfDescription {
  machineId?: string;
  instanceId: InstanceId;
  lineageId: LineageId;
  workspaceRoot: string;
  movedFrom?: string;
  runtimes: string[];
  runtimeNotes?: Array<{ id: string; label: string; reason: string }>;
  endpoints?: HostIdentity['endpoints'];
  unavailableReason?: string;
  bundleVersion?: string;
}

export interface SessionHostOptions {
  manager: SessionManager;
  /** Runs preview servers for §6.8. Absent means this host will not start processes. */
  servers?: PreviewServers;
  /**
   * The user's own terminals in this workspace.
   *
   * Absent means this host will not open one — a host constructed without it, or
   * one whose machine has no PTY binary beside the bundle. Refused by name
   * rather than silently unavailable, because a dark button teaches people the
   * feature does nothing.
   *
   * Constructed by the caller and handed in, because the *sink* for its output
   * is this server: it has to reach one client's channel and no other, and only
   * this file knows which channel that is.
   */
  shells?: Shells<ShellOwner>;
  identity: HostSelfDescription;
  /**
   * Every workspace this host holds, asked live.
   *
   * A function rather than a value because the set changes while the host runs —
   * `workspace.open` adds to it — and a snapshot taken at construction would
   * make every later handshake describe a machine as it was when it started.
   *
   * Absent means "just the one in `identity`", which is what `agbrte serve` and
   * every direct construction mean.
   */
  workspaces?: () => HostWorkspace[];
  /**
   * Open a folder on this machine (§8).
   *
   * Absent means this host will not open one, which is the honest state for a
   * server constructed around a single workspace: `workspace.open` is refused by
   * name rather than silently succeeding against a folder nothing would serve.
   */
  openWorkspace?: (root: string) => Promise<HostWorkspace>;
  /**
   * Decides what role a client gets, and who the log will say it was.
   *
   * One function for both because they are one question. A role that is not
   * anchored to an identity records "someone with write access did this", which
   * is not an answer, and an identity that grants nothing is decoration.
   *
   * Defaults to granting what was asked, attributed to the workspace's owner.
   * That is right for a `0600` socket, where reaching it already *is* the proof
   * (`host/identity.ts`). A multi-user host replaces this rather than bolting
   * authorization on somewhere else.
   */
  grantRole?: (requested: AccessRole, client: string) => { role: AccessRole; actor: Actor };
  /**
   * What each endpoint currently serves, asked live (§3.8).
   *
   * A callback because the answer lives in the *agent* host, which this server
   * reaches only through the supervisor that `hostMain` owns. Absent means the
   * question cannot be answered here — `agbrte serve` with no agent host, for
   * instance — and the command says so rather than returning an empty list,
   * which a client would show as "this machine has no models".
   */
  models?: () => Promise<EndpointModels[]>;
  /**
   * Whether this machine can open a terminal, asked live (§7).
   *
   * A function and not a field on the identity, for the same reason `models` is
   * one: the answer changes under a running host. A remote is given the pty
   * module while its host is already serving, and a value captured at startup
   * would keep saying "no terminal here" until somebody restarted it — which is
   * a thing nobody would think to do, because the deploy said it had succeeded.
   *
   * Named apart from `shells`, which is the terminal *service* an embedder
   * passes in: this answers whether one could be opened, not what opens them.
   */
  canOpenShells?: () => boolean;
  /**
   * What one model can actually do (§3.3), for a client about to choose it.
   *
   * A separate callback from `models` for the same reason it is a separate
   * command: this one probes and that one does not. Absent means this host
   * cannot answer — `agbrte serve` with no agent host — and the command says so
   * rather than returning an empty hint, which reads as "asked, nobody knows".
   */
  modelCapabilities?: (endpointId: string, modelId: string) => Promise<ModelCapabilityHint>;
  /** Starts a pull and reports on every one started. Absent where nothing can. */
  installModel?: (endpointId: string, tag: string) => Promise<void>;
  installProgress?: () => Promise<ModelInstallProgress[]>;
  /**
   * Write a model endpoint into this host's `endpoints.json` (§6.5, §13).
   *
   * A callback, like `models` beside it, so this file never imports the module
   * that touches a credential — the key passes through as an argument to
   * something `hostMain` supplied and is not held here, not defaulted here, and
   * not describable from here.
   *
   * Absent means this host will not write one, which is the honest state for a
   * server constructed without a home directory to write into. Said by name
   * rather than silently succeeding.
   */
  addEndpoint?: (input: {
    id: string;
    label?: string;
    provider: string;
    baseUrl: string;
    apiKey?: string;
  }) => Promise<EndpointAdded>;
  /**
   * Called whenever this server stops serving, for any reason.
   *
   * Named for the *fact* rather than for one cause, because it had one cause and
   * that was the bug: it fired on the idle timer only, so a client asking the
   * host to shut down got an acknowledgement while the process stayed up holding
   * its socket — still accepting connections, still answering. `agbrte stop`
   * reported success and left a host behind, and the next client to compute that
   * socket found the zombie rather than starting a replacement.
   */
  onStopped?: (reason: string) => void;
  /**
   * Called synchronously once a stop has been agreed, before it happens.
   *
   * For closing the door only: whoever owns the listener stops accepting here,
   * so a client that dials on the strength of `{stopped:true}` finds nothing
   * rather than being welcomed by a host on its way out.
   */
  onAgreedToStop?: () => void;
  /**
   * This host's own control port, when it listens on one (§6.2's loopback mode).
   *
   * A function because the server is constructed before the listener binds, and
   * the port is whatever the OS chose. Passing a number here would have meant
   * passing `undefined` forever — which is what it did until something looked.
   */
  controlPort?: () => number | undefined;
  /** Milliseconds with no client and no work before exiting. 0 disables. */
  lingerMs?: number;
  now?: () => number;
}

/**
 * The token a terminal is opened under, and the way back to its one reader.
 *
 * Handed to `Shells` instead of the `Client` itself so the supervisor holds
 * something it can only `post` to — it has no access to the role, the actor, or
 * the channel's `close`. Identity is the object, which is why it is minted once
 * per connection and never recreated: two clients cannot collide, and a client
 * cannot name another's shell because it has no way to produce that object.
 */
export interface ShellOwner {
  post(message: Parameters<HostSideSessionChannel['post']>[0]): void;
}

interface Client {
  channel: HostSideSessionChannel;
  role: AccessRole;
  label: string;
  /** This connection's terminals, keyed by the object `Shells` compares. */
  shellOwner: ShellOwner;
  /**
   * Fixed at handshake, never re-read.
   *
   * A turn can outlive the connection that sent it, and the log must say who
   * sent it rather than who is still attached when it finishes.
   */
  actor: Actor;
  /**
   * The workspace this connection was bound to at `hello`, or `null`.
   *
   * Fixed for the connection's life. Mutable binding was the obvious
   * alternative and is a trap: a command's meaning would then depend on when it
   * was sent relative to a rebind, and two clients racing a rebind on one socket
   * is not a thing this protocol should be able to express.
   *
   * `null` is a *machine* connection — one that attached the box and no folder.
   * It can list what is here, ask about models and retire the host; every
   * workspace-scoped command is refused by name.
   */
  workspace: HostWorkspace | null;
  /**
   * Whether a `hello` has been *received* on this channel.
   *
   * Set synchronously as the message arrives, not when it has been handled —
   * which is the distinction the flag exists for. Framing preserves order, so a
   * command that arrives after a `hello` sees this set even though the handshake
   * is still in flight.
   */
  helloSeen: boolean;
  /**
   * Resolves when the handshake has finished, including binding the workspace.
   *
   * `hello` became asynchronous when a connection started naming the folder it
   * wants — the host may have to *open* it — and that turned "always first" from
   * a fact about the wire into a race. A client posts `hello` and calls in the
   * same tick, which is the ordinary case for `HostConnection`; both were
   * dispatched, the second overtook the first at its `await`, and the command
   * ran against a connection that had not been bound or had its role granted
   * yet. Serialising *everything* would be the heavy fix and would cost the
   * concurrency this server has always had; waiting only for the handshake costs
   * nothing and is what the protocol already claims.
   */
  handshake: Promise<void>;
  handshakeDone: () => void;
}

export class SessionHostServer {
  private readonly clients = new Set<Client>();
  /**
   * Partial blob transfers, held in memory (§6.7).
   *
   * Per host rather than per client, which is what makes a transfer resumable
   * across a reconnect: the laptop that dropped its connection halfway through a
   * screenshot comes back as a *new* client and continues from where the host
   * already is, rather than starting again because its old staging left with it.
   */
  private readonly intake = new BlobIntake();
  /**
   * Workspaces opened through `openWorkspace`, for a host that does not track
   * them itself. Ignored when `opts.workspaces` answers — see `heldWorkspaces`.
   */
  private readonly opened = new Map<string, HostWorkspace>();
  private lingerTimer: NodeJS.Timeout | null = null;
  private closed = false;
  /**
   * Set the instant a stop is *agreed*, which is a tick before `closed`.
   *
   * `stop()` runs on the next turn of the loop so the acknowledgement wins the
   * race (see the `shutdown` handler), and the listener is closed synchronously
   * — but closing a listener is itself asynchronous down in libuv, and a busy
   * loop is exactly when it takes longest. A client that dials in that gap is
   * accepted by the kernel and dispatched here with `closed` still false, and
   * gets a full welcome from the process it just retired: `hosts.update` then
   * reports success against the code it set out to replace. This is the same
   * refusal as `closed`, moved to the moment the answer was promised.
   */
  private leaving = false;

  constructor(private readonly opts: SessionHostOptions) {
    const { manager } = opts;

    /*
     * Pushed to every client **working in that session's folder**.
     *
     * "Every attached client" was right while a host was one workspace, and
     * became a leak the moment it held several: a connection bound to one
     * project would receive another project's transcript, permission prompts and
     * queue depths — and the app, which holds one entry per workspace, would
     * show every session under every folder. Found end to end, by two hosts on
     * one machine each listing the other's sessions.
     *
     * A client that connected halfway through a turn still sees the rest of it,
     * because the events come from the manager rather than from any client's
     * subscription. That part is unchanged.
     */
    manager.on('event', (sessionId: SessionId, event: unknown) =>
      this.toWorkspaceOf(sessionId, { t: 'push.event', sessionId, event: event as never }),
    );
    manager.on('session', (session: unknown) =>
      this.toWorkspace((session as Session).instanceId, {
        t: 'push.session',
        session: session as never,
      }),
    );
    manager.on('permission', (request: unknown) =>
      this.toWorkspaceOf((request as PermissionRequest).sessionId, {
        t: 'push.permission',
        request: request as never,
      }),
    );
    manager.on('permission-resolved', (resolved: unknown) =>
      this.toWorkspaceOf((resolved as { sessionId: SessionId }).sessionId, {
        t: 'push.permissionResolved',
        resolved: resolved as never,
      }),
    );
    manager.on('queue', (sessionId: SessionId, agentId: AgentId, depth: number) =>
      this.toWorkspaceOf(sessionId, { t: 'push.queue', sessionId, agentId, depth }),
    );

    this.armLinger();
  }

  /** Attach a client. Called once per accepted connection. */
  accept(channel: HostSideSessionChannel): void {
    /*
     * A host that has stopped serves nobody, including whoever arrives next.
     *
     * `stop()` drops every client and hands the process to its owner to exit,
     * and this class does not own the listener — it takes channels, never
     * sockets, so it cannot know whether the thing feeding it connections has
     * been closed yet. A welcome sent from here after `stop()` is a promise the
     * process cannot keep: the client adopts a host whose next answer is the
     * socket dying, which is the ambiguous half-alive peer `hosts.update` kept
     * meeting. Closed at once instead, so the client sees "nothing is there" —
     * the one state every discovery path already knows how to handle.
     *
     * `leaving` rather than only `closed`, because `closed` is a tick too late
     * and one measurement said so: with `hostMain` closing its listener in the
     * same tick as the reply, an isolated run never reaches here — and a run
     * under a saturated machine did, welcomed the replacement's dial, and made
     * `hosts.update` report success against the host it had just retired. A
     * listener's close is asynchronous inside libuv, so a loaded loop widens the
     * very gap the close was meant to shut. This refusal does not depend on the
     * loop getting there, nor on the embedder's ordering — `agbrte serve` or a
     * loopback control port keeping its listener open a moment longer is served
     * the same answer.
     */
    if (this.closed || this.leaving) {
      channel.close();
      return;
    }

    // `read-only` until the handshake says otherwise, and an actor that claims
    // nothing. A connection that never says hello must not be able to write, and
    // must not be able to put a name on anything either.
    const client: Client = {
      channel,
      role: 'read-only',
      label: 'unknown',
      actor: { id: 'unknown', via: 'asserted' },
      shellOwner: { post: (message) => channel.post(message) },
      // Bound at `hello` and not before. A connection that never says hello can
      // reach nothing, which is the same rule its `read-only` role follows.
      workspace: null,
      helloSeen: false,
      handshake: Promise.resolve(),
      handshakeDone: () => undefined,
    };
    client.handshake = new Promise<void>((done) => {
      client.handshakeDone = done;
    });
    this.clients.add(client);
    this.cancelLinger();

    channel.onMessage((command) => {
      // Flagged here rather than inside `dispatch`, because `dispatch` is async
      // and this must be true the instant the message lands: it is what tells a
      // command that overtook the handshake that there *is* one to wait for.
      if (command.t === 'hello') client.helloSeen = true;
      void this.dispatch(client, command);
    });
    channel.onClose(() => {
      this.clients.delete(client);
      /*
       * Its terminals go with it, and this is the one place the shell differs
       * from every other thing this host owns.
       *
       * A session, a turn, a preview server: all of those deliberately outlive
       * the client that started them, because the whole design is that leaving
       * is not stopping. A terminal is the opposite — it is a *view*, it has
       * exactly one reader, and with that reader gone it is a program blocked on
       * a prompt nobody will answer, printing into a buffer nobody will read.
       */
      /*
       * Across every workspace, not just `opts.shells`.
       *
       * That field is the *single-workspace* shape a host built directly around
       * one folder passes (`agbrte serve`, and every test). `hostMain` supplies
       * a supervisor per workspace instead — `cwd` is the whole of what one is
       * for — and left this line reading a field it no longer sets, so a client
       * disconnecting from a real host reaped nothing at all. Every terminal it
       * had open stayed: a shell blocked on a prompt with its reader gone, which
       * is the one thing this handler exists to prevent.
       */
      for (const workspace of this.heldWorkspaces()) {
        workspace.shells?.closeOwned(client.shellOwner);
      }
      this.opts.shells?.closeOwned(client.shellOwner);
      // A departing client is not a reason to stop. It owns nothing.
      this.armLinger();
    });
  }

  /** Every client, whatever they are bound to. For facts about the host itself. */
  private broadcast(message: Parameters<HostSideSessionChannel['post']>[0]): void {
    for (const client of this.clients) client.channel.post(message);
  }

  /**
   * Every client bound to one workspace.
   *
   * A client bound to nothing gets nothing here, and that is the same rule its
   * refused commands follow: it attached a machine, not a project, and a
   * transcript it did not ask for is a leak rather than a courtesy.
   */
  private toWorkspace(
    instanceId: InstanceId,
    message: Parameters<HostSideSessionChannel['post']>[0],
  ): void {
    for (const client of this.clients) {
      if (client.workspace?.info.instanceId === instanceId) client.channel.post(message);
    }
  }

  /**
   * The same, for a push that names a session rather than a workspace.
   *
   * A session this manager has not loaded resolves to `null`, and nothing is
   * sent — *cannot say* rather than "send it to everyone", because the failure
   * of the second is silent and crosses a boundary.
   */
  private toWorkspaceOf(
    sessionId: SessionId,
    message: Parameters<HostSideSessionChannel['post']>[0],
  ): void {
    const instanceId = this.opts.manager.instanceOf(sessionId);
    if (instanceId === null) return;
    this.toWorkspace(instanceId, message);
  }

  private async dispatch(client: Client, command: SessionCommand): Promise<void> {
    const { manager } = this.opts;

    // Never before the handshake it followed. Only when one was seen, so a
    // connection that never says hello is served exactly as it was — capped at
    // `read-only` with no actor — rather than hanging on a promise nothing will
    // resolve.
    if (command.t !== 'hello' && client.helloSeen) await client.handshake;

    if (command.t === 'hello') {
      /**
       * The host decides whether it will serve this client.
       *
       * Only the *older* direction is refused, and only below the minimum: a
       * client newer than this host is fine, because it consults `protocol`
       * below and declines to send commands this host has never heard of.
       * Refusing it would be the behaviour that stranded every running host on
       * an additive bump.
       *
       * Absent means a client that predates negotiation, which is v1.
       */
      const speaks = command.protocol ?? 1;
      if (speaks < MIN_CLIENT_PROTOCOL) {
        client.channel.post({
          t: 'err',
          id: command.id,
          name: 'ClientTooOld',
          message:
            `this host serves session protocol v${MIN_CLIENT_PROTOCOL} and above; ` +
            `that client speaks v${speaks} — upgrade it`,
        });
        /**
         * Refused means disconnected, not "told no and left listening".
         *
         * Without this the client kept a channel whose role is the default
         * `read-only` and whose dispatch still served `session.list` and
         * `session.events` — so a client this host had just declined to serve
         * could read every transcript on it. §6.4 says a mismatch is "refused at
         * handshake"; a message is not a refusal.
         *
         * Found auditing §13 against today's code rather than by anything
         * failing, which is how the last two holes in this section turned up.
         */
        client.channel.close();
        client.handshakeDone();
        return;
      }

      /*
       * Bound *before* the role is decided, because the policy that decides it
       * is the bound workspace's (§8.2). Deciding first and binding after would
       * grant a role from one folder's `access.json` to a connection working in
       * another — exactly the "recorded and not enforced" failure §16 keeps
       * finding.
       */
      let bound: HostWorkspace | null;
      try {
        bound = await this.bindFor(command.workspace);
      } catch (err) {
        client.channel.post({
          t: 'err',
          id: command.id,
          name: 'WorkspaceUnavailable',
          message: err instanceof Error ? err.message : String(err),
        });
        client.channel.close();
        // Released even on the failing path: a command already queued behind
        // this one must fail on a closed channel rather than wait forever.
        client.handshakeDone();
        return;
      }
      client.workspace = bound;

      const decided = (bound?.grantRole ?? this.opts.grantRole)?.(command.role, command.client);
      const granted = decided?.role ?? command.role;
      client.role = granted;
      client.label = command.client;
      if (decided !== undefined) client.actor = decided.actor;
      client.channel.post({
        t: 'welcome',
        id: command.id,
        role: granted,
        identity: {
          ...(this.opts.identity.machineId !== undefined
            ? { machineId: this.opts.identity.machineId }
            : {}),
          workspaces: this.heldWorkspaces().map((w) => w.info),
          ...(bound === null ? {} : { workspace: bound.info }),
          runtimes: this.opts.identity.runtimes,
          ...(this.opts.identity.runtimeNotes !== undefined
            ? { runtimeNotes: this.opts.identity.runtimeNotes }
            : {}),
          ...(this.opts.canOpenShells !== undefined ? { shells: this.opts.canOpenShells() } : {}),
          ...(this.opts.identity.endpoints !== undefined
            ? { endpoints: this.opts.identity.endpoints }
            : {}),
          ...(this.opts.identity.unavailableReason !== undefined
            ? { unavailableReason: this.opts.identity.unavailableReason }
            : {}),
          ...(this.opts.identity.bundleVersion !== undefined
            ? { bundleVersion: this.opts.identity.bundleVersion }
            : {}),
          pid: process.pid,
          protocol: SESSION_PROTOCOL_VERSION,
          minProtocol: MIN_CLIENT_PROTOCOL,
        },
      });
      client.handshakeDone();
      return;
    }

    if (command.t === 'shutdown') {
      // Answered *before* stopping. `stop()` closes every channel, so replying
      // afterwards writes into a socket the client has already seen close — and
      // the client cannot then tell "it stopped because I asked" from "it died".
      try {
        this.requireWrite(client, 'shut the host down');
      } catch (err) {
        client.channel.post({
          t: 'err',
          id: command.id,
          message: err instanceof Error ? err.message : String(err),
          ...(err instanceof Error ? { name: err.name } : {}),
        });
        return;
      }

      // Refused while work is in flight. A detached host holding a live agent
      // must not go down because a window closed — that is the whole point of it
      // being detached.
      if (this.busy()) {
        client.channel.post({
          t: 'ok',
          id: command.id,
          value: { stopped: false, reason: 'work is still running' },
        });
        return;
      }

      client.channel.post({ t: 'ok', id: command.id, value: { stopped: true } });
      /*
       * The door shuts in this tick; the teardown can take its time.
       *
       * A client restarting this host dials again the moment it has this reply,
       * and until this host stops answering it is handed a whole handshake by
       * the process that just agreed to go — so the update reports success
       * against the code it set out to replace. Deferring the *whole* stop made
       * that window as wide as this process was busy, which is why it failed
       * under a loaded test suite and passed alone. Two things shut it, because
       * the listener alone was not enough: `leaving` refuses a dial in this
       * process, synchronously, and `onAgreedToStop` closes the listener so
       * there is nothing to refuse.
       */
      this.leaving = true;
      this.opts.onAgreedToStop?.();
      // After the reply has been posted, so the acknowledgement wins the race.
      setTimeout(() => this.stop('shutdown requested'), 0);
      return;
    }

    await this.reply(client, command.id, async () => {
      switch (command.t) {
        case 'session.list': {
          // The bound folder's sessions, not the machine's. A host holds several
          // now, and a client asked about one.
          const bound = this.bound(client, 'list sessions').info.instanceId;
          return (await manager.list()).filter((s) => s.instanceId === bound);
        }

        case 'preview.start': {
          // A write: it runs a command on this machine. The role check is the
          // point — a read-only client watching from a phone must not be able
          // to start processes on a build box.
          this.requireWrite(client, 'start a preview server');
          return this.servers(client).start(command.sessionId, command.command);
        }

        case 'preview.stop':
          this.requireWrite(client, 'stop a preview server');
          return this.servers(client).stop(command.serverId);

        case 'preview.servers':
          return this.servers(client).list(command.sessionId);

        case 'preview.log':
          return this.opts.servers?.log(command.serverId) ?? null;

        case 'template.list':
          return listTemplates(this.bound(client, 'list templates').info.root);

        case 'template.save': {
          // A write: it puts a file in the repo that colleagues will pull.
          this.requireWrite(client, 'save a session template');
          const session = await manager.get(command.sessionId as SessionId);
          return saveTemplate(
            this.bound(client, 'save a template').info.root,
            // The target comes from the client, which is the only side that
            // knows it — see `TemplateOrigin`. A v5 client sends none and the
            // template records none, exactly as before.
            fromSession(
              session,
              command.name,
              ...(command.target !== undefined ? [{ target: command.target }] : []),
            ),
          );
        }

        case 'template.delete':
          this.requireWrite(client, 'delete a session template');
          return deleteTemplate(this.bound(client, 'delete a template').info.root, command.templateId);

        case 'template.apply': {
          this.requireWrite(client, 'start a session from a template');
          const workspace = this.bound(client, 'start a session from a template');
          const template = await readTemplate(workspace.info.root, command.templateId);
          if (template === null) {
            throw new Error(`no template "${command.templateId}" in this workspace`);
          }
          /*
           * Refused before anything is created (§4.2).
           *
           * A session holds one agent, so a template naming two roles cannot be
           * applied at all. Checked here rather than left to `addAgent`'s
           * refusal because that one fires on the *second* seat — by then a
           * session exists, with one agent and a name taken from a template it
           * does not match, and the user has to notice and clean it up. Named
           * roles rather than a count: these files are committed and
           * hand-editable, so the message has to say what to edit.
           */
          if (template.roles.length > 1) {
            throw new Error(
              `the template "${template.name}" names ${template.roles.length} agents (` +
                `${template.roles
                  .map((r) => `${r.role} · ${r.model?.modelId ?? r.runtimeId}`)
                  .join(', ')}) and a session holds one. Edit the template to a single role, ` +
                `or start one session per agent and group them so the models can message ` +
                `each other.`,
            );
          }
          const created = await manager.createSession({
            title: command.title ?? template.name,
            goal: template.goal ?? template.name,
            // The folder the template came from. A manager holds several now
            // (§8), and a template is a fact about *this* repository — applying
            // one into whichever workspace happened to be first would put a
            // session for one project in another project's store.
            workspaceRoot: workspace.info.root,
          });
          for (const seat of template.roles) {
            // One at a time and not in parallel: `addAgent` is admission (§3.10),
            // and a roster that half-applies should stop at the seat that was
            // refused rather than racing three more past it.
            await manager.addAgent(created.sessionId, {
              role: seat.role,
              runtimeId: seat.runtimeId,
              ...(seat.model !== undefined ? { model: seat.model } : {}),
              ...(seat.systemPrompt !== undefined ? { systemPrompt: seat.systemPrompt } : {}),
              isolation: seat.isolation,
            });
          }
          return manager.get(created.sessionId as SessionId);
        }

        case 'preview.ports':
          // A read, like `session.search`: it answers about this machine, and
          // the narrowing that matters is by uid rather than by role — a
          // read-only client and a read-write one are the same person here.
          return this.listeningPorts();

        case 'session.search':
          // A read, so no `requireWrite`: it answers from logs a client with
          // any role can already read one at a time.
          return searchWorkspace(this.bound(client, 'search').info.root, command.query, {
            ...(command.limit !== undefined ? { limit: command.limit } : {}),
          });

        case 'session.listOnDisk': {
          /*
           * The bound folder's sessions on disk, and only those.
           *
           * The manager can answer for every folder it holds and deliberately
           * does not here: a connection is a workspace, and a client holding one
           * entry per folder would otherwise see each folder's sessions once per
           * entry. The machine-wide question has its own command —
           * `workspace.list` says which folders are here, and opening one is how
           * its sessions are seen.
           */
          const bound = this.bound(client, 'list sessions on disk').info.instanceId;
          return (await manager.listOnDisk()).filter((s) => s.instanceId === bound);
        }

        case 'workspace.list':
          // A read. Available to a `read-only` client on `files.list`'s
          // reasoning: a client that can read a transcript naming these folders
          // is not protected by withholding their names.
          return this.heldWorkspaces().map((w) => w.info);

        case 'workspace.open': {
          // A write: it creates `.agbrte/` where there is none, which is a
          // change to somebody's disk. A phone pinned to `read-only` by §7's
          // policy must not be able to make one on a build box.
          this.requireWrite(client, 'open a workspace');
          const opened = await this.bindFor(command.root);
          if (opened === null) {
            throw new Error(`could not open ${command.root} on this host`);
          }
          return opened.info;
        }

        case 'session.get':
          return manager.get(command.sessionId as SessionId);

        case 'session.create': {
          this.requireWrite(client, 'create a session');
          const input = command.input ?? { title: command.title, goal: command.goal };
          return manager.createSession(
            {
              ...input,
              /*
               * The connection's folder wins over anything the client named.
               *
               * A client asks for a workspace at `hello` and is answered with
               * the checkout it got; letting a later `session.create` name a
               * different one would make the binding advisory, and a binding
               * that can be stepped around is not what the access policy above
               * was applied to. A client that wants another folder opens
               * another connection, which is the same act stated honestly.
               */
              workspaceRoot: this.bound(client, 'create a session').info.root,
            },
            client.actor,
          );
        }

        case 'session.resume':
          // A read: loading a session from its log changes nothing about it.
          return manager.resumeSession(command.sessionId as SessionId);

        case 'session.addAgent':
          this.requireWrite(client, 'add an agent');
          return manager.addAgent(
            command.sessionId as SessionId,
            command.input as Parameters<SessionManager['addAgent']>[1],
            client.actor,
          );

        case 'session.send':
          this.requireWrite(client, 'send a turn');
          // Resolves when *this* turn completes, which may be after the client
          // that sent it has gone. The turn belongs to the host either way.
          await manager.send(
            command.sessionId as SessionId,
            command.agentId as AgentId,
            {
              // Text first, because it is what the person wrote and the blocks
              // are what they were pointing at. An image ahead of its caption
              // reads to a model as an image nobody explained.
              content: [
                ...(command.text !== '' ? [{ type: 'text' as const, text: command.text }] : []),
                ...(command.blocks ?? []),
              ],
            },
            client.actor,
          );
          return undefined;

        case 'session.interrupt':
          this.requireWrite(client, 'interrupt');
          await manager.interrupt(
            command.sessionId as SessionId,
            command.agentId as AgentId | undefined,
            client.actor,
          );
          return undefined;

        case 'session.setReasoning':
          // A write: it changes how the agent behaves on every later turn.
          this.requireWrite(client, 'setReasoning');
          await manager.setReasoning(command.sessionId as SessionId, command.agentId as AgentId, {
            mode: command.mode,
          });
          return undefined;

        case 'session.prepareSplit':
          // A write: it settles a proposal and decides a child, even though the
          // child is made elsewhere.
          this.requireWrite(client, 'answer a split');
          return manager.prepareSplit(
            command.sessionId as SessionId,
            command.proposalId,
            { approved: command.approved, ...(command.reason !== undefined ? { reason: command.reason } : {}) },
            client.actor,
          );

        case 'session.group':
          /*
           * A write, and not a marginal one. Grouping opens a channel *into*
           * every session named — a member can be woken by a sibling and spend
           * its budget answering — so a read-only client that could group is a
           * read-only client that can start work (§7, §17 Q14).
           */
          this.requireWrite(client, 'group sessions');
          return manager.groupSessions(
            command.sessionIds as SessionId[],
            command.name,
            command.groupId,
            client.actor,
          );

        case 'session.rename':
          // A write: a name is what every other client sees this session called,
          // and a read-only client changing it would be editing their screen.
          this.requireWrite(client, 'rename a session');
          return manager.renameSession(
            command.sessionId as SessionId,
            command.title,
            client.actor,
          );

        case 'session.ungroup':
          // A write for the mirror-image reason: it closes that channel, and
          // one client silencing another's group is not a read.
          this.requireWrite(client, 'remove a session from its group');
          return manager.ungroupSession(command.sessionId as SessionId, client.actor);

        case 'session.recordChild':
          this.requireWrite(client, 'record a child');
          await manager.recordChild(
            command.sessionId as SessionId,
            command.child,
            command.parentBudget,
            command.contract,
            client.actor,
          );
          return undefined;

        case 'blob.get': {
          /*
           * Ungated, like `session.events` and `session.snapshot` beside it.
           *
           * A read-only client can already read the transcript, and §7's
           * read-only role is *watching* — which includes seeing the screenshot
           * a turn was about. Gating this while leaving the summary readable
           * would withhold the picture and keep the caption.
           */
          const bytes = await manager.readBlob(
            command.sessionId as SessionId,
            command.sha256 as Sha256,
            command.mime,
          );
          return bytes === null ? null : bytes.toString('base64');
        }

        case 'session.events':
          return manager.events(command.sessionId as SessionId, command.fromSeq);

        case 'session.projection':
          return manager.projection(command.sessionId as SessionId);

        case 'session.queueDepth': {
          const session = manager.get(command.sessionId as SessionId);
          return session.agents.reduce(
            (total, agent) => total + manager.queueDepth(agent.agentId),
            0,
          );
        }

        case 'agent.rawLog':
          // A read, like `session.events` beside it: the same bytes a client
          // with any role already watches arrive parsed in the transcript,
          // minus the parsing. Gating it would withhold the raw form of what
          // the role is explicitly allowed to see.
          return manager.rawLog(command.sessionId as SessionId, command.agentId as AgentId);

        case 'runtime.capabilities':
          // The bound workspace's root, because §3.2 makes capabilities a
          // function of adapter, model *and* the directory a spec names — and a
          // host holding four folders would otherwise answer about whichever
          // one it happened to start with.
          return probeCapabilities(
            manager,
            this.bound(client, 'ask what a runtime can do').info.root,
            command.runtimeId,
          );

        case 'models.install': {
          // A write in the sense that matters: it puts gigabytes on somebody's
          // disk, on a machine that may not be theirs.
          this.requireWrite(client, 'install a model');
          const install = this.opts.installModel;
          if (install === undefined) throw new Error('this host cannot install models');
          await install(command.endpointId, command.tag);
          return null;
        }

        case 'models.progress':
          return (await this.opts.installProgress?.()) ?? [];

        case 'endpoints.add': {
          /*
           * A write, and the strongest case for that word in this switch.
           *
           * It changes where this host's turns can be sent, and every turn sent
           * there spends somebody's money. §7's `read-only` role exists so a
           * phone pinned by an access policy can watch a build box without
           * driving it; a client that could add a keyed endpoint could point
           * that box at an account it does not own.
           *
           * **Nothing about `command.endpoint` is logged, reported or echoed.**
           * The reply is `EndpointAdded`, the failure carries only the
           * validator's sentence, and the argument goes straight to the callback
           * that writes the file. `reply()` below turns a thrown error into its
           * `message`, which is exactly why the writer never interpolates a key
           * into one.
           */
          this.requireWrite(client, 'add a model endpoint');
          const add = this.opts.addEndpoint;
          if (add === undefined) {
            throw new Error(
              'this host cannot write endpoints — it was started without a place to keep them',
            );
          }
          return add(command.endpoint);
        }

        case 'models.list': {
          // A read: asking a server what it has changes nothing about the work.
          const ask = this.opts.models;
          if (ask === undefined) {
            throw new Error(
              'this host cannot list models — it is running without an agent host',
            );
          }
          return ask();
        }

        case 'models.capabilities': {
          /*
           * A read, and gated as one — but the cost is not a read's.
           *
           * It probes: for `openai-compatible` that is real inference requests
           * at whatever the endpoint charges. Not write-gated, because nothing
           * about the work changes and a read-only client choosing a model for a
           * session it may not start is a legitimate thing to do. What keeps it
           * from being a way to spend somebody's money is that the client asks
           * for one model at a time, for the one in front of a person.
           */
          const ask = this.opts.modelCapabilities;
          if (ask === undefined) {
            throw new Error(
              'this host cannot establish model capabilities — it is running without an agent host',
            );
          }
          return ask(command.endpointId, command.modelId);
        }

        case 'inbox.list': {
          // The bound folder's, for `session.list`'s reason: a client holding one
          // entry per folder aggregates across them itself (§8), so a host-wide
          // answer here would be counted once per entry.
          const bound = this.bound(client, 'read the inbox').info.instanceId;
          return (await manager.inbox(command.limit)).filter((e) => e.instanceId === bound);
        }

        case 'inbox.markRead':
          // Not gated on write access. Marking what *you* have read changes
          // nothing about the work, and a read-only client that cannot clear its
          // own badge would be told about the same thing forever.
          return manager.markInboxRead();

        case 'session.respondSplit':
          // Write access, because approving one creates a session and spends
          // budget — the two things a read-only client must not be able to do.
          this.requireWrite(client, 'answer a split proposal');
          return manager.respondSplit(
            command.sessionId as SessionId,
            command.proposalId,
            command.decision,
            client.actor,
          );

        case 'blob.has':
          /**
           * A write, despite the name — and that is why it is gated.
           *
           * `hasBlob` does not only answer; on a miss it *copies* the blob from
           * a sibling session on this host into the target session's
           * attachments, which is §6.7's "transfers once". A read-only client
           * could therefore cause the host to write files. It leaks nothing —
           * a client that can reach this can already read those sessions — but
           * "read-only" has to mean it, and disk consumed on someone else's
           * machine is not a read.
           *
           * Gated identically to `blob.put`, which is also the only caller: a
           * client asks this to decide whether to send bytes.
           */
          this.requireWrite(client, 'transfer a blob');
          return manager.hasBlob(
            command.sessionId as SessionId,
            command.sha256 as Sha256,
            command.mime,
          );

        case 'blob.put': {
          // A write, because it lands bytes in a session's store and an event in
          // its log. A read-only client that could push blobs is not read-only.
          this.requireWrite(client, 'transfer a blob');

          const received = this.intake.accept(
            command.sha256,
            command.offset,
            Buffer.from(command.chunk, 'base64'),
          );
          if (!command.final) return received;

          // Verified here, before the store ever sees it. `commit` throws on a
          // mismatch and drops the staging, so bytes that do not hash to the
          // name they were sent under are never written under either name.
          const verified = this.intake.commit(command.sha256);
          await manager.attachBlob(command.sessionId as SessionId, verified, command.mime);
          return verified.length;
        }

        case 'shell.open': {
          /*
           * A write, and the gate here is the *role*, not §13.
           *
           * §13 gates what a model asks for. This is a person with `read-write`
           * typing on their own machine, and asking them to approve their own
           * keystrokes would be theatre that taught people to click through
           * prompts. What the role check does buy is real: a read-only client —
           * a phone watching a run, a colleague looking over the wire — must
           * not get a shell on this machine.
           *
           * Nothing about it touches the session's durable record. `sessionId`
           * scopes the pane, and for `{kind:'agbrte'}` it also names the session
           * our own CLI is told to attach to — which reaches an argv and no
           * event. Being told to attach is not the same as being logged: if that
           * CLI then *sends* something, it does so as a client over this same
           * socket, and the resulting `user.turn` is written by the ordinary
           * path with the ordinary actor, exactly as a second window's would be.
           *
           * `program` is passed through unvalidated *here* on purpose: the check
           * that matters is "is this one of the things this host detected", and
           * that question can only be answered where the detection is —
           * `TerminalPrograms.resolve`, which refuses anything else by name and
           * whose refusal reaches the client through the ordinary error path.
           * A shape check here as well would be a second opinion that can only
           * ever be wrong in the permissive direction.
           */
          this.requireWrite(client, 'open a terminal');
          return this.shells(client).open(client.shellOwner, {
            sessionId: command.sessionId,
            ...(command.program !== undefined ? { program: command.program } : {}),
            ...(command.cols !== undefined ? { cols: command.cols } : {}),
            ...(command.rows !== undefined ? { rows: command.rows } : {}),
          });
        }

        case 'shell.input':
          this.requireWrite(client, 'type into a terminal');
          // `false` for a shell this client does not own or that has already
          // exited — an answer rather than an error, because a keystroke landing
          // a millisecond after the program ended is an ordinary race and not
          // something to put a banner on screen for.
          return this.shells(client).write(client.shellOwner, command.shellId, command.data);

        case 'shell.resize':
          this.requireWrite(client, 'resize a terminal');
          return this.shells(client).resize(
            client.shellOwner,
            command.shellId,
            command.cols,
            command.rows,
          );

        case 'shell.close':
          this.requireWrite(client, 'close a terminal');
          return this.shells(client).close(client.shellOwner, command.shellId);

        case 'files.list':
          /*
           * A read, so no `requireWrite` — the treatment `session.events`,
           * `blob.get` and `agent.rawLog` get, and for the same reason: a
           * read-only client can already read a transcript that names these
           * files and quotes their contents, so withholding the list would keep
           * the caption and hide the picture.
           *
           * **Not §13-gated, and somebody would reasonably wonder.** §13's gate
           * covers what a *model* asks the app for; an agent reading a file goes
           * through `tools/index.ts`, which checks this same root and then the
           * session's `ToolPolicy`. There is no agent on this path. This is a
           * person with a window open on their own workspace, and prompting them
           * to approve their own click is the theatre §13 warns about — it
           * trains people to dismiss the prompts that matter.
           *
           * What does the actual containment is `listDirectory` itself: every
           * path is resolved against this host's workspace root and refused by
           * name if it escapes, lexically or through a symlink.
           *
           * Nothing here is a session event. No log write, no queue, no
           * projection change — a client browsing leaves the transcript exactly
           * as it found it.
           */
          return listDirectory(this.bound(client, 'list files').info.root, command.path, {
            ...(command.limit !== undefined ? { limit: command.limit } : {}),
          });

        case 'files.read':
          // The same read, the same reasoning. Bounded on this side rather than
          // trusted from the client: oversized and non-text are refused by name,
          // never truncated (see `readTextFile`).
          return readTextFile(this.bound(client, 'read a file').info.root, command.path);

        case 'permission.pending':
          return manager.pendingPermissions();

        case 'permission.respond':
          this.requireWrite(client, 'answer a permission request');
          return manager.respondPermission(command.requestId, command.decision, client.actor);

      }
    });
  }

  private async reply(
    client: Client,
    id: RequestId,
    fn: () => Promise<unknown>,
  ): Promise<void> {
    try {
      const value = await fn();
      client.channel.post({ t: 'ok', id, ...(value !== undefined ? { value } : {}) });
    } catch (err) {
      client.channel.post({
        t: 'err',
        id,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { name: err.name } : {}),
      });
    }
  }

  private requireWrite(client: Client, action: string): void {
    if (client.role === 'read-only') throw new AccessDenied(action);
  }

  /** Any session mid-turn, or any prompt waiting on a human. */
  private busy(): boolean {
    const { manager } = this.opts;
    if (manager.pendingPermissions().length > 0) return true;
    return manager.list().some((session) => session.state === 'working');
  }

  /**
   * Exit after a quiet spell with nothing attached and nothing running.
   *
   * §8 parks hosts for the same reason: without this, every workspace ever
   * opened leaves a process behind, and they are invisible because nothing shows
   * them. Re-armed whenever the last client leaves, cancelled when one arrives.
   */
  private armLinger(): void {
    const lingerMs = this.opts.lingerMs ?? 0;
    this.cancelLinger();
    if (lingerMs <= 0 || this.closed) return;
    if (this.clients.size > 0) return;

    this.lingerTimer = setTimeout(() => {
      if (this.clients.size > 0 || this.busy()) {
        // Work arrived while the timer ran, or a prompt is still waiting. Try
        // again later rather than exiting out from under it.
        this.armLinger();
        return;
      }
      this.stop('idle');
    }, lingerMs);
    // Never hold the process open just to time its own exit.
    this.lingerTimer.unref?.();
  }

  private cancelLinger(): void {
    if (this.lingerTimer !== null) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  /** Tell every client why, then drop them. */
  stop(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelLinger();
    // Before the channels close rather than relying on each one's `onClose` to
    // sweep: a host that stops must not leave a shell behind, and depending on
    // a callback that fires per client makes "all of them" a property of the
    // loop below rather than something this line states.
    for (const workspace of this.heldWorkspaces()) workspace.shells?.closeAll();
    this.opts.shells?.closeAll();
    this.broadcast({ t: 'push.closing', reason });
    for (const client of this.clients) client.channel.close();
    this.clients.clear();
    // One exit path for every reason it stops. The owner closes the listener and
    // ends the process; leaving that to only one caller is how a "stopped" host
    // kept answering.
    this.opts.onStopped?.(reason);
  }

  /**
   * The preview-server supervisor, or a refusal that says why.
   *
   * Absent only where a host was constructed without one — tests, and any
   * embedding that does not want to run commands. Saying so beats a `?.` that
   * silently reports success for a server nobody started.
   */
  private servers(client: Client): PreviewServers {
    const found = client.workspace?.servers ?? this.opts.servers;
    if (found === undefined) {
      throw new Error(
        client.workspace === null
          ? 'this connection is not bound to a workspace, so there is nothing to run a preview in'
          : 'this host does not run preview servers',
      );
    }
    return found;
  }

  // ------------------------------------------------------------- workspaces

  /**
   * The workspaces this host holds, always including the one it started with.
   *
   * The default entry is synthesised from `identity` rather than required from
   * the caller, which is what keeps `agbrte serve` and every direct
   * construction working unchanged: a host built around one folder holds one.
   */
  private heldWorkspaces(): HostWorkspace[] {
    /*
     * A caller that says what it holds is believed; one that does not gets what
     * this server has opened.
     *
     * `hostMain` owns the set — it has to, because it also writes each folder's
     * pointer record and stops each folder's servers — so when it answers, that
     * answer is the whole truth and this map is not consulted. A host embedded
     * without one (a test, `agbrte serve`) would otherwise open a workspace
     * through the factory and immediately forget it, which is a drift waiting to
     * happen rather than a state anybody wants.
     */
    const supplied = this.opts.workspaces?.();
    if (supplied !== undefined && supplied.length > 0) return supplied;
    return [this.defaultWorkspace(), ...this.opened.values()];
  }

  private defaultWorkspace(): HostWorkspace {
    const id = this.opts.identity;
    return {
      info: {
        instanceId: id.instanceId,
        lineageId: id.lineageId,
        root: id.workspaceRoot,
        ...(id.movedFrom !== undefined ? { movedFrom: id.movedFrom } : {}),
      },
      ...(this.opts.servers !== undefined ? { servers: this.opts.servers } : {}),
      ...(this.opts.shells !== undefined ? { shells: this.opts.shells } : {}),
      ...(this.opts.grantRole !== undefined ? { grantRole: this.opts.grantRole } : {}),
    };
  }

  /**
   * Which workspace a connection asking for `root` gets.
   *
   * Three answers, and the third is the one worth stating. A path that is
   * already held resolves to it; a path that is not is **opened**, because a
   * client naming a folder is asking for it and refusing would mean a person
   * has to open it somewhere else first. And a client that named *nothing*
   * binds to the host's only workspace when there is exactly one — there being
   * nothing to disambiguate — and to nothing at all when there are several,
   * because picking the first would serve one folder's transcripts to a client
   * that asked about another.
   */
  private async bindFor(root: string | undefined): Promise<HostWorkspace | null> {
    const held = this.heldWorkspaces();
    if (root === undefined) return held.length === 1 ? (held[0] ?? null) : null;

    const wanted = resolve(root);
    const found = held.find((w) => resolve(w.info.root) === wanted);
    if (found !== undefined) return found;

    if (this.opts.openWorkspace === undefined) {
      throw new Error(
        `this host serves ${held.map((w) => w.info.root).join(', ')} and cannot open ` +
          `${wanted} — it was built around a single workspace`,
      );
    }
    const opened = await this.opts.openWorkspace(wanted);
    this.opened.set(resolve(opened.info.root), opened);
    return opened;
  }

  /**
   * The workspace a workspace-scoped command runs against, or a refusal.
   *
   * Named in the refusal, because "no workspace" on a host holding four folders
   * is a sentence nobody can act on. The verb is carried for the same reason
   * `requireWrite` carries one: a person needs to know what was refused, not
   * merely that something was.
   */
  private bound(client: Client, verb: string): HostWorkspace {
    if (client.workspace !== null) return client.workspace;
    const held = this.heldWorkspaces().map((w) => w.info.root);
    throw new Error(
      `this connection is attached to the machine and not to a workspace, so it cannot ` +
        `${verb}. Open one of ${held.length === 0 ? 'its folders' : held.join(', ')} first.`,
    );
  }

  /**
   * The terminal supervisor, or a refusal that names the reason.
   *
   * Absent where a host was built without one — a test, or `agbrte serve` — and
   * saying so beats a `?.` that reports success for a terminal nobody opened.
   * The other way this is absent is a machine with no PTY binary beside the
   * bundle, and that one is refused deeper down by `ShellUnavailable`, which
   * carries the same class of message for the same reason.
   */
  private shells(client: Client): Shells<ShellOwner> {
    const found = client.workspace?.shells ?? this.opts.shells;
    if (found === undefined) {
      throw new Error(
        client.workspace === null
          ? 'this connection is not bound to a workspace, so there is no directory to open a terminal in'
          : 'this host does not open terminals',
      );
    }
    return found;
  }

  /**
   * Ports on this machine that could be a preview (§6.8).
   *
   * Returns `[]` rather than throwing where it cannot look. This is the
   * asymmetry `capture/client.ts` already draws and for the same reason: asking
   * what is available is a question a UI asks on open, so an unanswerable one
   * must not turn into an error banner. The client learns the difference from
   * `preview.ports` being unavailable on an older host, which it checks first.
   */
  private async listeningPorts(): Promise<ListeningPort[]> {
    try {
      // The host's own control port is excluded where there is one: offering to
      // forward the channel this request arrived on is offering a loop.
      return await listListeningPorts(
        (() => {
          const own = this.opts.controlPort?.();
          return own === undefined ? {} : { exclude: [own] };
        })(),
      );
    } catch {
      return [];
    }
  }

  /** Test and diagnostic view. */
  get clientCount(): number {
    return this.clients.size;
  }
}

/**
 * Ask a runtime what it declares, with no session to ask through.
 *
 * `capabilities(spec)` takes a spec because capabilities belong to
 * adapter + model + installed version rather than to the adapter alone (§3.2),
 * so one has to be invented: an empty policy, no limits, this workspace.
 *
 * **A runtime that needs a model is not probed at all**, which is the whole
 * subtlety here. `AgbrteHarness` answers by *making real requests* — §3.3 is
 * explicit that these endpoints' self-reports cannot be trusted — so a probe
 * carrying a placeholder model id is not a cheap metadata read. The first
 * version invented one, and every host attach then fired a live request at a
 * model that does not exist, behind a two-minute timeout: the end-to-end suite
 * went from one minute to nine and a permission test timed out waiting. It was
 * also the wrong question, since the answer belongs to whichever model the user
 * is about to choose and not to a name we made up.
 *
 * So it returns `null` and the matrix says the adapter could not be asked, which
 * is exactly true: nothing can be declared about a model nobody has picked yet.
 *
 * **`null` rather than an error on every other failure too.** A CLI uninstalled
 * since the host started, a probe that throws: not reasons to fail the caller. A
 * table that refuses to render because one adapter is unreachable is less useful
 * than one with a gap in it.
 */
async function probeCapabilities(
  manager: SessionManager,
  workspaceRoot: string,
  runtimeId: string,
): Promise<RuntimeCapabilities | null> {
  const registry = manager.registry;
  if (!registry.has(runtimeId)) return null;
  // Only a runtime that *must* have a model is unprobeable without one.
  // An installed CLI takes one optionally and probes fine with its own default.
  if (registry.describe(runtimeId).model === 'required') return null;

  const spec: AgentSpec = {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId,
    auth: { kind: 'none' },
    toolPolicy: { rules: [], defaultAction: 'ask' },
    limits: {},
    workspacePath: workspaceRoot,
  };

  try {
    return await registry.resolveCapabilities(spec);
  } catch {
    return null;
  }
}
