/**
 * The app's connection to a session host (DESIGN.md §6.4, §8).
 *
 * Presents the slice of `SessionManager` that `Fleet` uses, so the fleet keeps
 * calling the same methods and stops caring that sessions now live in another
 * process. That is the same trick `HostBackedRuntime` plays for `AgentRuntime`,
 * one level up — and it is the reason moving ownership out of the app touches so
 * little of the app.
 *
 * The app holds **no session state**. Everything here is a request or a
 * subscription, which is what makes closing the app a non-event for a running
 * session and makes a second device a new connection rather than a second copy.
 */

import type { ListeningPort } from '../preview/ports.js';
import type { PreviewServer, PreviewServerLog } from '../preview/servers.js';
import type { SessionTemplate } from '../store/templates.js';
import { EventEmitter } from 'node:events';
import {
  COMMAND_SINCE,
  SESSION_PROTOCOL_VERSION,
  type AppSideSessionChannel,
  type HostIdentity,
  type OnDiskSession,
  type SessionCommand,
  type SessionMessage,
} from '@shared/host/sessionProtocol.js';

import type {
  AccessRole,
  AgentId,
  ContentBlock,
  AgentRecord,
  AgbrteEvent,
  PermissionDecision,
  InboxEntry,
  PermissionRequest,
  RuntimeCapabilities,
  Session,
  SessionId,
  SessionProjection,
  Sha256,
} from '@shared/types/index.js';
import { sha256Of } from '@main/store/blobs.js';
import { CHUNK_BYTES } from '@main/store/blobTransfer.js';
import type { SearchHit } from '@main/store/searchSessions.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * `Omit` over a union collapses it to the keys every member shares, which for a
 * command union is just `t`. Distributing keeps each member's own fields.
 */
type Unsent<T> = T extends unknown ? Omit<T, 'id'> : never;

export class HostProtocolMismatch extends Error {
  constructor(hostVersion: number, minimum: number) {
    super(
      `host v${hostVersion} will not serve a client older than v${minimum}; ` +
        `this app speaks v${SESSION_PROTOCOL_VERSION} — upgrade the app`,
    );
    this.name = 'HostProtocolMismatch';
  }
}

/**
 * The host is real, connected, and simply older than this command.
 *
 * A separate error from the mismatch above, because it is a separate situation
 * and a separate fix: nothing is wrong with the connection, one feature is
 * unavailable, and the remedy is on the *other* machine. Reported where the
 * command is called rather than at handshake, so the rest of the session keeps
 * working — which is the whole point of negotiating instead of refusing.
 */
export class CommandUnavailable extends Error {
  constructor(command: string, since: number, hostVersion: number) {
    super(
      `this host speaks session protocol v${hostVersion} and \`${command}\` needs v${since} — ` +
        'upgrade the host to use it',
    );
    this.name = 'CommandUnavailable';
  }
}

export interface HostConnectionOptions {
  channel: AppSideSessionChannel;
  /** What this client asks for. The host decides what it gets. */
  role?: AccessRole;
  /** Shown in the host's logs; useful when several devices are attached. */
  client?: string;
  onClose?: (reason?: string) => void;
}

/**
 * Events, re-emitted from the host:
 *
 *   'event'      (sessionId, AgbrteEvent)
 *   'session'    (Session)
 *   'permission' (PermissionRequest)
 *   'permission-resolved' (PermissionResolved)
 *   'queue'      (sessionId, agentId, depth)
 *   'closing'    (reason)   — the host is stopping on purpose; do not return
 *   'closed'     (reason)   — the link broke; the host may still be running
 */
export class HostConnection extends EventEmitter {
  private readonly pendingCalls = new Map<string, Pending>();
  private nextId = 0;
  private closed: string | null = null;

  private identity: HostIdentity | null = null;
  private granted: AccessRole = 'read-only';

  readonly ready: Promise<HostIdentity>;
  private announce!: (identity: HostIdentity) => void;
  private failReady!: (err: Error) => void;

  constructor(private readonly opts: HostConnectionOptions) {
    super();

    this.ready = new Promise((resolve, reject) => {
      this.announce = resolve;
      this.failReady = reject;
    });
    // Marks the rejection handled so a caller that never awaits `ready` cannot
    // trigger an unhandled rejection; anyone awaiting still sees the error.
    this.ready.catch(() => undefined);

    opts.channel.onMessage((message) => this.receive(message));
    opts.channel.onClose((reason) => this.handleClose(reason));

    opts.channel.post({
      t: 'hello',
      id: this.mintId(),
      role: opts.role ?? 'read-write',
      client: opts.client ?? 'agbrte-app',
      // The host decides whether it will serve this, because the host is the
      // owner — the same reason roles are granted rather than claimed.
      protocol: SESSION_PROTOCOL_VERSION,
    });
  }

  /** What the host granted, which may be less than what was asked. */
  get role(): AccessRole {
    return this.granted;
  }

  get host(): HostIdentity | null {
    return this.identity;
  }

  private mintId(): string {
    this.nextId += 1;
    return `c${this.nextId}`;
  }

  private call<T>(command: Unsent<SessionCommand>): Promise<T> {
    if (this.closed !== null) return Promise.reject(new Error(this.closed));
    const id = this.mintId();
    return new Promise<T>((resolve, reject) => {
      this.pendingCalls.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.opts.channel.post({ ...command, id } as SessionCommand);
    });
  }

  private receive(message: SessionMessage): void {
    switch (message.t) {
      case 'welcome': {
        /**
         * Refused only when this app is older than the host will serve.
         *
         * That is the one case a version check has to catch: a command whose
         * *shape* changed, which a client cannot detect on its own. Meeting an
         * older host is not that case, and used to be refused here — which
         * stranded every running host on an additive bump, and left `agbrte
         * stop` unable to reach the host it was meant to retire.
         *
         * A host that predates this field sends nothing, and its silence means
         * 1, which is true of it.
         */
        const minimum = message.identity.minProtocol ?? 1;
        if (SESSION_PROTOCOL_VERSION < minimum) {
          this.failReady(new HostProtocolMismatch(message.identity.protocol, minimum));
          this.opts.channel.close();
          return;
        }
        this.identity = message.identity;
        this.granted = message.role;
        this.announce(message.identity);
        return;
      }

      case 'ok': {
        const pending = this.pendingCalls.get(message.id);
        this.pendingCalls.delete(message.id);
        pending?.resolve(message.value);
        return;
      }

      case 'err': {
        const pending = this.pendingCalls.get(message.id);
        this.pendingCalls.delete(message.id);
        const error = new Error(message.message);
        if (message.name !== undefined) error.name = message.name;
        pending?.reject(error);
        return;
      }

      case 'push.event':
        this.emit('event', message.sessionId, message.event);
        return;
      case 'push.session':
        this.emit('session', message.session);
        return;
      case 'push.permission':
        this.emit('permission', message.request);
        return;

      case 'push.permissionResolved':
        this.emit('permission-resolved', message.resolved);
        return;
      case 'push.queue':
        this.emit('queue', message.sessionId, message.agentId, message.depth);
        return;
      case 'push.closing':
        this.emit('closing', message.reason);
        return;
    }
  }

  /**
   * The host went away.
   *
   * Every in-flight call fails rather than hanging. `ready` fails too: it is not
   * a pending call, and leaving it unsettled is how a host that dies before
   * handshaking hangs the app instead of reporting itself unavailable.
   */
  private handleClose(reason?: string): void {
    this.closed = reason ?? 'host connection closed';
    this.failReady(new Error(this.closed));
    for (const [, pending] of this.pendingCalls) pending.reject(new Error(this.closed));
    this.pendingCalls.clear();
    // Announced, not merely reported to the constructor's callback. Before this
    // the only observable close was `push.closing` — a host saying it is going
    // away *on purpose* — so a link that simply died was invisible: the fleet
    // kept an entry pointing at a dead connection and every later command failed
    // one at a time. The two are different facts and need different answers:
    // `closing` means the host stopped and there is nothing to return to,
    // `closed` means the link broke and the host is probably still running.
    this.emit('closed', this.closed);
    this.opts.onClose?.(reason);
  }

  // ------------------------------------------------------------------ sessions

  list(): Promise<Session[]> {
    return this.call({ t: 'session.list' });
  }

  listOnDisk(): Promise<OnDiskSession[]> {
    return this.call({ t: 'session.listOnDisk' });
  }

  get(sessionId: SessionId): Promise<Session> {
    return this.call({ t: 'session.get', sessionId });
  }

  createSession(input: { title: string; goal: string }): Promise<Session> {
    return this.call({ t: 'session.create', title: input.title, goal: input.goal });
  }

  resumeSession(sessionId: SessionId): Promise<Session> {
    return this.call({ t: 'session.resume', sessionId });
  }

  addAgent(sessionId: SessionId, input: unknown): Promise<AgentRecord> {
    return this.call({ t: 'session.addAgent', sessionId, input });
  }

  /** Resolves when the turn completes — which may be long after this client left. */
  send(
    sessionId: SessionId,
    agentId: AgentId,
    text: string,
    blocks?: ContentBlock[],
  ): Promise<void> {
    return this.call({
      t: 'session.send',
      sessionId,
      agentId,
      text,
      ...(blocks !== undefined && blocks.length > 0 ? { blocks } : {}),
    });
  }

  /**
   * Whether the host on the other end has a given command.
   *
   * Public because a UI should be able to grey a button rather than offer one
   * that will explain itself only after being pressed.
   */
  /**
   * Ports listening on the machine this host runs on (§6.8).
   *
   * `require` first, so meeting a host deployed before this command existed
   * costs one feature and says which — rather than a request that hangs or an
   * error about a message type nobody recognises.
   */
  async previewPorts(): Promise<ListeningPort[]> {
    // `async` so the gate below *rejects* rather than throwing synchronously.
    // A method typed `Promise<T>` that can throw before returning one is a trap:
    // `previewPorts().catch(...)` would never see it, and the caller gets an
    // uncaught exception from a line that looks handled. `hasBlob` had the same
    // shape and was changed with it.
    this.require('preview.ports');
    return this.call<ListeningPort[]>({ t: 'preview.ports' });
  }

  /**
   * Start a preview server on the host's machine (§6.8).
   *
   * `async` so the version gate rejects rather than throwing synchronously —
   * see `previewPorts`.
   */
  async startPreviewServer(sessionId: SessionId, command: string): Promise<PreviewServer> {
    this.require('preview.start');
    return this.call<PreviewServer>({ t: 'preview.start', sessionId, command });
  }

  async stopPreviewServer(serverId: string): Promise<boolean> {
    this.require('preview.stop');
    return this.call<boolean>({ t: 'preview.stop', serverId });
  }

  async previewServers(sessionId?: SessionId): Promise<PreviewServer[]> {
    this.require('preview.servers');
    return this.call<PreviewServer[]>({
      t: 'preview.servers',
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  async previewServerLog(serverId: string): Promise<PreviewServerLog | null> {
    this.require('preview.log');
    return this.call<PreviewServerLog | null>({ t: 'preview.log', serverId });
  }

  /** Templates in this host's workspace (§17 Q12). */
  async templates(): Promise<SessionTemplate[]> {
    this.require('template.list');
    return this.call<SessionTemplate[]>({ t: 'template.list' });
  }

  async saveTemplate(sessionId: SessionId, name: string): Promise<SessionTemplate> {
    this.require('template.save');
    return this.call<SessionTemplate>({ t: 'template.save', sessionId, name });
  }

  async applyTemplate(templateId: string, title?: string): Promise<Session> {
    this.require('template.apply');
    return this.call<Session>({
      t: 'template.apply',
      templateId,
      ...(title !== undefined ? { title } : {}),
    });
  }

  async deleteTemplate(templateId: string): Promise<boolean> {
    this.require('template.delete');
    return this.call<boolean>({ t: 'template.delete', templateId });
  }

  supports(command: keyof typeof COMMAND_SINCE | string): boolean {
    return (this.identity?.protocol ?? 1) >= (COMMAND_SINCE[command] ?? 1);
  }

  private require(command: string): void {
    const since = COMMAND_SINCE[command] ?? 1;
    if (!this.supports(command)) {
      throw new CommandUnavailable(command, since, this.identity?.protocol ?? 1);
    }
  }

  /** Whether this session can already resolve the hash (§6.7). */
  async hasBlob(sessionId: SessionId, sha256: Sha256, mime: string): Promise<boolean> {
    // `async` for the same reason as `previewPorts`: `require` throws, and a
    // synchronous throw out of a `Promise`-typed method escapes `.catch`.
    this.require('blob.has');
    return this.call({ t: 'blob.has', sessionId, sha256, mime });
  }

  /**
   * Transfer bytes to the session's blob store, skipping it if they are there.
   *
   * Chunks are sent one at a time and awaited, which is the whole of §6.7's
   * "rate-limited so a 4K screenshot never starves the event tail". A rate
   * limiter inside a single 10 MiB write would not have helped; a gap between
   * every 256 KiB is what actually lets the host's pushes through.
   *
   * Resumption is implicit and needs no reconnect handling here: the reply is
   * the byte count the host holds, so a chunk that was applied but whose
   * acknowledgement was lost simply reports a further offset, and the next
   * chunk continues from it. The loop follows the host rather than its own
   * count, which is why a retry cannot duplicate bytes.
   */
  async putBlob(sessionId: SessionId, data: Buffer, mime: string): Promise<Sha256> {
    // Checked before the hash, so an old host costs nothing rather than a
    // needless pass over several megabytes.
    this.require('blob.put');
    const sha = sha256Of(data);
    if (await this.hasBlob(sessionId, sha, mime)) return sha;

    let offset = 0;
    // `do` rather than `while`: an empty buffer is still a blob, and a loop that
    // never runs would return a hash the host has never been told about — a
    // dangling reference produced by the transfer that was meant to prevent one.
    do {
      const end = Math.min(offset + CHUNK_BYTES, data.length);
      const received: number = await this.call({
        t: 'blob.put',
        sessionId,
        sha256: sha,
        mime,
        offset,
        chunk: data.subarray(offset, end).toString('base64'),
        final: end === data.length,
      });
      // The host's count, not ours. A retried chunk reports where the host
      // actually is, and following that is what makes the retry idempotent.
      offset = received;
    } while (offset < data.length);
    return sha;
  }

  interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    return this.call({
      t: 'session.interrupt',
      sessionId,
      ...(agentId !== undefined ? { agentId } : {}),
    });
  }

  search(query: string, limit?: number): Promise<SearchHit[]> {
    return this.call({
      t: 'session.search',
      query,
      ...(limit !== undefined ? { limit } : {}),
    });
  }

  events(sessionId: SessionId, fromSeq = 0): Promise<AgbrteEvent[]> {
    return this.call({ t: 'session.events', sessionId, fromSeq });
  }

  projection(sessionId: SessionId): Promise<SessionProjection> {
    return this.call({ t: 'session.projection', sessionId });
  }

  queueDepth(sessionId: SessionId): Promise<number> {
    return this.call({ t: 'session.queueDepth', sessionId });
  }

  respondSplit(
    sessionId: SessionId,
    proposalId: string,
    decision: { approved: boolean; reason?: string },
  ): Promise<Session | null> {
    return this.call({ t: 'session.respondSplit', sessionId, proposalId, decision });
  }

  inbox(limit?: number): Promise<InboxEntry[]> {
    return this.call({ t: 'inbox.list', ...(limit !== undefined ? { limit } : {}) });
  }

  markInboxRead(): Promise<void> {
    return this.call({ t: 'inbox.markRead' });
  }

  /** What a runtime declares, or `null` where it could not be asked. */
  capabilities(runtimeId: string): Promise<RuntimeCapabilities | null> {
    return this.call({ t: 'runtime.capabilities', runtimeId });
  }

  pendingPermissions(): Promise<PermissionRequest[]> {
    return this.call({ t: 'permission.pending' });
  }

  respondPermission(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'answered' | 'already-answered' | 'unknown'> {
    return this.call({ t: 'permission.respond', requestId, decision });
  }

  /** Ask the host to exit. It refuses while work is in flight. */
  requestShutdown(): Promise<{ stopped: boolean; reason?: string }> {
    return this.call({ t: 'shutdown' });
  }

  /**
   * Disconnect without stopping the host.
   *
   * The default on app close, and the behaviour the whole design is for: leaving
   * is not stopping.
   */
  disconnect(): void {
    this.opts.channel.close();
  }
}
