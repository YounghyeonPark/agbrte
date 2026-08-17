/**
 * Getting a connection to a workspace's session host (DESIGN.md §6.4, §8).
 *
 * The app's side of detachment. Connect to the host that is already running; if
 * there is none, start one **detached** and connect to that.
 *
 * ## Detached means detached
 *
 * `detached: true` plus `unref()` plus `stdio: 'ignore'`. All three are needed
 * and each fixes a different way the child would otherwise die with its parent:
 * a shared process group forwards Ctrl-C to it, an unreffed handle is what lets
 * the parent's event loop exit without waiting, and an inherited stdio keeps a
 * pipe open to a terminal that is going away. Getting two of the three right
 * produces a host that survives some exits and not others, which is worse than
 * one that never survives — the failure is intermittent.
 *
 * ## The record is a hint, the socket is the truth
 *
 * `host.json` can outlive the process it describes: killed, out of memory, power
 * cut. So a failed connect is not an error, it is "no host" — the record is
 * cleared and one is started. Trusting the file would give the classic
 * stale-pidfile deadlock, where an app refuses to start a host because a record
 * of a dead one exists.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, hostSocketPath } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { clearHostRecord, readHostRecord } from '../../host/discovery.js';
import { openWorkspace } from '../store/identity.js';
import { HostConnection } from './hostConnection.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ConnectOptions {
  workspaceRoot: string;
  /** Path to the built host bundle. Defaults to the one beside this file. */
  hostEntry?: string;
  /** How long to wait for a freshly spawned host to start listening. */
  startupTimeoutMs?: number;
  /** Node binary to run the host with. Electron supplies its own. */
  execPath?: string;
  client?: string;
}

/** How long a spawned host gets to open its socket before we give up. */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

async function tryConnect(socket: string, client?: string): Promise<HostConnection | null> {
  try {
    const channel = await connect<SessionCommand, SessionMessage>(socket, 2_000);
    // The label reaches `grantRole`, so a workspace policy that pins a client
    // family to read-only can never fire if this is dropped on the floor.
    return new HostConnection({ channel, ...(client !== undefined ? { client } : {}) });
  } catch {
    // ENOENT or ECONNREFUSED: nothing is listening. Ordinary, not a failure.
    return null;
  }
}

export async function connectOrSpawnHost(opts: ConnectOptions): Promise<HostConnection> {
  const workspaceRoot = resolve(opts.workspaceRoot);
  const identity = await openWorkspace(workspaceRoot);
  const socket = hostSocketPath(identity.instanceId);

  const existing = await tryConnect(socket, opts.client);
  if (existing !== null) {
    const serving = await existing.ready.catch(() => null);
    if (serving === null || resolve(serving.workspaceRoot) === workspaceRoot) return existing;

    // The host answering is serving a *different* directory under the same
    // identity, which happens for exactly one reason: the workspace moved and a
    // host at the old location is still running. The socket is keyed by
    // `instanceId` and that survives a move by design, so the old host answers
    // requests made from the new path and then fails opening files that are no
    // longer there. Only a real move surfaces this — every path in the code is
    // correct in isolation.
    existing.disconnect();
    const stopped = await stopStale(socket, workspaceRoot, serving.workspaceRoot, opts.client);
    if (!stopped.ok) throw new Error(stopped.reason);
    await clearHostRecord(workspaceRoot);
  }

  // Nothing answered. If a record says otherwise it describes a process that is
  // no longer there, so clear it rather than leaving a lie on disk.
  if ((await readHostRecord(workspaceRoot)) !== null) {
    await clearHostRecord(workspaceRoot);
  }

  spawnDetached(workspaceRoot, opts);

  const deadline = Date.now() + (opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
  for (;;) {
    const connection = await tryConnect(socket, opts.client);
    if (connection !== null) return connection;
    if (Date.now() > deadline) {
      throw new Error(`host for ${workspaceRoot} did not start listening on ${socket}`);
    }
    // Polling rather than watching: a socket appearing is not a filesystem event
    // on Windows named pipes, so there is nothing to watch for.
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Retire a host still serving this workspace's previous location.
 *
 * Asked to stop rather than killed, and allowed to refuse: it may be holding a
 * live agent, and taking that down because a folder was renamed would lose work
 * for a reason the user would never connect to the cause. A refusal is reported
 * with both paths, because "no host for /new/path" is a true sentence that
 * explains nothing.
 */
async function stopStale(
  socket: string,
  wanted: string,
  serving: string,
  client?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const connection = await tryConnect(socket, client);
  if (connection === null) return { ok: true }; // it went away on its own

  try {
    const result = await connection.requestShutdown();
    if (!result.stopped) {
      return {
        ok: false,
        reason:
          `this workspace has moved to ${wanted}, but a host is still running at ` +
          `${serving} and will not stop: ${result.reason ?? 'work is in flight'}. ` +
          `Let it finish, or stop it there.`,
      };
    }
  } catch {
    return { ok: true }; // it died while being asked, which is the outcome wanted
  } finally {
    connection.disconnect();
  }

  // The socket is removed by the departing host; waiting for that to actually
  // happen is what stops the replacement failing with EADDRINUSE.
  const deadline = Date.now() + 5_000;
  while (existsSync(socket) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return { ok: true };
}

function spawnDetached(workspaceRoot: string, opts: ConnectOptions): void {
  const entry = opts.hostEntry ?? resolve(HERE, '../agbrteHost.js');

  // Checked before spawning because the child is `stdio: 'ignore'` — it has to
  // be, to outlive us — so a missing entry produces no output anywhere and
  // surfaces fifteen seconds later as "the host did not start listening", which
  // points at the host rather than at the path that was wrong.
  if (!existsSync(entry)) {
    throw new Error(
      `no session host bundle at ${entry} — the app and the CLI resolve this ` +
        `relative to their own bundle, so a caller in a new location must pass hostEntry`,
    );
  }

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['AGBRTE_WORKSPACE_ROOT'] = workspaceRoot;

  /*
   * The switch belongs to the *binary being run*, not to whether one was named.
   *
   * `process.execPath` inside Electron is the Electron binary, which runs a
   * plain script only with this set; a real `node` ignores it. This used to key
   * off `opts.execPath === undefined` — "unset means we are Electron" — which
   * was true for the two callers that existed and became false the moment a
   * third appeared: the CLI passes its own `execPath` explicitly, and the app's
   * terminal pane now runs that CLI *under* `electron.exe` with
   * `ELECTRON_RUN_AS_NODE` already set. Under the old rule that CLI, on the rare
   * path where it has to start a host, would have spawned Electron with the
   * switch stripped — which does not run a script, it opens a second copy of the
   * app, with a window, from inside a terminal pane.
   *
   * Asking `process.versions.electron` instead is the same question the comment
   * was always trying to ask, and it is answerable rather than inferred (it is
   * defined under `ELECTRON_RUN_AS_NODE` too, which is exactly the case that
   * broke).
   */
  const exec = opts.execPath ?? process.execPath;
  if (process.versions.electron !== undefined && exec === process.execPath) {
    env['ELECTRON_RUN_AS_NODE'] = '1';
  } else {
    delete env['ELECTRON_RUN_AS_NODE'];
  }

  const child = spawn(exec, [entry, workspaceRoot], {
    detached: true,
    stdio: 'ignore',
    env,
    windowsHide: true,
  });

  // Without this the parent's event loop keeps a handle on the child and will
  // not exit until it does — which for a host meant to outlive the app is
  // exactly backwards.
  child.unref();
}
