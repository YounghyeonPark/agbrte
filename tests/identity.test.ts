import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace, peekIdentity } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gilmok-ws-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openWorkspace', () => {
  it('creates the .devagents tree with both identity files', async () => {
    const id = await openWorkspace(dir, { displayName: 'acme-api' });
    const layout = workspaceLayout(dir);

    expect(id.origin).toBe('created');
    for (const p of [
      layout.projectFile,
      layout.instanceFile,
      layout.gitignoreFile,
      layout.memoryIndex,
      layout.sessionsDir,
      layout.runDir,
    ]) {
      await expect(stat(p)).resolves.toBeTruthy();
    }
  });

  it('is idempotent — reopening returns the same identity', async () => {
    const first = await openWorkspace(dir);
    const second = await openWorkspace(dir);

    expect(second.origin).toBe('existing');
    expect(second.lineageId).toBe(first.lineageId);
    expect(second.instanceId).toBe(first.instanceId);
  });

  it('excludes sessions but keeps memory in the nested gitignore', async () => {
    await openWorkspace(dir);
    const ignore = await readFile(workspaceLayout(dir).gitignoreFile, 'utf8');

    // memory/ is tracked by default and safe to commit; transcripts are not (§1).
    expect(ignore).toMatch(/^sessions\/$/m);
    expect(ignore).toMatch(/^instance\.json$/m);
    expect(ignore).not.toMatch(/^memory\/$/m);
  });

  it('a clone inherits the lineage and mints a new instance', async () => {
    // Original workspace with committed memory but, as git would leave it, no
    // instance.json — that file is gitignored (§5.2).
    const origin = await openWorkspace(dir, { displayName: 'acme-api' });
    const clone = await mkdtemp(join(tmpdir(), 'gilmok-clone-'));
    try {
      await cp(join(dir, '.devagents'), join(clone, '.devagents'), { recursive: true });
      await rm(join(clone, '.devagents', 'instance.json'));

      const cloned = await openWorkspace(clone);

      expect(cloned.origin).toBe('cloned');
      // Project memory follows the repo…
      expect(cloned.lineageId).toBe(origin.lineageId);
      // …but sessions do not, so the checkout needs its own instance.
      expect(cloned.instanceId).not.toBe(origin.instanceId);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  it('refuses a workspace written by a newer schema rather than corrupting it', async () => {
    await openWorkspace(dir);
    const layout = workspaceLayout(dir);
    const project = JSON.parse(await readFile(layout.projectFile, 'utf8')) as {
      schemaVersion: number;
    };
    project.schemaVersion = 9999;
    await writeFile(layout.projectFile, JSON.stringify(project));

    await expect(openWorkspace(dir)).rejects.toThrow(/newer Gilmok/);
  });

  it('does not overwrite an existing memory index', async () => {
    await openWorkspace(dir);
    const layout = workspaceLayout(dir);
    await writeFile(layout.memoryIndex, '# curated by hand\n');

    await openWorkspace(dir);
    expect(await readFile(layout.memoryIndex, 'utf8')).toBe('# curated by hand\n');
  });
});

describe('peekIdentity', () => {
  it('returns null for a directory that is not a workspace', async () => {
    expect(await peekIdentity(dir)).toBeNull();
  });

  it('reads identity without creating anything', async () => {
    const created = await openWorkspace(dir);
    const peeked = await peekIdentity(dir);
    expect(peeked?.lineageId).toBe(created.lineageId);
    expect(peeked?.instanceId).toBe(created.instanceId);
  });

  it('reports a missing instance as null — the relocation resolver depends on it', async () => {
    await openWorkspace(dir);
    await rm(workspaceLayout(dir).instanceFile);
    const peeked = await peekIdentity(dir);
    expect(peeked?.lineageId).toBeTruthy();
    expect(peeked?.instanceId).toBeNull();
  });
});
