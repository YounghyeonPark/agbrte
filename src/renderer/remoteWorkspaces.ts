/**
 * The last remote workspace that worked, remembered per machine (§6.2, §10).
 *
 * A view preference, exactly like `agentDefaults.ts` and for the same reason:
 * *which* folder on a build box this person reaches for first is a fact about
 * this person at this keyboard, not about the workspace, the host, or anything
 * durable. It belongs in `localStorage` and not in a log, a store, or the ssh
 * config. Another device attaching the same machine is free to prefer a
 * different folder, and neither is wrong.
 *
 * Keyed by **alias** because that is what the user chose — the string they hand
 * to `ssh` — and because the question is "what did I open on *this machine* last
 * time". `instanceId` would be the wrong key: it is minted by the workspace that
 * is being looked for, so it does not exist yet at the moment this is read.
 *
 * Every read is a *suggestion*: the path is placed in the field, still visible
 * and still editable, and the attach that follows either works or produces the
 * ordinary error. Nothing here is trusted enough to act on by itself — a folder
 * that has been renamed or a machine that has been rebuilt must degrade to
 * typing, never to a confident wrong attach.
 */

const KEY = 'agbrte.remoteWorkspaces.v1';

interface Memory {
  /** The machine attached last, so the picker opens on it. */
  lastAlias?: string;
  /** Alias → the workspace path that last attached successfully. */
  byAlias: Record<string, string>;
}

/** The whole record, tolerating a missing or corrupt store — both mean nothing. */
function read(): Memory {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { byAlias: {} };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { byAlias: {} };
    }
    const record = parsed as Partial<Memory>;
    const byAlias =
      typeof record.byAlias === 'object' && record.byAlias !== null && !Array.isArray(record.byAlias)
        ? record.byAlias
        : {};
    return {
      ...(typeof record.lastAlias === 'string' && record.lastAlias !== ''
        ? { lastAlias: record.lastAlias }
        : {}),
      byAlias,
    };
  } catch {
    // Storage disabled, quota, or somebody edited the JSON by hand. Remembering
    // is a convenience; failing to remember must never cost more than typing.
    return { byAlias: {} };
  }
}

/** The machine attached last from this client, or `null`. */
export function loadLastAlias(): string | null {
  return read().lastAlias ?? null;
}

/**
 * The workspace last attached on that machine, or `null`.
 *
 * Shape-checked on the way out because `localStorage` outlives app versions:
 * anything that is not a non-empty string reads as nothing remembered.
 */
export function loadLastWorkspace(alias: string): string | null {
  const value = read().byAlias[alias];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** Record an attach that actually worked. Called on success, never on intent. */
export function rememberRemoteWorkspace(alias: string, workspaceRoot: string): void {
  if (alias.trim() === '' || workspaceRoot.trim() === '') return;
  try {
    const memory = read();
    localStorage.setItem(
      KEY,
      JSON.stringify({
        lastAlias: alias,
        byAlias: { ...memory.byAlias, [alias]: workspaceRoot },
      } satisfies Memory),
    );
  } catch {
    // Not being able to remember is not an error worth a banner.
  }
}
