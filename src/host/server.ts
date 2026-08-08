/**
 * The AgentHost server (DESIGN.md §8, §6.4).
 *
 * Runs inside the host process — a local `utilityProcess` today, a
 * `agbrte-agent-host` binary over SSH in Phase 5. It owns the runtime registry,
 * the adapters, and the agent loops. It owns no session state, no policy, and
 * no log: those stay with whoever asked, which is what keeps one append-only
 * writer per session (§5.1) and one place where every permission decision is
 * recorded (§13).
 *
 * Transport-free by construction: it takes a `HostSideChannel`. The Electron
 * entry point is a dozen lines on top of this, and the tests drive it with an
 * in-memory channel.
 */

import type {
  AgentHandle,
  AgentSpec,
  PermissionDecision,
  RuntimeContext,
} from '@shared/types/index.js';
import type {
  HandleId,
  HostCommand,
  HostSideChannel,
  RequestId,
} from '@shared/host/protocol.js';
import type { RuntimeRegistry } from '@main/runtime/registry.js';
import type { PublicEndpoint } from './endpoints.js';

interface LiveHandle {
  handle: AgentHandle;
  abort: AbortController;
  /** Set once the event pump has drained, so teardown is idempotent. */
  closed: boolean;
}

export class AgentHostServer {
  private readonly handles = new Map<HandleId, LiveHandle>();
  /** Permission asks awaiting an answer from the other side. */
  private readonly asks = new Map<RequestId, (d: PermissionDecision) => void>();
  /** Handles aborted before their `start` arrived. */
  private readonly preAborted = new Set<HandleId>();
  private nextAskId = 0;

  constructor(
    private readonly channel: HostSideChannel,
    private readonly registry: RuntimeRegistry,
    /** Advertised so a client can offer them. Secrets are already stripped. */
    endpoints: PublicEndpoint[] = [],
  ) {
    channel.onMessage((command) => void this.dispatch(command));
    channel.onClose(() => this.shutdown());
    channel.post({
      t: 'ready',
      runtimeIds: registry.list().map((d) => d.id),
      endpoints,
    });
  }

  private async dispatch(command: HostCommand): Promise<void> {
    switch (command.t) {
      case 'capabilities':
        await this.reply(command.id, () =>
          this.registry.get(command.spec.runtimeId).capabilities(command.spec),
        );
        return;

      case 'start':
      case 'resume':
        await this.reply(command.id, async () => {
          const runtime = this.registry.get(command.spec.runtimeId);
          const abort = new AbortController();

          // An abort can legitimately arrive *before* the handle exists: main
          // registers the handle and wires the signal before sending `start`, so
          // an already-aborted signal posts `abort` first. Applying it here — and
          // before the adapter is constructed — is what makes the signal it
          // receives already-aborted rather than silently live.
          if (this.preAborted.delete(command.handleId)) abort.abort();

          const ctx = this.contextFor(command.handleId, command.spec, command.ctx, abort);

          const handle =
            command.t === 'start'
              ? await runtime.start(command.spec, ctx)
              : await runtime.resume(command.spec, command.token, ctx);

          this.handles.set(command.handleId, { handle, abort, closed: false });

          // Subscribe before replying. The host is the only consumer of this
          // stream, and `AgentHandle.events` is consumable once — starting the
          // pump after the reply would race a `send` that arrives immediately,
          // and an adapter that buffers from construction would look like it
          // emitted nothing.
          void this.pump(command.handleId, handle);
          this.pushToken(command.handleId, handle);
          return undefined;
        });
        return;

      case 'send':
        await this.reply(command.id, async () => {
          await this.live(command.handleId).handle.send(command.turn);
          this.pushToken(command.handleId, this.live(command.handleId).handle);
          return undefined;
        });
        return;

      case 'interrupt':
        await this.reply(command.id, () => this.live(command.handleId).handle.interrupt());
        return;

      case 'stop':
        await this.reply(command.id, async () => {
          const live = this.handles.get(command.handleId);
          // Idempotent: stopping an already-gone handle is a normal race with
          // the turn ending on its own, not an error worth propagating.
          if (live) {
            live.abort.abort();
            await live.handle.stop(command.reason);
          }
          return undefined;
        });
        return;

      case 'abort': {
        const live = this.handles.get(command.handleId);
        if (live) {
          live.abort.abort();
        } else {
          // Recorded, not dropped — see the note in `start`. Dropping it made an
          // agent started from an already-cancelled context run anyway.
          this.preAborted.add(command.handleId);
        }
        return;
      }

      case 'permission': {
        const resolve = this.asks.get(command.askId);
        this.asks.delete(command.askId);
        // A decision for an unknown ask means the handle already went away.
        // Dropping it is right; the tool call it belonged to is gone too.
        resolve?.(command.decision);
        return;
      }

      case 'shutdown':
        this.shutdown();
        return;
    }
  }

  /** Run `fn`, then reply `ok` with its value, or `err`. Never throws. */
  private async reply(id: RequestId, fn: () => Promise<unknown>): Promise<void> {
    try {
      const value = await fn();
      this.channel.post({ t: 'ok', id, ...(value !== undefined ? { value } : {}) });
    } catch (err) {
      // The message must survive: an adapter refusing a spec, a missing
      // runtime, and a dead model server are all diagnosed from this string.
      this.channel.post({
        t: 'err',
        id,
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error ? { name: err.name } : {}),
      });
    }
  }

  private contextFor(
    handleId: HandleId,
    spec: AgentSpec,
    ctx: {
      seedHistory?: RuntimeContext['seedHistory'];
      modelEgress?: RuntimeContext['modelEgress'];
      peers?: RuntimeContext['peers'];
    },
    abort: AbortController,
  ): RuntimeContext {
    return {
      ...(ctx.seedHistory !== undefined ? { seedHistory: ctx.seedHistory } : {}),
      ...(ctx.modelEgress !== undefined ? { modelEgress: ctx.modelEgress } : {}),
      ...(ctx.peers !== undefined ? { peers: ctx.peers } : {}),
      abortSignal: abort.signal,
      reportProgress: (progress) => this.channel.post({ t: 'progress', handleId, progress }),
      // Forwarded verbatim. The sender and the hop count are stamped by the
      // owner of the log, which is the only party that cannot be wrong about
      // either — nothing between here and there can forge attribution (§13).
      sendMessage: (message) => this.channel.post({ t: 'message', handleId, message }),
      proposeSplit: (proposal) => this.channel.post({ t: 'proposeSplit', handleId, proposal }),
      requestPermission: (ask) =>
        new Promise<PermissionDecision>((resolve) => {
          const askId = `${handleId}:${(this.nextAskId += 1)}`;
          this.asks.set(askId, resolve);
          this.channel.post({ t: 'ask', askId, handleId, ask: { ...ask, agentId: spec.agentId } });
        }),
    };
  }

  /** Drain a handle's stream onto the channel, then announce the close. */
  private async pump(handleId: HandleId, handle: AgentHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        this.channel.post({ t: 'event', handleId, event });
      }
    } catch (err) {
      // A stream that dies mid-turn is a transport failure, which is retryable.
      // Reporting the close without this would look like a clean finish — a
      // silently truncated turn presented as success (§3.9).
      this.channel.post({
        t: 'event',
        handleId,
        event: { type: 'stopped', stop: { kind: 'transport' } },
      });
      void err;
    } finally {
      const live = this.handles.get(handleId);
      if (live && !live.closed) {
        live.closed = true;
        this.pushToken(handleId, handle);
        this.channel.post({ t: 'closed', handleId });
      }
      this.handles.delete(handleId);
      this.failAsksFor(handleId);
    }
  }

  private pushToken(handleId: HandleId, handle: AgentHandle): void {
    this.channel.post({ t: 'token', handleId, token: handle.resumeToken() });
  }

  /**
   * Deny any permission ask still outstanding for a dead handle.
   *
   * Leaving them unresolved would hang the adapter's `requestPermission`
   * forever, and with it the loop that is waiting to be torn down.
   */
  private failAsksFor(handleId: HandleId): void {
    for (const [askId, resolve] of [...this.asks]) {
      if (!askId.startsWith(`${handleId}:`)) continue;
      this.asks.delete(askId);
      resolve({ result: 'deny', reason: 'agent stopped before the request was answered' });
    }
  }

  private live(handleId: HandleId): LiveHandle {
    const live = this.handles.get(handleId);
    if (!live) throw new Error(`no live handle ${handleId}`);
    return live;
  }

  shutdown(): void {
    for (const [handleId, live] of [...this.handles]) {
      live.abort.abort();
      void live.handle.stop('host shutting down');
      this.failAsksFor(handleId);
    }
    this.handles.clear();
  }
}
