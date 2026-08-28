/**
 * On-disk layout of a workspace's `.agbrte/` (DESIGN.md §5.1).
 *
 * Identical whether the workspace is local or remote — the remote agent host
 * runs the same code against the same layout, which is why the local path
 * continuously exercises the remote one.
 *
 * ## Two directories share a name on purpose
 *
 * `~/.agbrte` is the **machine's install area**: the private Node, the host
 * bundles, `endpoints.json`, the machine host's own state. `<workspace>/.agbrte`
 * is **one workspace's data**: identity, memory, templates, sessions. They are
 * different things that now happen to spell their name the same way, which is a
 * readability decision and not a merge. Nothing in this file knows about the
 * install area, and `assertNotInstallRoot` below refuses the one case where they
 * would collide — a workspace rooted at `$HOME`.
 *
 * ## The old name is read forever
 *
 * The directory used to be `.devagents`. Existing workspaces keep it: see
 * `workspaceDirName`.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { machineRoot } from '../../host/machine.js';
import type { SessionId } from '@shared/types/index.js';

/** The directory a workspace created today gets. */
export const WORKSPACE_DIR = '.agbrte';

/**
 * The directory workspaces created before v0.0.12 got, read forever.
 *
 * **Read as a fallback, never renamed.** Four reasons, in the order they'd bite:
 *
 * 1. A rename is a write to the directory holding an `events.jsonl` that a
 *    *detached* host — a process this one did not start and cannot see — may be
 *    appending to right now. §5.1's single-writer property says that host is the
 *    writer; moving the file out from under it is a second party mutating the
 *    log's location. On Windows the rename simply fails while a descriptor is
 *    open; on POSIX it succeeds and the host keeps writing to a moved inode,
 *    which works by luck while every absolute path it holds — its socket, its
 *    host record — goes stale.
 * 2. `project.json`, `memory/` and `templates/` are *tracked*. A rename is a
 *    change to the user's committed tree that they did not ask for, arriving as
 *    deletions in `git status`, possibly on a branch an agent is about to commit.
 * 3. A released build is in the wild and reads only the old name. Renaming makes
 *    every existing session invisible to it — including after a rollback, and
 *    including a machine with both installed. Reading both keeps one folder
 *    legible to both builds.
 * 4. The cost of keeping it is one `existsSync` in one function, and it is
 *    bounded: `workspaceDirName` is the only place that decides.
 *
 * A rename remains available as an explicit, user-initiated action if it is ever
 * wanted. It must not be something an open does on the way past.
 */
export const LEGACY_WORKSPACE_DIR = '.devagents';

export const SCHEMA_VERSION = 4;

/**
 * `memory/` is tracked by default and safe to commit; `sessions/`, `index/`,
 * `run/`, and `instance.json` are excluded. A nested gitignore does this
 * without touching the user's root .gitignore (§1).
 */
export const NESTED_GITIGNORE = `# Written by Agbrte. To exclude .agbrte/ entirely, add it to the repository's own .gitignore.
sessions/
index/
run/
instance.json
host.json
`;

/**
 * Lines this file must contain, whatever else a user has added to it.
 *
 * `host.json` is the one that made this necessary. It was never excluded — a
 * gap that mattered little while it was written once per workspace by a host
 * that was about to be the only one, and matters now that the machine host
 * leaves a **pointer** in every folder it opens (§8). On a loopback control
 * channel that record carries the bearer token that is the *entire*
 * authentication for it (§6.2), so a committed one is a credential in a
 * repository — exactly what §13 says the workspace store must never be.
 *
 * Repaired rather than rewritten: this file is the user's to edit — a rule they
 * added is theirs to keep — and only the missing lines are appended.
 *
 * The header used to say "delete this file to exclude `.agbrte/` entirely",
 * which `openWorkspace` has never honoured: it recreates the file on the next
 * open, so a deletion lasted until the workspace was next touched. The
 * instruction now names the thing that actually works — an entry in the
 * repository's own `.gitignore`, which nothing here writes.
 */
export const REQUIRED_GITIGNORE_LINES = ['sessions/', 'index/', 'run/', 'instance.json', 'host.json'];

/**
 * Which of the two names this workspace uses, decided by what is on disk.
 *
 * Preference order is new, then legacy, then new for a folder that is neither —
 * so a workspace created today gets `.agbrte` and one created last month keeps
 * `.agbrte` in place. When *both* exist the new name wins: that is the only
 * rule that stays stable once somebody has renamed one by hand, and the
 * alternative — preferring whichever holds `project.json` — makes the answer
 * depend on how far a half-finished migration got.
 *
 * Synchronous because every caller of `workspaceLayout` is, and it is two
 * `stat`s at worst on paths the OS has cached. It is deliberately not memoised:
 * a cache here would answer about a directory as it was, which is the class of
 * bug §5.3 exists to handle rather than to create.
 */
export function workspaceDirName(root: string): string {
  if (existsSync(join(root, WORKSPACE_DIR))) return WORKSPACE_DIR;
  if (existsSync(join(root, LEGACY_WORKSPACE_DIR))) return LEGACY_WORKSPACE_DIR;
  return WORKSPACE_DIR;
}

/**
 * A folder that is not a workspace, and why, kept apart from what to do about it.
 *
 * The two halves have different audiences. `openWorkspace` throws this at a
 * caller that cannot ask anything — the app, a host, a script — and there the
 * remedy has to travel with the reason or the message is a dead end. A terminal
 * is about to ask *"Folder to work in [~/agbrte]:"*, and printing "change into a
 * project folder first, or name one: agbrte web …" immediately above that
 * question is telling somebody how to answer a question they can simply answer.
 *
 * So the reason is the sentence, the remedy is a separate one, and `message`
 * joins them for every reader that is not going to follow up.
 */
export class NotAWorkspace extends Error {
  constructor(
    readonly reason: string,
    readonly remedy: string,
  ) {
    super(`${reason} ${remedy}`);
    this.name = 'NotAWorkspace';
  }
}

/** What to type instead, on this platform. */
function anExample(): string {
  return `agbrte web ${process.platform === 'win32' ? 'C:\\Users\\you\\my-project' : '~/my-project'}`;
}

/**
 * Refuse a workspace whose data directory would *be* the machine install area.
 *
 * Only one path does this: `$HOME`, where `<root>/.agbrte` and `~/.agbrte` are
 * the same directory. Opening it would put `sessions/` beside the private Node
 * and `instance.json` beside `endpoints.json` — a machine's install area and one
 * workspace's data in one folder, which is exactly the conflation the shared
 * name must not cause. Refused by name rather than worked around, because a home
 * directory is not a workspace and silently relocating its store would make the
 * sessions unfindable by the next honest reader.
 */
export function assertNotInstallRoot(root: string, home?: string): void {
  const dir = resolve(join(root, workspaceDirName(root)));
  // `machineRoot` rather than `join(home, …)`: the install directory is wherever
  // `AGBRTE_HOME` says it is, and a reader that joins `$HOME` itself keeps
  // pointing at the other installation — which is the trap `machineFilePath`
  // fell into. Passing `home` through preserves the caller that names one.
  if (dir !== resolve(machineRoot(home))) return;
  throw new NotAWorkspace(
    `${resolve(root)} cannot be a workspace: its ${WORKSPACE_DIR}/ is this machine's Agbrte install directory (${dir}).`,
    `Choose a project folder instead — ${anExample()}`,
  );
}

/**
 * Refuse a workspace that would put a project folder inside the operating system.
 *
 * ## The path somebody actually took
 *
 * `npx agbrte web .` is the shortest way into this program and the connect screen
 * offers it first, so the folder it lands in is whatever the terminal opened in.
 * On Windows, "Run as administrator" opens PowerShell in `C:\WINDOWS\system32` —
 * and a first-time reader who pastes the line there gets
 *
 *   no session host for C:\Windows\System32: EPERM: operation not permitted,
 *   mkdir 'C:\Windows\System32\.agbrte'
 *
 * which names an errno and a path and nothing they can act on.
 *
 * ## The quieter half, which is why this is a name check
 *
 * That message is at least a *failure*. The same paste from an elevated shell
 * with write access to `System32` **succeeds**: a workspace is created inside the
 * Windows system directory, a detached host binds it, and sessions accumulate in
 * a folder nobody will ever look in and no uninstall will clean up. A check that
 * only translated the permission error would let exactly the more privileged case
 * through, which is the wrong way round.
 *
 * So this refuses by name, before anything is created, like
 * `assertNotInstallRoot` above it and for a related reason: some directories are
 * not workspaces, and the honest response is to say so rather than to comply.
 *
 * ## What is on the list, and what deliberately is not
 *
 * A filesystem root, and the directories an operating system owns. Read from the
 * environment on Windows rather than hardcoded, because `C:` is a default rather
 * than a fact and a machine installed on `D:` would otherwise be unguarded.
 *
 * The list is short on purpose. `/var`, `/opt`, `/srv` and `%ProgramData%` are
 * all places people genuinely keep working directories — a demo host lives under
 * `/srv` in this project's own documentation — and refusing a folder somebody
 * chose on purpose is a worse failure than the one this prevents. What is here is
 * only what nobody puts a project in.
 */
export function assertUsableWorkspace(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const target = resolve(root);

  // `dirname` of a root is itself, on both platforms. Cheaper and more reliable
  // than matching drive-letter shapes, and it is right for a UNC share too.
  if (dirname(target) === target) {
    throw new NotAWorkspace(
      `${target} is the top of a filesystem, not a project folder.`,
      `Change into the folder you want to work in first, or name one — ${anExample()}`,
    );
  }

  const owned =
    process.platform === 'win32'
      ? [env['SystemRoot'], env['windir'], env['ProgramFiles'], env['ProgramFiles(x86)']]
      : ['/bin', '/sbin', '/usr', '/etc', '/boot', '/proc', '/sys', '/dev', '/System'];

  /*
   * Compared case-insensitively on Windows, which is not a nicety.
   *
   * `%SystemRoot%` is spelled `C:\WINDOWS` and `path.resolve` of a working
   * directory hands back `C:\Windows\System32`. A case-sensitive `startsWith`
   * therefore matched neither, and the first version of this check let the exact
   * folder it was written for straight through — the filesystem-root branch
   * caught `C:\` and the one that mattered silently did not. The filesystem is
   * case-insensitive here; the comparison has to be too.
   */
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const folded = fold(target);

  for (const raw of owned) {
    if (raw === undefined || raw === '') continue;
    const dir = resolve(raw);
    // The directory itself or anything under it. `startsWith` on the separator
    // rather than on the string, so `/systemd` is not read as inside `/sys`.
    if (folded !== fold(dir) && !folded.startsWith(fold(dir) + sep)) continue;
    throw new NotAWorkspace(
      `${target} is inside ${dir}, which belongs to the operating system, ` +
        `so Agbrte will not keep a workspace there.`,
      `Change into a project folder first, or name one — ${anExample()}`,
    );
  }
}

export interface WorkspaceLayout {
  readonly root: string;
  /** The workspace's own directory — `.agbrte`, or `.agbrte` on an old one. */
  readonly dir: string;
  /** Which name `dir` used, for anything that has to say so. */
  readonly dirName: string;
  readonly projectFile: string;
  readonly instanceFile: string;
  readonly gitignoreFile: string;
  readonly memoryDir: string;
  readonly memoryIndex: string;
  readonly sessionsDir: string;
  readonly indexDir: string;
  readonly indexDb: string;
  readonly runDir: string;
}

export function workspaceLayout(root: string): WorkspaceLayout {
  const dirName = workspaceDirName(root);
  const dir = join(root, dirName);
  return {
    root,
    dir,
    dirName,
    projectFile: join(dir, 'project.json'),
    instanceFile: join(dir, 'instance.json'),
    gitignoreFile: join(dir, '.gitignore'),
    memoryDir: join(dir, 'memory'),
    memoryIndex: join(dir, 'memory', 'MEMORY.md'),
    sessionsDir: join(dir, 'sessions'),
    indexDir: join(dir, 'index'),
    indexDb: join(dir, 'index', 'sessions.sqlite'),
    runDir: join(dir, 'run'),
  };
}

export interface SessionLayout {
  readonly dir: string;
  readonly sessionFile: string;
  readonly eventLog: string;
  readonly checkpointsDir: string;
  readonly attachmentsDir: string;
}

export function sessionLayout(root: string, sessionId: SessionId): SessionLayout {
  const dir = join(workspaceLayout(root).sessionsDir, sessionId);
  return {
    dir,
    sessionFile: join(dir, 'session.json'),
    eventLog: join(dir, 'events.jsonl'),
    checkpointsDir: join(dir, 'checkpoints'),
    attachmentsDir: join(dir, 'attachments'),
  };
}

/** Checkpoints are zero-padded so lexical order is numeric order. */
export function checkpointName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`;
}

/** Directory mode for anything that may hold transcripts or sockets (§13). */
export const PRIVATE_DIR_MODE = 0o700;
