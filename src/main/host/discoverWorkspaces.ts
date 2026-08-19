/**
 * Asking a machine what workspaces are on it (DESIGN.md §6.2, §6.4).
 *
 * Attaching a remote used to be an alias and a *typed absolute path*. The local
 * side has a folder picker; the remote side had a text field with
 * `/home/you/project` in it, so attaching to a machine you had not used for a
 * month meant remembering the path or opening a terminal to go and look. This is
 * the missing half: once the machine is chosen, ask it.
 *
 * ## It runs before a host exists, so it is main's job and not the protocol's
 *
 * There is no `HostConnection` at this point — no bundle, no Node, nothing
 * deployed. Discovery therefore reuses the bootstrap's own runner (`SshRunner`,
 * the user's `ssh` with their config, keys and jump hosts) exactly as
 * `probeRemote` does, and deliberately needs **nothing but a POSIX shell**: a
 * machine that has never been attached, and would need the private-Node install
 * to run anything of ours, still answers this. Listing directories must not be
 * gated on a hundred-megabyte install.
 *
 * ## Bounded, because an unbounded `find` is a hang with no explanation
 *
 * A `find $HOME` on a machine with a `node_modules` tree in it is minutes of
 * disk with nothing on screen. Four independent bounds, none of which is enough
 * on its own:
 *
 *   * **roots** — a small fixed list, and only the ones that exist;
 *   * **depth** — {@link DISCOVERY_MAX_DEPTH}, so a workspace is found at most
 *     two levels below a root and never deeper;
 *   * **pruning** — hidden directories and the handful of famously enormous
 *     build and dependency directories are never descended into;
 *   * **a cap and a timeout** — `head` stops the stream at
 *     {@link DISCOVERY_MAX_RESULTS}, the remote's own `timeout(1)` (where it has
 *     one) stops each root, and this side kills the `ssh` if the whole thing
 *     overruns. Whatever had already streamed back is still parsed and shown.
 *
 * And the result says **what was searched**, because an empty list has two very
 * different meanings — "there is nothing under these five directories" and "this
 * feature is broken" — and only the first one is worth showing a person.
 *
 * ## Nothing that was typed reaches a shell
 *
 * The script contains no interpolated user input at all: the roots are literals,
 * `$HOME` is expanded and quoted on the far side, and the alias is an `argv`
 * element of `ssh` rather than part of any command. The one thing an alias *can*
 * do is look like an option — `ssh -oProxyCommand=… host` runs a command **on
 * this machine** — so an alias beginning with `-` is refused by name rather than
 * handed to `ssh` (see {@link assertSafeAlias}).
 *
 * ## Unverified against a live server, and this is where that is written down
 *
 * The machine this was written on has no `sshd` — `ssh localhost` is refused —
 * so the command construction, the parsing, the cap, the timeout classification
 * and the Windows refusal are unit-tested against an injected runner, and the
 * *live* path (a real `find` on a real remote, through a real `ssh`) has not been
 * measured here. The shapes it depends on are the ones `probeRemote` already uses
 * in production, but the timings are intent rather than knowledge. A first run
 * against a real remote should check two things in particular: whether
 * `timeout(1)` exists there (macOS and the BSDs usually lack it, in which case
 * only this side's kill applies), and whether the depth is deep enough to be
 * worth having on that person's layout.
 */

import {
  describeSshFailure,
  RemoteBootstrapFailed,
  shellQuote,
  systemSshRunner,
  type SshRunner,
} from './sshTransport.js';
import { probeWindows, windowsSshRunner } from './windowsBootstrap.js';
import { LEGACY_WORKSPACE_DIR, WORKSPACE_DIR } from '@main/store/layout.js';

/** How far below a root a marker may be found: a workspace two levels down. */
export const DISCOVERY_MAX_DEPTH = 3;

/**
 * The hard result cap.
 *
 * A picker with more rows than this is not a picker, and the number also bounds
 * what crosses ssh and IPC. Hitting it is reported (`truncated`) rather than
 * hidden, because a silently clipped list is a list you cannot trust.
 */
export const DISCOVERY_MAX_RESULTS = 200;

/** How long this side waits before killing the `ssh` and using what arrived. */
export const DISCOVERY_TIMEOUT_MS = 20_000;

/** Per-root budget on the far side, where `timeout(1)` exists. */
const REMOTE_FIND_SECONDS = 6;

/**
 * Where to look, in the order a person would.
 *
 * `$HOME` plus the conventional project parents, and the conventional
 * server-side ones. Suffixes only: they are appended to a *quoted* `"$HOME"` on
 * the far side, so a home directory with a space in it needs nothing special and
 * cannot break the command.
 */
export const HOME_ROOT_SUFFIXES = [
  '',
  '/src',
  '/projects',
  '/code',
  '/dev',
  '/work',
  '/repos',
  '/git',
  '/workspace',
] as const;

/** Absolute roots, searched only where they exist. */
export const ABSOLUTE_ROOTS = ['/srv', '/opt', '/workspace'] as const;

/**
 * Directories never descended into.
 *
 * `.*` covers every hidden directory in one rule — `.cache`, `.npm`, `.cargo`,
 * `.rustup`, `.local` — and is why this list is short. It is applied *after* the
 * marker test, so `.git` and `.agbrte` are still found; they are pruned too,
 * as soon as they are printed, because there is nothing inside either of them
 * that this is looking for.
 *
 * The rest are the ones that are both enormous and never a workspace. `go` is
 * here because a GOPATH module cache is hundreds of thousands of directories,
 * and `build`, `dist` and `target` because they are build output — at the price,
 * stated rather than hidden, that a repository *called* `build` two levels down
 * will not be offered. The manual field is the answer for that.
 */
export const PRUNED_NAMES = [
  '.*',
  'node_modules',
  'vendor',
  'venv',
  '__pycache__',
  'Library',
  'snap',
  'go',
  'target',
  'build',
  'dist',
] as const;

/** What a candidate is, which is the whole reason they are not one flat list. */
export type WorkspaceCandidateKind =
  /** Holds a `.agbrte/` — this project has run here, and sessions may exist. */
  | 'workspace'
  /** A git repository. The next-best guess at "a thing you would work in". */
  | 'git'
  /** A directory that is neither. Offered last, and separately. */
  | 'folder';

export interface WorkspaceCandidate {
  path: string;
  kind: WorkspaceCandidateKind;
}

export interface WorkspaceDiscovery {
  alias: string;
  /** The roots that existed and were walked — what an empty list means. */
  roots: string[];
  /** How far below each root the walk went. */
  depth: number;
  candidates: WorkspaceCandidate[];
  /** The cap was hit: there are more of these than are listed. */
  truncated: boolean;
  /** A walk was cut short by a timeout, so the list may be missing things. */
  partial: boolean;
  /**
   * Why there is nothing to show, when the machine answered but cannot be asked
   * this question — a Windows remote, or a shell that is not POSIX.
   *
   * A *failure* to reach the machine throws instead, so it reaches the same
   * diagnosis every other ssh failure does.
   */
  unavailable?: string;
}

/** Rank order. Definitive first, guesses second, noise last. */
const RANK: Record<WorkspaceCandidateKind, number> = { workspace: 0, git: 1, folder: 2 };

/**
 * Refuse an alias that could be read as an option by `ssh`.
 *
 * `ssh` takes the destination as a positional argument, so `-oProxyCommand=…` in
 * that position is not a hostname — it is an instruction to run a command **on
 * this machine**. Nothing else in this file can be injected into (the script has
 * no interpolation and the alias never reaches a shell), which makes this the one
 * place where what the user typed matters.
 *
 * Refused rather than escaped: there is no such thing as a legitimate ssh
 * destination beginning with `-`, and `--` as a separator is not portable across
 * every `ssh` this app may find on a user's PATH.
 */
export function assertSafeAlias(alias: string): void {
  const value = alias.trim();
  if (value === '') throw new RemoteBootstrapFailed('no machine was named');
  if (value.startsWith('-')) {
    throw new RemoteBootstrapFailed(
      `"${value}" cannot be a machine name: ssh would read it as an option, not a destination`,
    );
  }
  // Whitespace and control characters only. A hyphen *inside* a name is ordinary
  // — `build-01` is the likeliest alias on any machine — so the rule above is
  // about the first character and this one is about the rest.
  if (/[\s\u0000-\u001f]/.test(value)) {
    throw new RemoteBootstrapFailed(
      `"${value}" cannot be a machine name: it contains whitespace or a control character`,
    );
  }
}

/** The roots as shell tokens — `"$HOME/src"` expands there, `/srv` is literal. */
function rootTokens(): string[] {
  return [
    ...HOME_ROOT_SUFFIXES.map((suffix) => `"$HOME${suffix}"`),
    ...ABSOLUTE_ROOTS.map((root) => shellQuote(root)),
  ];
}

/**
 * The one command discovery sends.
 *
 * Output is line-oriented and self-describing, which is what lets a truncated
 * stream still be parsed:
 *
 * ```
 * =roots                      a section marker
 * /home/a b                   a root that exists and was searched
 * =marks
 * /home/a b/proj/.git         a marker; the workspace is its parent
 * ?/srv                       this root's walk was cut short by the timeout
 * =dirs
 * /home/a b/Documents         a plain directory, one level below a root
 * ```
 *
 * The roots are printed **before** the capped block and the markers **before**
 * the plain directories, so neither a full home directory nor a `head` cutting
 * the stream can crowd out the answer that matters.
 */
export function discoveryScript(
  opts: { depth?: number; cap?: number; findSeconds?: number } = {},
): string {
  const depth = opts.depth ?? DISCOVERY_MAX_DEPTH;
  const cap = opts.cap ?? DISCOVERY_MAX_RESULTS;
  const seconds = opts.findSeconds ?? REMOTE_FIND_SECONDS;
  const roots = rootTokens().join(' ');
  // Both workspace names, because §5.1 reads the old one forever: a machine
  // with sessions in `.devagents` folders must still be offered them, and this
  // walk is the only place discovery can see them at all.
  const markers = `\\( -name ${WORKSPACE_DIR} -o -name ${LEGACY_WORKSPACE_DIR} -o -name .git \\)`;
  const pruned = PRUNED_NAMES.map((name) => `-name ${shellQuote(name)}`).join(' -o ');

  return [
    // Empty where the remote has no `timeout(1)` — macOS and the BSDs usually do
    // not — in which case this side's kill is the only bound. Deliberately
    // unquoted where it is used, so that empty means "no wrapper" rather than
    // "run a program whose name is the empty string".
    `T=`,
    `command -v timeout >/dev/null 2>&1 && T=${shellQuote(`timeout ${seconds}`)}`,
    `printf '=roots\\n'`,
    `for r in ${roots}; do [ -d "$r" ] && printf '%s\\n' "$r"; done`,
    `{`,
    `printf '=marks\\n'`,
    `for r in ${roots}; do`,
    `[ -d "$r" ] || continue`,
    // `-print -prune` in that order: printing succeeds, so the prune always runs
    // and nothing descends into a `.git`. The marker test is not `-type d`, so a
    // linked worktree or a submodule — where `.git` is a *file* — is found too.
    `$T find "$r" -maxdepth ${depth} ${markers} -print -prune -o -type d \\( ${pruned} \\) -prune`,
    // 124 is `timeout`'s "I killed it". Any other non-zero is the ordinary
    // permission-denied noise of walking somebody's home directory, which is not
    // worth reporting and is why this checks the number rather than using `||`.
    `[ $? -eq 124 ] && printf '?%s\\n' "$r"`,
    `done`,
    `printf '=dirs\\n'`,
    `for r in ${roots}; do`,
    `[ -d "$r" ] || continue`,
    `$T find "$r" -mindepth 1 -maxdepth 1 -type d ! -name '.*' -print`,
    `done`,
    // A few lines of headroom for the section markers, so the cap counts results
    // rather than lines.
    `} 2>/dev/null | head -n ${cap + 4}`,
  ].join('\n');
}

/**
 * Turn the stream into candidates, tolerating a stream that stops anywhere.
 *
 * Nothing here trusts the remote to have finished: every line stands alone, an
 * unknown line is ignored rather than fatal, and a Windows shell echoing the
 * script back produces zero roots — which is the signal the caller uses to go and
 * ask a different question, rather than reporting "nothing found".
 */
export function parseDiscovery(
  stdout: string,
  opts: { cap?: number } = {},
): { roots: string[]; candidates: WorkspaceCandidate[]; truncated: boolean; partial: boolean } {
  const cap = opts.cap ?? DISCOVERY_MAX_RESULTS;
  const roots: string[] = [];
  const found: WorkspaceCandidate[] = [];
  let partial = false;
  let section = '';

  for (const raw of stdout.split('\n')) {
    // Only the trailing CR: a path may legitimately contain a space, and
    // trimming both ends would silently rename one.
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line.startsWith('=')) {
      section = line.slice(1);
      continue;
    }
    if (line.startsWith('?')) {
      partial = true;
      continue;
    }
    if (!line.startsWith('/')) continue;

    if (section === 'roots') {
      roots.push(line);
    } else if (section === 'marks') {
      const marker = [WORKSPACE_DIR, LEGACY_WORKSPACE_DIR].find((name) =>
        line.endsWith(`/${name}`),
      );
      if (marker !== undefined) {
        found.push({ path: line.slice(0, -(marker.length + 1)), kind: 'workspace' });
      } else if (line.endsWith('/.git')) {
        found.push({ path: line.slice(0, -'/.git'.length), kind: 'git' });
      }
    } else if (section === 'dirs') {
      found.push({ path: line, kind: 'folder' });
    }
  }

  /*
   * One path can arrive several times — the roots overlap (`$HOME` and
   * `$HOME/src` both reach `~/src/proj`), and a `.agbrte` workspace is
   * usually a git repository as well. The strongest claim wins, which is the
   * whole point of ranking them: a workspace this project has already used must
   * not be demoted to "a git repository" by the order the far side happened to
   * print things in.
   */
  const best = new Map<string, WorkspaceCandidate>();
  for (const candidate of found) {
    const existing = best.get(candidate.path);
    if (existing === undefined || RANK[candidate.kind] < RANK[existing.kind]) {
      best.set(candidate.path, candidate);
    }
  }

  const candidates = [...best.values()].sort(
    (a, b) => RANK[a.kind] - RANK[b.kind] || a.path.localeCompare(b.path),
  );

  return {
    roots,
    candidates: candidates.slice(0, cap),
    // Counted on the deduplicated list, because that is the list being shown:
    // reporting "there are more" when the extras were the same three paths seen
    // from two roots would be a warning about nothing.
    truncated: candidates.length > cap,
    partial,
  };
}

export interface DiscoverOptions {
  runner?: SshRunner;
  /** The second runner, for the same reason `connectRemoteHost` keeps one. */
  windowsRunner?: SshRunner;
  timeoutMs?: number;
  depth?: number;
  cap?: number;
}

/**
 * Ask one machine what is on it.
 *
 * Throws for a machine that could not be *reached* — the same diagnosis every
 * other ssh failure in this app gets — and returns `unavailable` for one that
 * answered and cannot be asked this question. The difference matters to the
 * person reading it: the first is about their network or their keys, the second
 * is about the machine, and only the second leaves the manual path as the answer.
 */
export async function discoverRemoteWorkspaces(
  alias: string,
  opts: DiscoverOptions = {},
): Promise<WorkspaceDiscovery> {
  assertSafeAlias(alias);
  const runner = opts.runner ?? systemSshRunner();
  const depth = opts.depth ?? DISCOVERY_MAX_DEPTH;
  const cap = opts.cap ?? DISCOVERY_MAX_RESULTS;
  const timeoutMs = opts.timeoutMs ?? DISCOVERY_TIMEOUT_MS;

  const result = await runner.exec(alias, discoveryScript({ depth, cap }), { timeoutMs });
  const parsed = parseDiscovery(result.stdout, { cap });
  // 124 is this side's kill, mirroring `timeout`'s number on purpose: whatever
  // streamed back before it is real, so a slow machine gives a short list marked
  // as short rather than an error.
  const timedOut = result.code === 124;

  if (parsed.roots.length > 0) {
    return {
      alias,
      roots: parsed.roots,
      depth,
      candidates: parsed.candidates,
      truncated: parsed.truncated,
      partial: parsed.partial || timedOut,
    };
  }

  const empty = { alias, roots: [], depth, candidates: [], truncated: false, partial: false };

  if (timedOut) {
    return {
      ...empty,
      partial: true,
      unavailable:
        `${alias} did not answer within ${Math.round(timeoutMs / 1000)}s — ` +
        `type the path below, or try again`,
    };
  }

  /*
   * No roots came back, which on a POSIX machine is impossible: `$HOME` is
   * always a directory. So this takes the same fork `connectRemoteHost` does — a
   * Windows remote answers ssh perfectly well, hands the script to `cmd.exe`,
   * prints nothing that was asked for and frequently **exits 0**. Reporting "no
   * workspaces found" there would be a confident lie, so the second probe is
   * paid for only on this already-failed path.
   */
  const windows = await probeWindows(opts.windowsRunner ?? windowsSshRunner(), alias);
  if (windows.reachable) {
    /*
     * Refused by name on Windows, and that is a decision rather than an
     * oversight (§6.2). Attaching a Windows remote works — `windowsBootstrap`
     * exists — so this makes one locality behave differently from the others,
     * which is worth stating plainly in the UI and here.
     *
     * The reason is that the PowerShell equivalent is not this command with
     * different quoting. `Get-ChildItem` has no `-prune`, so bounding the walk
     * means enumerating and filtering rather than not descending; `.git` carries
     * the hidden attribute on Windows, so `-Force` is required or a discovery
     * finds *nothing* and says so confidently; and there is no `timeout(1)` to
     * bound a root. Every one of those is a detail this machine cannot check —
     * there is no Windows remote to try it against here, and no sshd at all —
     * and an unverified script that returns an empty list is indistinguishable
     * from a machine with no projects on it. That is exactly the failure this
     * feature exists to remove, so it is better to say "not here" than to guess.
     */
    return {
      ...empty,
      unavailable:
        `${alias} is a Windows machine, and looking around one is not built yet — ` +
        `attaching still works, so type the workspace path below`,
    };
  }

  if (result.code !== 0) {
    throw new RemoteBootstrapFailed(
      describeSshFailure(alias, result.stderr.trim() || result.stdout.trim()),
    );
  }

  return {
    ...empty,
    unavailable:
      `${alias} answered, but its shell did not run a POSIX script, so there is nothing ` +
      `to list — type the workspace path below`,
  };
}
