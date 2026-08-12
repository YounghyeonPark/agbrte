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
  type RuntimeCapabilities,
  type SessionId,
  type Sha256,
} from '@shared/types/index.js';
import { BlobIntake } from '@main/store/blobTransfer.js';
import { searchWorkspace } from '@main/store/searchSessions.js';
import {
  MIN_CLIENT_PROTOCOL,
  SESSION_PROTOCOL_VERSION,
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
  /** Starts a pull and reports on every one started. Absent where nothing can. */
  installModel?: (endpointId: string, tag: string) => Promise<void>;
  installProgress?: () => Promise<ModelInstallProgress[]>;
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

interface Client {
  channel: HostSideSessionChannel;
  role: AccessRole;
  label: string;
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
    // `read-only` until the handshake says otherwise, and an actor that claims
    // nothing. A connection that never says hello must not be able to write, and
    // must not be able to put a name on anything either.
    const client: Client = {
      channel,
      role: 'read-only',
      label: 'unknown',
      actor: { id: 'unknown', via: 'asserted' },
    };
    this.clients.add(client);
    this.cancelLinger();

    channel.onMessage((command) => void this.dispatch(client, command));
    channel.onClose(() => {
      this.clients.delete(client);
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
            { title: command.title, goal: command.goal },
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
