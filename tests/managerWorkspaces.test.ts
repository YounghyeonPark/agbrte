/**
 * One manager, several workspaces (DESIGN.md §5.1, §8, §9, §17 Q22).
 *
 * A `SessionManager` used to be one workspace, one log, one host. The host is
 * now one per **machine** rather than one per workspace, so the manager it owns
 * holds a table of open workspaces and every session names its own through
 * `instanceId`.
 *
 * What must not change is the invariant underneath: **one log has exactly one
 * writer**. That is a property of each log, not of the manager, and N logs under
 * one manager satisfies it exactly as N managers over N logs did. These tests
 * pin down the places where a shortcut would break it — a session writing into
 * the wrong folder, a relocation in one workspace throwing away resume tokens in
 * another, a lease held in one repository blocking a write in an unrelated one —
 * and the property the change was made for: two sessions in different folders on
 * one machine can be grouped, because they are in one `sessions` map.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { sessionLayout, workspaceLayout } from '@main/store/layout.js';
import { LeaseTables } from '@main/tools/leases.js';
import type { AgentId, SessionId } from '@shared/types/index.js';

const dirs: string[] = [];
const managers: SessionManager[] = [];

async function tempDir(tag: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `agbrte-${tag}-`));
  dirs.push(dir);
  return dir;
}

/** A manager holding one workspace to start with, exactly as a host builds it. */
async function manager(root: string): Promise<SessionManager> {
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
  const made = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId: identity.instanceId,
  });
  managers.push(made);
  return made;
}

beforeEach(() => {
  dirs.length = 0;
});

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('a session picks its folder when it is created', () => {
  it('writes its log into the folder it named, not the first one the host had', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);

    const here = await m.createSession({ title: 'here', goal: 'in the first folder' });
    const there = await m.createSession({
      title: 'there',
      goal: 'in the second folder',
      workspaceRoot: second,
    });

    expect(existsSync(sessionLayout(first, here.sessionId).eventLog)).toBe(true);
    expect(existsSync(sessionLayout(second, there.sessionId).eventLog)).toBe(true);
    // The half a path-joining bug would get wrong quietly: nothing from one
    // workspace may appear in the other's store.
    expect(existsSync(sessionLayout(second, here.sessionId).dir)).toBe(false);
    expect(existsSync(sessionLayout(first, there.sessionId).dir)).toBe(false);
  });

  it('names the checkout it landed in, so nothing has to derive it from a path', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    const secondId = (await openWorkspace(second)).instanceId;

    const there = await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    // §5.2: identity is never derived from a path, so this is the field
    // everything downstream resolves the folder through.
    expect(there.instanceId).toBe(secondId);
    expect(m.workspaceOf(there).root).toBe(second);
  });

  it('loads a folder that already has sessions in it rather than refusing', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');

    // Somebody worked here before, with a different host, and left a session.
    const earlier = await manager(second);
    const old = await earlier.createSession({ title: 'yesterday', goal: 'g' });
    earlier.dispose();

    const m = await manager(first);
    await m.createSession({ title: 'today', goal: 'g', workspaceRoot: second });

    // The sessions that are there are the sessions you get.
    const onDisk = await m.listOnDisk();
    expect(onDisk.map((s) => s.sessionId)).toContain(old.sessionId);
  });

  it('lists what is on disk across every folder, saying which is which', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    const firstId = (await openWorkspace(first)).instanceId;
    const secondId = (await openWorkspace(second)).instanceId;

    const here = await m.createSession({ title: 'here', goal: 'g' });
    const there = await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    const byId = new Map((await m.listOnDisk()).map((s) => [s.sessionId, s.instanceId]));
    expect(byId.get(here.sessionId)).toBe(firstId);
    expect(byId.get(there.sessionId)).toBe(secondId);
  });

  it('resumes a session from whichever folder holds its log', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    const there = await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    // A fresh manager over both folders, as a host restart produces.
    const restarted = await manager(first);
    await restarted.addWorkspace(second);
    const back = await restarted.resumeSession(there.sessionId);

    expect(back.title).toBe('there');
    expect(back.instanceId).toBe(there.instanceId);
  });

  it('names every folder it looked in when a session is in none of them', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    await m.addWorkspace(second);

    // §13's rule about refusals: a person can only act on one that says where
    // it looked.
    const missing = '01a00000-0000-7000-8000-000000000000' as SessionId;
    await expect(m.resumeSession(missing)).rejects.toThrow(/looked in/);
    await expect(m.resumeSession(missing)).rejects.toThrow(second);
  });
});

describe('two checkouts of one repository', () => {
  it('are refused rather than aliased when the same instance turns up twice', async () => {
    const original = await tempDir('ws-a');
    const copy = await tempDir('ws-copy');
    const m = await manager(original);

    // A folder copied *including* `instance.json` — §5.3's fork. Resolving it is
    // a decision with a UI; a lookup must not make it on the way past.
    await cp(workspaceLayout(original).dir, join(copy, '.agbrte'), { recursive: true });

    await expect(m.addWorkspace(copy)).rejects.toThrow(/same one already open/);
    // Both paths in the sentence, or nobody can tell which two folders to look at.
    await expect(m.addWorkspace(copy)).rejects.toThrow(original);
  });

  it('holds a genuine clone beside the original, because it is a different checkout', async () => {
    const original = await tempDir('ws-a');
    const clone = await tempDir('ws-clone');
    const m = await manager(original);

    // A clone carries `project.json` and not `instance.json` (§5.2), so it mints
    // a new instance under the existing lineage.
    await cp(workspaceLayout(original).dir, join(clone, '.agbrte'), { recursive: true });
    await rm(join(clone, '.agbrte', 'instance.json'));

    const held = await m.addWorkspace(clone);
    expect(held.root).toBe(clone);
    expect(m.listWorkspaces()).toHaveLength(2);
  });
});

describe('a move is a fact about one folder', () => {
  it('discards the native resume token only in the workspace that moved', async () => {
    const stayed = await tempDir('ws-stay');
    const other = await tempDir('ws-other');
    const identity = await openWorkspace(stayed);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });

    // The host constructs its first workspace with the move it detected there.
    const m = new SessionManager({
      registry,
      workspaceRoot: stayed,
      instanceId: identity.instanceId,
      relocatedFrom: '/somewhere/else',
    });
    managers.push(m);

    const here = await m.createSession({ title: 'moved', goal: 'g' });
    const there = await m.createSession({ title: 'not moved', goal: 'g', workspaceRoot: other });

    // The manager-wide flag this replaced would have said both had moved, which
    // would throw away every native resume token in a folder nobody touched.
    expect(m.workspaceOf(here).relocatedFrom).toBe('/somewhere/else');
    expect(m.workspaceOf(there).relocatedFrom).toBeUndefined();
  });

  it('records the move against the folder that moved', async () => {
    const stayed = await tempDir('ws-stay');
    const identity = await openWorkspace(stayed);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
    const m = new SessionManager({
      registry,
      workspaceRoot: stayed,
      instanceId: identity.instanceId,
      relocatedFrom: '/somewhere/else',
    });
    managers.push(m);

    const session = await m.createSession({ title: 'moved', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(session.sessionId, agent.agentId as AgentId, { content: [{ type: 'text', text: 'hello' }] });

    const log = await readFile(sessionLayout(stayed, session.sessionId).eventLog, 'utf8');
    const moved = log
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as { type: string; from?: string; to?: string })
      .find((event) => event.type === 'workspace.relocated');
    expect(moved?.from).toBe('/somewhere/else');
    expect(moved?.to).toBe(stayed);
  });
});

describe('leases are one table per folder', () => {
  it('does not let a lease in one repository block a write in another', () => {
    const tables = new LeaseTables();
    const a = tables.for('/repo/a');
    const b = tables.for('/repo/b');

    expect(a).not.toBe(b);
    // The same table for the same root, however it is spelled — the sharing §9
    // requires between two agents in one workspace.
    expect(tables.for('/repo/a')).toBe(a);
    expect(tables.size).toBe(2);
  });

  it('is the same table for two agents in one workspace, which is the point', () => {
    const tables = new LeaseTables();
    const first = tables.for('/repo/a').acquire('/repo/a/src/x.ts', 'agent-1' as AgentId);
    expect(first).toEqual({ ok: true });

    const second = tables.for('/repo/a').acquire('/repo/a/src/x.ts', 'agent-2' as AgentId);
    expect(second.ok).toBe(false);

    // …and the unrelated repository is unaffected, which is the whole reason
    // this is a table per root rather than one per process.
    expect(tables.for('/repo/b').acquire('/repo/a/src/x.ts', 'agent-2' as AgentId)).toEqual({
      ok: true,
    });
  });
});

describe('a group can span folders on one machine', () => {
  it('groups two sessions in different workspaces, because they are in one map', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);

    const here = await m.createSession({ title: 'here', goal: 'g' });
    const there = await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    const grouped = await m.groupSessions([here.sessionId, there.sessionId], 'the work');

    expect(grouped.map((s) => s.group?.name)).toEqual(['the work', 'the work']);
    // One group id, so they can address each other — the thing a group is for.
    expect(new Set(grouped.map((s) => s.group?.groupId)).size).toBe(1);
    // And each half is recorded in its own log, in its own folder.
    for (const [root, session] of [
      [first, here],
      [second, there],
    ] as const) {
      const log = await readFile(sessionLayout(root, session.sessionId).eventLog, 'utf8');
      expect(log).toContain('session.joined_group');
    }
  });
});

describe('the inbox read marker stays in the workspace', () => {
  it('marks each folder, so a folder that moves carries what was read', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    await m.createSession({ title: 'here', goal: 'g' });
    await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    await m.markInboxRead(new Date('2026-08-19T10:00:00Z'));

    for (const root of [first, second]) {
      const marker = JSON.parse(
        await readFile(join(workspaceLayout(root).dir, 'inbox.json'), 'utf8'),
      ) as { readAt: string };
      expect(marker.readAt).toBe('2026-08-19T10:00:00.000Z');
    }
  });

  it('reads each session against the marker in its own workspace', async () => {
    const first = await tempDir('ws-a');
    const second = await tempDir('ws-b');
    const m = await manager(first);
    const here = await m.createSession({ title: 'here', goal: 'g' });
    await m.createSession({ title: 'there', goal: 'g', workspaceRoot: second });

    // One folder was read far in the future, the other never.
    await writeFile(
      join(workspaceLayout(first).dir, 'inbox.json'),
      JSON.stringify({ readAt: '2099-01-01T00:00:00.000Z' }),
    );

    const agent = await m.addAgent(here.sessionId, { role: 'worker', runtimeId: 'echo' });
    await m.send(here.sessionId, agent.agentId as AgentId, { content: [{ type: 'text', text: 'hello' }] });

    // Nothing in the first folder is unread; a host-wide marker would have been
    // one answer for both folders.
    const unread = (await m.inbox()).filter((entry) => entry.unread);
    expect(unread.every((entry) => entry.sessionId !== here.sessionId)).toBe(true);
  });
});
