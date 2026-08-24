/**
 * Finding the host that owns a machine (DESIGN.md §6.4, §8).
 *
 * A detached host has to be *discoverable*, because the app that started it is
 * gone and a different app has to find it. `~/.agbrte/host.json` is that record:
 * which process, which socket, which protocol.
 *
 * ## Two records, and only one of them is the host's
 *
 * The record used to live in the workspace, because a host was one per
 * workspace. It is one per **machine** now, so the record it writes about itself
 * is in the machine's own directory — and a *second*, smaller record is left in
 * each workspace it opens, saying "the host for this folder is over there".
 *
 * That pointer is not tidiness. Two readers need it and neither can be given
 * anything else. A **released client** knows only how to look in the workspace,
 * and if it finds nothing it starts its own host there — a second process
 * appending to a log this one owns, which is the one failure §5.1 does not
 * survive. And a **current client** about to open a folder has to know whether
 * some older, per-workspace host is already holding it, which is a fact that
 * exists only in that folder. So the pointer is written where both of them
 * already look, and the machine record is the host's own.
 *
 * ## Why the file is a hint, never the truth
 *
 * A process can die without cleaning up after itself — killed, out of memory,
 * machine powered off. So the file being present proves nothing, and the only
 * real test is whether the socket answers. Every reader here treats a failed
 * connect as "no host", removes the stale record, and moves on. Trusting the
 * file instead would mean an app that refuses to start a host because a record
 * of a dead one exists — the classic stale-pidfile deadlock.
 */

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_DIR_MODE, workspaceLayout } from '@main/store/layout.js';
import { machineRoot } from './machine.js';
import { restrictToOwner } from './ownerOnly.js';
import { SESSION_PROTOCOL_VERSION } from '@shared/host/sessionProtocol.js';

export interface HostRecord {
  pid: number;
  socket: string;
  protocol: number;
  startedAt: string;
  /**
   * The checkout this record is about, on a *workspace* record.
   *
   * Kept on the machine record too, where it is the workspace the host was
   * started with — a released client reads it and a missing field would read as
   * a malformed record rather than as "this host holds several".
   */
  instanceId: string;
  /**
   * Which machine's host this is (§5.2, §8).
   *
   * **Present is the whole test for "this is a machine host".** A record without
   * it was written by a per-workspace host from before v21, which is a host this
   * build must not start a second writer alongside — so the absence is load
   * bearing and is checked rather than defaulted.
   */
  machineId?: string;
  /**
   * Loopback control port, when the host could not use a unix socket (§6.2).
   *
   * Present together with `token` or not at all — they are one fact about how to
   * reach this host, and half of it is useless.
   */
  port?: number;
  /**
   * The bearer token for that port.
   *
   * **This file is a credential when this field is set.** A loopback port is
   * reachable by every process on the machine, so the token is what stands in
   * for the `0600` unix socket's OS-enforced proof of who you are — which is why
   * the record is written `0600` inside `.agbrte/`'s `0700` (§13), and why
   * nothing may copy this field into a log, an event, or an error string.
   */
  token?: string;
}

/**
 * Where the machine's host record lives. `~/.agbrte/host.json`, 0700 (§13).
 *
 * The host's own record: pid, socket, protocol, and — when it had to fall back
 * to a loopback port — the bearer token that stands in for a socket's file mode.
 */
export function machineRecordPath(home?: string): string {
  return join(machineRoot(home), 'host.json');
}

/** Where a workspace's pointer record lives. Inside its `.agbrte/`, 0700 (§13). */
export function hostRecordPath(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).dir, 'host.json');
}

export async function readHostRecord(workspaceRoot: string): Promise<HostRecord | null> {
  return readRecordAt(hostRecordPath(workspaceRoot));
}

/** The machine's own record, which is the one a client looks for first. */
export async function readMachineRecord(home?: string): Promise<HostRecord | null> {
  return readRecordAt(machineRecordPath(home));
}

async function readRecordAt(path: string): Promise<HostRecord | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const record = JSON.parse(raw) as HostRecord;
    // A record from a different protocol is not useful to us even if the process
    // is alive: the handshake would refuse it anyway, and failing here keeps the
    // reason specific.
    if (typeof record.socket !== 'string' || typeof record.pid !== 'number') return null;
    return record;
  } catch {
    // Missing or unparseable are the same answer: nothing to connect to.
    return null;
  }
}

export async function writeHostRecord(
  workspaceRoot: string,
  record: Omit<HostRecord, 'protocol'>,
): Promise<void> {
  await writeRecordAt(hostRecordPath(workspaceRoot), record);
}

/**
 * Write the machine's own record.
 *
 * The directory is created here rather than assumed: this is the first thing a
 * host writes on a machine that has only ever run the app, and `~/.agbrte` may
 * not exist until something puts a bundle or a credential in it.
 */
export async function writeMachineRecord(
  record: Omit<HostRecord, 'protocol'>,
  home?: string,
): Promise<void> {
  await mkdir(machineRoot(home), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeRecordAt(machineRecordPath(home), record);
}

async function writeRecordAt(
  path: string,
  record: Omit<HostRecord, 'protocol'>,
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify({ ...record, protocol: SESSION_PROTOCOL_VERSION }, null, 2)}\n`,
    /**
     * `0600` unconditionally rather than only when a token is present. The
     * containing directory is already `0700`, so this changes nothing for other
     * users — but a record that is sometimes a credential and sometimes not
     * would depend on every future caller remembering which, and always costs
     * nothing. On Windows it is close to a no-op — see `restrictOnWindows`.
     *
     * **This was written once and did not take.** The edit that added it landed
     * in the interface's documentation and not in this call, so the file went
     * out at `0666 & ~umask` — `0644` on an ordinary machine — carrying the
     * bearer token that is the *entire* authentication for §6.2's loopback
     * control channel. The test asserting `0600` existed the whole time and
     * skips on Windows, which was the only place it had ever run. Linux CI
     * caught it on its first execution: `expected 420 to be 384`.
     */
    { encoding: 'utf8', mode: 0o600 },
  );

  await restrictOnWindows(path, record);
}

/**
 * Give the record a Windows ACL, because `mode` does not.
 *
 * The comment on `writeHostRecord` used to end "ignored on Windows, where the
 * pipe path it carries is not secret". That was true of the host it described,
 * and stopped being true when Windows became a supported target: a Windows host
 * cannot listen on a unix socket, so it listens on loopback and this file
 * carries the **bearer token that is the entire authentication** for it. A
 * premise falsified by a change three files away, with nothing to recheck it.
 *
 * The mechanism moved to `ownerOnly.ts` when `endpoints.json` became the second
 * credential file in this program; what stays here is the *decision*, which is
 * this file's to make. Only a record with a token is a secret, and a volume with
 * no ACLs must not stop a host from starting over a file that is public anyway.
 */
async function restrictOnWindows(
  path: string,
  record: Omit<HostRecord, 'protocol'>,
): Promise<void> {
  if (record.token === undefined) return;
  await restrictToOwner(path, "this host's bearer token");
}

export async function clearHostRecord(workspaceRoot: string): Promise<void> {
  await rm(hostRecordPath(workspaceRoot), { force: true });
}

export async function clearMachineRecord(home?: string): Promise<void> {
  await rm(machineRecordPath(home), { force: true });
}

/**
 * Remove a record **only if it still names this process**.
 *
 * The unconditional pair above is right for one caller and one situation:
 * `connectOrSpawn` has just proved that nothing answers the socket, so whatever
 * the file says describes a process that is gone and clearing it removes a lie.
 *
 * Every other clear is a host tidying up after itself, and there the difference
 * is the whole of a bug that cost a machine its remote sessions. A host that
 * loses the bind race — the socket was taken while it was starting — wrote the
 * machine record before binding and then deleted it on the way out, and the
 * record it deleted belonged to **the host that won**. From then on that
 * machine had a live host and nothing on disk saying so: every later attach read
 * no record, concluded there was no host, tried to start one, lost the same race
 * and deleted the same record again. Self-perpetuating, and unrecoverable from
 * the app — the person has to ssh in.
 *
 * `pid` is the whole check. It is not a liveness test (`processAlive` says so
 * for its own reasons) and does not need to be: the question here is *whose
 * record is this*, and a record naming another process is not this host's to
 * remove whatever state that process is in.
 */
async function clearIfOurs(path: string, pid: number): Promise<void> {
  const record = await readRecordAt(path);
  if (record === null || record.pid !== pid) return;
  await rm(path, { force: true });
}

export async function clearOwnHostRecord(workspaceRoot: string, pid: number): Promise<void> {
  await clearIfOurs(hostRecordPath(workspaceRoot), pid);
}

export async function clearOwnMachineRecord(pid: number, home?: string): Promise<void> {
  await clearIfOurs(machineRecordPath(home), pid);
}

/**
 * Whether a pid is a live process.
 *
 * `kill(pid, 0)` tests for existence without signalling. Only used for
 * diagnostics — **never** to decide whether to connect, because a pid can be
 * reused by an unrelated process and a live pid says nothing about whether *our*
 * host is listening. The socket answers that question.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which for our purposes
    // is still "not a host we can use".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
