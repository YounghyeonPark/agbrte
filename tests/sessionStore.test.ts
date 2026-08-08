import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '@main/store/sessionStore.js';
import {
  CHECKPOINT_VERSION,
  listCheckpoints,
  pruneCheckpoints,
  readLatestCheckpoint,
} from '@main/store/checkpoints.js';
import { openWorkspace } from '@main/store/identity.js';
import { checkpointName } from '@main/store/layout.js';
import { newSessionId, type InstanceId, type SessionId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-store-'));
  instanceId = (await openWorkspace(root)).instanceId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function makeStore(
  sessionId: SessionId = newSessionId(),
  checkpointInterval = 5,
): Promise<SessionStore> {
  return SessionStore.create(
    root,
    { sessionId, instanceId, title: 'Test session', goal: 'do the thing', createdAt: new Date().toISOString() },
    { checkpointInterval },
  );
}

describe('SessionStore', () => {
  it('creates the session tree and records session.created', async () => {
    const store = await makeStore();
    const { projection } = await store.load();

    expect(projection.state).toBe('planning');
    expect(projection.lastSeq).toBe(1);
    expect((await store.readMeta()).goal).toBe('do the thing');
  });

  it('survives a reopen with the transcript intact — Phase 1 acceptance in miniature', async () => {
    const sessionId = newSessionId();
    const store = await makeStore(sessionId);
    await store.append({ type: 'user.turn', content: [{ type: 'text', text: 'hello' }] });
    await store.append({ type: 'agent.text', text: 'hi back' });
    await store.append({ type: 'session.state', from: 'planning', to: 'working' });

    const { store: reopened, truncatedBytes } = await SessionStore.open(root, sessionId);
    const { projection } = await reopened.load();

    expect(truncatedBytes).toBe(0);
    expect(projection.state).toBe('working');
    expect(projection.stats.turns).toBe(1);
    expect(projection.lastSeq).toBe(4);
  });

  it('writes a checkpoint only once the interval is reached', async () => {
    const store = await makeStore(newSessionId(), 3);
    expect(await store.maybeCheckpoint()).toBe(false); // 1 event so far

    await store.append({ type: 'agent.text', text: 'a' });
    await store.append({ type: 'agent.text', text: 'b' });
    expect(await store.maybeCheckpoint()).toBe(true);

    expect(await listCheckpoints(store.layout.checkpointsDir)).toHaveLength(1);
  });

  it('loads from the newest checkpoint and replays only the tail', async () => {
    const store = await makeStore(newSessionId(), 1000);
    for (let i = 0; i < 10; i += 1) {
      await store.append({ type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0.01 });
    }
    await store.checkpoint();
    await store.append({ type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0.01 });

    const { projection, fromCheckpointSeq, replayed } = await store.load();

    expect(fromCheckpointSeq).toBe(11);
    expect(replayed).toBe(1); // only the event after the checkpoint
    expect(projection.usage.inputTokens).toBe(11);
  });

  it('deleting every checkpoint loses nothing but time', async () => {
    const store = await makeStore(newSessionId(), 1000);
    for (let i = 0; i < 25; i += 1) {
      await store.append({ type: 'usage', inputTokens: 2, outputTokens: 1, cost: 0.02 });
      await store.append({ type: 'checklist.updated', itemId: `item-${i % 4}`, state: 'doing' });
    }
    await store.checkpoint();
    await store.append({ type: 'session.state', from: 'planning', to: 'verifying' });

    const withCheckpoint = await store.load();
    expect(withCheckpoint.fromCheckpointSeq).not.toBeNull();

    await rm(store.layout.checkpointsDir, { recursive: true, force: true });
    const fromScratch = await store.load();

    // The executable form of "checkpoints are derived" (§5.4 invariant 8).
    expect(fromScratch.fromCheckpointSeq).toBeNull();
    expect(fromScratch.projection).toEqual(withCheckpoint.projection);
  });

  it('ignores a checkpoint written by a different version', async () => {
    const store = await makeStore(newSessionId(), 1000);
    await store.append({ type: 'usage', inputTokens: 5, outputTokens: 5, cost: 1 });
    await store.checkpoint();

    const seqs = await listCheckpoints(store.layout.checkpointsDir);
    const path = join(store.layout.checkpointsDir, checkpointName(seqs[0] as number));
    const cp = JSON.parse(await readFile(path, 'utf8')) as { version: number };
    cp.version = CHECKPOINT_VERSION + 1;
    await writeFile(path, JSON.stringify(cp));

    const { projection, fromCheckpointSeq } = await store.load();

    // A stale shape must be replaced by a replay, never migrated in place.
    expect(fromCheckpointSeq).toBeNull();
    expect(projection.usage.inputTokens).toBe(5);
  });

  it('ignores a corrupt checkpoint rather than failing the open', async () => {
    const store = await makeStore(newSessionId(), 1000);
    await store.append({ type: 'usage', inputTokens: 7, outputTokens: 1, cost: 1 });
    await store.checkpoint();

    const seqs = await listCheckpoints(store.layout.checkpointsDir);
    await writeFile(
      join(store.layout.checkpointsDir, checkpointName(seqs[0] as number)),
      '{ not valid json',
    );

    const { projection, fromCheckpointSeq } = await store.load();
    expect(fromCheckpointSeq).toBeNull();
    expect(projection.usage.inputTokens).toBe(7);
  });

  it('falls back to an older checkpoint when the newest is unreadable', async () => {
    const store = await makeStore(newSessionId(), 1000);
    await store.append({ type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0 });
    await store.checkpoint();
    await store.append({ type: 'usage', inputTokens: 1, outputTokens: 1, cost: 0 });
    await store.checkpoint();

    const seqs = await listCheckpoints(store.layout.checkpointsDir);
    expect(seqs).toHaveLength(2);
    await writeFile(
      join(store.layout.checkpointsDir, checkpointName(seqs[1] as number)),
      'garbage',
    );

    const latest = await readLatestCheckpoint(store.layout.checkpointsDir);
    expect(latest?.seq).toBe(seqs[0]);
  });

  it('prunes old checkpoints, keeping the newest', async () => {
    const store = await makeStore(newSessionId(), 1000);
    for (let i = 0; i < 4; i += 1) {
      await store.append({ type: 'agent.text', text: `t${i}` });
      await store.checkpoint();
    }
    expect(await listCheckpoints(store.layout.checkpointsDir)).toHaveLength(4);

    const removed = await pruneCheckpoints(store.layout.checkpointsDir, 2);
    expect(removed).toBe(2);

    const remaining = await listCheckpoints(store.layout.checkpointsDir);
    expect(remaining).toHaveLength(2);
    // Pruning must never leave the load path worse off than before.
    const { projection } = await store.load();
    expect(projection.lastSeq).toBe(5);
  });

  it('recovers from a torn write and keeps appending cleanly', async () => {
    const sessionId = newSessionId();
    const store = await makeStore(sessionId);
    await store.append({ type: 'agent.text', text: 'complete' });
    await appendFile(store.layout.eventLog, '{"seq":3,"type":"agent.te');

    const { store: reopened, truncatedBytes } = await SessionStore.open(root, sessionId);
    expect(truncatedBytes).toBeGreaterThan(0);

    await reopened.append({ type: 'agent.text', text: 'after' });
    const { projection } = await reopened.load();
    expect(projection.skippedLines).toBe(0);
    expect(projection.lastSeq).toBe(3);
  });

  it('attaches a blob and records it, deduplicating a repeat', async () => {
    const store = await makeStore();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

    const first = await store.attach(png, 'image/png');
    const second = await store.attach(png, 'image/png');

    expect(second.sha256).toBe(first.sha256);
    expect(second.deduped).toBe(true);

    const { projection } = await store.load();
    expect(projection.stats.captures).toBe(2); // two references, one blob
  });

  it('reports a log offset a follower could resume from', async () => {
    const store = await makeStore();
    const before = store.logOffset;
    await store.append({ type: 'agent.text', text: 'more' });
    expect(store.logOffset).toBeGreaterThan(before);
  });

  it('encodes workspace paths portably through the store codec', async () => {
    const store = await makeStore();
    const encoded = store.paths.encode(join(root, 'src', 'index.ts'));
    expect(encoded).toEqual({ $ws: 'src/index.ts' });
  });
});
