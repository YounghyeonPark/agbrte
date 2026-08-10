/**
 * Getting bytes to the host that owns the session (DESIGN.md §6.7).
 *
 * §12.1's capture happens on the machine with the screen, and for a remote
 * session the blob store is at the other end of an ssh connection. Without this
 * an `ImageBlock` naming a sha the host has never seen is a dangling reference
 * that fails when the model request is *built*, well after the point where the
 * bytes were actually missing.
 *
 * Two properties carry the weight and they are tested hardest:
 *
 *  - **A commit is verified.** The name of a blob is a claim about its contents
 *    and every later reader trusts it — including §6.7's dedup, which skips the
 *    transfer entirely on a hash it already has. Bytes stored under a hash they
 *    do not hash to would make all of those readers wrong.
 *  - **Staging is bounded.** This is the only command in the protocol where a
 *    client picks how much host memory to use.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlobGap,
  BlobIntake,
  BlobMismatch,
  BlobTooLarge,
  CHUNK_BYTES,
  ensureBlob,
} from '@main/store/blobTransfer.js';
import { sha256Of } from '@main/store/blobs.js';
import { sessionLayout } from '@main/store/layout.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId, SessionId, Sha256 } from '@shared/types/index.js';

const bytes = (n: number, fill = 7): Buffer => Buffer.alloc(n, fill);

describe('assembling a chunked upload', () => {
  it('joins chunks in order and hands back the bytes', () => {
    const intake = new BlobIntake();
    const data = Buffer.from('a screenshot, notionally');
    const sha = sha256Of(data);

    expect(intake.accept(sha, 0, data.subarray(0, 10))).toBe(10);
    expect(intake.accept(sha, 10, data.subarray(10))).toBe(data.length);
    expect(intake.commit(sha).equals(data)).toBe(true);
  });

  it('refuses a chunk that would leave a hole', () => {
    /**
     * Rather than zero-filling or buffering out of order. A hole filled with
     * zeroes still hashes to *something*, so it would be caught on commit — but
     * as a hash mismatch, which reads like corruption rather than like the
     * sequencing bug it actually is.
     */
    const intake = new BlobIntake();
    intake.accept('sha', 0, bytes(10));

    expect(() => intake.accept('sha', 20, bytes(10))).toThrow(BlobGap);
  });

  it('absorbs a chunk the client re-sent, which is what makes a retry safe', () => {
    // A client whose acknowledgement was lost does the right thing by sending
    // the chunk again. Refusing it would turn a successful retry into a failed
    // upload, which is the opposite of resumable.
    const intake = new BlobIntake();
    const data = Buffer.from('0123456789abcdef');
    const sha = sha256Of(data);

    intake.accept(sha, 0, data.subarray(0, 8));
    expect(intake.accept(sha, 0, data.subarray(0, 8))).toBe(8);
    intake.accept(sha, 8, data.subarray(8));

    expect(intake.commit(sha).equals(data)).toBe(true);
  });

  it('keeps only the fresh tail of a partly-overlapping chunk', () => {
    // The overlap case the retry above only touches at the edges: a client
    // resuming from a stale offset re-sends ground already covered *and* new
    // ground in one message.
    const intake = new BlobIntake();
    const data = Buffer.from('0123456789abcdef');
    const sha = sha256Of(data);

    intake.accept(sha, 0, data.subarray(0, 10));
    // Overlaps by 4 bytes and carries 6 new ones.
    expect(intake.accept(sha, 6, data.subarray(6))).toBe(data.length);
    expect(intake.commit(sha).equals(data)).toBe(true);
  });

  it('commits an empty blob rather than treating it as nothing to do', () => {
    // Not a real screenshot, but the loop that sends it must terminate somewhere
    // and returning a hash the host was never told about is a dangling reference
    // produced by the very transfer meant to prevent one.
    const intake = new BlobIntake();
    const sha = sha256Of(Buffer.alloc(0));

    expect(intake.accept(sha, 0, Buffer.alloc(0))).toBe(0);
    expect(intake.commit(sha).length).toBe(0);
  });
});

describe('a content-addressed store is poisonable, so a commit is verified', () => {
  it('refuses bytes that do not hash to the name they were sent under', () => {
    const intake = new BlobIntake();
    intake.accept('deadbeef', 0, Buffer.from('not that at all'));

    expect(() => intake.commit('deadbeef')).toThrow(BlobMismatch);
  });

  it('drops the staging on a mismatch rather than letting it be retried', () => {
    // Keeping it would let a client retry a bad upload forever against a growing
    // buffer — and whatever it holds is not what it claims to be, which is the
    // one thing this store cannot store.
    const intake = new BlobIntake();
    intake.accept('deadbeef', 0, Buffer.from('wrong'));
    expect(() => intake.commit('deadbeef')).toThrow(BlobMismatch);

    expect(intake.received('deadbeef')).toBe(0);
  });

  it('names both hashes, because a mismatch is usually a bug and not an attack', () => {
    const intake = new BlobIntake();
    const data = Buffer.from('x');
    intake.accept('claimed', 0, data);

    expect(() => intake.commit('claimed')).toThrow(sha256Of(data));
  });
});

describe('staging is the one place a client chooses how much host memory to use', () => {
  it('refuses a blob over the cap', () => {
    const intake = new BlobIntake({ maxBytes: 100 });
    intake.accept('sha', 0, bytes(80));

    expect(() => intake.accept('sha', 80, bytes(40))).toThrow(BlobTooLarge);
  });

  it('drops the transfer rather than holding it at the limit', () => {
    // Holding 64 MiB of an upload that can never complete is exactly the cost
    // the cap exists to avoid.
    const intake = new BlobIntake({ maxBytes: 100 });
    intake.accept('sha', 0, bytes(80));
    expect(() => intake.accept('sha', 80, bytes(40))).toThrow(BlobTooLarge);

    expect(intake.received('sha')).toBe(0);
    expect(intake.pending()).toBe(0);
  });

  it('sweeps a transfer nobody finished', () => {
    let clock = 1_000;
    const intake = new BlobIntake({ ttlMs: 500, now: () => clock });
    intake.accept('sha', 0, bytes(10));
    expect(intake.pending()).toBe(1);

    clock += 501;
    expect(intake.pending()).toBe(0);
  });

  it('does not sweep a transfer that is still being retried', () => {
    // The sweep must not fire under an active client. A resumable transfer that
    // loses its staging mid-retry restarts from zero, silently and forever.
    let clock = 1_000;
    const intake = new BlobIntake({ ttlMs: 500, now: () => clock });
    const data = Buffer.from('0123456789');
    const sha = sha256Of(data);

    intake.accept(sha, 0, data.subarray(0, 5));
    clock += 400;
    // A duplicate, which is what a retry looks like — and it must count as life.
    intake.accept(sha, 0, data.subarray(0, 5));
    clock += 400;

    expect(intake.accept(sha, 5, data.subarray(5))).toBe(data.length);
  });
});

describe('the same screenshot on one host transfers once (§6.7)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-blob-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const png = Buffer.from('not really a png, but hashing does not care');
  const sha = sha256Of(png) as Sha256;

  async function plant(sessionId: string): Promise<void> {
    const dir = sessionLayout(root, sessionId as SessionId).attachmentsDir;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${sha}.png`), png);
  }

  it('says no when nobody on the host has it', async () => {
    expect(await ensureBlob(root, 'sess-a' as SessionId, sha, 'image/png')).toBe(false);
  });

  it('says yes when this session already has it', async () => {
    await plant('sess-a');
    expect(await ensureBlob(root, 'sess-a' as SessionId, sha, 'image/png')).toBe(true);
  });

  it('copies from a sibling instead of asking for the bytes again', async () => {
    /**
     * This is where §6.7's "transfers once" actually comes from, and it needs
     * the copy because attachments are stored **per session**. That is not an
     * oversight: sessions have independent lifetimes, and a shared store would
     * mean deleting one session silently breaks another one's transcript — a
     * far worse property than a duplicated few megabytes.
     *
     * So the copy keeps both: one transfer over the wire, independent copies on
     * disk.
     */
    await plant('sess-a');

    expect(await ensureBlob(root, 'sess-b' as SessionId, sha, 'image/png')).toBe(true);

    // Materialized, not merely reported. A `true` that left the target session
    // unable to read the blob would be the dangling reference this prevents.
    const landed = join(sessionLayout(root, 'sess-b' as SessionId).attachmentsDir, `${sha}.png`);
    expect((await readFile(landed)).equals(png)).toBe(true);
  });

  it('answers no on a workspace with no sessions yet', async () => {
    // An ordinary state for a fresh workspace, and the honest answer is the same
    // as "nobody has it" rather than an error about a missing directory.
    expect(await ensureBlob(root, 'sess-a' as SessionId, sha, 'image/png')).toBe(false);
  });
});

describe('over the protocol, end to end', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-blobwire-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function rig(): { connect: (role?: 'read-write' | 'read-only') => HostConnection } {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      model: 'none',
    });
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    managers.push(manager);

    const server = new SessionHostServer({
      manager,
      identity: { instanceId, lineageId: 'lin' as never, workspaceRoot: root, runtimes: ['echo'] },
    });

    return {
      connect: (role) => {
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main, ...(role !== undefined ? { role } : {}) });
      },
    };
  }

  it('transfers a blob larger than one chunk and stores it under its hash', async () => {
    const c = rig().connect();
    const session = await c.createSession({ title: 's', goal: 'g' });

    // Deliberately over `CHUNK_BYTES`, so the loop actually loops — a single
    // -chunk test would pass against an implementation that ignored `offset`.
    const data = Buffer.concat([bytes(CHUNK_BYTES, 1), bytes(4096, 2)]);
    const sha = await c.putBlob(session.sessionId, data, 'image/png');

    expect(sha).toBe(sha256Of(data));
    expect(await c.hasBlob(session.sessionId, sha, 'image/png')).toBe(true);
  });

  it('skips the transfer entirely on the second attach', async () => {
    const c = rig().connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const data = bytes(2048, 3);

    await c.putBlob(session.sessionId, data, 'image/png');
    // The dedup path: `has` answers true and no chunk is sent. Observable in the
    // log, which gains one `capture.attached` rather than two.
    await c.putBlob(session.sessionId, data, 'image/png');

    const attached = (await c.events(session.sessionId)).filter(
      (e) => e.type === 'capture.attached',
    );
    expect(attached).toHaveLength(1);
  });

  it('records the arrival in the transcript', async () => {
    // A blob that landed without a trace would be unattributable the moment
    // anybody asked where a screenshot came from — which for a screenshot is
    // the question that gets asked.
    const c = rig().connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const sha = await c.putBlob(session.sessionId, bytes(64, 9), 'image/png');

    const events = await c.events(session.sessionId);
    expect(events.some((e) => e.type === 'capture.attached' && e.sha256 === sha)).toBe(true);
  });

  it('refuses a read-only client', async () => {
    // A read-only client that can still write bytes into a session's store and
    // an event into its log is not read-only.
    const r = rig();
    const writer = r.connect();
    const session = await writer.createSession({ title: 's', goal: 'g' });

    const reader = r.connect('read-only');
    await reader.ready;
    await expect(reader.putBlob(session.sessionId, bytes(32), 'image/png')).rejects.toThrow(
      /read-only|transfer a blob/i,
    );
  });

  it('refuses a blob for a session that does not exist', async () => {
    // Rather than answering "I do not have it", which reads as "send it to me"
    // and fails on the write instead of on the question.
    const c = rig().connect();
    await c.ready;

    await expect(c.putBlob('nope' as SessionId, bytes(32), 'image/png')).rejects.toThrow(/nope/);
  });
});
