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
 * The environment variable that moves this machine's directory.
 *
 * **A real capability, not a test affordance**, and it predates this file: the
 * installer script has always read the same name
 * (`AGBRTE_HOME="${AGBRTE_HOME:-$HOME/.agbrte}"`), so a machine where somebody
 * installed elsewhere already expects it honoured. What was missing was a single
 * place that read it, and the consequence of the gap was immediate — the whole
 * point of a host being one per machine is that everything on that machine
 * agrees where the machine's directory is, so a second reader that computes
 * `$HOME/.agbrte` by hand is not a duplicate, it is a *disagreement*.
 *
 * It exists because "one host per machine" has to mean *one installation*
 * rather than *one computer*. Three cases need them apart:
 *
 *  - **Two builds side by side.** A release and a checkout on one laptop are two
 *    installations: two bundles, two sets of credentials, two hosts. Without a
 *    lever they would fight over one socket, and the loser would report that a
 *    host was already running — correctly, and uselessly.
 *  - **A shared machine.** `~` is already per user, so this is not what keeps two
 *    people apart; what it allows is one person running an isolated instance
 *    without disturbing the one their editor is attached to.
 *  - **A test suite.** Everything in this directory is global to a machine, so a
 *    suite using the real one shares a host between every file, spends §5.3
 *    relocation signals in the developer's own projects, and — the failure that
 *    made this urgent — hands a test expecting *no host* a perfectly good one
 *    that another file left running.
 */
export const MACHINE_HOME_ENV = 'AGBRTE_HOME';

/**
 * Where Agbrte keeps this machine's own things. `~/.agbrte` unless moved.
 *
 * **Everything that names the machine's directory goes through here** — the
 * machine id, the host record, the workspace registry, the endpoints file — and
 * the socket follows, because it is named from the `machineId` this directory
 * holds. That is what makes `AGBRTE_HOME` move an *installation* rather than one
 * file: a reader that joined `$HOME` itself would keep pointing at the other one.
 *
 * An explicit argument wins over the variable, for callers that know which
 * machine directory they mean — a host told where it lives, and the remote
 * bootstrap, which is computing a path on somebody else's computer.
 */
export function machineRoot(home?: string): string {
  if (home !== undefined) return join(home, '.agbrte');
  const configured = process.env[MACHINE_HOME_ENV];
  if (configured !== undefined && configured !== '') return configured;
  return join(homedir(), '.agbrte');
}

/**
 * This machine's identity file. Beside `endpoints.json`, never in a workspace.
 *
 * `home?` rather than `home = homedir()`, and the difference is the whole of a
 * bug. `machineRoot` reads `AGBRTE_HOME` **only when it is given no argument**,
 * because an explicit one is a caller who knows which machine directory they
 * mean — so a default of `homedir()` is not a default at all, it is every
 * caller silently claiming to know, and the variable was ignored by all of them.
 *
 * What that cost: the socket is named from the id in this file, so every host on
 * the machine computed the *same* socket no matter which directory it had been
 * pointed at. Two installations side by side — the case `AGBRTE_HOME` exists for
 * — would have shared one, and in a parallel test run they did: files reached
 * one another's hosts, and a test read a record its own host had never written.
 */
export function machineFilePath(home?: string): string {
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
export async function machineIdentity(home?: string): Promise<MachineFile> {
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
