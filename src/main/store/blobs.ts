/**
 * Content-addressed attachment store (DESIGN.md §5.4c, §6.7).
 *
 * Attachments are keyed by sha256, never by path. Three consequences fall out
 * for free rather than needing mechanism:
 *
 *  - Moving a workspace moves the blobs; nothing to fix.
 *  - Deduplication: the same screenshot attached to three sessions is stored
 *    once per workspace.
 *  - Remote transfer is `hasBlob(sha)` then `putBlob` only on a miss.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { asSha256, type Sha256 } from '@shared/types/index.js';
import { PRIVATE_DIR_MODE } from './layout.js';

const MIME_EXT: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'audio/mpeg': 'mp3',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
};

export function extForMime(mime: string): string {
  return MIME_EXT[mime] ?? 'bin';
}

export function sha256Of(data: Buffer): Sha256 {
  return asSha256(createHash('sha256').update(data).digest('hex'));
}

export class BlobStore {
  constructor(private readonly dir: string) {}

  pathFor(sha: Sha256, ext: string): string {
    return join(this.dir, `${sha}.${ext}`);
  }

  /**
   * Store content, returning its hash. Idempotent: an existing blob with the
   * same hash is left alone rather than rewritten, so `put` is safe to call on
   * every attach without checking first.
   */
  async put(data: Buffer, mime: string): Promise<{ sha256: Sha256; deduped: boolean }> {
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const sha = sha256Of(data);
    const target = this.pathFor(sha, extForMime(mime));

    if (await exists(target)) return { sha256: sha, deduped: true };

    await writeFile(target, data);
    return { sha256: sha, deduped: false };
  }

  async has(sha: Sha256, mime: string): Promise<boolean> {
    return exists(this.pathFor(sha, extForMime(mime)));
  }

  async get(sha: Sha256, mime: string): Promise<Buffer> {
    return readFile(this.pathFor(sha, extForMime(mime)));
  }

  /**
   * Recovery path for a hash whose mime is unknown — scans for `<sha>.*`.
   * Callers normally have the mime from the event that referenced the blob, so
   * this should not be on a hot path.
   */
  async locate(sha: Sha256): Promise<string | null> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return null;
    }
    const hit = entries.find((e) => e.startsWith(`${sha}.`));
    return hit ? join(this.dir, hit) : null;
  }

  /**
   * Verify stored content still hashes to its name. Cheap integrity check for
   * a workspace that travelled over a network or sat on a shared disk.
   */
  async verify(sha: Sha256, mime: string): Promise<boolean> {
    try {
      return sha256Of(await this.get(sha, mime)) === sha;
    } catch {
      return false;
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
