/**
 * The append-only event log (DESIGN.md §5.1, §6.6).
 *
 * `events.jsonl` is the source of truth for a session. Everything else —
 * checkpoints, the SQLite index, the dashboard, a remote workspace's local
 * mirror — is derived and disposable.
 *
 * Four properties this file exists to guarantee:
 *
 *  1. **Append-only.** Records are never rewritten or reordered. The one
 *     exception is documented on `open()` below and is not a record edit.
 *  2. **Crash safety.** A process killed mid-write leaves a partial final
 *     line; readers discard it rather than failing.
 *  3. **`seq` orders events, not timestamps.** A transcript can span machines
 *     whose clocks differ by tens of seconds (§5.4d).
 *  4. **Byte-offset resumability.** `parseWholeLines` lets a follower mirror
 *     resume at an exact offset with zero loss and zero duplication (§6.6),
 *     which is what makes remote sessions survive a dropped connection.
 */

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat, truncate } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  newEventId,
  type Actor,
  type EventBody,
  type EventOrigin,
  type AgbrteEvent,
} from '@shared/types/index.js';
import { PRIVATE_DIR_MODE } from './layout.js';

export interface ParseResult {
  events: AgbrteEvent[];
  /**
   * Bytes consumed — always ends on a newline, so a caller can persist this
   * offset and resume exactly. Never includes a partial trailing line.
   */
  consumed: number;
  /** Mid-file lines that failed to parse. Non-zero means real corruption. */
  skipped: number;
}

/**
 * Parse only whole lines from a buffer, retaining any partial trailing line
 * for the next chunk. This is the mirror's workhorse (§6.6) and the reader's
 * torn-tail defense in one function.
 *
 * A malformed line in the *middle* of a file is corruption rather than a torn
 * write, so it is skipped and counted instead of throwing — one bad line must
 * not make a session unopenable — and the caller is expected to surface it.
 */
export function parseWholeLines(buf: Buffer): ParseResult {
  const lastNewline = buf.lastIndexOf(0x0a); // '\n'
  if (lastNewline === -1) return { events: [], consumed: 0, skipped: 0 };

  const consumed = lastNewline + 1;
  const text = buf.subarray(0, consumed).toString('utf8');

  const events: AgbrteEvent[] = [];
  let skipped = 0;

  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as AgbrteEvent);
    } catch {
      skipped += 1;
    }
  }

  return { events, consumed, skipped };
}

/** Incremental parser for a stream of chunks arriving at arbitrary boundaries. */
export class LineAccumulator {
  // Explicitly widened: `Buffer.alloc` yields Buffer<ArrayBuffer>, while
  // `subarray` on a stream chunk yields Buffer<ArrayBufferLike>.
  private remainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private consumedTotal = 0;
  private skippedTotal = 0;

  push(chunk: Buffer): AgbrteEvent[] {
    const buf = this.remainder.length === 0 ? chunk : Buffer.concat([this.remainder, chunk]);
    const { events, consumed, skipped } = parseWholeLines(buf);
    this.remainder = buf.subarray(consumed);
    this.consumedTotal += consumed;
    this.skippedTotal += skipped;
    return events;
  }

  /** Byte offset of the end of the last complete line seen. */
  get offset(): number {
    return this.consumedTotal;
  }

  get skipped(): number {
    return this.skippedTotal;
  }

  /** Bytes held back as an incomplete line. Non-zero at EOF means a torn tail. */
  get pending(): number {
    return this.remainder.length;
  }
}

export interface AppendMeta {
  agentId?: AgbrteEvent['agentId'];
  origin?: EventOrigin;
  clockSkewMs?: number;
  /** Set only for events a person caused. See `EventEnvelope.actor`. */
  actor?: Actor;
  /** Injectable for deterministic tests. */
  now?: () => Date;
}

export interface OpenResult {
  log: EventLog;
  /** Bytes removed because the previous process died mid-write. */
  truncatedBytes: number;
  /** Mid-file unparseable lines found while scanning. */
  skipped: number;
}

export class EventLog {
  private constructor(
    readonly path: string,
    private seq: number,
    private bytes: number,
  ) {}

  /**
   * Open for append, scanning to recover `seq` and the byte length.
   *
   * **A torn trailing line is truncated here.** Readers tolerate one, but a
   * writer must not append after it — that would leave a permanently corrupt
   * record wedged in the middle of the file. Removing bytes that were never a
   * complete record is not an edit to the append-only history.
   *
   * The scan is O(file). Checkpoints (§5.1) will make this O(1) for large
   * logs; at Phase 1 sizes the simple version is correct and fast enough.
   */
  static async open(path: string): Promise<OpenResult> {
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });

    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      // Missing file: create it empty so appends and tails agree on offset 0.
      const fh = await open(path, 'a');
      await fh.close();
      return { log: new EventLog(path, 1, 0), truncatedBytes: 0, skipped: 0 };
    }

    const acc = new LineAccumulator();
    let maxSeq = 0;

    await new Promise<void>((resolveScan, rejectScan) => {
      const stream = createReadStream(path);
      stream.on('data', (chunk) => {
        for (const ev of acc.push(chunk as Buffer)) {
          if (typeof ev.seq === 'number' && ev.seq > maxSeq) maxSeq = ev.seq;
        }
      });
      stream.on('end', () => resolveScan());
      stream.on('error', rejectScan);
    });

    let truncatedBytes = 0;
    if (acc.pending > 0) {
      truncatedBytes = size - acc.offset;
      await truncate(path, acc.offset);
    }

    return {
      log: new EventLog(path, maxSeq + 1, acc.offset),
      truncatedBytes,
      skipped: acc.skipped,
    };
  }

  get nextSeq(): number {
    return this.seq;
  }

  /** Byte length of complete records — the offset a mirror would resume from. */
  get byteLength(): number {
    return this.bytes;
  }

  /**
   * Append one record. Serialized as a single write so a crash can only ever
   * produce a partial *trailing* line, which `open()` and readers both handle.
   */
  async append(body: EventBody, meta: AppendMeta = {}): Promise<AgbrteEvent> {
    const now = meta.now ?? (() => new Date());
    const event = {
      id: newEventId(),
      seq: this.seq,
      at: now().toISOString(),
      ...(meta.clockSkewMs !== undefined ? { clockSkewMs: meta.clockSkewMs } : {}),
      ...(meta.agentId !== undefined ? { agentId: meta.agentId } : {}),
      ...(meta.actor !== undefined ? { actor: meta.actor } : {}),
      ...(meta.origin !== undefined ? { origin: meta.origin } : {}),
      ...body,
    } as AgbrteEvent;

    const line = `${JSON.stringify(event)}\n`;
    await appendFile(this.path, line, 'utf8');

    this.seq += 1;
    this.bytes += Buffer.byteLength(line, 'utf8');
    return event;
  }

  /** Read every complete record. */
  async readAll(): Promise<{ events: AgbrteEvent[]; skipped: number }> {
    return this.readFrom(0);
  }

  /** Read complete records from a byte offset — the mirror's resume path. */
  async readFrom(offset: number): Promise<{ events: AgbrteEvent[]; skipped: number }> {
    const acc = new LineAccumulator();
    const events: AgbrteEvent[] = [];

    await new Promise<void>((resolveRead, rejectRead) => {
      const stream = createReadStream(this.path, { start: offset });
      stream.on('data', (chunk) => {
        events.push(...acc.push(chunk as Buffer));
      });
      stream.on('end', () => resolveRead());
      stream.on('error', rejectRead);
    });

    return { events, skipped: acc.skipped };
  }
}
