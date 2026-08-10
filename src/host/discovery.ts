/**
 * Finding the host that owns a workspace (DESIGN.md §6.4, §8).
 *
 * A detached host has to be *discoverable*, because the app that started it is
 * gone and a different app has to find it. `.devagents/host.json` is that
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
   * the record is written `0600` inside `.devagents/`'s `0700` (§13), and why
   * nothing may copy this field into a log, an event, or an error string.
   */
  token?: string;
}

/** Where a workspace's host record lives. Inside `.devagents/`, 0700 (§13). */
export function hostRecordPath(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).devagents, 'host.json');
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
    'utf8',
  );
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
