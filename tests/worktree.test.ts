/**
 * `worktree` isolation (DESIGN.md §9, §15 Phase 6).
 *
 * > the agent gets a `git worktree` on its own branch. Truly parallel writes;
 * > costs setup time, disk, and an explicit merge, surfaced as a checklist item.
 *
 * Driven against **real git**, because every claim here is about what git
 * actually did: a branch that exists, a checkout at a path, commits that are
 * reachable from one ref and not another. A mocked `execFile` would test the
 * argument strings and assume the outcome, which is the half that is easy.
 *
 * The other half of §9. Leases make concurrent agents *safe* in one tree by
 * making them take turns; this makes them parallel by giving each its own.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createWorktree,
  hasCommits,
  removeWorktree,
  worktreeSupport,
  WorktreeUnavailable,
} from '@main/worktree.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AgentId, InstanceId } from '@shared/types/index.js';

/*
 * Every test in this file shells out to `git`, several of them more than once,
 * and two of them cut a worktree *and* run turns through a real manager.
 *
 * The 5-second default is a number nobody chose for that. Measured on the
 * machine this was written on, the heaviest case lands within a few hundred
 * milliseconds of the limit — so it passed most of the time and failed under any
 * load, which is the worst arrangement available: green locally, red on a
 * shared CI runner, and no signal about which. A budget generous enough that
 * only a genuine hang reaches it is the honest shape; a test that fails on a
 * busy machine is not reporting anything about the code.
 */
vi.setConfig({ testTimeout: 30_000 });

const run = promisify(execFile);

let root: string;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: root });
  return stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-wt-'));
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
  await git('add', '.');
  await git('commit', '-m', 'first');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
});

describe('cutting a worktree', () => {
  it('gives the agent its own checkout on its own branch', async () => {
    const wt = await createWorktree(root, 'agent-1' as AgentId);

    expect(wt.branch).toBe('agbrte/agent-1');
    expect(wt.base).toBe('main');
    // A real checkout with the repository's content in it, not a bare directory.
    // Trimmed because git's `core.autocrlf` rewrites line endings on checkout,
    // and the claim here is that the content arrived, not how it is terminated.
    expect((await readFile(join(wt.path, 'a.txt'), 'utf8')).trim()).toBe('one');
    expect(await git('branch', '--list', 'agbrte/agent-1')).toContain('agbrte/agent-1');
  });

  it('keeps parallel writes genuinely parallel', async () => {
    const one = await createWorktree(root, 'agent-1' as AgentId);
    const two = await createWorktree(root, 'agent-2' as AgentId);

    // The point of buying a worktree: no lease, no waiting, no clobbering,
    // because they are not the same file.
    await writeFile(join(one.path, 'a.txt'), 'from one\n', 'utf8');
    await writeFile(join(two.path, 'a.txt'), 'from two\n', 'utf8');

    expect(await readFile(join(one.path, 'a.txt'), 'utf8')).toBe('from one\n');
    expect(await readFile(join(two.path, 'a.txt'), 'utf8')).toBe('from two\n');
    // And the workspace itself is untouched by either.
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
  });

  it('lives under .agbrte rather than beside the repo', async () => {
    const wt = await createWorktree(root, 'agent-1' as AgentId);
    // Agbrte's bookkeeping belongs in the directory git is already told to
    // ignore. Beside the workspace it would litter the user's parent folder
    // with directories they did not create and will not recognise.
    expect(wt.path.replace(/\\/g, '/')).toContain('/.agbrte/worktrees/');
  });
});

describe('refusing rather than degrading', () => {
  it('refuses a workspace that is not a repository, and says which problem it is', async () => {
    const plain = await mkdtemp(join(tmpdir(), 'agbrte-plain-'));
    try {
      const support = await worktreeSupport(plain);
      expect(support.ok).toBe(false);
      // "git is not installed" and "this folder is not a repository" need
      // different fixes, so a combined message would send the user after the
      // wrong one.
      expect(support.ok === false && support.reason).toMatch(/not a git repository/);
      await expect(createWorktree(plain, 'a' as AgentId)).rejects.toThrow(WorktreeUnavailable);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it('reports a missing git separately', async () => {
    // Injected, because uninstalling git to test this is not an option.
    const noGit = (async () => {
      throw new Error('spawn git ENOENT');
    }) as never;
    const support = await worktreeSupport(root, noGit);
    expect(support.ok === false && support.reason).toMatch(/git is not installed/);
  });
});

describe('what happens to the branch', () => {
  it('survives the checkout being removed', async () => {
    const wt = await createWorktree(root, 'agent-1' as AgentId);
    await writeFile(join(wt.path, 'b.txt'), 'work\n', 'utf8');
    await run('git', ['add', '.'], { cwd: wt.path });
    await run('git', ['commit', '-m', 'agent work'], { cwd: wt.path });

    await removeWorktree(root, wt);

    // Removing a checkout is housekeeping. Removing the branch would delete work
    // nobody accepted, and an agent stopping is not its output being merged.
    expect(await git('branch', '--list', wt.branch)).toContain(wt.branch);
    expect(await git('rev-list', '--count', `main..${wt.branch}`)).toBe('1');
  });

  it('knows whether there is anything to merge', async () => {
    const wt = await createWorktree(root, 'agent-1' as AgentId);
    expect(await hasCommits(root, wt)).toBe(false);

    await writeFile(join(wt.path, 'b.txt'), 'work\n', 'utf8');
    await run('git', ['add', '.'], { cwd: wt.path });
    await run('git', ['commit', '-m', 'agent work'], { cwd: wt.path });
    expect(await hasCommits(root, wt)).toBe(true);
  });

  it('assumes there is something to merge when it cannot tell', async () => {
    const wt = await createWorktree(root, 'agent-1' as AgentId);
    const broken = (async () => {
      throw new Error('git exploded');
    }) as never;
    // Reporting "no commits" for a branch we failed to inspect would silently
    // drop a merge item for work that may well exist.
    expect(await hasCommits(root, wt, broken)).toBe(true);
  });
});

describe('through the session manager', () => {
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) {
      await m.releaseWorktrees().catch(() => undefined);
      m.dispose();
    }
  });

  function manager(): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      model: 'none',
    });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  it('points the agent at its worktree, not at the workspace', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      isolation: 'worktree',
    });

    const specs = (m as unknown as { sessions: Map<string, { specs: Map<AgentId, { workspacePath: string }> }> })
      .sessions.get(session.sessionId)!.specs;
    // §3.2: `workspacePath` is environment, resolved by whoever is adjacent to
    // the filesystem — and under this isolation it is not the workspace root.
    expect(specs.get(agent.agentId)?.workspacePath).not.toBe(root);
    expect(specs.get(agent.agentId)?.workspacePath.replace(/\\/g, '/')).toContain('/worktrees/');
  });

  it('actually isolates the runtime admission only isolates on paper', async () => {
    /**
     * The hole this closes.
     *
     * §3.10 refuses an `all-or-nothing` runtime in `shared` isolation because
     * nothing gates its calls, so the filesystem view has to be the boundary.
     * Admission enforced that and `worktree` was accepted — but nothing cut one,
     * so `workspacePath` stayed the workspace root and the agent ran in the very
     * tree the rule exists to keep it out of. Admission said contained; the
     * filesystem said otherwise, and only the admission was visible.
     */
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        id: 'coarse',
        script: [{ kind: 'stop', stop: { kind: 'end_turn' } }],
        capabilities: { permissionFidelity: 'all-or-nothing' },
      }),
      { label: 'Coarse', model: 'none' },
    );
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);

    const session = await m.createSession({ title: 's', goal: 'g' });
    // Still refused where nothing can contain it.
    await expect(
      m.addAgent(session.sessionId, { role: 'worker', runtimeId: 'coarse', isolation: 'shared' }),
    ).rejects.toThrow(/isolation/);

    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'coarse',
      isolation: 'worktree',
    });
    const specs = (
      m as unknown as { sessions: Map<string, { specs: Map<AgentId, { workspacePath: string }> }> }
    ).sessions.get(session.sessionId)!.specs;

    // And where it is allowed, it is genuinely somewhere else.
    expect(specs.get(agent.agentId)?.workspacePath).not.toBe(root);
  });

  it('puts an unmerged branch on the checklist rather than merging it', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      isolation: 'worktree',
    });

    const wt = (m as unknown as { sessions: Map<string, { worktrees: Map<AgentId, { path: string; branch: string }> }> })
      .sessions.get(session.sessionId)!.worktrees.get(agent.agentId)!;
    await writeFile(join(wt.path, 'b.txt'), 'work\n', 'utf8');
    await run('git', ['add', '.'], { cwd: wt.path });
    await run('git', ['commit', '-m', 'agent work'], { cwd: wt.path });

    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    const checklist = (await m.projection(session.sessionId)).checklist;
    expect(checklist.map((i) => i.text)).toContainEqual(expect.stringContaining('merge agbrte/'));
    // Nothing was merged. An automatic `git merge` either conflicts at an
    // inconvenient moment or, worse, does not — and lands work nobody reviewed.
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await git('rev-list', '--count', 'main')).toBe('1');
  });

  it('adds one merge item however many turns the agent takes', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      isolation: 'worktree',
    });
    const wt = (m as unknown as { sessions: Map<string, { worktrees: Map<AgentId, { path: string }> }> })
      .sessions.get(session.sessionId)!.worktrees.get(agent.agentId)!;
    await writeFile(join(wt.path, 'b.txt'), 'work\n', 'utf8');
    await run('git', ['add', '.'], { cwd: wt.path });
    await run('git', ['commit', '-m', 'agent work'], { cwd: wt.path });

    for (let i = 0; i < 3; i += 1) {
      await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    }

    // A five-turn agent contributes one line, not five.
    const merges = (await m.projection(session.sessionId)).checklist.filter((i) =>
      i.text.startsWith('merge '),
    );
    expect(merges).toHaveLength(1);
  });

  it('says nothing about a branch with no commits on it', async () => {
    const m = manager();
    const session = await m.createSession({ title: 's', goal: 'g' });
    const agent = await m.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'echo',
      isolation: 'worktree',
    });
    await m.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });

    // An agent that wrote nothing leaves nothing to merge, and a checklist item
    // for it would be a permanent unfinished task with no work behind it.
    expect((await m.projection(session.sessionId)).checklist).toEqual([]);
  });
});
