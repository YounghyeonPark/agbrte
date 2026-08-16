/**
 * Agent host supervision (DESIGN.md §8).
 *
 * `SessionManager` holds a `RuntimeRegistry` for the life of a workspace, but
 * the process behind it can die. This class keeps the registry's entries stable
 * while the process underneath is replaced, so a crash never invalidates
 * anything the manager is holding.
 *
 * The mechanism is one level of indirection: registered runtimes are façades
 * that resolve the *current* `HostClient` on each call. A crash therefore
 * surfaces exactly where §8 says it should — as a `transport` stop, which
 * `stopDisposition` classifies as `retry`, so the next turn opens a fresh handle
 * and rehydrates from the log. A crash costs time, never memory.
 *
 * Respawning is **lazy**. Eagerly restarting a process that crashes on startup
 * is a CPU-burning loop with no work to do; waiting until something asks means a
 * broken host is diagnosed by a failing request rather than by a hot fan.
 */

import type {
  AgentHandle,
  AgentRuntime,
  AgentSpec,
  ModelCapabilityHint,
  RuntimeCapabilities,
  RuntimeContext,
} from '@shared/types/index.js';
import type { MainSideChannel } from '@shared/host/protocol.js';
import type { ModelNeed } from '../runtime/registry.js';
import type { HostAdvertisement } from './hostRuntime.js';
import type { EndpointModels, ModelInstallProgress } from '@shared/host/protocol.js';
import { HostBackedRuntime, HostClient } from './hostRuntime.js';

export interface HostSupervisorOptions {
  /** Creates a fresh channel to a new host process. */
  spawn: () => { channel: MainSideChannel };
  /** Descriptors to advertise. Must match what the host actually registers. */
  runtimes: Array<{ id: string; label: string; version: string; model: ModelNeed }>;
  onRestart?: (attempt: number, reason?: string) => void;
}

export class HostSupervisor {
  private client: HostClient | null = null;
  private restarts = 0;
  private disposed = false;

  constructor(private readonly opts: HostSupervisorOptions) {}

  /**
   * The live client, spawning a host if there is none.
   *
   * Every proxied call goes through here, which is what makes the replacement
   * invisible to callers holding a runtime reference.
   */
  private current(): HostClient {
    if (this.disposed) throw new Error('agent host supervisor is disposed');
    if (this.client !== null) return this.client;

    const { channel } = this.opts.spawn();
    const client = new HostClient({
      channel,
      onUnexpectedClose: (reason) => {
        // Only clear if this is still the current client: a close arriving from
        // an already-replaced process must not discard the live one.
        if (this.client === client) this.client = null;
        this.restarts += 1;
        this.opts.onRestart?.(this.restarts, reason);
      },
    });
    this.client = client;
    return client;
  }

  /** Runtime façades to register. Stable for the workspace's lifetime. */
  runtimes(): Array<{ runtime: AgentRuntime; label: string; model: ModelNeed }> {
    return this.opts.runtimes.map((descriptor) => ({
      label: descriptor.label,
      model: descriptor.model,
      runtime: new HostedFacade(() => this.current(), descriptor.id, descriptor.version),
    }));
  }

  /** Ids the running host actually reported, for reconciling against `runtimes`. */
  async advertised(): Promise<string[]> {
    return (await this.current().ready).runtimeIds;
  }

  /** Models the running host can reach, credentials already stripped. */
  async endpoints(): Promise<HostAdvertisement['endpoints']> {
    return (await this.current().ready).endpoints;
  }

  /** Begin pulling a model into an endpoint that can take one. */
  async installModel(endpointId: string, tag: string): Promise<void> {
    const client = this.current();
    await client.ready;
    await client.request({ t: 'model.install', id: client.mintId(), endpointId, tag });
  }

  /** How far every install on this host has got. */
  async installProgress(): Promise<ModelInstallProgress[]> {
    const client = this.current();
    await client.ready;
    return ((await client.request({ t: 'model.progress', id: client.mintId() })) ??
      []) as ModelInstallProgress[];
  }

  /**
   * Which models each endpoint has, asked now.
   *
   * Deliberately not derived from the handshake the way `endpoints()` is. The
   * set of endpoints is configuration and changes when a file changes; the set
   * of *models* changes when somebody runs `ollama pull`, which is a thing they
   * do while the host is running and expect to see the result of.
   */
  async models(): Promise<EndpointModels[]> {
    const client = this.current();
    await client.ready;
    const value = await client.request({ t: 'models', id: client.mintId() });
    return (value ?? []) as EndpointModels[];
  }

  /**
   * What one model can actually do (§3.3).
   *
   * Separate from `models()` because the cost is: this one probes, which for
   * `openai-compatible` means real inference requests. Asked for a model
   * somebody chose, never for a list.
   */
  async modelCapabilities(endpointId: string, modelId: string): Promise<ModelCapabilityHint> {
    const client = this.current();
    await client.ready;
    const value = await client.request({
      t: 'model.capabilities',
      id: client.mintId(),
      endpointId,
      modelId,
    });
    return value as ModelCapabilityHint;
  }

  get restartCount(): number {
    return this.restarts;
  }

  dispose(): void {
    this.disposed = true;
    this.client?.dispose();
    this.client = null;
  }
}

/**
 * An `AgentRuntime` that resolves its client per call.
 *
 * A plain `HostBackedRuntime` would capture one client and keep proxying to a
 * dead process after a crash, so every subsequent turn would fail with "agent
 * host exited" instead of transparently starting a new host.
 */
class HostedFacade implements AgentRuntime {
  constructor(
    private readonly client: () => HostClient,
    readonly id: string,
    readonly version: string,
  ) {}

  private runtime(): HostBackedRuntime {
    return new HostBackedRuntime(this.client(), this.id, this.version);
  }

  capabilities(spec: AgentSpec): Promise<RuntimeCapabilities> {
    return this.runtime().capabilities(spec);
  }

  start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.runtime().start(spec, ctx);
  }

  resume(spec: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return this.runtime().resume(spec, token, ctx);
  }
}
