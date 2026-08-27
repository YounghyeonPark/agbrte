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
  CompactedHistory,
  ModelCapabilityHint,
  OutboundPeerMessage,
  PeerDelivery,
  PeerHistory,
  PermissionDecision,
  RuntimeContext,
} from '@shared/types/index.js';
import type {
  EndpointModels,
  ModelInstallProgress,
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
  private readonly compactions = new Map<RequestId, (h: CompactedHistory | null) => void>();
  /** In flight `message_peer` calls, waiting for the owner's `peerDelivered`. */
  private readonly peerAsks = new Map<RequestId, (d: PeerDelivery) => void>();
  /** In flight `peer_history` reads, waiting for the owner's `peerHistory`. */
  private readonly peerReads = new Map<
    RequestId,
    (r: { history?: PeerHistory; error?: string }) => void
  >();
  /**
   * Session-tool calls awaiting the owner's answer (§17 Q20).
   *
   * Same shape as `compactions` and for the same reason: a turn in this process
   * is blocked on the promise, so the owner always replies — including with a
   * failure — and nothing here needs a timeout of its own.
   */
  private readonly toolCalls = new Map<
    RequestId,
    (r: { ok: boolean; summary: string; content: string }) => void
  >();
  /** Handles aborted before their `start` arrived. */
  private readonly preAborted = new Set<HandleId>();
  private nextAskId = 0;

  constructor(
    private readonly channel: HostSideChannel,
    private readonly registry: RuntimeRegistry,
    /** Advertised so a client can offer them. Secrets are already stripped. */
    endpoints: PublicEndpoint[] = [],
    /**
     * Asks each endpoint what models it has, now.
     *
     * Injected because answering needs the *resolved* endpoint — the one
     * carrying a credential — and this server is deliberately given only the
     * public ones. The closure is built in `entry.ts`, which is the single place
     * that holds both the provider and the endpoint registry, and nothing here
     * gains the ability to read a key.
     */
    private readonly listModels?: () => Promise<EndpointModels[]>,
    /** Starts a pull, and reports on every one started. Absent means no runner here can. */
    private readonly installer?: {
      install: (endpointId: string, tag: string) => Promise<void>;
      progress: () => ModelInstallProgress[];
    },
    /**
     * Establishes what one model can do, at whatever it costs (§3.3).
     *
     * Injected for the same reason as `listModels`: the answer needs a resolved
     * endpoint, and this server is handed only public ones.
     */
    private readonly probeModel?: (
      endpointId: string,
      modelId: string,
    ) => Promise<ModelCapabilityHint>,
    /**
     * What was looked for and not found (§3.12), for the owner to pass on.
     *
     * Reported rather than logged: this process's stderr goes to a file on
     * whichever machine it runs on, which is the one place the person choosing a
     * runtime is not looking.
     */
    runtimeNotes: Array<{ id: string; label: string; reason: string }> = [],
  ) {
    channel.onMessage((command) => void this.dispatch(command));
    channel.onClose(() => this.shutdown());
    channel.post({
      t: 'ready',
      runtimeIds: registry.list().map((d) => d.id),
      /*
       * The descriptors, not only the ids.
       *
       * The owner forks this process and then has to build its *own* registry,
       * because `admit()` runs there — beside the log and the permission gate.
       * Sending ids alone left it guessing, and what it guessed was a constant
       * in another file, which is how a detected CLI came to be advertised by
       * the same process that would refuse it.
       */
      runtimes: registry.list().map((d) => ({ id: d.id, label: d.label, model: d.model })),
      ...(runtimeNotes.length > 0 ? { runtimeNotes } : {}),
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

      case 'models':
        await this.reply(command.id, async () => (await this.listModels?.()) ?? []);
        return;

      case 'model.capabilities':
        await this.reply(command.id, async () => {
          if (this.probeModel === undefined) {
            // Thrown rather than answered with an empty hint: an empty hint
            // means "asked and nobody could tell", and this is "not asked".
            throw new Error('this host cannot establish model capabilities');
          }
          return this.probeModel(command.endpointId, command.modelId);
        });
        return;

      case 'model.install':
        await this.reply(command.id, async () => {
          if (this.installer === undefined) {
            throw new Error('no runner here can install models');
          }
          await this.installer.install(command.endpointId, command.tag);
          return null;
        });
        return;

      case 'model.progress':
        await this.reply(command.id, () => Promise.resolve(this.installer?.progress() ?? []));
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

      case 'compacted': {
        const resolve = this.compactions.get(command.askId);
        this.compactions.delete(command.askId);
        // Same reasoning as above, with one difference: a turn is waiting on
        // this promise, so an answer for a live handle must always arrive. The
        // owner replies `null` rather than staying silent when it cannot
        // compact — silence here would hang the turn, not degrade it.
        resolve?.(command.history);
        return;
      }

      case 'peerHistory': {
        const resolve = this.peerReads.get(command.askId);
        this.peerReads.delete(command.askId);
        // Same as the others: a turn is waiting, so the owner always answers,
        // and an unknown id means the handle went away with the loop.
        resolve?.({
          ...(command.history !== undefined ? { history: command.history } : {}),
          ...(command.error !== undefined ? { error: command.error } : {}),
        });
        return;
      }

      case 'peerDelivered': {
        const resolve = this.peerAsks.get(command.askId);
        this.peerAsks.delete(command.askId);
        // Same as `compacted` and `toolResult`: a turn is waiting on this, so
        // the owner always answers — an unknown id means the handle went away
        // and took the loop with it.
        resolve?.(command.delivery);
        return;
      }

      case 'toolResult': {
        const resolve = this.toolCalls.get(command.callId);
        this.toolCalls.delete(command.callId);
        // Same as `compacted`: a turn is waiting, so the owner always answers —
        // an unknown id here means the handle went away and the loop with it.
        resolve?.(command.result);
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
      groupPeers?: RuntimeContext['groupPeers'];
      sessionTools?: Array<{ name: string; description: string; schema: object }>;
    },
    abort: AbortController,
  ): RuntimeContext {
    return {
      ...(ctx.seedHistory !== undefined ? { seedHistory: ctx.seedHistory } : {}),
      ...(ctx.modelEgress !== undefined ? { modelEgress: ctx.modelEgress } : {}),
      ...(ctx.peers !== undefined ? { peers: ctx.peers } : {}),
      /*
       * The session's injected tools, rebuilt around the channel (§17 Q20).
       *
       * Declaration on this side, execution on the owner's: the runtime needs
       * the name, description and schema to put the tool in front of the model,
       * and `run` posts a `toolCall` because the MCP connection belongs to
       * whoever owns the log. Exactly the split `compact` uses — and, like
       * `compact`, its absence here was invisible to every unit test, because a
       * test hands the runtime a context directly and never crosses this
       * boundary at all.
       */
      ...(ctx.sessionTools !== undefined
        ? {
            sessionTools: ctx.sessionTools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: tool.schema,
              // The signal is deliberately not forwarded: the owner runs the
              // tool under *its* abort signal for this agent, and an interrupt
              // reaches that side through the `abort` command either way. A
              // second signal on the wire would be a second thing to keep in
              // step with the first.
              run: (args: Record<string, unknown>) =>
                new Promise<{ ok: boolean; summary: string; content: string }>((resolve) => {
                  const callId = `${handleId}:${(this.nextAskId += 1)}`;
                  this.toolCalls.set(callId, resolve);
                  this.channel.post({ t: 'toolCall', callId, handleId, name: tool.name, args });
                }),
            })),
          }
        : {}),
      abortSignal: abort.signal,
      reportProgress: (progress) => this.channel.post({ t: 'progress', handleId, progress }),
      // The pipes are in this process and the tail is kept in the owner's, for
      // the same reason the log is: a handle is a turn, and what the CLI printed
      // has to still be readable after the turn that printed it.
      reportRaw: (line) => this.channel.post({ t: 'raw', handleId, line }),
      // Forwarded verbatim. The sender and the hop count are stamped by the
      // owner of the log, which is the only party that cannot be wrong about
      // either — nothing between here and there can forge attribution (§13).
      sendMessage: (message) => this.channel.post({ t: 'message', handleId, message }),
      /*
       * The cross-session pair, supplied together or not at all (§17 Q22).
       *
       * `message_peer` refuses unless it has both, which is why the list is
       * conditional and the sender is not: a session in no group arrives here
       * with no `groupPeers`, the tool sees a sender with nothing to address,
       * and says there is no group. Wiring the sender unconditionally would
       * break that pairing.
       *
       * A round trip rather than a post, because a peer message can be refused
       * and the refusal belongs to the model that sent it — the same shape as
       * `requestPermission` and `toolCall`, and for the same reason.
       */
      ...(ctx.groupPeers !== undefined
        ? {
            groupPeers: ctx.groupPeers,
            readPeerHistory: (sessionId: string, since?: number) =>
              new Promise<PeerHistory>((resolve, reject) => {
                const askId = `${handleId}:${(this.nextAskId += 1)}`;
                this.peerReads.set(askId, (r) =>
                  r.history !== undefined
                    ? resolve(r.history)
                    : reject(new Error(r.error ?? 'the peer read failed')),
                );
                this.channel.post({
                  t: 'peerHistoryAsk',
                  askId,
                  handleId,
                  sessionId,
                  ...(since !== undefined ? { since } : {}),
                });
              }),
            sendPeerMessage: (message: OutboundPeerMessage) =>
              new Promise<PeerDelivery>((resolve) => {
                const askId = `${handleId}:${(this.nextAskId += 1)}`;
                this.peerAsks.set(askId, resolve);
                this.channel.post({ t: 'peerAsk', askId, handleId, message });
              }),
          }
        : {}),
      proposeSplit: (proposal) => this.channel.post({ t: 'proposeSplit', handleId, proposal }),
      requestPermission: (ask) =>
        new Promise<PermissionDecision>((resolve) => {
          const askId = `${handleId}:${(this.nextAskId += 1)}`;
          this.asks.set(askId, resolve);
          this.channel.post({ t: 'ask', askId, handleId, ask: { ...ask, agentId: spec.agentId } });
        }),
      /*
       * Compaction crosses the channel for the same reason permission does: the
       * runtime is here and the log is written over there (§3.7).
       *
       * This was missing, and missing invisibly. The context the runtime is
       * handed is assembled *here*, so a hook added only to the owner's own
       * factory left `ctx.compact` undefined on every real session while the
       * unit tests — which construct a context directly — went on passing.
       */
      compact: (budgetTokens) =>
        new Promise<CompactedHistory | null>((resolve) => {
          const askId = `${handleId}:${(this.nextAskId += 1)}`;
          this.compactions.set(askId, resolve);
          this.channel.post({ t: 'compactAsk', askId, handleId, budgetTokens });
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
    // A session-tool call outstanding for a dead handle hangs the same loop for
    // the same reason (§17 Q20). Settled as a tool failure rather than denied:
    // it is not a decision, it is a call that will not come back.
    for (const [callId, resolve] of [...this.toolCalls]) {
      if (!callId.startsWith(`${handleId}:`)) continue;
      this.toolCalls.delete(callId);
      resolve({
        ok: false,
        summary: 'session tool interrupted',
        content: 'the agent stopped before the tool returned',
      });
    }
    /*
     * The cross-session pair, for the same reason and with two different
     * answers (§17 Q22).
     *
     * A message is *refused* — it never reached the other session, and §17 Q22's
     * rule is that a refusal reaches the model that sent it rather than being
     * dropped. A read *fails* — it is not a decision anybody declined to make,
     * it is an answer that will not come back.
     *
     * Both were missing, and both hang the same loop the two above hang. Found
     * by the test for the read; the message half had shipped with the hole.
     */
    for (const [askId, resolve] of [...this.peerAsks]) {
      if (!askId.startsWith(`${handleId}:`)) continue;
      this.peerAsks.delete(askId);
      resolve({ accepted: false, reason: 'the agent stopped before the message was sent' });
    }
    for (const [askId, resolve] of [...this.peerReads]) {
      if (!askId.startsWith(`${handleId}:`)) continue;
      this.peerReads.delete(askId);
      resolve({ error: 'the agent stopped before the read returned' });
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
