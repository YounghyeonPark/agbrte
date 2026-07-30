/**
 * Workspace-relative path encoding (DESIGN.md §5.4b).
 *
 * Every path written to the durable log is stored relative to the workspace
 * root and expanded against whatever root is resolved at read time. Without
 * this, moving a workspace leaves an agent with intact memory of files that no
 * longer exist — and moving it between machines with different home
 * directories makes every absolute path wrong at once.
 *
 * Paths genuinely outside the workspace are stored absolute and flagged, so
 * rehydration can warn instead of silently referencing something gone.
 */

/** Inside the workspace. Separators are always POSIX, whatever wrote it. */
export interface WorkspacePath {
  readonly $ws: string;
}

/** Outside the workspace. Machine-specific by nature — rehydration warns. */
export interface ExternalPath {
  readonly abs: string;
  readonly external: true;
}

export type EncodedPath = WorkspacePath | ExternalPath;

export function isWorkspacePath(p: EncodedPath): p is WorkspacePath {
  return '$ws' in p;
}

export function isExternalPath(p: EncodedPath): p is ExternalPath {
  return 'external' in p;
}
