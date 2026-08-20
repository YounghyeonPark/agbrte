/**
 * The machines this app has been told about (DESIGN.md §8, §6.2).
 *
 * A host is one per **machine** now, and a session picks its folder when it is
 * created — so the two questions that used to be one form are two acts. Naming a
 * machine is the first; it is cheap, reversible, and produces nothing durable.
 * Opening a folder on it is the second, and that is what starts a host, writes a
 * `.agbrte/` and shows up in the sidebar.
 *
 * ## Why this is renderer state and not a fleet concept
 *
 * A machine with no folder open has nothing running on it and nothing to show —
 * there is no host, no connection, no session, and deliberately so: §6.4's
 * bootstrap starts a host *because of* a workspace, and starting one for a
 * machine somebody merely named would install a private Node on a box they were
 * only looking at. What a named machine is, precisely, is **a destination the
 * user does not want to type again**, which is exactly what `localStorage` is
 * for and is the same job `remoteWorkspaces.ts` already does for paths.
 *
 * The consequence worth stating: this list is not authority. A machine here may
 * be unreachable, may have been reinstalled, may never have been reachable — and
 * nothing acts on it until a folder is opened, at which point the ordinary ssh
 * diagnosis (§8.3's four failures, each named where it happens) applies. Nothing
 * here can be wrong in a way that costs anything.
 *
 * ## This machine is always in it
 *
 * `local` is not stored and cannot be removed: the machine the app is running on
 * is present by construction, and offering to "add" it would be offering to
 * agree with a fact. It is first in the list for the same reason.
 */

const KEY = 'agbrte.machines.v1';

/** One place a workspace could be opened. */
export interface Machine {
  /** `local`, or the ssh destination exactly as the user typed it. */
  id: string;
  kind: 'local' | 'ssh';
  /** What to show. The alias for ssh; a fixed label for this machine. */
  label: string;
}

export const LOCAL_MACHINE: Machine = { id: 'local', kind: 'local', label: 'This machine' };

function readAliases(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    // Filtered rather than trusted: this is a file a person can edit and a
    // browser can half-write, and one bad entry must not empty the list.
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  } catch {
    // Unavailable (a browser with storage disabled) or unparseable. Both mean
    // "no remembered machines", which is the state a first run is in anyway.
    return [];
  }
}

/** Every machine a workspace could be opened on, this one first. */
export function loadMachines(): Machine[] {
  return [
    LOCAL_MACHINE,
    ...readAliases().map((alias): Machine => ({ id: alias, kind: 'ssh', label: alias })),
  ];
}

/**
 * Remember a machine.
 *
 * Idempotent, and **most recent first**: the machine somebody just named is the
 * one they are about to open a folder on, and a list ordered by when it was
 * first added puts that at the bottom by the time it matters.
 */
export function rememberMachine(alias: string): Machine[] {
  const name = alias.trim();
  if (name === '') return loadMachines();
  const kept = [name, ...readAliases().filter((a) => a !== name)];
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage full or unavailable. The machine still works for this session,
    // which is better than refusing to attach over a preference.
  }
  return loadMachines();
}

/** Forget one. `local` is not forgettable — it is where the app is running. */
export function forgetMachine(alias: string): Machine[] {
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify(readAliases().filter((a) => a !== alias)),
    );
  } catch {
    // See above.
  }
  return loadMachines();
}
