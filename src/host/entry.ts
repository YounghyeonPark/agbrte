/**
 * AgentHost process entry point (DESIGN.md §8).
 *
 * Deliberately thin: it builds the registry, wraps whichever parent channel it
 * has, and hands both to `AgentHostServer`. All the behaviour is there and is
 * tested in-process over an in-memory channel.
 *
 * This process owns agent loops and tool execution. It does **not** own the
 * event log, session state, or policy — those belong to the session host, which
 * keeps one append-only writer per session (§5.1) and one place where every
 * permission decision is recorded (§13).
 *
 * **Two parents, one entry.** It runs under an Electron `utilityProcess`
 * (`process.parentPort`) and under a plain `child_process.fork` (`process.send`).
 * The session host is a standalone Node process and cannot use the former, but
 * it still wants a separate process for loops — a crashing adapter must not take
 * down the owner of the log. Detecting the parent here is cheaper than
 * maintaining two entry points that must not drift.
 */

import type { HostMessage, HostCommand, HostSideChannel } from '@shared/host/protocol.js';
import { AgentHostServer } from './server.js';
import { loadEndpoints, type EndpointRegistry } from './endpoints.js';
import type { EndpointModels } from '@shared/host/protocol.js';
import { detectRunner, ModelInstaller } from './modelInstall.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import {
  AgbrteHarnessRuntime,
  AGBRTE_HARNESS_RUNTIME_ID,
  RETIRED_HARNESS_RUNTIME_ID,
} from '@main/runtime/runtimes/agbrteHarness.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { CliStdioRuntime, detectCli, runtimeIdFor } from '@main/runtime/runtimes/cliStdio.js';
import { CLI_MANIFESTS } from '@main/runtime/cli/manifests.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@main/runtime/providers/openaiCompatible.js';
import type { ModelCapabilityHint, ModelEndpoint, ModelProvider } from '@shared/types/index.js';

/**
 * `parentPort` in a utilityProcess: `postMessage` plus a `message` event.
 *
 * There is no `exit` to listen for from in here — this *is* the child — so
 * `onClose` is wired to the port closing, which is what a killed parent looks
 * like from this side.
 */
class ParentPortChannel implements HostSideChannel {
  private handler: ((m: HostCommand) => void) | null = null;
  private readonly backlog: HostCommand[] = [];

  constructor(private readonly port: NonNullable<typeof process.parentPort>) {
    port.on('message', (event: { data: HostCommand }) => {
      if (this.handler === null) {
        this.backlog.push(event.data);
        return;
      }
      this.handler(event.data);
    });
  }

  post(message: HostMessage): void {
    this.port.postMessage(message);
  }

  onMessage(handler: (m: HostCommand) => void): void {
    this.handler = handler;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    process.on('exit', () => handler('host process exiting'));
  }

  close(): void {
    process.exit(0);
  }
}

/**
 * `process.send` in a forked child. Same shape, different API.
 *
 * `disconnect` fires when the parent goes away, which for the session host means
 * the process that owns the log has died — there is nothing left to serve.
 */
class ForkChannel implements HostSideChannel {
  private handler: ((m: HostCommand) => void) | null = null;
  private readonly backlog: HostCommand[] = [];

  constructor() {
    process.on('message', (message: HostCommand) => {
      if (this.handler === null) {
        this.backlog.push(message);
        return;
      }
      this.handler(message);
    });
  }

  post(message: HostMessage): void {
    process.send?.(message);
  }

  onMessage(handler: (m: HostCommand) => void): void {
    this.handler = handler;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    process.on('disconnect', () => handler('session host disconnected'));
  }

  close(): void {
    process.exit(0);
  }
}

/**
 * What this host looked for and did not find, in the order it looked.
 *
 * Carried out of `buildHostRegistry` rather than logged, because the machine
 * that knows is not the machine somebody is looking at: a host three time zones
 * away writing "claude not found" to its own stderr has told nobody. §3.12's
 * whole premise is that detection is per machine, and the corollary nobody
 * built until it cost a session is that the *result* has to travel.
 */
export interface RuntimeNote {
  /** The id it would have had, so a client can match it against a known list. */
  id: string;
  label: string;
  reason: string;
}

/**
 * The runtimes this host offers, and the ones it could not.
 *
 * Must stay in agreement with what main advertises to the renderer: main lists
 * runtime ids from the host's `ready` handshake, so anything missing here simply
 * does not appear in the UI rather than failing at `addAgent`.
 */
export async function buildHostRegistry(
  endpoints: EndpointRegistry,
  /**
   * The provider the harness will run on.
   *
   * Taken as an argument so the *same instance* — and therefore the same probe
   * cache — answers the picker's "what can this model do" and the run that
   * follows it. Two instances would probe twice: once to draw a badge and again
   * on the first turn, which is two inference requests for one answer and, worse,
   * two answers that can disagree.
   */
  provider: ModelProvider = new OpenAiCompatibleProvider({ keyFor: (id) => endpoints.keyFor(id) }),
  /**
   * Filled with one line per CLI that was looked for and not found.
   *
   * An out-parameter rather than a changed return type, because this function is
   * the seam three other things already build against and widening it to a pair
   * would touch each of them to deliver a diagnostic. The notes are additive:
   * every existing caller ignores the argument and gets exactly the registry it
   * got before.
   */
  notes: RuntimeNote[] = [],
): Promise<RuntimeRegistry> {
  const registry = new RuntimeRegistry();

  /**
   * One table for the whole workspace (§9).
   *
   * Created here rather than inside a runtime so the sharing is visible at the
   * wiring site: leases are keyed by path and scoped to the *workspace*, so two
   * tables would let two agents each believe they hold the same file. This
   * process is one per workspace and adjacent to its filesystem, which is
   * exactly where §9 says lease authority belongs.
   *
   * It covers contention between sessions as well as within one, with no extra
   * mechanism — the property that stops hierarchy reintroducing cross-session
   * clobbering the moment it is used.
   */
  const leases = new WorkspaceLeases();

  registry.register(
    new AgbrteHarnessRuntime({
      leases,
      // The credential lookup lives with the provider, which is the only place a
      // request is actually made. The endpoint it resolves carries no secret.
      provider,
      endpointFor: (endpointId) => endpoints.resolve(endpointId),
    }),
    { label: 'Agbrte harness', model: 'required' },
  );
  registry.alias(RETIRED_HARNESS_RUNTIME_ID, AGBRTE_HARNESS_RUNTIME_ID);

  registry.register(new EchoRuntime(), { label: 'Echo (no model)', model: 'none' });

  /**
   * Installed CLIs, offered only where they exist (§3.12).
   *
   * Detected rather than listed, because this host may be a laptop or a server
   * three time zones away and the answer differs per machine — which is the
   * whole reason capabilities are a function rather than a constant (§3.2).
   * Listing an uninstalled CLI would put a runtime in the picker whose every
   * session fails at the first spawn.
   *
   * Detection is a subprocess each, run in parallel: a missing binary resolves
   * fast, but a slow one should not delay the rest of the host coming up.
   *
   * **A miss is recorded rather than skipped.** Not offering a CLI that is not
   * installed is right and stays; saying nothing about it was the mistake. The
   * two are separable, and the second one costs a string.
   */
  const detected = await Promise.all(
    CLI_MANIFESTS.map(async (manifest) => ({ manifest, found: await detectCli(manifest) })),
  );
  for (const { manifest, found } of detected) {
    if (!found.found) {
      notes.push({
        id: runtimeIdFor(manifest),
        label: manifest.label,
        reason: found.reason,
      });
      continue;
    }
    registry.register(new CliStdioRuntime({ manifest, toolVersion: found.version }), {
      // The version is in the label because these protocols are the vendor's to
      // change, and "which build produced this transcript" is the first question
      // asked when one does.
      label: `${manifest.label} ${found.version}`,
      // Optional, which is the answer a boolean could not give. These CLIs
      // authenticate themselves and have their own default; `-m` is a choice a
      // user is entitled to make, and `false` had admission reject it.
      model: 'optional',
    });
  }

  return registry;
}

const port = process.parentPort;
const channel: HostSideChannel =
  port !== undefined
    ? new ParentPortChannel(port)
    : process.send !== undefined
      ? new ForkChannel()
      : (() => {
          throw new Error(
            'agent host needs a parent: run it as an Electron utilityProcess or a forked child',
          );
        })();

// Unhandled rejections must not silently kill the host: the whole point of this
// process is that a failing adapter is survivable. Reported and kept alive; the
// affected turn already failed through its own error path.
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`agent host unhandled rejection: ${String(reason)}\n`);
});

// Awaited before the server exists, because a malformed endpoint file must
// stop the host rather than surface as a turn that quietly went to the wrong
// place. The failure reaches the app as `unavailableReason` on the handshake.
const endpoints = await loadEndpoints();

/*
 * Ask every endpoint what models it has, on demand.
 *
 * Built here because this is the one scope holding both the provider and the
 * *resolved* endpoints — the ones carrying credentials. The server is given
 * this closure rather than either of those, so nothing downstream gains the
 * ability to read a key while gaining the ability to ask the question.
 *
 * Each endpoint is asked independently and a failure is returned rather than
 * thrown: a machine with a local Ollama and a hosted API is the ordinary case,
 * and the local one is unreachable whenever the laptop is elsewhere. One
 * endpoint being down is not a reason to have no answer about the others.
 */
const provider = new OpenAiCompatibleProvider({ keyFor: (id) => endpoints.keyFor(id) });

/**
 * How many models per endpoint are asked to describe themselves.
 *
 * A bound rather than a preference. Self-description is one cheap metadata read
 * per model (§3.3 prefers it over probing precisely because it is), but "cheap"
 * times an unbounded list is a burst fired by somebody opening a menu. Beyond
 * this the hint is simply absent, which the picker already renders as *unknown*
 * — the same degradation as an endpoint that does not self-describe at all.
 */
const SELF_DESCRIBE_LIMIT = 64;

const modelLister = async (): Promise<EndpointModels[]> => {
  return Promise.all(
    endpoints.list().map(async ({ id, baseUrl }): Promise<EndpointModels> => {
      // Asked together because a client needs both to draw one control: the
      // list to choose from, and whether "install" is even a thing here.
      const runner = await detectRunner(id, baseUrl);
      const capability = {
        runner: runner.kind,
        canInstall: runner.canInstall,
        ...(runner.reason !== undefined ? { installHint: runner.reason } : {}),
      };
      try {
        const found = await provider.listModels(endpoints.resolve(id));
        const models = found.map((m) => m.modelId);
        return { endpointId: id, models, ...capability, ...(await hintsFor(id, models)) };
      } catch (err) {
        return {
          endpointId: id,
          models: [],
          error: err instanceof Error ? err.message : String(err),
          ...capability,
        };
      }
    }),
  );
};

/**
 * The free half of §3.3, for a whole list.
 *
 * `describe` never runs a model: it reads what the server says about itself and
 * hands back any probe already in this process's cache. The expensive half is
 * `model.capabilities` below, asked for one model at a time.
 *
 * A model that throws is left out rather than reported as incapable — an absent
 * hint is the honest "nobody could tell", and `false` would be a claim.
 */
async function hintsFor(
  endpointId: string,
  models: string[],
): Promise<{ capabilities?: ModelCapabilityHint[] }> {
  if (provider.describe === undefined) return {};
  const describe = provider.describe.bind(provider);
  const endpoint = endpoints.resolve(endpointId);
  const hints = await Promise.all(
    models.slice(0, SELF_DESCRIBE_LIMIT).map(async (modelId) => {
      try {
        return await describe(endpoint, modelId);
      } catch {
        return null;
      }
    }),
  );
  const kept = hints.filter((h): h is ModelCapabilityHint => h !== null);
  return kept.length > 0 ? { capabilities: kept } : {};
}

/**
 * What one model can actually do, paying the probe (§3.3).
 *
 * Asked for a model somebody selected, never for a list. The failure is
 * returned as a hint carrying `error` rather than thrown, so a picker shows one
 * sentence about the model it asked about instead of losing the row.
 */
const modelCapabilities = async (
  endpointId: string,
  modelId: string,
): Promise<ModelCapabilityHint> => {
  try {
    const endpoint = endpoints.resolve(endpointId);
    // Fills the cache `describe()` and the harness both read, so this is paid
    // for once per (endpoint, model) however many times it is asked.
    await provider.probe(endpoint, modelId);
    return (await provider.describe?.(endpoint, modelId)) ?? { endpointId, modelId };
  } catch (err) {
    return { endpointId, modelId, error: err instanceof Error ? err.message : String(err) };
  }
};

/*
 * One installer for the host's lifetime, so progress survives the request that
 * started it. A pull is minutes long and the call that begins it returns in
 * milliseconds — the state has to outlive the caller or there is nothing to ask.
 */
const installer = new ModelInstaller();
const modelInstaller = {
  install: async (endpointId: string, tag: string): Promise<void> => {
    const endpoint = endpoints.list().find((e) => e.id === endpointId);
    if (endpoint === undefined) throw new Error(`no endpoint "${endpointId}" on this host`);
    const runner = await detectRunner(endpointId, endpoint.baseUrl);
    // Refused here rather than attempted and failed at a 404: the reason is
    // about the runner, and only this side knows which one it is.
    if (!runner.canInstall) throw new Error(runner.reason ?? 'this endpoint cannot install models');
    installer.start(endpointId, endpoint.baseUrl, tag);
  },
  progress: () => installer.progress(),
};

/**
 * Filled by `buildHostRegistry` and handed straight to the handshake.
 *
 * Declared before the registry it describes because the registry is `await`ed
 * into the constructor call, and the notes have to exist for it to fill.
 */
const runtimeNotes: RuntimeNote[] = [];

new AgentHostServer(
  channel,
  // The same provider instance the lister and the probe use: one cache, so a
  // capability shown in the picker is the capability the run was started with.
  await buildHostRegistry(endpoints, provider, runtimeNotes),
  endpoints.list(),
  modelLister,
  modelInstaller,
  modelCapabilities,
  runtimeNotes,
);
