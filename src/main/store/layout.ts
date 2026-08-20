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
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
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
export function assertNotInstallRoot(root: string, home = homedir()): void {
  const dir = resolve(join(root, workspaceDirName(root)));
  if (dir !== resolve(join(home, WORKSPACE_DIR))) return;
  throw new Error(
    `${resolve(root)} cannot be a workspace: its ${WORKSPACE_DIR}/ is this machine's Agbrte install directory (${dir}). Choose a project folder instead.`,
  );
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
