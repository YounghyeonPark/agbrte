/**
 * The paths no grant opens and no policy rule allows (DESIGN.md §17 Q24 step 6,
 * §13).
 *
 * In one place because two layers have to agree on them. The tools refuse them
 * (`tools/index.ts`), which binds the agents whose tools this program runs; the
 * policy denies them, non-overridably (`evaluate.ts`), which is the only thing a
 * CLI runtime's tools meet — the independent review of folder grants found
 * Claude Code, told of a granted home folder with `--add-dir`, could edit
 * `grants.json` through a policy that read the grant as "inside" and allowed it.
 * A check in the tools alone was a check one runtime never reached.
 *
 * ## What is off limits
 *
 * **The machine directory** (`~/.agbrte`, or `AGBRTE_HOME`): `grants.json`, the
 * file an agent would write to grant itself everything, and the secrets and
 * endpoint keys beside it. By path, case as the platform folds it; through
 * links, from the nearest part of the path that exists — an 8.3 short name
 * (`AGBRTE~1`) for a folder not created yet got past a check that tried one
 * parent and gave up; and a hard link, which has no target to resolve, by
 * comparing it with the files that are there.
 *
 * **A store's live bearer and its scheduler** — `.agbrte/host.json`, which on
 * Windows holds the loopback token that is the host's whole authentication, and
 * `.agbrte/run/` — in any workspace, read or written. With the token an agent
 * needs one shell call to ask the host for a grant directly, past the window.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { machineRoot } from '../../host/machine.js';

const STORE_DIRS = ['.agbrte', '.devagents'];

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${sep}`) && rel !== '..' && !/^[a-zA-Z]:/u.test(rel));
}

/** The nearest part of `abs` that exists, resolved through links, or `null`. */
function realNearest(abs: string): string | null {
  let at = abs;
  for (;;) {
    try {
      const real = realpathSync.native(at);
      return at === abs ? real : join(real, relative(at, abs));
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      at = up;
    }
  }
}

/** Whether `abs` is a hard link to one of the machine directory's files. */
function linkedIntoMachine(abs: string, machine: string): boolean {
  let target;
  try {
    target = statSync(abs);
  } catch {
    return false;
  }
  if (!target.isFile() || target.nlink < 2) return false;
  try {
    for (const name of readdirSync(machine)) {
      try {
        const there = statSync(join(machine, name));
        if (there.ino === target.ino && there.dev === target.dev) return true;
      } catch {
        // Gone between the listing and the look; it cannot be this one.
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** Whether `abs` is in the machine directory, by any of its names. */
export function inMachineDir(abs: string): boolean {
  const machine = resolve(machineRoot());
  if (inside(machine, abs)) return true;
  const realMachine = realNearest(machine);
  const real = realNearest(abs);
  if (realMachine !== null && real !== null && inside(realMachine, real)) return true;
  return linkedIntoMachine(abs, machine);
}

/** Whether `abs` is a store's `host.json` or `run/`, in any workspace, by path or through links. */
export function inPrivateStore(abs: string): boolean {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  for (const candidate of [abs, realNearest(abs)]) {
    if (candidate === null) continue;
    const parts = resolve(candidate).split(sep).map(fold);
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (STORE_DIRS.includes(parts[i]!) && (parts[i + 1] === 'host.json' || parts[i + 1] === 'run')) return true;
    }
  }
  return false;
}

/**
 * Whether `folder` holds the machine directory — a granted home folder does.
 * Such a grant is not passed to a runtime that reads on its own authority
 * (`cliStdio.ts`): Claude Code reads inside an `--add-dir` folder without
 * asking anybody, so the policy's deny never sees the read of a key there.
 */
export function holdsMachineDir(folder: string): boolean {
  const machine = resolve(machineRoot());
  if (inside(resolve(folder), machine)) return true;
  const realFolder = realNearest(resolve(folder));
  const realMachine = realNearest(machine);
  return realFolder !== null && realMachine !== null && inside(realFolder, realMachine);
}

/** Why `abs` is off limits, or `null`. */
export function offLimits(abs: string): string | null {
  if (inMachineDir(abs)) {
    return "it is in Agbrte's machine directory, which holds its keys and its folder grants; no grant opens it";
  }
  if (inPrivateStore(abs)) {
    return "it is a workspace store's host record or scheduler, which carry the host's credentials";
  }
  return null;
}
