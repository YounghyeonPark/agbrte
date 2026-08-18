/**
 * Looking at the files a session is working on (DESIGN.md §6.4, §7, §13).
 *
 * A **view**, and every shape here says so. Nothing in this file is written to
 * the event log, nothing is a `ContentBlock`, and nothing survives the pane that
 * asked for it — which is why the paths are plain strings rather than
 * `EncodedPath` (§5.4b). `PathCodec` exists to make a path *durable*: it records
 * an escaping path as `{abs, external: true}` rather than refusing it, because
 * its job is to describe what happened, not to decide what may happen. That is
 * exactly the wrong instrument for a client asking a host to open a file, so the
 * gate here is `isInsideWorkspace` — the policy answer — and the wire form is a
 * relative POSIX string that has no meaning at all outside the root it is
 * resolved against.
 *
 * ## POSIX on the wire, whatever either machine uses
 *
 * The host may be Linux while the app is Windows, so `/` is the separator in
 * every `path` here and the host converts on the way in and out. The renderer is
 * sandboxed and has no `node:path` to do it with anyway — the same reason
 * `folderName` in App.tsx splits on both separators by hand.
 *
 * ## Incremental by construction
 *
 * One directory per request. A recursive walk of a `node_modules` tree over ssh
 * is a request that never comes back, with nothing on screen to explain it, so
 * the shape that would allow one is simply not here: there is no `depth`, no
 * `recursive`, and no glob.
 */

/** What a directory entry is. Deliberately closed — a client renders each case. */
export type WorkspaceEntryKind = 'dir' | 'file' | 'link' | 'other';

export interface WorkspaceEntry {
  /** The entry's own name, with no separator in it. */
  name: string;
  /** Workspace-relative, POSIX separators. `''` is the root and never an entry. */
  path: string;
  kind: WorkspaceEntryKind;
  /**
   * Bytes on disk, for `kind: 'file'` only.
   *
   * Carried so a client can say *2.4 MB — too large to preview* without asking
   * for it first. Absent for anything that is not a plain file, because a
   * directory's "size" is a number that means nothing to the person reading it.
   */
  size?: number;
}

/**
 * One directory, capped.
 *
 * `truncated` is the count that did **not** fit, not a boolean, because the
 * sentence a client shows is "412 more entries" and a boolean would make it
 * "some more entries". `0` means this is the whole directory.
 */
export interface DirListing {
  /** The directory that was listed, workspace-relative POSIX. `''` is the root. */
  path: string;
  entries: WorkspaceEntry[];
  /** How many entries the cap excluded. `0` means nothing was hidden. */
  truncated: number;
  /** The cap that was applied, so a client can say what bit rather than guess. */
  limit: number;
}

/**
 * One file's text.
 *
 * There is no `truncated` here on purpose: a file is returned **whole or
 * refused**. A half-file shown without a scrollbar's worth of warning is a
 * transcript of a bug waiting to be reported, and the refusal — which names the
 * size and the cap — is a sentence somebody can act on.
 */
export interface FilePreview {
  /** Workspace-relative POSIX, echoed back so a late reply cannot mislabel a pane. */
  path: string;
  text: string;
  /** Bytes read. Equal to the file's size, since nothing partial is returned. */
  bytes: number;
}
