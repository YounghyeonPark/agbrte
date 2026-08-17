/**
 * The raw side of a seat, kept by the owner (§3.12, §7).
 *
 * The event stream is what a CLI's output *parses to*; this is what it *was* —
 * NDJSON, update banners, deprecation notices, stderr — so a long turn can be
 * watched the way a terminal would show it.
 *
 * **It lives here rather than on the handle, and that placement is the whole
 * fix.** A handle is a turn: `SessionManager.runTurn` releases it the moment the
 * turn ends, so a tail owned by the handle was discarded exactly when somebody
 * went to read it, and every line the CLI had printed went with it. Worse, in
 * the shipped topology the handle the manager holds is a `HostBackedHandle`
 * proxying another process, which has no subprocess and never had a tail to
 * offer at all. Both disappear once the *session* keeps the lines and the
 * adapter merely reports them (`RuntimeContext.reportRaw`), because the session
 * outlives every handle and lives on the side of the boundary that answers
 * `sessions.rawLog`.
 *
 * Bounded the way the preview server log is (§6.8), with one addition it needs
 * and that one does not: a preview log dies with its process, while this now
 * lives as long as the session does, so a line cap alone is not a memory bound.
 * A single CLI line can be a megabyte of tool output, and 2,000 of those is not
 * a "tail". Three limits, therefore — per line, in total, and in count — and
 * `dropped` keeps a truncated tail honest about being truncated.
 */

import type { RawTail } from '@shared/types/index.js';

/** How many raw lines a seat keeps. */
export const RAW_TAIL_LINES = 2_000;

/**
 * How much of one line is kept.
 *
 * Clamped rather than dropped: a 4 MB tool result still has a first line worth
 * seeing, and the alternative — omitting it — reads as "the CLI never said
 * that", which is the failure `dropped` exists to prevent one level up.
 */
export const RAW_LINE_CHARS = 2_000;

/** The hard bound on one seat's tail. Roughly a screenful per line, 128 of them. */
export const RAW_TAIL_CHARS = 256_000;

/** The mark left where a clamped line was cut, so a truncation is visible. */
const CUT = '…';

export class RawTailBuffer {
  private readonly lines: string[] = [];
  private dropped = 0;
  private chars = 0;

  constructor(
    private readonly maxLines: number = RAW_TAIL_LINES,
    private readonly maxChars: number = RAW_TAIL_CHARS,
    private readonly maxLineChars: number = RAW_LINE_CHARS,
  ) {}

  push(line: string): void {
    const kept =
      line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}${CUT}` : line;
    this.lines.push(kept);
    this.chars += kept.length;

    // The count *and* the byte budget, with one line always spared: a single
    // line over the whole budget is still the newest thing that happened, and
    // evicting to empty would answer "nothing printed" to a seat that printed.
    while (
      this.lines.length > this.maxLines ||
      (this.chars > this.maxChars && this.lines.length > 1)
    ) {
      const gone = this.lines.shift() as string;
      this.chars -= gone.length;
      this.dropped += 1;
    }
  }

  /** A copy, so a caller cannot reach back into the ring. */
  tail(): RawTail {
    return { lines: [...this.lines], dropped: this.dropped };
  }

  /** Whether anything has ever been reported here. */
  get isEmpty(): boolean {
    return this.lines.length === 0 && this.dropped === 0;
  }
}
