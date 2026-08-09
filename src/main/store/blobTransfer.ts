/**
 * Getting bytes to the host that owns the session (DESIGN.md §6.7).
 *
 * > `hasBlob(sha256)` then `putBlob` only on miss. The same annotated screenshot
 * > attached to three sessions on one host transfers once. Chunked, resumable,
 * > rate-limited so a 4K screenshot never starves the event tail.
 *
 * §12.1 is what needs this. A screen capture happens on the machine with the
 * screen, and for a remote session the blob store is on the other end of an ssh
 * connection — so an `ImageBlock` referring to a sha the host has never seen is
 * a dangling reference, and the model request built from it fails at the point
 * where the bytes are read rather than at the point where they were missing.
 *
 * ## Redact before you transfer, not after you arrive
 *
 * §12.1's ordering guarantee is written as "the unredacted frame is never
 * written to disk". Once a capture can cross a network that sentence is no
 * longer the whole guarantee, because bytes that reach a remote host have left
 * the machine they were captured on whether or not anyone stored them. So the
 * rule this file assumes — and that `capture/client.ts` enforces — is stronger:
 * **painting happens on the machine that took the picture.** What travels here
 * is already redacted, and there is no command in this protocol that would let
 * a raw frame through instead.
 *
 * That is only possible because `content/pixels.ts` runs on plain Node. An
 * Electron-only painter would have forced the opposite pipeline, where the raw
 * frame is shipped to the host and painted there, and the credential would have
 * crossed the wire every time.
 *
 * ## Verified on commit, because a content-addressed store is poisonable
 *
 * The name of a blob is a claim about its contents, and every later reader
 * trusts it — §6.7's dedup skips the transfer entirely on a hash it already
 * has. A client that could store bytes under a hash they do not hash to would
 * make every one of those readers wrong. So the assembled bytes are hashed and
 * compared before anything is written, and a mismatch drops the staging rather
 * than storing it under either name.
 *
 * ## Staged in memory, bounded, and swept
 *
 * Partials are held in memory rather than written as `<sha>.part`, for a reason
 * worth stating: a half-written file in the blob directory is indistinguishable
 * from a complete one to anything that lists it, and the whole store is built on
 * a filename being a hash. Memory has no such ambiguity — an interrupted
 * transfer leaves nothing at all.
 *
 * The cost is that staging is attacker-controlled growth, so it is capped per
 * blob and swept by age. A client that opens a thousand transfers and finishes
 * none of them should not be able to take the host down, and this is the only
 * command in the protocol where a client chooses how much host memory to use.
 */

import { readdir, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sessionLayout, workspaceLayout, PRIVATE_DIR_MODE } from './layout.js';
import { BlobStore, extForMime, sha256Of } from './blobs.js';
import type { SessionId, Sha256 } from '@shared/types/index.js';

/**
 * The largest blob this will accept.
 *
 * §6.7's worked example is a 4K screenshot, which is a few megabytes of PNG.
 * 64 MiB leaves room for a long capture or a lossless multi-monitor grab while
 * keeping the failure mode of a runaway client bounded and legible.
 */
export const MAX_BLOB_BYTES = 64 * 1024 * 1024;

/**
 * How long an unfinished transfer is kept.
 *
 * Long enough to survive a client reconnecting and resuming — which is the case
 * "resumable" exists for — and short enough that an abandoned one is not held
 * for the life of a detached host.
 */
export const STAGING_TTL_MS = 10 * 60 * 1000;

/**
 * How much goes in one message.
 *
 * The chunk is the rate limit. §6.7 asks that a 4K screenshot "never starve the
 * event tail", and the mechanism is not a token bucket: chunks are sent one at a
 * time and awaited, so every gap between them is a point where the host's
 * pushes get the channel. A single 10 MiB message would hold it for the whole
 * write, and no amount of rate limiting *inside* that message would help.
 */
export const CHUNK_BYTES = 256 * 1024;

export class BlobTooLarge extends Error {
  constructor(size: number) {
    super(`blob exceeds the ${MAX_BLOB_BYTES}-byte limit (${size} bytes)`);
    this.name = 'BlobTooLarge';
  }
}

/**
 * A chunk that would leave a hole.
 *
 * Refused rather than zero-filled or buffered out of order. A hole filled with
 * zeroes still hashes to something, and the something is not the sha the client
 * named — so it would be caught on commit, but as a hash mismatch, which reads
 * like corruption rather than like the sequencing bug it is.
 */
export class BlobGap extends Error {
  constructor(offset: number, received: number) {
    super(`chunk at ${offset} would leave a gap; ${received} bytes received so far`);
    this.name = 'BlobGap';
  }
}

export class BlobMismatch extends Error {
  constructor(claimed: string, actual: string) {
    super(`assembled bytes hash to ${actual}, not the claimed ${claimed}`);
    this.name = 'BlobMismatch';
  }
}

interface Staged {
  parts: Buffer[];
  received: number;
  touched: number;
}

/**
 * Host-side assembly of a chunked upload.
 *
 * Deliberately knows nothing about the store or the protocol: it takes offsets
 * and buffers and hands back verified bytes. That is what lets the interesting
 * properties — gaps refused, duplicates absorbed, hashes checked, memory
 * bounded — be tested without a host, a socket, or a temp directory.
 */
export class BlobIntake {
  private readonly staging = new Map<string, Staged>();
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: { maxBytes?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxBytes = opts.maxBytes ?? MAX_BLOB_BYTES;
    this.ttlMs = opts.ttlMs ?? STAGING_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * How many bytes are staged for this hash.
   *
   * This is what makes a transfer resumable: a client that lost its connection
   * asks, and continues from the answer rather than starting again.
   */
  received(sha256: string): number {
    this.sweep();
    return this.staging.get(sha256)?.received ?? 0;
  }

  /**
   * Take one chunk, returning the new offset.
   *
   * A chunk that repeats ground already covered is absorbed rather than
   * refused. Retry-after-timeout is the ordinary way a resumable transfer
   * behaves, and a client that re-sends the last chunk because it never saw the
   * acknowledgement is doing the right thing — refusing it would turn a
   * successful retry into a failed upload.
   */
  accept(sha256: string, offset: number, chunk: Buffer): number {
    this.sweep();
    const entry = this.staging.get(sha256) ?? { parts: [], received: 0, touched: this.now() };

    if (offset > entry.received) throw new BlobGap(offset, entry.received);

    // The already-held prefix of this chunk, dropped. `offset === received` is
    // the ordinary path and skips nothing.
    const skip = entry.received - offset;
    if (skip >= chunk.length) {
      // Wholly a duplicate. Touch it so a client that is retrying does not have
      // its staging swept out from under it.
      entry.touched = this.now();
      this.staging.set(sha256, entry);
      return entry.received;
    }

    const fresh = chunk.subarray(skip);
    if (entry.received + fresh.length > this.maxBytes) {
      // Dropped, not kept at the limit. Holding 64 MiB of a transfer that can
      // never complete is the cost this cap exists to avoid.
      this.staging.delete(sha256);
      throw new BlobTooLarge(entry.received + fresh.length);
    }

    entry.parts.push(fresh);
    entry.received += fresh.length;
    entry.touched = this.now();
    this.staging.set(sha256, entry);
    return entry.received;
  }

  /**
   * Assemble and verify, returning the bytes.
   *
   * The staging is dropped either way. On success because it has been handed
   * on, and on mismatch because keeping it would let a client retry a bad
   * upload forever against a growing buffer — and because whatever it holds is
   * not what it claims to be, which is the one thing this store cannot store.
   */
  commit(sha256: string): Buffer {
    const entry = this.staging.get(sha256);
    this.staging.delete(sha256);
    const assembled = Buffer.concat(entry?.parts ?? []);

    const actual = sha256Of(assembled);
    if (actual !== sha256) throw new BlobMismatch(sha256, actual);
    return assembled;
  }

  /** Abandon a transfer. Called when a client goes away mid-upload. */
  drop(sha256: string): void {
    this.staging.delete(sha256);
  }

  /** Staged transfers, for a host reporting on itself. */
  pending(): number {
    this.sweep();
    return this.staging.size;
  }

  private sweep(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [sha, entry] of this.staging) {
      if (entry.touched < cutoff) this.staging.delete(sha);
    }
  }
}

/**
 * Whether this session already has the blob, sourcing it locally if a sibling
 * session on the same host does.
 *
 * This is where §6.7's "the same annotated screenshot attached to three sessions
 * on one host transfers once" actually comes from — and it needs the copy,
 * because attachments are stored **per session**. That is not an oversight:
 * sessions have independent lifetimes, and a shared store would mean deleting
 * one session silently breaks another session's transcript, which is a much
 * worse property than a duplicated few megabytes.
 *
 * So the copy keeps both: one transfer over the wire, independent copies on
 * disk. The lookup is only reachable by naming the hash, and in a
 * content-addressed store naming the hash means having held the content — this
 * is not a way to read a blob you could not already produce.
 */
export async function ensureBlob(
  workspaceRoot: string,
  sessionId: SessionId,
  sha256: Sha256,
  mime: string,
): Promise<boolean> {
  const target = new BlobStore(sessionLayout(workspaceRoot, sessionId).attachmentsDir);
  if (await target.has(sha256, mime)) return true;

  const source = await findInSiblings(workspaceRoot, sessionId, sha256, mime);
  if (source === null) return false;

  await mkdir(sessionLayout(workspaceRoot, sessionId).attachmentsDir, {
    recursive: true,
    mode: PRIVATE_DIR_MODE,
  });
  await copyFile(source, target.pathFor(sha256, extForMime(mime)));
  return true;
}

async function findInSiblings(
  workspaceRoot: string,
  exclude: SessionId,
  sha256: Sha256,
  mime: string,
): Promise<string | null> {
  const { sessionsDir } = workspaceLayout(workspaceRoot);
  let ids: string[];
  try {
    ids = await readdir(sessionsDir);
  } catch {
    // No sessions directory yet. An ordinary state for a fresh workspace, and
    // the answer is the same as "nobody has it".
    return null;
  }

  for (const id of ids) {
    if (id === exclude) continue;
    const candidate = join(sessionsDir, id, 'attachments', `${sha256}.${extForMime(mime)}`);
    const store = new BlobStore(join(sessionsDir, id, 'attachments'));
    if (await store.has(sha256, mime)) return candidate;
  }
  return null;
}
