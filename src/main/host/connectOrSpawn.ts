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
 *
 * ## …and a socket that accepts is not yet a host either
 *
 * `listen` asks a bind conflict "is anything actually there" (§17 Q9) because a
 * path can outlive its owner. **Connecting had the mirror-image gap**: a peer
 * that accepts and then goes away without a `welcome` was treated as this
 * workspace's host and handed back, because the check was `connect()` succeeded
 * rather than *it said hello*. That is precisely a host on its way out — its
 * listener is still open for the milliseconds between answering `shutdown` and
 * `listener.close()` — so `hosts.update`, which stops a host and immediately
 * reattaches, connected to the corpse every single time and failed with
 * `peer ended the connection` from `HostConnection.ready`.
 *
 * So the question here is the same one, asked with the handshake instead of a
 * bare connect: a host is something that says hello. A peer that accepts and
 * dies is a host **leaving**, and the answer is to wait for it to go and then
 * start a replacement rather than to adopt it or to spawn a rival into a socket
 * it still holds. A peer that accepts and says nothing at all is neither, and is
 * refused by name — nothing else can be true of it that this process can fix.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, hostSocketPath } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { clearHostRecord, readHostRecord } from '../../host/discovery.js';
import { openWorkspace } from '../store/identity.js';
import { HostConnection, HostProtocolMismatch } from './hostConnection.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ConnectOptions {
  workspaceRoot: string;
  /** Path to the built host bundle. Defaults to the one beside this file. */
  hostEntry?: string;
  /** How long to wait for a freshly spawned host to start listening. */
  startupTimeoutMs?: number;
  /**
   * How long a host that is on its way out gets to finish going.
   *
   * Separate from `startupTimeoutMs` because it is a different wait with a
   * different remedy: one is "the replacement is slow to boot", the other is
   * "the predecessor still owns the socket". Folding them into one budget would
   * let a slow departure eat the whole startup allowance and report the wrong
   * one of the two.
   */
  vacancyTimeoutMs?: number;
  /** Node binary to run the host with. Electron supplies its own. */
  execPath?: string;
  client?: string;
}

/** How long a spawned host gets to open its socket before we give up. */
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

/**
 * How long a departing host gets to release the socket.
 *
 * Its exit is not instant and is not meant to be: it stops preview servers,
 * closes terminals, disposes the agent host and clears its record before the
 * listener goes. Ten seconds is longer than any of that and short enough that a
 * host which is never going to leave is reported rather than waited on.
 */
const DEFAULT_VACANCY_TIMEOUT_MS = 10_000;

/**
 * How long a peer that accepted gets to say hello.
 *
 * Generous, because the cost of being wrong is refusing a healthy host. It can
 * be generous *because* a host binds its listener last — every expensive thing
 * it does (detecting runtimes, reading endpoints, opening the log) happens
 * before it accepts anything — so a `welcome` is immediate once a connection is
 * accepted at all, and five seconds of silence means something that is not
 * going to answer.
 */
const HANDSHAKE_TIMEOUT_MS = 5_000;

/** What is on the other end of the socket, asked with the handshake. */
type Probe =
  | { at: 'host'; connection: HostConnection; workspaceRoot: string }
  /** Nothing accepted the connection: no host, or the last one has gone. */
  | { at: 'empty' }
  /** Accepted, then went away without a handshake: a host on its way out. */
  | { at: 'leaving'; detail: string }
  /** Accepted and never spoke: something is there, and it is not answering. */
  | { at: 'silent' }
  /**
   * It answered and declined to serve this client.
   *
   * Kept apart from `leaving` because it is the one handshake failure that is
   * *final*: waiting changes nothing and starting a second host would collide
   * with a perfectly healthy first one. §17.16's rule is that a version skew
   * costs a command or a connection, never the host holding the work.
   */
  | { at: 'refused'; error: Error };

/**
 * Connect *and* handshake, because only the second one proves there is a host.
 *
 * The `welcome` is bounded separately from the connect: a peer that accepts and
 * then says nothing is a different fact from one that refuses, and the only way
 * to tell them apart is to wait a little and see.
 */
async function probeHost(socket: string, client?: string): Promise<Probe> {
  let connection: HostConnection;
  try {
    const channel = await connect<SessionCommand, SessionMessage>(socket, 2_000);
    // The label reaches `grantRole`, so a workspace policy that pins a client
    // family to read-only can never fire if this is dropped on the floor.
    connection = new HostConnection({ channel, ...(client !== undefined ? { client } : {}) });
  } catch {
    // ENOENT or ECONNREFUSED: nothing is listening. Ordinary, not a failure.
    return { at: 'empty' };
  }

  let timer: NodeJS.Timeout | undefined;
  const silence = new Promise<'silent'>((r) => {
    timer = setTimeout(() => r('silent'), HANDSHAKE_TIMEOUT_MS);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([
      connection.ready.then((i) => ({ ok: true as const, i })).catch((err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err : new Error(String(err)),
      })),
      silence,
    ]);
    if (outcome === 'silent') {
      connection.disconnect();
      return { at: 'silent' };
    }
    if (!outcome.ok) {
      connection.disconnect();
      /*
       * Two ways a handshake ends in a refusal, one per direction of the skew:
       * this client is too new for the host (`HostProtocolMismatch`, raised
       * here) or too old for it (`ClientTooOld`, sent by the host). Both are
       * final and neither is a host that is leaving — waiting for the socket
       * would report "still shutting down" about a host that is perfectly well.
       */
      if (
        outcome.error instanceof HostProtocolMismatch ||
        outcome.error.name === 'ClientTooOld'
      ) {
        return { at: 'refused', error: outcome.error };
      }
      return { at: 'leaving', detail: outcome.error.message };
    }
    return { at: 'host', connection, workspaceRoot: outcome.i.workspaceRoot };
  } finally {
    clearTimeout(timer);
  }
}

export async function connectOrSpawnHost(opts: ConnectOptions): Promise<HostConnection> {
  const workspaceRoot = resolve(opts.workspaceRoot);
  const identity = await openWorkspace(workspaceRoot);
  const socket = hostSocketPath(identity.instanceId);

  const vacancyBy = Date.now() + (opts.vacancyTimeoutMs ?? DEFAULT_VACANCY_TIMEOUT_MS);
  let spawnedAt: number | null = null;
  let departed = false;
  /**
   * How many times a host serving the *old* path has been asked to retire.
   *
   * Bounded because the loop's only unbounded branch is this one: a host that
   * answers `{stopped:true}` and then keeps answering would be asked again on
   * every round, forever. Three tries and then a sentence — a spin with no
   * output is the one outcome worse than a wrong error.
   */
  let retirements = 0;

  /*
   * One loop, because the states feed into each other: a departing host becomes
   * an empty socket, an empty socket becomes a spawn, and a spawn becomes a host.
   * Written as a sequence of `if`s it was three separate waits that each assumed
   * the previous one had finished, which is exactly the assumption that failed.
   */
  for (;;) {
    const probe = await probeHost(socket, opts.client);

    if (probe.at === 'host') {
      if (resolve(probe.workspaceRoot) === workspaceRoot) return probe.connection;

      // The host answering is serving a *different* directory under the same
      // identity, which happens for exactly one reason: the workspace moved and a
      // host at the old location is still running. The socket is keyed by
      // `instanceId` and that survives a move by design, so the old host answers
      // requests made from the new path and then fails opening files that are no
      // longer there. Only a real move surfaces this — every path in the code is
      // correct in isolation.
      probe.connection.disconnect();
      retirements += 1;
      if (retirements > 3) {
        throw new Error(
          `a host on ${socket} keeps answering for ${probe.workspaceRoot} after agreeing to ` +
            `stop, so ${workspaceRoot} cannot be served. Stop that process and try again.`,
        );
      }
      const stopped = await stopStale(socket, workspaceRoot, probe.workspaceRoot, opts.client);
      if (!stopped.ok) throw new Error(stopped.reason);
      await clearHostRecord(workspaceRoot);
      // Round again rather than spawning here: what it just asked to stop is now
      // a *departing* host, and the branch below is what knows to wait for it.
      continue;
    }

    // A host that will not serve this client is a host all the same. Starting a
    // second one would break §6.6's single writer to no purpose.
    if (probe.at === 'refused') throw probe.error;

    if (probe.at === 'leaving' || probe.at === 'silent') {
      /*
       * Something holds the socket and it is not a host we can use. Waiting is
       * the whole fix for `hosts.update`: spawning now would put a second host
       * onto a socket the first still owns, which on POSIX is `EADDRINUSE` and
       * on a Windows named pipe is a second listener nobody can predict the
       * winner of.
       */
      departed = true;
      if (Date.now() < vacancyBy) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      throw new Error(
        probe.at === 'leaving'
          ? `the host for ${workspaceRoot} is still shutting down on ${socket} and has not ` +
            `released it (${probe.detail}). Nothing was started, so nothing was lost — ` +
            `try again in a moment.`
          : `something is listening on ${socket} for ${workspaceRoot} but never completed a ` +
            `handshake, so it cannot be used and cannot be replaced. If it is a wedged host, ` +
            `stop that process and try again.`,
      );
    }

    // Nothing answered. If a record says otherwise it describes a process that is
    // no longer there, so clear it rather than leaving a lie on disk.
    if (spawnedAt === null) {
      if ((await readHostRecord(workspaceRoot)) !== null) {
        await clearHostRecord(workspaceRoot);
      }
      spawnDetached(workspaceRoot, opts);
      spawnedAt = Date.now();
    } else if (Date.now() > spawnedAt + (opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS)) {
      throw new Error(
        `host for ${workspaceRoot} did not start listening on ${socket}` +
          (departed ? ' after the previous one exited' : ''),
      );
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
  const probe = await probeHost(socket, client);
  // Anything that is not a live host is one that has gone or is going, and the
  // caller's next round is what waits for the socket rather than this one.
  if (probe.at !== 'host') return { ok: true };
  const connection = probe.connection;

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

  /*
   * Waiting for it to actually be gone is what stops the replacement failing
   * with `EADDRINUSE` — but the thing to wait *on* is the socket answering, not
   * a filesystem entry. `existsSync` was the test here and is a no-op on the
   * platform where it was written: a Windows named pipe has no directory entry
   * to disappear, so the loop fell straight through and the caller spawned into
   * a socket the old host still held. The caller's own round asks the honest
   * question, so this only has to not return before there is a point in asking.
   */
  const deadline = Date.now() + 5_000;
  for (;;) {
    const gone = await probeHost(socket, client);
    // Closed rather than left open: this is a poll, and a probe that finds the
    // old host still up must not leave a channel behind on every iteration.
    if (gone.at === 'host') gone.connection.disconnect();
    if (gone.at === 'empty' || Date.now() >= deadline) return { ok: true };
    await new Promise((r) => setTimeout(r, 50));
  }
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
