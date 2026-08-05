/**
 * The Electron `utilityProcess` transport for an AgentHost (DESIGN.md §8).
 *
 * Everything protocol-shaped lives in `hostRuntime.ts` and `server.ts`; this
 * file is only the pipe and the supervision around it. That split is what lets
 * Phase 5 reuse the same protocol over SSH by writing a different channel.
 *
 * ## Supervision
 *
 * §8: "A crashed worker is restarted by its host, rehydrating from the log — a
 * crash costs time, never memory." A crash here surfaces as a `transport` stop
 * on every open stream, which `stopDisposition` classifies as `retry`, so the
 * next turn opens a fresh handle and rehydrates. The restart is therefore lazy:
 * the process is respawned on the next request rather than eagerly, because
 * respawning immediately would burn CPU in a crash loop with no work to do.
 */

import { utilityProcess, type UtilityProcess } from 'electron';
import type {
  HostCommand,
  HostMessage,
  MainSideChannel,
} from '@shared/host/protocol.js';

/** A channel over one `utilityProcess`. */
class UtilityChannel implements MainSideChannel {
  private handler: ((m: HostMessage) => void) | null = null;
  private closeHandler: ((reason?: string) => void) | null = null;
  private readonly backlog: HostMessage[] = [];
  private dead = false;
  private exitReason: string | undefined;

  constructor(private readonly child: UtilityProcess) {
    child.on('message', (message: HostMessage) => {
      if (this.handler === null) {
        // The `ready` handshake can land before the client attaches, and losing
        // it would leave `client.ready` pending forever.
        this.backlog.push(message);
        return;
      }
      this.handler(message);
    });

    child.on('exit', (code) => {
      this.dead = true;
      this.exitReason = `agent host exited with code ${code}`;
      this.closeHandler?.(this.exitReason);
    });
  }

  post(message: HostCommand): void {
    if (this.dead) return;
    this.child.postMessage(message);
  }

  onMessage(handler: (m: HostMessage) => void): void {
    this.handler = handler;
    for (const message of this.backlog.splice(0)) handler(message);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandler = handler;
    // A child can exit before the client finishes constructing — a missing
    // binary exits immediately. Without this the exit is dropped and the client
    // waits forever for a handshake that will never arrive.
    if (this.dead) handler(this.exitReason);
  }

  close(): void {
    if (this.dead) return;
    this.dead = true;
    // `kill()` rather than waiting for a graceful exit: the client has already
    // sent `shutdown`, and a host wedged on a hung tool subprocess is exactly
    // the case where a polite close never returns.
    this.child.kill();
  }
}

export interface SpawnedHost {
  channel: MainSideChannel;
  pid: number | undefined;
}

/**
 * Fork an agent host process.
 *
 * `stdio: 'inherit'` so an adapter's diagnostics reach the terminal in dev.
 * Note that on Windows the parent may be a GUI-subsystem process, in which case
 * that output goes nowhere — the same trap documented in `scripts/launch.mjs`.
 */
export function spawnAgentHost(opts: {
  entry: string;
  workspaceRoot: string;
  modelBaseUrl?: string;
}): SpawnedHost {
  const child = utilityProcess.fork(opts.entry, [], {
    serviceName: 'loom-agent-host',
    stdio: 'inherit',
    env: {
      ...process.env,
      LOOM_WORKSPACE_ROOT: opts.workspaceRoot,
      ...(opts.modelBaseUrl !== undefined ? { LOOM_MODEL_BASE_URL: opts.modelBaseUrl } : {}),
    },
  });

  return { channel: new UtilityChannel(child), pid: child.pid };
}
