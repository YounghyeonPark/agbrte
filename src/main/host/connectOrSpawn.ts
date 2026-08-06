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
  if (existing !== null) return existing;

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

function spawnDetached(workspaceRoot: string, opts: ConnectOptions): void {
  const entry = opts.hostEntry ?? resolve(HERE, '../loomHost.js');

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
  env['LOOM_WORKSPACE_ROOT'] = workspaceRoot;

  // `process.execPath` inside Electron is the Electron binary, which runs a
  // plain script only with this set. Outside Electron — a test, a CLI — the
  // exec path is Node and the variable would be meaningless, so it is removed.
  if (opts.execPath === undefined) {
    env['ELECTRON_RUN_AS_NODE'] = '1';
  } else {
    delete env['ELECTRON_RUN_AS_NODE'];
  }

  const child = spawn(opts.execPath ?? process.execPath, [entry, workspaceRoot], {
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
