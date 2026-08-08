/**
 * `worktree` isolation (DESIGN.md §9).
 *
 * > the agent gets a `git worktree` on its own branch. Truly parallel writes;
 * > costs setup time, disk, and an explicit merge, surfaced as a checklist item.
 *
 * The other half of §9. Leases make concurrent agents *safe* in one tree by
 * making them take turns; a worktree makes them **parallel** by giving each one
 * its own checkout. Leases are the cheap default and worktrees are what you buy
 * when taking turns is the bottleneck — or when the agent cannot be trusted to
 * take turns at all, which is the case §3.10 cares about: an `all-or-nothing`
 * runtime runs its own tools outside our lease table, so the filesystem view has
 * to be the boundary.
 *
 * ## Nothing is merged automatically
 *
 * A worktree is a branch, and the merge is the user's call. §9 calls for it to
 * be "surfaced as a checklist item" and that is exactly the right shape: a
 * visible, unfinished thing rather than a silent `git merge` that either
 * conflicts at an inconvenient moment or, worse, does not and lands work nobody
 * reviewed.
 *
 * ## Refused rather than degraded
 *
 * A workspace that is not a git repository, or a host with no `git`, cannot
 * provide this. Both refuse at agent creation with the reason named. Silently
 * falling back to `shared` would be the dangerous version: an `all-or-nothing`
 * agent would then be running unarbitrated in the very workspace §3.10 refuses
 * to let it near, and the only signal would have been a mode nobody read.
 */

import { execFile } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AgentId } from '@shared/types/index.js';
import { workspaceLayout } from './store/layout.js';

const run = promisify(execFile);

export class WorktreeUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'WorktreeUnavailable';
  }
}

export interface Worktree {
  /** Where the agent works. Becomes its `AgentSpec.workspacePath`. */
  path: string;
  branch: string;
  /** The branch this was cut from, which is what a merge would target. */
  base: string;
}

/**
 * Whether this host can offer worktree isolation for this workspace.
 *
 * Two separate questions with two separate answers, because "git is not
 * installed" and "this folder is not a repository" need different fixes and a
 * combined message would send the user after the wrong one.
 */
export async function worktreeSupport(
  workspaceRoot: string,
  exec = run,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await exec('git', ['--version']);
  } catch {
    return { ok: false, reason: 'git is not installed on this host, so worktree isolation is unavailable' };
  }
  try {
    const { stdout } = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workspaceRoot });
    if (stdout.trim() !== 'true') throw new Error('not a work tree');
  } catch {
    return {
      ok: false,
      reason: `${workspaceRoot} is not a git repository, so an agent cannot be given its own worktree`,
    };
  }
  return { ok: true };
}

/**
 * Cut a worktree for one agent.
 *
 * Placed under `.devagents/` rather than beside the workspace: it is Agbrte's
 * bookkeeping, it is already the directory git is told to ignore, and putting it
 * next to the repo would litter the user's parent folder with directories they
 * did not create and will not recognise.
 */
export async function createWorktree(
  workspaceRoot: string,
  agentId: AgentId,
  exec = run,
): Promise<Worktree> {
  const support = await worktreeSupport(workspaceRoot, exec);
  if (!support.ok) throw new WorktreeUnavailable(support.reason);

  const base = await currentBranch(workspaceRoot, exec);
  const branch = `agbrte/${agentId}`;
  const root = join(workspaceLayout(workspaceRoot).devagents, 'worktrees');
  const path = join(root, agentId);

  await mkdir(root, { recursive: true });
  try {
    await exec('git', ['worktree', 'add', '-b', branch, path, base], { cwd: workspaceRoot });
  } catch (err) {
    throw new WorktreeUnavailable(`could not create a worktree: ${messageOf(err)}`);
  }
  return { path, branch, base };
}

/**
 * Remove a worktree, keeping its branch.
 *
 * The branch survives on purpose. Removing the checkout is housekeeping;
 * removing the branch would delete work that has not been merged, and this
 * function runs when an agent stops — which is not the same as its work being
 * accepted.
 */
export async function removeWorktree(
  workspaceRoot: string,
  worktree: Worktree,
  exec = run,
): Promise<void> {
  try {
    await exec('git', ['worktree', 'remove', '--force', worktree.path], { cwd: workspaceRoot });
  } catch {
    // Best effort. A worktree that will not go is a mess to clean up later, not
    // a reason to fail the turn that happened to finish next to it.
    await rm(worktree.path, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether a branch has anything the base does not. */
export async function hasCommits(
  workspaceRoot: string,
  worktree: Worktree,
  exec = run,
): Promise<boolean> {
  try {
    const { stdout } = await exec(
      'git',
      ['rev-list', '--count', `${worktree.base}..${worktree.branch}`],
      { cwd: workspaceRoot },
    );
    return Number(stdout.trim()) > 0;
  } catch {
    // Unknown, and the safe answer is "yes, look at it". Reporting no commits
    // for a branch we failed to inspect would drop a merge item for work that
    // may well exist.
    return true;
  }
}

async function currentBranch(workspaceRoot: string, exec: typeof run): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspaceRoot });
    const name = stdout.trim();
    // A detached HEAD has no name to branch from by name; the commit does.
    return name === 'HEAD' ? (await exec('git', ['rev-parse', 'HEAD'], { cwd: workspaceRoot })).stdout.trim() : name;
  } catch (err) {
    throw new WorktreeUnavailable(`could not read the current branch: ${messageOf(err)}`);
  }
}

const messageOf = (err: unknown): string =>
  err instanceof Error ? err.message.split('\n')[0] ?? err.message : String(err);
