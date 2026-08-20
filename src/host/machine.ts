/**
 * The machine's own directory and the machine's own identity (DESIGN.md §5.2, §8).
 *
 * `~/.agbrte` is what Agbrte keeps *per machine*: the private Node it unpacked
 * (§6.4), the host bundles, `endpoints.json` and its credentials (§6.5), and the
 * host's own state. A workspace's `.agbrte` is a different thing that now spells
 * its name the same way on purpose (§5.1) — one holds a machine's install, the
 * other one project's sessions — and the whole point of writing this file is
 * that nothing has to remember which by joining strings at the call site.
 *
 * ## Why a machine needs an id at all
 *
 * For as long as a host was one per workspace, `instanceId` answered both *which
 * checkout* and *which host*, so the two got used interchangeably. They are not
 * the same question and the difference is visible in the product: two folders on
 * one build box are two checkouts and **one** machine, and a fleet that keys on
 * `instanceId` says "those sessions are on 2 machines" about a single computer.
 * A machine is what has one install area, one set of credentials, one lease
 * authority and one host process; a checkout is what has a log, a memory
 * directory, and a path that moves out from under it (§5.3).
 *
 * ## Not derived from a hostname
 *
 * Hostnames are reassigned, duplicated across a fleet ("ubuntu", "build-01"),
 * and change when a laptop joins a different network — and §5.2's rule is that
 * identity is never derived from something that moves. So it is minted once and
 * written down, exactly as `instanceId` is, and for exactly the same reason.
 *
 * ## `0700`, and the same reasoning as the record it sits beside
 *
 * §13 puts `~/.agbrte` at `0700`. This file is not a credential, but it lives in
 * a directory that holds several, and creating that directory with a mode is the
 * only moment anything here can set it.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { newMachineId, type MachineId } from '@shared/types/index.js';
import { PRIVATE_DIR_MODE } from '@main/store/layout.js';

/**
 * Where Agbrte keeps this machine's own things. `~/.agbrte`.
 *
 * `AGBRTE_HOME` overrides it, and that is not a new idea: the installer script
 * has always read the same variable (`AGBRTE_HOME="${AGBRTE_HOME:-$HOME/.agbrte}"`),
 * so a machine where somebody installed elsewhere already expects it to be
 * honoured here. Two readers of one variable rather than one convention and one
 * hardcoded path.
 *
 * It is also the seam the test suite needs. Everything in this directory is
 * *global to a machine* — the host record, the machine id, the list of known
 * workspaces — so a suite using the real one would have every test share state
 * with every other and with the developer's own projects. An explicit argument
 * wins over the variable, for callers that know.
 */
export function machineRoot(home?: string): string {
  if (home !== undefined) return join(home, '.agbrte');
  const configured = process.env['AGBRTE_HOME'];
  if (configured !== undefined && configured !== '') return configured;
  return join(homedir(), '.agbrte');
}

/** This machine's identity file. Beside `endpoints.json`, never in a workspace. */
export function machineFilePath(home: string = homedir()): string {
  return join(machineRoot(home), 'machine.json');
}

export interface MachineFile {
  machineId: MachineId;
  createdAt: string;
}

/**
 * Read this machine's id, minting one the first time.
 *
 * Idempotent and racy-safe in the only way that matters: two hosts starting at
 * once could both mint, and the loser's write is the one on disk. That is
 * survivable because nothing durable is keyed by this id — it names a *machine
 * to a client*, and a client that sees a changed id treats it as a different
 * machine, which after a `rm -rf ~/.agbrte` it effectively is. Anything keyed by
 * it would need a lock; nothing is, deliberately.
 *
 * A malformed file is replaced rather than fatal, which is the opposite of
 * `endpoints.json`'s rule and right for the opposite reason: a broken endpoints
 * file means turns would go somewhere the user did not configure, while a broken
 * machine file means only that this machine has not been named yet.
 */
export async function machineIdentity(home: string = homedir()): Promise<MachineFile> {
  const path = machineFilePath(home);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<MachineFile>;
    if (typeof parsed.machineId === 'string' && parsed.machineId !== '') {
      return {
        machineId: parsed.machineId as MachineId,
        createdAt: parsed.createdAt ?? new Date().toISOString(),
      };
    }
  } catch {
    // Missing or unreadable are the same answer: this machine has no id yet.
  }

  const minted: MachineFile = { machineId: newMachineId(), createdAt: new Date().toISOString() };
  await mkdir(machineRoot(home), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(path, `${JSON.stringify(minted, null, 2)}\n`, 'utf8');
  return minted;
}
