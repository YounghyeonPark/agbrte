/**
 * Finding the dev server an agent is working on (DESIGN.md §6.8).
 *
 * > The host detects newly listening ports and offers to forward them.
 *
 * This runs **on the machine the session runs on**, which is the only place it
 * can: the whole point is a port on a build box that your laptop cannot see yet.
 *
 * ## Read from `/proc`, not from `ss`
 *
 * No subprocess, nothing to have installed, and nothing to parse whose output
 * format is a locale away from changing. A remote host is already Node on Linux
 * by construction — the bootstrap fetches a linux tarball and the probe checks
 * `uname` — and the transports queued behind this one (WSL, a container, a pod)
 * are Linux too. So the file that is always there is a better dependency than
 * the tool that usually is.
 *
 * The format was read off a real host rather than from documentation:
 *
 * ```
 *   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid …
 *    0: 36177B64:1E25 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 …
 * ```
 *
 * `st` is `0A` for `TCP_LISTEN`. The address is little-endian hex per 32-bit
 * word and the port is big-endian, which is the kind of asymmetry that is
 * cheaper to check against a live machine than to reason about.
 *
 * ## Only this user's ports, and that is a design decision
 *
 * `/proc/net/tcp` shows **every** listener on the machine, with a uid column.
 * On the shared build box §17 Q9 worries about, offering the full list would
 * turn a preview feature into a reconnaissance one: it tells you what your
 * colleagues are running, on which ports, right now. Nobody asked for that and
 * it arrives as a helpful dropdown.
 *
 * So the list is narrowed to the uid the host runs as. That is also the only
 * useful answer — a port belonging to somebody else is not a preview of your
 * agent's work, and forwarding it would be reaching into their process.
 *
 * ## The bind address is reported, not normalised away
 *
 * A dev server on `127.0.0.1` is visible to that machine; one on `0.0.0.0` is
 * visible to everyone who can route to it. Both are ordinary and the difference
 * matters on a shared host, so it is carried through rather than flattened into
 * "there is a server on 3000".
 */

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export interface ListeningPort {
  port: number;
  /** Dotted or bracketed, as it would be typed. */
  address: string;
  /** `false` means it is already reachable from off the machine. */
  loopbackOnly: boolean;
  family: 'ipv4' | 'ipv6';
}

export class PortsUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PortsUnavailable';
  }
}

/** `TCP_LISTEN`, the one state that means "something is serving here". */
const LISTEN = '0A';

/**
 * Ports that are never a preview.
 *
 * Not a security measure — a filter. Offering to forward sshd is noise in a
 * dropdown that is supposed to have one obvious entry in it.
 */
const NEVER_A_PREVIEW = new Set([22, 25, 53, 111, 123, 631]);

/** Parse one `/proc/net/tcp` or `/proc/net/tcp6` file. */
export function parseProcNetTcp(
  text: string,
  uid: number,
  family: 'ipv4' | 'ipv6',
): ListeningPort[] {
  const found: ListeningPort[] = [];

  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    // A short line is a truncated read or a kernel that grew a column; either
    // way skipping it is right, and throwing would take out a dropdown.
    if (cols.length < 8) continue;
    if (cols[3] !== LISTEN) continue;
    if (Number(cols[7]) !== uid) continue;

    const local = cols[1];
    if (local === undefined) continue;
    const at = local.lastIndexOf(':');
    if (at < 0) continue;

    const port = Number.parseInt(local.slice(at + 1), 16);
    if (!Number.isFinite(port) || port <= 0) continue;

    const address = family === 'ipv4' ? ipv4(local.slice(0, at)) : ipv6(local.slice(0, at));
    if (address === null) continue;

    found.push({
      port,
      address,
      loopbackOnly: isLoopback(address),
      family,
    });
  }

  return found;
}

/** `7100003A` → `58.0.0.113`. Little-endian, one 32-bit word. */
function ipv4(hex: string): string | null {
  if (hex.length !== 8) return null;
  const bytes = [6, 4, 2, 0].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  if (bytes.some((b) => !Number.isFinite(b))) return null;
  return bytes.join('.');
}

/** Four little-endian 32-bit words, printed as the address a person would type. */
function ipv6(hex: string): string | null {
  if (hex.length !== 32) return null;
  const bytes: number[] = [];
  for (let word = 0; word < 4; word += 1) {
    const chunk = hex.slice(word * 8, word * 8 + 8);
    for (const i of [6, 4, 2, 0]) {
      const b = Number.parseInt(chunk.slice(i, i + 2), 16);
      if (!Number.isFinite(b)) return null;
      bytes.push(b);
    }
  }

  // `::` and `::1` are what these actually are almost every time, and printing
  // them in full would make the common case unrecognisable.
  if (bytes.every((b) => b === 0)) return '::';
  if (bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1) return '::1';

  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    groups.push((((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0)).toString(16));
  }
  return groups.join(':');
}

function isLoopback(address: string): boolean {
  return address === '::1' || address.startsWith('127.');
}

/**
 * `lsof -F` field output, which is what macOS has instead of `/proc`.
 *
 * A process block is a `p<pid>` line followed by `n<address>` lines. The field
 * form is used rather than the default table because the table is aligned for
 * humans and its columns move; `-F` is the form `lsof` documents for programs.
 */
export function parseLsof(text: string): ListeningPort[] {
  const found: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('n')) continue;
    const address = line.slice(1).trim();
    const at = address.lastIndexOf(':');
    if (at < 0) continue;

    const port = Number.parseInt(address.slice(at + 1), 10);
    if (!Number.isFinite(port) || port <= 0) continue;

    const rawHost = address.slice(0, at);
    // `*` is every interface, which `lsof` prints where `/proc` gives `0.0.0.0`.
    // Normalised so `loopbackOnly` means the same thing on both.
    const host = rawHost === '*' ? '0.0.0.0' : rawHost.replace(/^\[|\]$/g, '');
    found.push({
      port,
      address: host,
      loopbackOnly: isLoopback(host),
      family: host.includes(':') ? 'ipv6' : 'ipv4',
    });
  }
  return found;
}

/**
 * `netstat -ano`, which is what Windows has.
 *
 * Measured before being chosen: 68 ms, against 83 **seconds** for
 * `tasklist /FI "USERNAME eq …"` — so the obvious way to answer "whose process
 * is this" is not available at any acceptable cost. See `ownedByUs`.
 */
export function parseNetstat(text: string, mine: (pid: number) => boolean): ListeningPort[] {
  const found: ListeningPort[] = [];
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'TCP' || cols[3] !== 'LISTENING') continue;

    const local = cols[1];
    const pid = Number(cols[4]);
    if (local === undefined || !Number.isFinite(pid)) continue;

    const at = local.lastIndexOf(':');
    if (at < 0) continue;
    const port = Number.parseInt(local.slice(at + 1), 10);
    if (!Number.isFinite(port) || port <= 0) continue;
    if (!mine(pid)) continue;

    const host = local.slice(0, at).replace(/^\[|\]$/g, '');
    found.push({
      port,
      address: host,
      loopbackOnly: isLoopback(host),
      family: host.includes(':') ? 'ipv6' : 'ipv4',
    });
  }
  return found;
}

/**
 * Whether a pid belongs to us, cheaply.
 *
 * `kill(pid, 0)` tests for existence without signalling, and on Windows it opens
 * the process — so `EPERM` means "exists, and is not reachable by this user".
 * Measured: three hundred probes in a millisecond, against `tasklist`'s eighty
 * three seconds for one filtered listing.
 *
 * It errs toward showing **less**: a process of ours running elevated is also
 * `EPERM`, so an admin dev server would be missing from the list. That is the
 * right direction for a filter whose purpose is not showing other people's
 * things — the failure is "my elevated server is not offered", not "somebody
 * else's is".
 */
export function ownedByUs(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'EPERM';
  }
}

export interface ListPortsOptions {
  /** Whose ports. Defaults to the user this process runs as. */
  uid?: number;
  /** Ports this host owns itself, which must never be offered as a preview. */
  exclude?: number[];
  /** Overridable so a test can drive real captured files. */
  read?: (path: string) => Promise<string>;
  /** Overridable so a test can drive captured command output. */
  run?: (bin: string, args: string[]) => Promise<string>;
  /** Overridable so a Windows test need not spawn processes to own. */
  owned?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
}

/** Run a listing command. A failure is "cannot tell", which the caller reports. */
const defaultRun = (bin: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // `lsof` exits non-zero when it finds nothing, which is not an error — so
      // stdout wins whenever there is any.
      if (stdout !== '') resolve(stdout);
      else if (err !== null) reject(err);
      else resolve('');
    });
  });

/**
 * What is listening here, that belongs to us, that could be a preview.
 *
 * Throws rather than returning `[]` where it cannot look: "no dev server is
 * running" and "this host cannot tell you" are different answers, and the second
 * one dressed as the first is how a user concludes their server did not start.
 */
export async function listListeningPorts(opts: ListPortsOptions = {}): Promise<ListeningPort[]> {
  const platform = opts.platform ?? process.platform;
  const excluded = new Set(opts.exclude ?? []);

  /** Dedupe, filter and order — the part every platform shares. */
  const finish = (all: ListeningPort[]): ListeningPort[] => {
    const seen = new Set<number>();
    const ports: ListeningPort[] = [];
    for (const entry of all) {
      if (excluded.has(entry.port) || NEVER_A_PREVIEW.has(entry.port)) continue;
      // A server bound to both stacks appears twice. One port is one server to
      // the person choosing from a list, so the first wins and v4 is listed
      // first.
      if (seen.has(entry.port)) continue;
      seen.add(entry.port);
      ports.push(entry);
    }
    return ports.sort((a, b) => a.port - b.port);
  };

  const run = opts.run ?? defaultRun;

  if (platform === 'darwin') {
    // `-u` does the owner filtering for us, which `/proc` needed a column for
    // and Windows has no cheap way to do at all.
    const uid = opts.uid ?? process.getuid?.() ?? -1;
    try {
      const out = await run('lsof', [
        '-nP', // no name resolution, numeric ports: faster and unambiguous
        '-iTCP',
        '-sTCP:LISTEN',
        '-u',
        String(uid),
        '-F',
        'pn',
      ]);
      return finish(parseLsof(out));
    } catch (err) {
      throw new PortsUnavailable(
        `could not list listening ports with lsof: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (platform === 'win32') {
    const owned = opts.owned ?? ownedByUs;
    try {
      return finish(parseNetstat(await run('netstat', ['-ano']), owned));
    } catch (err) {
      throw new PortsUnavailable(
        `could not list listening ports with netstat: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (platform !== 'linux') {
    throw new PortsUnavailable(`detecting listening ports is not implemented for ${platform}`);
  }

  const read = opts.read ?? ((path: string) => readFile(path, 'utf8'));
  // `process.getuid` is absent on Windows, which this branch has already ruled
  // out — but typing says otherwise, so the fallback keeps it honest.
  const uid = opts.uid ?? process.getuid?.() ?? -1;

  const files = await Promise.all([
    read('/proc/net/tcp').catch(() => null),
    // IPv6 is absent on some kernels and that is not an error — a v4-only host
    // still has every port that matters.
    read('/proc/net/tcp6').catch(() => null),
  ]);

  if (files[0] === null && files[1] === null) {
    throw new PortsUnavailable('could not read /proc/net/tcp on this host');
  }

  return finish([
    ...(files[0] === null ? [] : parseProcNetTcp(files[0], uid, 'ipv4')),
    ...(files[1] === null ? [] : parseProcNetTcp(files[1], uid, 'ipv6')),
  ]);
}
