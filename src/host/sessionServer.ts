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
  type ModelCapabilityHint,
  type RuntimeCapabilities,
  type SessionId,
  type Sha256,
} from '@shared/types/index.js';
import { BlobIntake } from '@main/store/blobTransfer.js';
import { listDirectory, readTextFile } from '@main/workspace/files.js';
import { searchWorkspace } from '@main/store/searchSessions.js';
import {
  MIN_CLIENT_PROTOCOL,
  SESSION_PROTOCOL_VERSION,
  type EndpointAdded,
  type HostIdentity,
  type HostSideSessionChannel,
  type RequestId,
  type SessionCommand,
} from '@shared/host/sessionProtocol.js';
import type { SessionManager } from '@main/sessionManager.js';

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
  identity: Omit<HostIdentity, 'protocol' | 'pid'>;
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
  private lingerTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: SessionHostOptions) {
    const { manager } = opts;

    // Pushed to every attached client. A client that connected halfway through a
    // turn still sees the rest of it, because the events come from the manager
    // rather than from any client's subscription.
    manager.on('event', (sessionId: SessionId, event: unknown) =>
      this.broadcast({ t: 'push.event', sessionId, event: event as never }),
    );
    manager.on('session', (session: unknown) =>
      this.broadcast({ t: 'push.session', session: session as never }),
    );
    manager.on('permission', (request: unknown) =>
      this.broadcast({ t: 'push.permission', request: request as never }),
    );
    manager.on('permission-resolved', (resolved: unknown) =>
      this.broadcast({ t: 'push.permissionResolved', resolved: resolved as never }),
    );
    manager.on('queue', (sessionId: SessionId, agentId: AgentId, depth: number) =>
      this.broadcast({ t: 'push.queue', sessionId, agentId, depth }),
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
     * Measured rather than assumed on the bundled host, where it turns out to be
     * belt and braces: `hostMain` closes its listener in the same tick, so a
     * connect at +1ms is accepted by the kernel and never dispatched here at
     * all. It stays because that ordering is `hostMain`'s and not this class's —
     * an embedder that keeps its listener open a moment longer (`agbrte serve`,
     * a loopback control port) would otherwise hand out welcomes from a stopped
     * server, and nothing in this file would notice.
     */
    if (this.closed) {
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
    };
    this.clients.add(client);
    this.cancelLinger();

    channel.onMessage((command) => void this.dispatch(client, command));
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
      this.opts.shells?.closeOwned(client.shellOwner);
      // A departing client is not a reason to stop. It owns nothing.
      this.armLinger();
    });
  }

  private broadcast(message: Parameters<HostSideSessionChannel['post']>[0]): void {
    for (const client of this.clients) client.channel.post(message);
  }

  private async dispatch(client: Client, command: SessionCommand): Promise<void> {
    const { manager } = this.opts;

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
        return;
      }

      const decided = this.opts.grantRole?.(command.role, command.client);
      const granted = decided?.role ?? command.role;
      client.role = granted;
      client.label = command.client;
      if (decided !== undefined) client.actor = decided.actor;
      client.channel.post({
        t: 'welcome',
        id: command.id,
        role: granted,
        identity: {
          ...this.opts.identity,
          pid: process.pid,
          protocol: SESSION_PROTOCOL_VERSION,
          minProtocol: MIN_CLIENT_PROTOCOL,
        },
      });
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
      // After the reply has been posted, so the acknowledgement wins the race.
      setTimeout(() => this.stop('shutdown requested'), 0);
      return;
    }

    await this.reply(client, command.id, async () => {
      switch (command.t) {
        case 'session.list':
          return manager.list();

        case 'preview.start': {
          // A write: it runs a command on this machine. The role check is the
          // point — a read-only client watching from a phone must not be able
          // to start processes on a build box.
          this.requireWrite(client, 'start a preview server');
          return this.servers().start(command.sessionId, command.command);
        }

        case 'preview.stop':
          this.requireWrite(client, 'stop a preview server');
          return this.servers().stop(command.serverId);

        case 'preview.servers':
          return this.servers().list(command.sessionId);

        case 'preview.log':
          return this.opts.servers?.log(command.serverId) ?? null;

        case 'template.list':
          return listTemplates(this.opts.identity.workspaceRoot);

        case 'template.save': {
          // A write: it puts a file in the repo that colleagues will pull.
          this.requireWrite(client, 'save a session template');
          const session = await manager.get(command.sessionId as SessionId);
          return saveTemplate(
            this.opts.identity.workspaceRoot,
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
          return deleteTemplate(this.opts.identity.workspaceRoot, command.templateId);

        case 'template.apply': {
          this.requireWrite(client, 'start a session from a template');
          const template = await readTemplate(
            this.opts.identity.workspaceRoot,
            command.templateId,
          );
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
          return searchWorkspace(this.opts.identity.workspaceRoot, command.query, {
            ...(command.limit !== undefined ? { limit: command.limit } : {}),
          });

        case 'session.listOnDisk':
          return manager.listOnDisk();

        case 'session.get':
          return manager.get(command.sessionId as SessionId);

        case 'session.create':
          this.requireWrite(client, 'create a session');
          return manager.createSession(
            command.input ?? { title: command.title, goal: command.goal },
            client.actor,
          );

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
          return probeCapabilities(manager, this.opts.identity, command.runtimeId);

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

        case 'inbox.list':
          return manager.inbox(command.limit);

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
          return this.shells().open(client.shellOwner, {
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
          return this.shells().write(client.shellOwner, command.shellId, command.data);

        case 'shell.resize':
          this.requireWrite(client, 'resize a terminal');
          return this.shells().resize(
            client.shellOwner,
            command.shellId,
            command.cols,
            command.rows,
          );

        case 'shell.close':
          this.requireWrite(client, 'close a terminal');
          return this.shells().close(client.shellOwner, command.shellId);

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
          return listDirectory(this.opts.identity.workspaceRoot, command.path, {
            ...(command.limit !== undefined ? { limit: command.limit } : {}),
          });

        case 'files.read':
          // The same read, the same reasoning. Bounded on this side rather than
          // trusted from the client: oversized and non-text are refused by name,
          // never truncated (see `readTextFile`).
          return readTextFile(this.opts.identity.workspaceRoot, command.path);

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
  private servers(): PreviewServers {
    if (this.opts.servers === undefined) {
      throw new Error('this host does not run preview servers');
    }
    return this.opts.servers;
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
  private shells(): Shells<ShellOwner> {
    if (this.opts.shells === undefined) {
      throw new Error('this host does not open terminals');
    }
    return this.opts.shells;
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
  identity: Omit<HostIdentity, 'protocol' | 'pid'>,
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
    workspacePath: identity.workspaceRoot,
  };

  try {
    return await registry.resolveCapabilities(spec);
  } catch {
    return null;
  }
}
