/**
 * The remote machines to reach for again next time the app opens (§6.4, §8).
 *
 * Quitting **disconnects and does not stop**: a host outliving the app is the
 * feature, so a session started on a build box is still running when the window
 * comes back. What did not come back was the connection to it. Startup attached
 * only local workspaces, so a remote host was reachable, running, and invisible
 * until somebody pressed **Attach** again — and the comment beside `before-quit`
 * claiming "the next app to open reattaches to it" was true of local and of
 * nothing else.
 *
 * ## Why this is an app file and not a fleet concept
 *
 * `Fleet` answers "what am I connected to". This answers "what should I try to
 * be connected to", which is a **policy of the desktop app**: the CLI attaches
 * what its argv names and must not inherit a list somebody's window wrote, and a
 * test that attaches two hosts must not leave a machine behind for the next run
 * to dial. So the remembering happens at the two IPC handlers where a person
 * adds or removes a machine, and the acting on it happens once, in `main`.
 *
 * ## What is in it, and what is deliberately not
 *
 * An alias and a path — the two strings the person typed. The alias is an entry
 * in their own `ssh` config, which is where every credential for it already
 * lives and stays (§6.2): nothing here is a secret, and nothing here is enough
 * to connect *with* on its own. No `instanceId`, because it is minted by the
 * workspace being looked for and a remembered one would be a claim about a
 * folder that may have been deleted since. Local is never stored — the machine
 * the app runs on is attached by construction.
 *
 * A hint in `host.json`'s sense (§6.4): an entry that no longer reaches anything
 * costs one failed dial and is kept, because a build box that is off today is
 * the same machine tomorrow. Only a person removing the host forgets it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { machineRoot } from '../host/machine.js';
import { PRIVATE_DIR_MODE } from './store/layout.js';

/** One remembered destination. Exactly what `hosts.addRemote` was given. */
export interface RememberedMachine {
  alias: string;
  workspaceRoot: string;
}

interface FileShape {
  version: 1;
  machines: RememberedMachine[];
}

export function attachedMachinesPath(home?: string): string {
  return join(machineRoot(home), 'attached.json');
}

/**
 * What to reach for. Unreadable, missing and malformed are one answer — a list
 * of destinations is a convenience, and refusing to start because it could not
 * be parsed would trade the app for the shortcut.
 */
export async function readAttachedMachines(home?: string): Promise<RememberedMachine[]> {
  try {
    const parsed = JSON.parse(await readFile(attachedMachinesPath(home), 'utf8')) as
      | Partial<FileShape>
      | undefined;
    if (parsed === undefined || !Array.isArray(parsed.machines)) return [];
    return parsed.machines.filter(
      (m): m is RememberedMachine =>
        typeof m?.alias === 'string' &&
        m.alias !== '' &&
        typeof m.workspaceRoot === 'string' &&
        m.workspaceRoot !== '',
    );
  } catch {
    return [];
  }
}

async function write(machines: RememberedMachine[], home?: string): Promise<void> {
  const path = attachedMachinesPath(home);
  await mkdir(machineRoot(home), { recursive: true, mode: PRIVATE_DIR_MODE });
  const scratch = `${path}.${String(process.pid)}.tmp`;
  const body: FileShape = { version: 1, machines };
  await writeFile(scratch, `${JSON.stringify(body, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(scratch, path);
}

/**
 * Remember one, keyed by alias **and** path.
 *
 * Both, because one machine can hold two projects and reattaching to one of them
 * is not reattaching to the other. Re-adding the same pair rewrites nothing new,
 * which keeps this safe to call on every successful attach rather than only on
 * the first.
 */
export async function rememberMachine(
  machine: RememberedMachine,
  home?: string,
): Promise<void> {
  const machines = await readAttachedMachines(home);
  if (machines.some((m) => m.alias === machine.alias && m.workspaceRoot === machine.workspaceRoot)) {
    return;
  }
  machines.push(machine);
  await write(machines, home);
}

/** Forget one. Called when a person removes the host, and at no other time. */
export async function forgetMachine(
  machine: Partial<RememberedMachine>,
  home?: string,
): Promise<void> {
  const machines = await readAttachedMachines(home);
  const kept = machines.filter(
    (m) =>
      !(
        (machine.alias === undefined || m.alias === machine.alias) &&
        (machine.workspaceRoot === undefined || m.workspaceRoot === machine.workspaceRoot)
      ),
  );
  if (kept.length === machines.length) return;
  await write(kept, home);
}
