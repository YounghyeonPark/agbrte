/**
 * Refusing to become a second writer beside an older host (DESIGN.md §5.1, §8).
 *
 * Until v21 a host was one per *workspace* and its socket was keyed by that
 * workspace's `instanceId`. A host is one per *machine* now, keyed by
 * `machineId` — which means a build from this version and a build from before it
 * compute **different sockets for the same folder**, cannot see each other, and
 * would each happily open the same `events.jsonl`. Two processes appending to
 * one log is the single thing §5.1 does not survive: `seq` is allocated
 * per-writer, so the numbers collide, and a mirror resuming from a byte offset
 * reads a file two people were writing.
 *
 * A protocol version cannot catch this, because the two never speak. What can is
 * the record the older host already leaves in the workspace it owns. So before
 * opening a folder, this asks the only question that settles it — **is a host
 * that is not ours still answering for this workspace** — and refuses by name if
 * one is.
 *
 * Three things make an answer honest here, and each is the same rule stated
 * elsewhere in this design:
 *
 *  - **The record is a hint** (§6.4). A file left by a process that was killed
 *    proves nothing, so the socket is probed and a record nobody answers is
 *    treated as absent rather than as a blocker. Trusting the file would be the
 *    stale-pidfile deadlock, one directory over.
 *  - **Ours is recognisable.** A record written by a machine host carries a
 *    `machineId`; one written before v21 does not. That absence is the whole
 *    test, which is why `HostRecord.machineId` is documented as load bearing.
 *  - **A refusal names the remedy.** "Cannot open this workspace" sends somebody
 *    to look at the folder. Naming the pid, the socket and `agbrte stop` sends
 *    them to the process that is actually in the way.
 */

import { socketAnswers } from '@shared/host/socketChannel.js';
import { readHostRecord, type HostRecord } from './discovery.js';

export class WorkspaceHeldElsewhere extends Error {
  constructor(
    readonly workspaceRoot: string,
    readonly record: HostRecord,
  ) {
    const where =
      record.port === undefined ? record.socket : `127.0.0.1:${record.port}`;
    /*
     * Two holders, two remedies, and the difference is worth a sentence.
     *
     * A record with no `machineId` was written before one-host-per-machine, so
     * the two cannot see each other and the fix is to stop it. A record *with*
     * one is another machine host — which on one computer means two `AGBRTE_HOME`
     * directories, deliberate or otherwise — and the fix is to use that one.
     */
    const older = record.machineId === undefined;
    super(
      `${workspaceRoot} is already served by ` +
        (older
          ? `an older Agbrte host (pid ${record.pid}, ${where}). That host was started ` +
            `before one host per machine, so this one cannot see it — and opening the ` +
            `workspace anyway would put two processes on one event log. Stop it first: ` +
            `\`agbrte stop ${workspaceRoot}\`, or quit the app that started it.`
          : `another Agbrte host (pid ${record.pid}, ${where}, machine ` +
            `${record.machineId}). Two hosts on one workspace would both own its event ` +
            `log, so this one will not open it. Use that host, or stop it with ` +
            `\`agbrte stop ${workspaceRoot}\`.`),
    );
    this.name = 'WorkspaceHeldElsewhere';
  }
}

/** This host's own identity, as far as a record can recognise it. */
export interface OwnHost {
  socket?: string;
  machineId?: string;
}

/**
 * The host holding this workspace, or `null` if it is ours or nothing is.
 *
 * "Ours" is answered twice over, deliberately: by `machineId`, which is the
 * durable identity, and by the socket path, which catches a record written by a
 * host on this machine before it had an id to write. Either match is enough,
 * because a false *negative* here is the expensive one — it refuses to open a
 * folder this very host is already serving.
 */
export async function hostHolding(
  workspaceRoot: string,
  ours: OwnHost = {},
): Promise<HostRecord | null> {
  const record = await readHostRecord(workspaceRoot);
  if (record === null) return null;
  if (ours.machineId !== undefined && record.machineId === ours.machineId) return null;
  if (ours.socket !== undefined && record.socket === ours.socket) return null;

  // A loopback host's reachability is its port; the socket path it also records
  // is not listening at all on that transport (§6.2).
  const target = record.port === undefined ? record.socket : { port: record.port };
  return (await socketAnswers(target)) ? record : null;
}

/** Throw `WorkspaceHeldElsewhere` when one is. The gate, stated once. */
export async function refuseIfHeldElsewhere(
  workspaceRoot: string,
  ours: OwnHost = {},
): Promise<void> {
  const holder = await hostHolding(workspaceRoot, ours);
  if (holder !== null) throw new WorkspaceHeldElsewhere(workspaceRoot, holder);
}
