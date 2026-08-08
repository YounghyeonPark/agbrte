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

import { EventEmitter } from 'node:events';
import {
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
  AgentRecord,
  AgbrteEvent,
  PermissionDecision,
  PermissionRequest,
  RuntimeCapabilities,
  Session,
  SessionId,
  SessionProjection,
} from '@shared/types/index.js';

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
  constructor(hostVersion: number) {
    super(
      `host speaks session protocol v${hostVersion}, this app speaks v${SESSION_PROTOCOL_VERSION}`,
    );
    this.name = 'HostProtocolMismatch';
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
        if (message.identity.protocol !== SESSION_PROTOCOL_VERSION) {
          // A detached host outlives the app that spawned it, so a newer app can
          // meet an older host — the one direction a single-process design never
          // has to think about. Refuse at the handshake rather than halfway
          // through a command whose fields moved.
          this.failReady(new HostProtocolMismatch(message.identity.protocol));
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
  send(sessionId: SessionId, agentId: AgentId, text: string): Promise<void> {
    return this.call({ t: 'session.send', sessionId, agentId, text });
  }

  interrupt(sessionId: SessionId, agentId?: AgentId): Promise<void> {
    return this.call({
      t: 'session.interrupt',
      sessionId,
      ...(agentId !== undefined ? { agentId } : {}),
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
