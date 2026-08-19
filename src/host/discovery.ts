/**
 * Finding the host that owns a workspace (DESIGN.md §6.4, §8).
 *
 * A detached host has to be *discoverable*, because the app that started it is
 * gone and a different app has to find it. `.agbrte/host.json` is that
 * record: which process, which socket, which protocol.
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

import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceLayout } from '@main/store/layout.js';
import { restrictToOwner } from './ownerOnly.js';
import { SESSION_PROTOCOL_VERSION } from '@shared/host/sessionProtocol.js';

export interface HostRecord {
  pid: number;
  socket: string;
  protocol: number;
  startedAt: string;
  instanceId: string;
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

/** Where a workspace's host record lives. Inside `.agbrte/`, 0700 (§13). */
export function hostRecordPath(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).dir, 'host.json');
}

export async function readHostRecord(workspaceRoot: string): Promise<HostRecord | null> {
  try {
    const raw = await readFile(hostRecordPath(workspaceRoot), 'utf8');
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
  await writeFile(
    hostRecordPath(workspaceRoot),
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

  await restrictOnWindows(hostRecordPath(workspaceRoot), record);
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
