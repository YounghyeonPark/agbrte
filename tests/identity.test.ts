import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace, peekIdentity } from '@main/store/identity.js';
import { existsSync } from 'node:fs';
import {
  assertNotInstallRoot,
  LEGACY_WORKSPACE_DIR,
  WORKSPACE_DIR,
  workspaceLayout,
} from '@main/store/layout.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agbrte-ws-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('openWorkspace', () => {
  it('creates the .agbrte tree with both identity files', async () => {
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
    const clone = await mkdtemp(join(tmpdir(), 'agbrte-clone-'));
    try {
      await cp(join(dir, '.agbrte'), join(clone, '.agbrte'), { recursive: true });
      await rm(join(clone, '.agbrte', 'instance.json'));

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

    await expect(openWorkspace(dir)).rejects.toThrow(/newer Agbrte/);
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

/**
 * The workspace directory was renamed `.devagents` → `.agbrte`, and the old name
 * is read forever rather than migrated (DESIGN.md §5.1).
 *
 * These are the tests that make "forever" mean something. A rename-on-open would
 * pass the first two and fail the third, which is the one that says a released
 * build in the wild still sees the same sessions.
 */
describe('a workspace created before the rename', () => {
  it('is opened in place, under its own name', async () => {
    const legacy = join(dir, LEGACY_WORKSPACE_DIR);
    await mkdir(join(legacy, 'sessions'), { recursive: true });
    await writeFile(
      join(legacy, 'project.json'),
      JSON.stringify({ schemaVersion: 4, lineageId: 'lin-1', displayName: 'old' }),
    );
    await writeFile(
      join(legacy, 'instance.json'),
      JSON.stringify({ instanceId: 'inst-1', createdAt: '2026-01-01T00:00:00Z' }),
    );

    const id = await openWorkspace(dir);

    expect(id.origin).toBe('existing');
    expect(id.lineageId).toBe('lin-1');
    expect(id.instanceId).toBe('inst-1');
    expect(workspaceLayout(dir).dirName).toBe(LEGACY_WORKSPACE_DIR);
  });

  it('is not renamed — the old name stays on disk', async () => {
    await mkdir(join(dir, LEGACY_WORKSPACE_DIR), { recursive: true });
    await openWorkspace(dir);

    // Both halves matter. The old directory is still there, because a detached
    // host may be appending to a log inside it; and no new one appeared beside
    // it, because two stores in one folder is worse than one with an old name.
    await expect(stat(join(dir, LEGACY_WORKSPACE_DIR))).resolves.toBeTruthy();
    expect(existsSync(join(dir, WORKSPACE_DIR))).toBe(false);
  });

  it('keeps its sessions visible to a build that only knows the old name', async () => {
    const legacy = join(dir, LEGACY_WORKSPACE_DIR);
    await mkdir(join(legacy, 'sessions', 'sess-1'), { recursive: true });
    await writeFile(join(legacy, 'sessions', 'sess-1', 'events.jsonl'), '{"seq":1}\n');

    await openWorkspace(dir);

    // The path an older release computes, byte for byte.
    expect(await readFile(join(dir, '.devagents/sessions/sess-1/events.jsonl'), 'utf8')).toBe(
      '{"seq":1}\n',
    );
  });

  it('gives a fresh folder the new name', async () => {
    await openWorkspace(dir);
    expect(workspaceLayout(dir).dirName).toBe(WORKSPACE_DIR);
    expect(existsSync(join(dir, LEGACY_WORKSPACE_DIR))).toBe(false);
  });

  it('prefers the new name when a hand-migration left both', async () => {
    await mkdir(join(dir, LEGACY_WORKSPACE_DIR), { recursive: true });
    await mkdir(join(dir, WORKSPACE_DIR), { recursive: true });
    expect(workspaceLayout(dir).dirName).toBe(WORKSPACE_DIR);
  });
});

/**
 * `~/.agbrte` is the machine's install area (§6.4) and `<workspace>/.agbrte` is
 * one workspace's data. They spell their name the same way by intent, and there
 * is exactly one path where they would be the same directory.
 */
describe('a workspace rooted at $HOME', () => {
  it('is refused by name rather than sharing a folder with the install area', () => {
    expect(() => assertNotInstallRoot(dir, dir)).toThrow(/install directory/);
    // …and it names the workspace it refused, per §13.
    expect(() => assertNotInstallRoot(dir, dir)).toThrow(dir);
  });

  it('says nothing about an ordinary project folder', () => {
    expect(() => assertNotInstallRoot(join(dir, 'project'), dir)).not.toThrow();
  });
});
