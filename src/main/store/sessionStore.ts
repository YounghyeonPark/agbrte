/**
 * Per-session durable store (DESIGN.md §5).
 *
 * Ties together the four pieces a session needs on disk and presents the API
 * `SessionManager` uses: the append-only event log, the content-addressed blob
 * store, checkpoints, and the path codec.
 *
 * The load path is the whole point: newest usable checkpoint, then replay the
 * tail. That is what keeps opening a long session cheap while leaving the log
 * as the only source of truth.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type {
  AppendMeta,
} from './eventLog.js';
import { EventLog } from './eventLog.js';
import {
  emptyProjection,
  type EventBody,
  type InstanceId,
  type LoomEvent,
  type SessionId,
  type SessionProjection,
} from '@shared/types/index.js';
import { BlobStore } from './blobs.js';
import { PathCodec } from './pathCodec.js';
import { PRIVATE_DIR_MODE, sessionLayout, type SessionLayout } from './layout.js';
import { readLatestCheckpoint, writeCheckpoint } from './checkpoints.js';
import { reduceEvents } from './reduce.js';

/** Small enough that a crash loses little replay work, large enough to be cheap. */
export const DEFAULT_CHECKPOINT_INTERVAL = 200;

export interface SessionMeta {
  sessionId: SessionId;
  instanceId: InstanceId;
  title: string;
  goal: string;
  createdAt: string;
}

export interface LoadResult {
  projection: SessionProjection;
  /** Checkpoint seq the load started from, or null if it replayed from zero. */
  fromCheckpointSeq: number | null;
  /** Events replayed after the checkpoint — the cost the checkpoint saved. */
  replayed: number;
}

export interface OpenSessionResult {
  store: SessionStore;
  /** Bytes discarded because a previous process died mid-write (§5.1). */
  truncatedBytes: number;
}

export class SessionStore {
  readonly blobs: BlobStore;
  readonly paths: PathCodec;

  private sinceCheckpoint = 0;

  private constructor(
    readonly sessionId: SessionId,
    readonly layout: SessionLayout,
    private readonly log: EventLog,
    private readonly checkpointInterval: number,
    workspaceRoot: string,
  ) {
    this.blobs = new BlobStore(layout.attachmentsDir);
    this.paths = new PathCodec(workspaceRoot);
  }

  static async create(
    workspaceRoot: string,
    meta: SessionMeta,
    opts: { checkpointInterval?: number } = {},
  ): Promise<SessionStore> {
    const layout = sessionLayout(workspaceRoot, meta.sessionId);
    await mkdir(layout.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    await writeFile(layout.sessionFile, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

    const { log } = await EventLog.open(layout.eventLog);
    const store = new SessionStore(
      meta.sessionId,
      layout,
      log,
      opts.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
      workspaceRoot,
    );
    await store.append({ type: 'session.created', goal: meta.goal, title: meta.title });
    return store;
  }

  static async open(
    workspaceRoot: string,
    sessionId: SessionId,
    opts: { checkpointInterval?: number } = {},
  ): Promise<OpenSessionResult> {
    const layout = sessionLayout(workspaceRoot, sessionId);
    const { log, truncatedBytes } = await EventLog.open(layout.eventLog);
    return {
      store: new SessionStore(
        sessionId,
        layout,
        log,
        opts.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL,
        workspaceRoot,
      ),
      truncatedBytes,
    };
  }

  async readMeta(): Promise<SessionMeta> {
    return JSON.parse(await readFile(this.layout.sessionFile, 'utf8')) as SessionMeta;
  }

  /** Byte offset a follower mirror would resume from (§6.6). */
  get logOffset(): number {
    return this.log.byteLength;
  }

  get nextSeq(): number {
    return this.log.nextSeq;
  }

  /**
   * Notified after each durable append, for live forwarding to the UI (§7).
   *
   * A plain callback rather than an EventEmitter, and it fires *after* the
   * write, both deliberately: an emitter invites listeners that outlive the
   * store, and firing before the write would let the renderer display an event
   * that a crash then loses — the log stays the record of what happened.
   *
   * Anything this throws is swallowed. A subscriber's bug must not fail a
   * durable write.
   */
  onAppend: ((e: LoomEvent) => void) | null = null;

  async append(body: EventBody, meta: AppendMeta = {}): Promise<LoomEvent> {
    const event = await this.log.append(body, meta);
    this.sinceCheckpoint += 1;
    try {
      this.onAppend?.(event);
    } catch {
      // Forwarding is best-effort; the append already succeeded.
    }
    return event;
  }

  /**
   * Fold the session's current state. Starts from the newest usable checkpoint
   * and replays only what came after it; falls back to a full replay whenever a
   * checkpoint is absent, stale-versioned, or corrupt — which is always safe,
   * because the log is the truth and the checkpoint is only a cache.
   */
  async load(): Promise<LoadResult> {
    const checkpoint = await readLatestCheckpoint(this.layout.checkpointsDir);
    const base = checkpoint?.projection ?? emptyProjection(this.sessionId);
    const { events, skipped } = await this.log.readAll();

    // Replay from the checkpoint's seq. `reduceEvents` also skips already-folded
    // events by seq, so an off-by-one here cannot double-count.
    const tail = events.filter((e) => e.seq > base.lastSeq);
    const projection = reduceEvents(this.sessionId, tail, base, { skippedLines: skipped });

    return {
      projection,
      fromCheckpointSeq: checkpoint?.seq ?? null,
      replayed: tail.length,
    };
  }

  /** Write a checkpoint unconditionally. */
  async checkpoint(): Promise<SessionProjection> {
    const { projection } = await this.load();
    await writeCheckpoint(this.layout.checkpointsDir, projection);
    this.sinceCheckpoint = 0;
    return projection;
  }

  /** Write one only if enough events have accumulated. Returns whether it did. */
  async maybeCheckpoint(): Promise<boolean> {
    if (this.sinceCheckpoint < this.checkpointInterval) return false;
    await this.checkpoint();
    return true;
  }

  /**
   * Complete records after `fromSeq`. The renderer subscribes through this
   * rather than holding the whole log, which is what keeps a week-long session
   * from becoming a multi-gigabyte renderer heap (§7).
   */
  async readEvents(fromSeq = 0): Promise<LoomEvent[]> {
    const { events } = await this.log.readAll();
    return fromSeq === 0 ? events : events.filter((e) => e.seq > fromSeq);
  }

  /** Attach content and record it, returning the hash callers reference later. */
  async attach(data: Buffer, mime: string): Promise<{ sha256: string; deduped: boolean }> {
    const { sha256, deduped } = await this.blobs.put(data, mime);
    await this.append({ type: 'capture.attached', sha256, mime });
    return { sha256, deduped };
  }
}
