/**
 * Main-side proxy for a runtime living in an AgentHost (DESIGN.md §8, §3.2).
 *
 * `HostBackedRuntime` implements `AgentRuntime` and forwards across a channel.
 * That it can do so **without SessionManager knowing** is the test of §3.2's
 * claim that an adapter contains no transport awareness: the manager keeps
 * calling `start`, `resume`, `send`, and reading `events`, and the loop has
 * moved to another process.
 *
 * The one place the abstraction genuinely strains is `resumeToken()`, which is
 * synchronous and cannot become a round trip. The proxy returns the last token
 * the host pushed. That is sound only because §5.4 already treats the token as
 * a cache: stale or absent, resume falls through to rehydration from the log.
 * A design that trusted the token would break here.
 */

import type {
  AgentHandle,
  CompactedHistory,
  AgentRuntime,
  AgentSpec,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeEvent,
  UserTurn,
} from '@shared/types/index.js';
import type {
  HandleId,
  HostMessage,
  MainSideChannel,
  RequestId,
} from '@shared/host/protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * An async queue fed by pushes, drained by `for await`.
 *
 * The buffering matters: `AgentHandle.events` must be subscribable before the
 * first `send()` and must not lose anything that arrives before a consumer
 * attaches. Events cross the channel as soon as the host produces them, which
 * is often before the manager's pump has started iterating.
 */
class EventQueue implements AsyncIterable<RuntimeEvent> {
  private readonly buffer: RuntimeEvent[] = [];
  private waiting: ((r: IteratorResult<RuntimeEvent>) => void) | null = null;
  private done = false;

  push(event: RuntimeEvent): void {
    if (this.done) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: event, done: false });
      return;
    }
    this.buffer.push(event);
  }

  end(): void {
    if (this.done) return;
    this.done = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: (): Promise<IteratorResult<RuntimeEvent>> => {
        const next = this.buffer.shift();
        if (next !== undefined) return Promise.resolve({ value: next, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}

class HostBackedHandle implements AgentHandle {
  readonly queue = new EventQueue();
  private token: string | null = null;

  constructor(
    private readonly client: HostClient,
    private readonly handleId: HandleId,
  ) {}

  /** Memoized by construction — one queue, consumable once, as the contract says. */
  get events(): AsyncIterable<RuntimeEvent> {
    return this.queue;
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  resumeToken(): string | null {
    return this.token;
  }

  async send(turn: UserTurn): Promise<void> {
    await this.client.request({ t: 'send', id: this.client.mintId(), handleId: this.handleId, turn });
  }

  async interrupt(): Promise<void> {
    await this.client.request({ t: 'interrupt', id: this.client.mintId(), handleId: this.handleId });
  }

  async stop(reason: string): Promise<void> {
    await this.client.request({
      t: 'stop',
      id: this.client.mintId(),
      handleId: this.handleId,
      reason,
    });
  }
}

/** Everything the agent host says about itself when it comes up. */
export interface HostAdvertisement {
  runtimeIds: string[];
  endpoints: Array<{
    id: string;
    label: string;
    provider: string;
    baseUrl: string;
    authenticated: boolean;
  }>;
}

export interface HostClientOptions {
  channel: MainSideChannel;
  /** Ready-state gate; resolves when the host announces itself. */
  onUnexpectedClose?: (reason?: string) => void;
}

/**
 * The main-side end of the control protocol.
 *
 * One client per host process, shared by every runtime the host offers.
 */
export class HostClient {
  private readonly pending = new Map<RequestId, Pending>();
  private readonly handles = new Map<HandleId, HostBackedHandle>();
  private readonly contexts = new Map<HandleId, RuntimeContext>();
  private nextId = 0;
  private closed: string | null = null;


  /**
   * What the agent host reported at handshake.
   *
   * Widened from a bare id list to carry endpoints too: one host can reach
   * several models, and a client that cannot see which is available cannot
   * offer a choice — nor say which provider a turn was sent to, which §13
   * requires.
   */
  readonly ready: Promise<HostAdvertisement>;
  private announceReady!: (advert: HostAdvertisement) => void;
  private failReady!: (err: Error) => void;

  constructor(private readonly opts: HostClientOptions) {
    this.ready = new Promise((resolve, reject) => {
      this.announceReady = resolve;
      this.failReady = reject;
    });
    // Marks the rejection handled so a caller that never awaits `ready` does not
    // trigger an unhandled rejection. Callers awaiting it still see the error —
    // `.catch()` returns a new promise and leaves this one's state alone.
    this.ready.catch(() => undefined);

    opts.channel.onMessage((message) => this.receive(message));
    opts.channel.onClose((reason) => this.handleClose(reason));
  }

  mintId(): RequestId {
    this.nextId += 1;
    return `r${this.nextId}`;
  }

  request(command: Extract<Parameters<MainSideChannel['post']>[0], { id: RequestId }>): Promise<unknown> {
    if (this.closed !== null) return Promise.reject(new Error(this.closed));
    return new Promise((resolve, reject) => {
      this.pending.set(command.id, { resolve, reject });
      this.opts.channel.post(command);
    });
  }

  private receive(message: HostMessage): void {
    switch (message.t) {
      case 'ready':
        this.announceReady({ runtimeIds: message.runtimeIds, endpoints: message.endpoints ?? [] });
        return;

      case 'ok': {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        pending?.resolve(message.value);
        return;
      }

      case 'err': {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        const error = new Error(message.message);
        if (message.name !== undefined) error.name = message.name;
        pending?.reject(error);
        return;
      }

      case 'event':
        this.handles.get(message.handleId)?.queue.push(message.event);
        return;

      case 'closed': {
        const handle = this.handles.get(message.handleId);
        handle?.queue.end();
        this.handles.delete(message.handleId);
        this.contexts.delete(message.handleId);
        return;
      }

      case 'token':
        this.handles.get(message.handleId)?.setToken(message.token);
        return;

      case 'progress':
        this.contexts.get(message.handleId)?.reportProgress(message.progress);
        return;

      case 'message':
        // Dropped when the handle is gone rather than queued. A message from an
        // agent that has already stopped describes a turn nobody is running, and
        // delivering it would start work on the strength of a dead sender.
        this.contexts.get(message.handleId)?.sendMessage?.(message.message);
        return;

      case 'proposeSplit':
        this.contexts.get(message.handleId)?.proposeSplit?.(message.proposal);
        return;

      case 'ask': {
        const ctx = this.contexts.get(message.handleId);
        if (!ctx) {
          // No context means the handle is gone. Answering `deny` rather than
          // dropping it keeps the host from waiting forever on a dead ask.
          this.opts.channel.post({
            t: 'permission',
            askId: message.askId,
            decision: { result: 'deny', reason: 'agent is no longer live' },
          });
          return;
        }
        void ctx
          .requestPermission(message.ask)
          .then((decision) =>
            this.opts.channel.post({ t: 'permission', askId: message.askId, decision }),
          )
          .catch((err: unknown) =>
            this.opts.channel.post({
              t: 'permission',
              askId: message.askId,
              // A gate that throws must deny, never fall open (§13).
              decision: {
                result: 'deny',
                reason: `permission gate failed: ${err instanceof Error ? err.message : String(err)}`,
              },
            }),
          );
        return;
      }

      case 'compactAsk': {
        const ctx = this.contexts.get(message.handleId);
        /*
         * An answer always goes back, including `null`.
         *
         * A turn is blocked on this promise in the other process. Permission can
         * afford to drop an ask for a dead handle because the tool call it
         * belonged to is gone too; here, staying silent would hang the turn
         * rather than degrade it. `null` means "keep the history you have",
         * which is the right outcome for a missing context, a runtime whose
         * owner cannot compact, and a compaction that threw.
         */
        const reply = (history: CompactedHistory | null): void =>
          this.opts.channel.post({ t: 'compacted', askId: message.askId, history });

        if (!ctx?.compact) {
          reply(null);
          return;
        }
        void ctx
          .compact(message.budgetTokens)
          .then(reply)
          .catch(() => reply(null));
        return;
      }
    }
  }

  /**
   * The host died. Every in-flight request fails and every open stream closes
   * with a transport stop, so the supervisor retries rather than reporting a
   * clean finish — a crashed host must cost time, never memory (§8).
   */
  private handleClose(reason?: string): void {
    this.closed = reason ?? 'agent host exited';

    // `ready` is not a pending request, so failing only those left it unsettled
    // forever when a host died *before* handshaking — and `advertised()` returns
    // it, so attaching a workspace whose host cannot start hung indefinitely
    // rather than reporting the host unavailable.
    this.failReady(new Error(this.closed));

    for (const [, pending] of this.pending) pending.reject(new Error(this.closed));
    this.pending.clear();

    for (const [, handle] of this.handles) {
      handle.queue.push({ type: 'stopped', stop: { kind: 'transport' } });
      handle.queue.end();
    }
    this.handles.clear();
    this.contexts.clear();

    this.opts.onUnexpectedClose?.(reason);
  }

  registerHandle(handleId: HandleId, ctx: RuntimeContext): HostBackedHandle {
    const handle = new HostBackedHandle(this, handleId);
    this.handles.set(handleId, handle);
    this.contexts.set(handleId, ctx);

    // Forward local aborts into the host so `ctx.abortSignal` still cancels a
    // loop running in another process.
    if (ctx.abortSignal.aborted) {
      this.opts.channel.post({ t: 'abort', handleId });
    } else {
      ctx.abortSignal.addEventListener(
        'abort',
        () => this.opts.channel.post({ t: 'abort', handleId }),
        { once: true },
      );
    }

    return handle;
  }

  dispose(): void {
    this.opts.channel.post({ t: 'shutdown' });
    this.opts.channel.close();
  }
}

/** One `AgentRuntime` façade per runtime id the host offers. */
export class HostBackedRuntime implements AgentRuntime {
  /**
   * Assigned only when the host reported one. A constructor parameter property
   * would type as `string | undefined`, which `exactOptionalPropertyTypes`
   * rejects against an optional `string` — the distinction being "absent" versus
   * "present and undefined", and provenance (§5.1) cares which.
   */
  readonly toolVersion?: string;

  constructor(
    private readonly client: HostClient,
    readonly id: string,
    readonly version: string,
    toolVersion?: string,
  ) {
    if (toolVersion !== undefined) this.toolVersion = toolVersion;
  }

  async capabilities(spec: AgentSpec): Promise<RuntimeCapabilities> {
    const value = await this.client.request({
      t: 'capabilities',
      id: this.client.mintId(),
      spec,
    });
    if (value === undefined || value === null) {
      throw new Error(`host returned no capabilities for ${spec.runtimeId}`);
    }
    return value as RuntimeCapabilities;
  }

  start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.open(spec, ctx, { mode: 'start' });
  }

  /**
   * A null token still routes to the host's `resume`, not its `start`. An
   * adapter may legitimately treat "resume with nothing cached" differently,
   * and collapsing the two here would silently take that choice away from it.
   */
  resume(spec: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.open(spec, ctx, { mode: 'resume', token });
  }

  private async open(
    spec: AgentSpec,
    ctx: RuntimeContext,
    how: { mode: 'start' } | { mode: 'resume'; token: string | null },
  ): Promise<AgentHandle> {
    const handleId = `h${this.client.mintId()}`;
    // Registered before the command is sent: the host starts streaming as soon
    // as the adapter is constructed, and a queue created afterwards would miss
    // whatever arrived in between.
    const handle = this.client.registerHandle(handleId, ctx);

    const serializable = {
      ...(ctx.seedHistory !== undefined ? { seedHistory: ctx.seedHistory } : {}),
      ...(ctx.peers !== undefined ? { peers: ctx.peers } : {}),
      ...(ctx.modelEgress !== undefined ? { modelEgress: ctx.modelEgress } : {}),
    };

    await this.client.request(
      how.mode === 'start'
        ? { t: 'start', id: this.client.mintId(), handleId, spec, ctx: serializable }
        : {
            t: 'resume',
            id: this.client.mintId(),
            handleId,
            spec,
            token: how.token,
            ctx: serializable,
          },
    );

    return handle;
  }
}
