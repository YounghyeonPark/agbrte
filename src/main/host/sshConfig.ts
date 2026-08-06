/**
 * Reading the user's `~/.ssh/config` (DESIGN.md §6.2, §14).
 *
 * The single biggest thing that makes remote hosts *easy*: the user already has
 * their machines configured, so attaching one should be picking a name from a
 * list, not filling in a form. Everything a form would ask for — hostname, user,
 * port, key, jump host, proxy command — is already answered here, and answered
 * better, because it is the same answer their terminal uses.
 *
 * ## Why parse it at all if `ssh` reads it anyway
 *
 * `ssh` resolves the config; we only need the *names* to offer. Nothing here
 * tries to resolve connection semantics — no `Match` evaluation, no wildcard
 * expansion, no canonicalisation. Those belong to `ssh`, and reimplementing them
 * is how a picker ends up disagreeing with the command it eventually runs.
 *
 * So this is deliberately shallow: it lists what the user could type after
 * `ssh `, and hands the string to `ssh` unchanged.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface SshHostEntry {
  /** The alias, exactly as `ssh <alias>` would take it. */
  alias: string;
  /** `HostName`, when the config gives one. Display only. */
  hostName?: string;
  user?: string;
  port?: number;
  /** File this came from, so a user can find where a name is defined. */
  source: string;
}

export interface ReadSshConfigOptions {
  /** Defaults to `~/.ssh/config`. */
  path?: string;
  /** Cap on `Include` recursion; a config can include itself. */
  maxDepth?: number;
}

const DEFAULT_MAX_DEPTH = 8;

/**
 * List the host aliases a user could connect to.
 *
 * Patterns containing `*`, `?`, or `!` are skipped: they are defaults applied to
 * other hosts, not machines to connect to. Offering `*` in a picker would be
 * offering a wildcard as a destination.
 */
export async function readSshHosts(opts: ReadSshConfigOptions = {}): Promise<SshHostEntry[]> {
  const path = opts.path ?? join(homedir(), '.ssh', 'config');
  const seen = new Set<string>();
  const entries: SshHostEntry[] = [];

  await parseInto(entries, path, seen, opts.maxDepth ?? DEFAULT_MAX_DEPTH);

  // First definition wins, matching how `ssh` applies the first obtained value
  // for a keyword — a later duplicate would be misleading in a picker.
  const byAlias = new Map<string, SshHostEntry>();
  for (const entry of entries) {
    if (!byAlias.has(entry.alias)) byAlias.set(entry.alias, entry);
  }
  return [...byAlias.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}

async function parseInto(
  out: SshHostEntry[],
  path: string,
  seen: Set<string>,
  depth: number,
): Promise<void> {
  const full = resolve(path);
  // A config that includes itself, directly or in a cycle, would otherwise
  // recurse until the stack gives out.
  if (depth <= 0 || seen.has(full)) return;
  seen.add(full);

  let text: string;
  try {
    text = await readFile(full, 'utf8');
  } catch {
    // No config is the common case on a fresh machine, and an unreadable one is
    // not worth failing an attach over — the user can still type a host.
    return;
  }

  let current: SshHostEntry[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    // `ssh` accepts `Key value` and `Key=value`, case-insensitively.
    const match = /^([A-Za-z]+)[\s=]+(.*)$/.exec(line);
    if (match === null) continue;
    const keyword = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (keyword === 'host') {
      current = tokenize(value)
        .filter((pattern) => !isPattern(pattern))
        .map((alias) => {
          const entry: SshHostEntry = { alias, source: full };
          out.push(entry);
          return entry;
        });
      continue;
    }

    if (keyword === 'include') {
      // Resolved relative to the containing file's directory, or `~/.ssh` for a
      // bare name — the same rule `ssh` uses.
      for (const pattern of tokenize(value)) {
        const target = isAbsolute(pattern)
          ? pattern
          : pattern.startsWith('~')
            ? join(homedir(), pattern.slice(1))
            : join(dirname(full), pattern);
        // Globs in Include are not expanded: doing so would mean implementing
        // glob semantics that only matter for display.
        if (!isPattern(target)) await parseInto(out, target, seen, depth - 1);
      }
      continue;
    }

    // Everything else decorates whichever hosts are currently open. Only the
    // three that are worth showing are kept.
    for (const entry of current) {
      if (keyword === 'hostname') entry.hostName = value;
      else if (keyword === 'user') entry.user = value;
      else if (keyword === 'port' && Number.isFinite(Number(value))) entry.port = Number(value);
    }
  }
}

/** Split on whitespace, honouring the quoting `ssh` allows. */
function tokenize(value: string): string[] {
  return (value.match(/"[^"]*"|\S+/g) ?? []).map((token) => token.replace(/^"|"$/g, ''));
}

function isPattern(value: string): boolean {
  return value.includes('*') || value.includes('?') || value.startsWith('!');
}
