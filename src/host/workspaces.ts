/**
 * The folders a machine's host knows about (DESIGN.md §5.1, §8).
 *
 * `~/.agbrte` holds what is true of a *machine* and applies to every session on
 * it, and this is the list of workspaces its host has been asked to serve. It
 * exists for one requirement: **sessions in a folder nobody has opened this
 * launch still have to be findable.** A host holds what clients ask for, a
 * client asks for what a person picks, and a person picking has to be able to
 * see what is already here — which without a list is a chicken-and-egg problem
 * solved by making the user remember paths.
 *
 * ## A hint, exactly like `host.json`
 *
 * §6.4's rule about the host record applies here word for word: the file proves
 * nothing, and every reader treats an entry it cannot open as absent. A folder
 * can be deleted, renamed, or sit on a volume that is not mounted this morning,
 * and none of those is a reason for a host to fail to start. Entries that no
 * longer name a workspace are dropped the next time the file is written, so the
 * list converges on the truth without anything having to prune it on a schedule.
 *
 * ## Restoring is not opening
 *
 * An entry is restored with `record: false`, and that is §5.3's rule rather than
 * a detail: recording `lastKnownPath` *consumes* the relocation signal, and only
 * the owner of a workspace may spend it. A host reading its own list at startup
 * is not a person asking for a folder — the signal is spent when a client
 * actually binds to it, which is the moment somebody is there to be told.
 *
 * And a restore never *creates* a workspace. `peekIdentity` is the gate: no
 * `project.json` means no workspace, and `mkdir -p` on a deleted folder would
 * quietly resurrect a directory the user removed on purpose.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { peekIdentity } from '@main/store/identity.js';
import { PRIVATE_DIR_MODE } from '@main/store/layout.js';
import { machineRoot } from './machine.js';

/** One folder this machine's host has been asked to serve. */
export interface KnownWorkspace {
  root: string;
  instanceId: string;
}

interface RegistryFile {
  workspaces: KnownWorkspace[];
}

export function workspacesPath(home?: string): string {
  return join(machineRoot(home), 'workspaces.json');
}

/**
 * Every folder in the list that is still a workspace.
 *
 * The filtering is the point: an unreadable file, a missing entry and a deleted
 * folder all answer "not this one" rather than failing, because none of them is
 * a reason a host should not start.
 */
export async function readKnownWorkspaces(home?: string): Promise<KnownWorkspace[]> {
  let parsed: RegistryFile;
  try {
    parsed = JSON.parse(await readFile(workspacesPath(home), 'utf8')) as RegistryFile;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.workspaces)) return [];

  const kept: KnownWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.workspaces) {
    if (typeof entry?.root !== 'string' || entry.root === '') continue;
    const root = resolve(entry.root);
    if (seen.has(root)) continue;
    // `peekIdentity` reads and never creates, which is what makes this safe to
    // run against a list that may name folders the user has since deleted.
    const identity = await peekIdentity(root).catch(() => null);
    if (identity === null) continue;
    seen.add(root);
    kept.push({ root, instanceId: identity.instanceId ?? entry.instanceId });
  }
  return kept;
}

/**
 * Write the list, dropping anything that is no longer a workspace.
 *
 * Pruning on write rather than on a timer, for the same reason a stale
 * `host.json` is cleared by whoever finds it: the moment somebody is already
 * looking is the cheapest moment to be honest, and a sweeper is a second thing
 * that can be wrong.
 */
export async function writeKnownWorkspaces(
  workspaces: readonly KnownWorkspace[],
  home?: string,
): Promise<void> {
  const kept: KnownWorkspace[] = [];
  const seen = new Set<string>();
  for (const entry of workspaces) {
    const root = resolve(entry.root);
    if (seen.has(root)) continue;
    const identity = await peekIdentity(root).catch(() => null);
    if (identity === null) continue;
    seen.add(root);
    kept.push({ root, instanceId: identity.instanceId ?? entry.instanceId });
  }

  await mkdir(machineRoot(home), { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(
    workspacesPath(home),
    `${JSON.stringify({ workspaces: kept }, null, 2)}\n`,
    // `0600` for the same reason the host record is: this file names every
    // project on the machine, which is not a secret and is nobody else's
    // business either, and the directory around it is already `0700` (§13).
    { encoding: 'utf8', mode: 0o600 },
  );
}
