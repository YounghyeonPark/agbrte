/**
 * Where a voice clip lives (DESIGN.md §12.4).
 *
 * > Audio kept as an attachment with its transcript, so a mis-transcription is
 * > recoverable. … Audio never traverses the transport.
 *
 * Those two pull against each other the moment a session is owned by another
 * machine, and the resolution is that **the clip stays on the client that
 * recorded it**. The strongest reading of the second sentence wins, because
 * loosening it later is easy and tightening it is not: a clip already copied to
 * a shared build box cannot be un-copied.
 *
 * ## So this store *is* the attachment
 *
 * Nothing about the audio reaches the session log. That is not an oversight —
 * `SessionManager` records the *fitted* content, which is what the agent saw and
 * what §5.4 replays on resume, so a clip in the log would be replayed to a model
 * on every rehydration. What travels is the transcript, as ordinary text the
 * user has had a chance to edit.
 *
 * The link back is here instead: sha, transcript, session, and when. "Recover a
 * mis-transcription" therefore means opening the voice history on the machine
 * you dictated from, which is the only machine that ever had the recording.
 *
 * ## Bounded, because nobody prunes an invisible directory
 *
 * A dictation store grows a few hundred kilobytes at a time and is never looked
 * at. Left alone it becomes a folder of recordings of somebody talking about
 * their own codebase, retained indefinitely for no stated reason — which is the
 * kind of thing §13 exists to be unhappy about. So it keeps a bounded number of
 * recent clips and drops the oldest, and the bound is small on purpose:
 * recoverability is about the last thing you said, not about last month.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_DIR_MODE } from '../store/layout.js';
import { sha256Of } from '../store/blobs.js';
import type { Sha256 } from '@shared/types/index.js';

/**
 * How many clips are kept.
 *
 * Enough to go back over a working session's dictation; far too few to become an
 * archive. A user who wants one of these permanently can save it; the default
 * should not quietly accumulate speech.
 */
export const MAX_CLIPS = 50;

export interface StoredClip {
  sha256: Sha256;
  transcript: string;
  durationMs: number;
  /** Which session it was dictated into, so history can be shown in context. */
  sessionId: string;
  at: string;
  /** Which engine and weights produced the transcript, so a bad one is attributable. */
  engine?: string;
  model?: string;
}

/**
 * Clips on this machine, and only this machine.
 *
 * Takes its directory rather than computing one, because the caller knows
 * whether this is a desktop client with a `userData` path or a test with a temp
 * directory — and a store that reached for `app.getPath` would import `electron`
 * and stop loading under plain Node.
 */
export class ClipStore {
  constructor(
    private readonly dir: string,
    private readonly max = MAX_CLIPS,
  ) {}

  /** Store a clip and its transcript, returning the hash that identifies it. */
  async put(
    wav: Buffer,
    meta: Omit<StoredClip, 'sha256' | 'at'> & { at?: string },
  ): Promise<StoredClip> {
    // `0700`, like everything else that may hold a transcript (§13). A recording
    // of somebody dictating about their own code is at least as sensitive as the
    // transcript it produced.
    await mkdir(this.dir, { recursive: true, mode: PRIVATE_DIR_MODE });

    const sha256 = sha256Of(wav) as Sha256;
    const clip: StoredClip = { ...meta, sha256, at: meta.at ?? new Date().toISOString() };

    await writeFile(join(this.dir, `${sha256}.wav`), wav, { mode: 0o600 });
    await writeFile(join(this.dir, `${sha256}.json`), JSON.stringify(clip, null, 2), {
      mode: 0o600,
    });

    await this.prune();
    return clip;
  }

  /** The clips this machine still holds, newest first. */
  async list(sessionId?: string): Promise<StoredClip[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      // No store yet, which is the ordinary state of a client nobody has
      // dictated on. Not an error.
      return [];
    }

    const clips: StoredClip[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        clips.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as StoredClip);
      } catch {
        // A half-written or hand-edited record. Skipped rather than fatal: one
        // bad file should not make the whole history unreadable.
      }
    }

    return clips
      .filter((c) => sessionId === undefined || c.sessionId === sessionId)
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  /** The recording itself, for playing back a transcript that came out wrong. */
  async read(sha256: Sha256): Promise<Buffer | null> {
    try {
      return await readFile(join(this.dir, `${sha256}.wav`));
    } catch {
      return null;
    }
  }

  /** Forget one, now. The user asking is the only reason needed. */
  async forget(sha256: Sha256): Promise<void> {
    await rm(join(this.dir, `${sha256}.wav`), { force: true });
    await rm(join(this.dir, `${sha256}.json`), { force: true });
  }

  /** Forget all of them. */
  async forgetAll(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  /**
   * Drop the oldest beyond the cap.
   *
   * By file time rather than by the `at` field, because `at` is written by us
   * and a store that trusted it would be confused by a clock change into keeping
   * the wrong ones — and this is a deletion, which is the direction not to be
   * clever in.
   */
  private async prune(): Promise<void> {
    const names = (await readdir(this.dir)).filter((n) => n.endsWith('.wav'));
    if (names.length <= this.max) return;

    const aged = await Promise.all(
      names.map(async (name) => ({
        name,
        at: (await stat(join(this.dir, name))).mtimeMs,
      })),
    );
    aged.sort((a, b) => a.at - b.at);

    for (const { name } of aged.slice(0, aged.length - this.max)) {
      const sha = name.replace(/\.wav$/, '') as Sha256;
      await this.forget(sha);
    }
  }
}
