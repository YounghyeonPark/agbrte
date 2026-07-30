import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobStore, extForMime, sha256Of } from '@main/store/blobs.js';

let dir: string;
let store: BlobStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loom-blobs-'));
  store = new BlobStore(join(dir, 'attachments'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe('BlobStore', () => {
  it('stores content under its hash and reads it back', async () => {
    const { sha256, deduped } = await store.put(PNG, 'image/png');
    expect(deduped).toBe(false);
    expect(sha256).toBe(sha256Of(PNG));
    expect(await store.get(sha256, 'image/png')).toEqual(PNG);
  });

  it('deduplicates identical content — the same capture attached twice is stored once', async () => {
    const first = await store.put(PNG, 'image/png');
    const second = await store.put(PNG, 'image/png');

    expect(second.sha256).toBe(first.sha256);
    expect(second.deduped).toBe(true);
    expect(await readdir(join(dir, 'attachments'))).toHaveLength(1);
  });

  it('gives different content different names', async () => {
    const a = await store.put(Buffer.from('one'), 'text/plain');
    const b = await store.put(Buffer.from('two'), 'text/plain');
    expect(a.sha256).not.toBe(b.sha256);
    expect(await readdir(join(dir, 'attachments'))).toHaveLength(2);
  });

  it('reports presence without reading the content', async () => {
    const { sha256 } = await store.put(PNG, 'image/png');
    expect(await store.has(sha256, 'image/png')).toBe(true);

    const absent = sha256Of(Buffer.from('never stored'));
    expect(await store.has(absent, 'image/png')).toBe(false);
  });

  it('locates a blob when the mime is unknown', async () => {
    const { sha256 } = await store.put(PNG, 'image/png');
    const found = await store.locate(sha256);
    expect(found).toContain(`${sha256}.png`);
  });

  it('returns null from locate for an unknown hash and a missing directory', async () => {
    const empty = new BlobStore(join(dir, 'does-not-exist'));
    expect(await empty.locate(sha256Of(PNG))).toBeNull();

    await store.put(PNG, 'image/png');
    expect(await store.locate(sha256Of(Buffer.from('other')))).toBeNull();
  });

  it('verifies integrity and detects tampering', async () => {
    const { sha256 } = await store.put(PNG, 'image/png');
    expect(await store.verify(sha256, 'image/png')).toBe(true);

    // A workspace that travelled over a network or sat on a shared disk.
    await writeFile(store.pathFor(sha256, 'png'), Buffer.from('corrupted'));
    expect(await store.verify(sha256, 'image/png')).toBe(false);
  });

  it('reports a missing blob as unverified rather than throwing', async () => {
    expect(await store.verify(sha256Of(PNG), 'image/png')).toBe(false);
  });

  it('maps known mimes to extensions and falls back to bin', () => {
    expect(extForMime('image/png')).toBe('png');
    expect(extForMime('audio/wav')).toBe('wav');
    expect(extForMime('application/x-unheard-of')).toBe('bin');
  });

  it('survives being moved, because nothing is path-linked', async () => {
    const { sha256 } = await store.put(PNG, 'image/png');
    const moved = await mkdtemp(join(tmpdir(), 'loom-moved-'));
    try {
      // Simulate the workspace folder moving: same bytes, different location.
      const relocated = new BlobStore(join(moved, 'attachments'));
      await relocated.put(await store.get(sha256, 'image/png'), 'image/png');
      expect(await relocated.get(sha256, 'image/png')).toEqual(PNG);
    } finally {
      await rm(moved, { recursive: true, force: true });
    }
  });
});
