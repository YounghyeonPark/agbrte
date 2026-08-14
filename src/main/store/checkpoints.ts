/**
 * Checkpoints (DESIGN.md §5.1, §5.4 invariant 8).
 *
 * A checkpoint is a cached fold of the log so opening a 40 MB session does not
 * mean replaying 40 MB. It is **derived and disposable**: deleting every
 * checkpoint must lose nothing but time.
 *
 * Two consequences that are enforced here rather than merely documented:
 *
 *  - A checkpoint written by a different `CHECKPOINT_VERSION` is ignored, not
 *    migrated. Reusing a stale shape would silently produce a wrong projection,
 *    and replaying the log always yields the right one.
 *  - A corrupt or unreadable checkpoint is ignored the same way. There is never
 *    a reason to fail a session open because a cache went bad.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionProjection } from '@shared/types/index.js';
import { PRIVATE_DIR_MODE, checkpointName } from './layout.js';

/** Bump when the projection shape changes. Old checkpoints then self-invalidate. */
// 2: the projection carries `lastSeqIds`. A v1 checkpoint has no record of
// which events sat at its `lastSeq`, so it cannot be resumed from safely; it is
// ignored and the log is replayed in full, which is always correct.
// 3: the projection carries `standingGrant` (§17 Q19) and `skills` (§17 Q21).
// A v2 checkpoint cut after either event folded it into nothing: resuming
// from one would silently re-arm the gate against the log's own
// `via: 'standing-grant'` lines, or drop a skill the transcript says was
// attached. One bump for both, because both landed before any v3 shipped.
export const CHECKPOINT_VERSION = 3;

export interface Checkpoint {
  version: number;
  seq: number;
  createdAt: string;
  projection: SessionProjection;
}

export async function writeCheckpoint(
  dir: string,
  projection: SessionProjection,
  now: () => Date = () => new Date(),
): Promise<string> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  const checkpoint: Checkpoint = {
    version: CHECKPOINT_VERSION,
    seq: projection.lastSeq,
    createdAt: now().toISOString(),
    projection,
  };
  const path = join(dir, checkpointName(projection.lastSeq));
  await writeFile(path, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
  return path;
}

/** Sequence numbers of checkpoints present, ascending. */
export async function listCheckpoints(dir: string): Promise<number[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => /^\d{6,}\.json$/.test(e))
    .map((e) => Number.parseInt(e, 10))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
}

/**
 * Newest usable checkpoint, or null. Walks backwards so one bad file does not
 * discard the older good ones behind it.
 */
export async function readLatestCheckpoint(dir: string): Promise<Checkpoint | null> {
  const seqs = await listCheckpoints(dir);
  for (const seq of [...seqs].reverse()) {
    const cp = await readCheckpoint(dir, seq);
    if (cp) return cp;
  }
  return null;
}

export async function readCheckpoint(dir: string, seq: number): Promise<Checkpoint | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, checkpointName(seq)), 'utf8')) as Checkpoint;
    if (raw.version !== CHECKPOINT_VERSION) return null;
    if (typeof raw.seq !== 'number' || !raw.projection) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Keep the newest `keep` checkpoints; returns how many were removed. */
export async function pruneCheckpoints(dir: string, keep: number): Promise<number> {
  const seqs = await listCheckpoints(dir);
  const doomed = seqs.slice(0, Math.max(0, seqs.length - keep));
  for (const seq of doomed) {
    await unlink(join(dir, checkpointName(seq))).catch(() => undefined);
  }
  return doomed.length;
}
