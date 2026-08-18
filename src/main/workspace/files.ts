/**
 * Reading the workspace, on the machine that owns it (DESIGN.md §6.4, §6.6, §13).
 *
 * The motivating case is a **remote** workspace: the files are on a build box
 * reached over ssh, and until this existed there was no way to look at them from
 * the app at all. So this runs where `preview.ports`, `session.search` and
 * `shell.open` run — on the host — for the same reason all three do: it is the
 * only place the answer exists, and it makes a local folder and an ssh host
 * identical to every layer above.
 *
 * ## This is a path from a client to a filesystem, so it is bounded four ways
 *
 * 1. **Lexically inside the root.** Every path is workspace-relative and
 *    resolved here. `../../etc/passwd` and `/etc/passwd` both resolve outside
 *    and are refused by name.
 * 2. **Really inside the root.** The lexical check alone is not enough: a
 *    symlink inside the workspace can point anywhere, and `resolve()` cannot
 *    see through one. So the resolved path is `realpath`'d and checked again
 *    against the *real* root. Both checks, not one — the lexical check refuses
 *    a traversal that never touches the disk, and the real check refuses a link
 *    that does.
 * 3. **Entries per directory.** `node_modules` has tens of thousands of them
 *    and nobody is reading the 4,000th, so a listing stops at `MAX_ENTRIES` and
 *    *says how many it left out*. The count rather than a flag, because the
 *    client's sentence is "412 more entries" — §7's rule that the renderer holds
 *    a bounded projection applies to a directory as much as to a log.
 * 4. **Bytes per file.** A file over `MAX_PREVIEW_BYTES`, or one that is not
 *    text, is **refused rather than truncated**. Truncation is how megabytes
 *    end up crossing the IPC boundary one "just this once" at a time, and a
 *    half-file on screen with no marker is worse than a refusal that names the
 *    size and the cap.
 *
 * ## `isInsideWorkspace`, not `PathCodec`
 *
 * `PathCodec` (§5.4b) is the *durable* path instrument: it encodes an escaping
 * path as `{abs, external: true}` and hands it back, because its job is to
 * record what happened so rehydration can warn. It refuses nothing, by design.
 * A gate built on it would therefore admit everything and merely label it. This
 * is a view — nothing here is persisted, so there is nothing to make durable —
 * and the question being asked is a policy question, which is what
 * `isInsideWorkspace` answers and why `evaluate.ts` keeps it out of the store in
 * the first place.
 *
 * ## Not §13-gated, and that is not an oversight
 *
 * §13's permission gate covers what a **model** asks the app for: an agent
 * calling `read` goes through `tools/index.ts`, which checks the same root and
 * then the session's `ToolPolicy`. Nothing on this path has an agent on it. This
 * is a person looking at their own workspace through a window, and prompting
 * them to approve their own click would be the theatre §13 warns against — it
 * teaches people to dismiss prompts, which is what makes the real ones
 * dangerous. What *does* apply is the role check in `sessionServer.ts`, and both
 * commands are reads, so a `read-only` client may use them.
 *
 * Nothing here writes an event, touches the turn queue, or opens the session
 * store. The transcript is unchanged by anybody browsing.
 */

import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { isInsideWorkspace } from '../policy/evaluate.js';
import type {
  DirListing,
  FilePreview,
  WorkspaceEntry,
  WorkspaceEntryKind,
} from '@shared/types/index.js';

/**
 * The most entries one directory answers with.
 *
 * Sized for "a large source directory renders whole" rather than for
 * `node_modules`, which is the case the cap exists for and the case nobody
 * scrolls. A request may ask for fewer and never for more — the cap belongs to
 * the host, because the host is what a large request costs.
 */
export const MAX_ENTRIES = 500;

/**
 * The largest file this will return.
 *
 * 256 KiB is comfortably past any source file and comfortably short of the point
 * where the hop through IPC is felt. A minified bundle or a lockfile lands over
 * it, which is the right place for the line: those are the files somebody clicks
 * by accident.
 */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** How much of a file is sniffed for the NUL that means "not text". */
const SNIFF_BYTES = 8192;

/**
 * A refusal a client can render as a sentence.
 *
 * `name` travels on the protocol's `err` message, so a client can tell "outside
 * the workspace" from "too large" from "the host is too old" without parsing
 * English. The message names the thing refused, because the only useful refusal
 * is one that says which path, or which cap.
 */
function refuse(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** Workspace-relative, POSIX, whatever this machine's separator is. */
function toRelPosix(root: string, abs: string): string {
  const rel = relative(root, abs);
  return sep === '/' ? rel : rel.split(sep).join('/');
}

/**
 * Resolve a client's path inside the workspace, or refuse it by name.
 *
 * Returns the real absolute path (what the filesystem calls are made against)
 * and the relative POSIX form (what goes back on the wire), because every caller
 * needs both and computing the second twice is how the two drift.
 *
 * The order matters. The lexical check runs first, so a traversal is refused
 * without ever touching the disk — a path naming something a person may not
 * reach should not also work as a probe for whether it exists. `realpath` then
 * runs on what survived, and its answer is checked against the *real* root: a
 * workspace under `/tmp` on macOS is really under `/private/tmp`, and comparing
 * a resolved link against an unresolved root would refuse the whole workspace.
 */
async function resolveInside(
  workspaceRoot: string,
  path: string,
): Promise<{ abs: string; rel: string }> {
  const root = resolve(workspaceRoot);
  const requested = path.trim();

  // An empty path is the root itself, which is the listing a browser opens on.
  const candidate = requested === '' || requested === '.' ? root : resolve(root, requested);

  if (!isInsideWorkspace(root, candidate)) {
    throw refuse(
      'PathOutsideWorkspace',
      `"${requested}" is outside this workspace — the file browser only reaches paths under ${root}`,
    );
  }

  let real: string;
  let realRoot: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(candidate);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw refuse('NoSuchPath', `there is no "${requested}" in this workspace`);
    }
    throw err;
  }

  // The second check, and the one a lexical test cannot make: a symlink under
  // the root can name anything on the machine, and following it would turn a
  // workspace browser into a filesystem browser.
  if (!isInsideWorkspace(realRoot, real)) {
    throw refuse(
      'PathOutsideWorkspace',
      `"${requested}" leads outside this workspace through a link — the file browser only ` +
        `follows paths that stay under ${root}`,
    );
  }

  return { abs: real, rel: toRelPosix(realRoot, real) };
}

/**
 * What a directory entry is, without following anything.
 *
 * A symlink is reported as `'link'` rather than resolved to what it points at.
 * That is a deliberate refusal to be helpful: the target is decided somewhere
 * this function cannot see, may leave the root, and `resolveInside` would refuse
 * it on the click anyway — so offering it as an expandable folder would be
 * offering a control that fails. The client shows it and says what it is.
 */
function kindOf(entry: {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}): WorkspaceEntryKind {
  if (entry.isSymbolicLink()) return 'link';
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  return 'other';
}

/**
 * One directory. Never its children's children.
 *
 * Sorted directories first, then by name case-insensitively, so the order is the
 * one every file browser has rather than the order the filesystem happened to
 * return — and it does not vary with the host's locale, which `localeCompare`
 * would make it do.
 */
export async function listDirectory(
  workspaceRoot: string,
  path: string,
  opts: { limit?: number } = {},
): Promise<DirListing> {
  const { abs, rel } = await resolveInside(workspaceRoot, path);

  const info = await stat(abs);
  if (!info.isDirectory()) {
    throw refuse('NotADirectory', `"${rel}" is not a directory`);
  }

  // Clamped rather than trusted: a client asking for a million entries is asking
  // the host to build a million entries, and the cap is the host's to keep.
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_ENTRIES, MAX_ENTRIES));

  const dirents = await readdir(abs, { withFileTypes: true });
  dirents.sort((a, b) => {
    const aDir = a.isDirectory() ? 0 : 1;
    const bDir = b.isDirectory() ? 0 : 1;
    if (aDir !== bDir) return aDir - bDir;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const shown = dirents.slice(0, limit);
  const entries: WorkspaceEntry[] = await Promise.all(
    shown.map(async (dirent) => {
      const kind = kindOf(dirent);
      const childRel = rel === '' ? dirent.name : `${rel}/${dirent.name}`;
      const base: WorkspaceEntry = { name: dirent.name, path: childRel, kind };
      if (kind !== 'file') return base;
      try {
        const child = await stat(resolve(abs, dirent.name));
        return { ...base, size: child.size };
      } catch {
        // A file that vanished between `readdir` and `stat` is an ordinary race
        // in a directory somebody is working in, not a reason to fail the whole
        // listing. It is listed without a size, which reads as "cannot tell".
        return base;
      }
    }),
  );

  return {
    path: rel,
    entries,
    truncated: Math.max(0, dirents.length - shown.length),
    limit,
  };
}

/**
 * One file's text, or a refusal that names why.
 *
 * Three refusals, all by name, and none of them a truncation:
 *
 *  - `NotAFile` — a directory or a device asked for as a file.
 *  - `FileTooLarge` — over the cap, with the size and the cap in the message.
 *  - `FileNotText` — a NUL in the first `SNIFF_BYTES`, or bytes that are not
 *    valid UTF-8. Sniffed rather than trusted from the extension, which is a
 *    guess about a filename rather than an observation about the contents.
 *
 * The size is checked from `stat` *before* the read, so an oversized file is
 * never held in the host's memory on its way to being refused.
 */
export async function readTextFile(workspaceRoot: string, path: string): Promise<FilePreview> {
  const { abs, rel } = await resolveInside(workspaceRoot, path);

  const info = await stat(abs);
  if (!info.isFile()) {
    throw refuse('NotAFile', `"${rel}" is not a file`);
  }
  if (info.size > MAX_PREVIEW_BYTES) {
    throw refuse(
      'FileTooLarge',
      `"${rel}" is ${Math.round(info.size / 1024)} KB and the preview stops at ` +
        `${Math.round(MAX_PREVIEW_BYTES / 1024)} KB — open it on the machine that owns ` +
        `this workspace instead`,
    );
  }

  const bytes = await readFile(abs);
  if (bytes.subarray(0, SNIFF_BYTES).includes(0)) {
    throw refuse('FileNotText', `"${rel}" is not a text file, so there is nothing to show here`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw refuse('FileNotText', `"${rel}" is not valid UTF-8, so there is nothing to show here`);
  }

  return { path: rel, text, bytes: bytes.byteLength };
}
