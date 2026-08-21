/**
 * What a seat printed, kept beside its log (§3.12, §5.1, §7).
 *
 * The event log is the transcript: what the CLI's output *parsed to*. The raw
 * tail is what it *was* — NDJSON, banners, stderr, the bytes a terminal would
 * have shown. Until now that lived only in memory, which made the two panes
 * unequal in a way nobody notices until it matters: reopen a session and the
 * chat comes back whole from the log while the CLI pane is blank, because the
 * ring died with the process that filled it.
 *
 * So the ring is mirrored to disk. **Mirrored, not appended to**: the in-memory
 * tail is already bounded three ways (`RawTailBuffer`), so a snapshot of it is
 * bounded too — a quarter of a megabyte per seat, whatever the session's age —
 * and a file that can only ever be that size needs no compaction pass to keep
 * it honest. An append-only raw log would need one, and would be a second
 * growing file beside `events.jsonl` for output that is explicitly a *tail*.
 *
 * **This is not a second transcript, and the distinction is load-bearing.** The
 * log stays the truth: resume, the §13 gate, projections and checkpoints all
 * read it and none of them read this. What restoring buys is only that the pane
 * shows the bytes that were really printed there — the objection this replaces
 * was to *inventing* terminal output by re-rendering the log, which would put
 * text on screen that nothing ever printed. Copying back what a process wrote
 * is the opposite of that.
 *
 * **What lands on disk is what the process printed**, which is the same class
 * of content the log beside it already holds — a tool result in `events.jsonl`
 * can carry whatever a command wrote too — so it is written the same way: `0600`
 * inside the session directory, under `.agbrte/`'s `0700`, and inside `sessions/`
 * which the workspace's own `.gitignore` excludes (§13). What it must never
 * become is a *new* place for a credential to appear: nothing here adds a field,
 * redacts, or reformats. It stores the bytes the seat already held in memory,
 * and it stores them nowhere a reader of the log could not already look.
 *
 * Written through a temporary name and renamed into place, unlike the log
 * beside it. The log tolerates a torn trailing line because a record is a line;
 * a snapshot is one JSON document, so a half-written one is not a shorter tail
 * but no tail at all.
 */

import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PRIVATE_DIR_MODE, sessionLayout } from './layout.js';
import type { RawTail, SessionId } from '@shared/types/index.js';

/** Where a session's raw side lives: `<session>/raw/<agent>.json`. */
export function rawTailDir(root: string, sessionId: SessionId): string {
  return join(sessionLayout(root, sessionId).dir, 'raw');
}

/**
 * The one shape an agent id may take before it becomes a filename.
 *
 * An id reaches here from the wire, and a path is the last place to find out it
 * was never checked. Anything else is skipped rather than sanitised: a name
 * that needed rewriting to be safe is not the name of a seat this host admitted.
 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function rawTailPath(root: string, sessionId: SessionId, agentId: string): string | null {
  if (!SAFE_ID.test(agentId)) return null;
  return join(rawTailDir(root, sessionId), `${agentId}.json`);
}

/** Mirror one seat's ring. Overwrites, because a snapshot has no history. */
export async function saveRawTail(
  root: string,
  sessionId: SessionId,
  agentId: string,
  tail: RawTail,
): Promise<void> {
  const path = rawTailPath(root, sessionId, agentId);
  if (path === null) return;
  const dir = rawTailDir(root, sessionId);
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  // Unique per write rather than one `.tmp`: two flushes for the same seat can
  // overlap, and sharing the scratch name is how one truncates the other's file
  // between its write and its rename.
  const scratch = `${path}.${String(process.pid)}.${String(nextScratch())}.tmp`;
  await writeFile(scratch, JSON.stringify(tail), { encoding: 'utf8', mode: 0o600 });
  await rename(scratch, path);
}

let scratchCounter = 0;
function nextScratch(): number {
  scratchCounter += 1;
  return scratchCounter;
}

/**
 * Every seat's mirrored ring for one session.
 *
 * Missing is ordinary — a session whose seats never printed, or one from before
 * this file existed — and so is an unreadable entry: the raw side is a
 * convenience, and refusing to reopen a session because a tail file was
 * corrupt would trade the transcript for the pane beside it.
 */
export async function loadRawTails(
  root: string,
  sessionId: SessionId,
): Promise<Map<string, RawTail>> {
  const dir = rawTailDir(root, sessionId);
  const found = new Map<string, RawTail>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return found;
  }

  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const agentId = name.slice(0, -'.json'.length);
    if (!SAFE_ID.test(agentId)) continue;
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as Partial<RawTail>;
      if (!Array.isArray(parsed.lines)) continue;
      const lines = parsed.lines.filter((l): l is string => typeof l === 'string');
      const dropped = typeof parsed.dropped === 'number' && parsed.dropped >= 0 ? parsed.dropped : 0;
      if (lines.length === 0 && dropped === 0) continue;
      found.set(agentId, { lines, dropped });
    } catch {
      // Unreadable or half-written: this seat has no raw side to show, which is
      // the same answer as never having printed.
    }
  }
  return found;
}
