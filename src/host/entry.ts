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
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { LoomHarnessRuntime } from '@main/runtime/runtimes/loomHarness.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import {
  OpenAiCompatibleProvider,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from '@main/runtime/providers/openaiCompatible.js';
import type { ModelEndpoint } from '@shared/types/index.js';

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

function localEndpoint(): ModelEndpoint {
  return {
    endpointId: 'local-ollama',
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: process.env['LOOM_MODEL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
    auth: { kind: 'none' },
    locality: 'app-local',
    dataHandling: { provider: 'local' },
  };
}

/**
 * The runtimes this host offers.
 *
 * Must stay in agreement with what main advertises to the renderer: main lists
 * runtime ids from the host's `ready` handshake, so anything missing here simply
 * does not appear in the UI rather than failing at `addAgent`.
 */
export function buildHostRegistry(): RuntimeRegistry {
  const registry = new RuntimeRegistry();

  registry.register(
    new LoomHarnessRuntime({
      provider: new OpenAiCompatibleProvider(),
      endpoint: localEndpoint(),
    }),
    { label: 'Loom harness (local model)', requiresModel: true },
  );

  registry.register(new EchoRuntime(), { label: 'Echo (no model)', requiresModel: false });

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

new AgentHostServer(channel, buildHostRegistry());
