/**
 * Workspace-relative path encoding (DESIGN.md §5.4b).
 *
 * A path written raw into the log is a defect even if it works today: move the
 * workspace and it points at nothing; move it to another machine and every
 * absolute path is wrong at once.
 *
 * Two details that matter for R3 and R7:
 *
 *  - Stored form always uses POSIX separators, so a log written on Windows
 *    reads correctly on Linux and vice versa.
 *  - Paths outside the workspace are stored absolute and flagged `external`,
 *    so rehydration can warn rather than silently referencing something gone.
 */

import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isExternalPath, type EncodedPath, type ExternalPath, type WorkspacePath } from '@shared/types/index.js';

export const toPosix = (p: string): string => (sep === '/' ? p : p.split(sep).join('/'));
export const fromPosix = (p: string): string => (sep === '/' ? p : p.split('/').join(sep));

export class PathCodec {
  private readonly root: string;

  constructor(workspaceRoot: string) {
    this.root = resolve(workspaceRoot);
  }

  /** Absolute (or root-relative) path → durable form. */
  encode(input: string): EncodedPath {
    const abs = resolve(this.root, input);
    const rel = relative(this.root, abs);

    // Empty means the root itself. A `..` prefix or an absolute result means
    // the path escaped the workspace — on Windows, a different drive letter
    // also yields an absolute result here.
    if (rel === '') return { $ws: '.' };
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return { abs, external: true } satisfies ExternalPath;
    }
    return { $ws: toPosix(rel) } satisfies WorkspacePath;
  }

  /** Durable form → absolute path against the currently resolved root. */
  decode(p: EncodedPath): string {
    if (isExternalPath(p)) return p.abs;
    return resolve(this.root, fromPosix(p.$ws));
  }

  /**
   * True when this encoded path can be trusted after a move. External paths
   * cannot — rehydration surfaces them as warnings (§5.4b).
   */
  isPortable(p: EncodedPath): boolean {
    return !isExternalPath(p);
  }

  /** A new codec for the same logical workspace at a different location. */
  rebase(newRoot: string): PathCodec {
    return new PathCodec(newRoot);
  }
}
