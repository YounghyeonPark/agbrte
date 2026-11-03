/**
 * The folders a person has let the agent reach on this machine (DESIGN.md §17
 * Q24 step 6, §9).
 *
 * The owner's answer, 2026-11-02: the agent may reach every folder it has been
 * granted, not only the tab's — a grant list per host replaces "one workspace
 * root", and `cd` moves the shell and changes nothing for the agent. Asked again
 * when this was built, 2026-11-03: a grant is **read and write**, always, as the
 * workspace is; and a grant may be made from the shell (`agbrte grant`) as well
 * as from the palette — confirmed in the window either way, so that the agent,
 * which can run commands but cannot press a button in the window, cannot widen
 * its own reach.
 *
 * ## Where it lives, and why there
 *
 * `~/.agbrte/grants.json`, the machine's install area (§5.1), beside the
 * secrets and the endpoints: per host, because a path names a folder on one
 * machine and means nothing on another; never in a workspace, because a grant
 * that travelled with a repository would be a repository granting itself the
 * rest of whoever clones it's disk.
 *
 * And the machine directory is the one folder a grant never opens. The tools
 * refuse it by path whatever is granted (`tools/index.ts`), because a person who
 * grants their home folder has not thereby given the agent `grants.json` — the
 * file it would write to grant itself everything — nor the keys beside it.
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { machineRoot } from './machine.js';

export function grantsPath(): string {
  // Through `machineRoot`, so `AGBRTE_HOME` is honoured — the mistake a
  // `= homedir()` default made once with the socket is available here too.
  return join(machineRoot(), 'grants.json');
}

export class GrantRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'GrantRefused';
  }
}

/** The granted folders, absolute, in the order they were granted. A missing or unreadable file is none. */
export async function readGrants(path = grantsPath()): Promise<string[]> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { folders?: unknown };
    if (!Array.isArray(parsed.folders)) return [];
    // Filtered on the way in: a hand-edited relative path would be resolved
    // against wherever the host happened to start, which is nobody's intent.
    return parsed.folders.filter((f): f is string => typeof f === 'string' && isAbsolute(f));
  } catch {
    /*
     * Unreadable reads as none, which fails closed: the agent reaches less,
     * and the palette shows an empty list a person can fill again. The
     * opposite failure — a corrupt file read as "everything" — is not
     * available from an empty list.
     */
    return [];
  }
}

async function write(path: string, folders: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Beside it and renamed over it, so the tools never read half a list.
  const partial = `${path}.${process.pid}.tmp`;
  await writeFile(partial, `${JSON.stringify({ folders }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(partial, path);
}

/** Two paths are one folder: case-insensitively on Windows, where the filesystem is. */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const x = resolve(a);
  const y = resolve(b);
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * Grant one folder. Absolute or not — relative to nothing in particular is
 * refused rather than guessed — and it must exist and be a folder now, so a
 * typo is said at once rather than discovered as a refusal mid-turn.
 * Granting one already granted is success.
 */
export async function addGrant(folder: string, path = grantsPath()): Promise<string[]> {
  if (!isAbsolute(folder)) throw new GrantRefused(`"${folder}" is not an absolute path`);
  const abs = resolve(folder);
  let isDir = false;
  try {
    isDir = (await stat(abs)).isDirectory();
  } catch {
    throw new GrantRefused(`${abs} does not exist on this machine`);
  }
  if (!isDir) throw new GrantRefused(`${abs} is a file, not a folder`);
  const held = await readGrants(path);
  if (held.some((f) => sameFolder(f, abs))) return held;
  const next = [...held, abs];
  await write(path, next);
  return next;
}

/** Take one back. Not granted is success: the person wanted it gone, and it is. */
export async function removeGrant(folder: string, path = grantsPath()): Promise<string[]> {
  const held = await readGrants(path);
  const next = held.filter((f) => !sameFolder(f, folder));
  if (next.length !== held.length) await write(path, next);
  return next;
}
