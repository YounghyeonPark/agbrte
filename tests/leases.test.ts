/**
 * File leases and stale reads (DESIGN.md §9, §15 Phase 6).
 *
 * > agents work the workspace directly under an advisory **file lease**:
 * > exclusive, time-bounded, required before write; a write to a file modified
 * > since the agent last read it is rejected with a stale-read error the agent
 * > can recover from.
 *
 * Multiple agents per session already worked. Nothing arbitrated their writes,
 * so the failure available before this was the quiet one: two agents read a
 * file, both edit it, and the second discards the first's work with every tool
 * call reporting success. Every test here is a version of that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool, readTool, writeTool, type ToolContext } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import type { AgentId } from '@shared/types/index.js';

let root: string;
let leases: WorkspaceLeases;
let clock: number;

/** Two agents on one workspace, which is the whole subject. */
const ALICE = 'agent-alice' as AgentId;
const BOB = 'agent-bob' as AgentId;

const ctxFor = (agentId: AgentId): ToolContext => ({
  workspaceRoot: root,
  signal: new AbortController().signal,
  agentId,
  leases,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-leases-'));
  clock = 1_000_000;
  leases = new WorkspaceLeases(() => clock);
  await writeFile(join(root, 'shared.ts'), 'export const v = 1;\n', 'utf8');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const read = (file: string): Promise<string> => readFile(join(root, file), 'utf8');

describe('two agents, one file', () => {
  it('refuses the second writer and says who has it', async () => {
    await writeTool.run({ file_path: 'shared.ts', content: 'alice was here\n' }, ctxFor(ALICE));

    const bob = await writeTool.run({ file_path: 'shared.ts', content: 'bob was here\n' }, ctxFor(BOB));

    expect(bob.ok).toBe(false);
    // Named, because "try again later" is not something an agent can act on and
    // "held by agent-alice until 10:32" is.
    expect(bob.summary).toContain('agent-alice');
    expect(await read('shared.ts')).toBe('alice was here\n');
  });

  it('lets the holder keep writing its own file', async () => {
    // Otherwise the first realistic turn deadlocks against itself: read, edit,
    // edit again is the normal shape of doing work.
    const a = await writeTool.run({ file_path: 'shared.ts', content: 'one\n' }, ctxFor(ALICE));
    const b = await writeTool.run({ file_path: 'shared.ts', content: 'two\n' }, ctxFor(ALICE));
    expect([a.ok, b.ok]).toEqual([true, true]);
  });

  it('hands the file over once the lease expires', async () => {
    await writeTool.run({ file_path: 'shared.ts', content: 'alice\n' }, ctxFor(ALICE));
    clock += 31_000;

    // Time-bounded, so an agent that crashed mid-turn cannot hold a file for the
    // rest of the session.
    const bob = await writeTool.run({ file_path: 'shared.ts', content: 'bob\n' }, ctxFor(BOB));
    expect(bob.ok).toBe(true);
  });

  it('hands it back when the holder is finished, without waiting for the clock', () => {
    leases.acquire(join(root, 'shared.ts'), ALICE);
    leases.releaseHeld(ALICE);
    // The expiry is a backstop for a crash. An agent that merely finished should
    // not keep a sibling out for another thirty seconds.
    expect(leases.holderOf(join(root, 'shared.ts'))).toBeNull();
  });
});

describe('writing over something you have not looked at lately', () => {
  it('refuses when the file changed since this agent read it', async () => {
    await readTool.run({ file_path: 'shared.ts' }, ctxFor(ALICE));

    // Somebody else changes it — another agent, a build step, the user.
    await writeFile(join(root, 'shared.ts'), 'export const v = 99;\n', 'utf8');

    const edit = await editTool.run(
      { file_path: 'shared.ts', old_string: 'const v = 1', new_string: 'const v = 2' },
      ctxFor(ALICE),
    );

    expect(edit.ok).toBe(false);
    expect(edit.summary).toMatch(/changed since you read it/);
    // Recoverable, and the message says how. An agent told only "failed" would
    // retry the identical edit.
    expect(edit.summary).toMatch(/read it again/i);
    expect(await read('shared.ts')).toBe('export const v = 99;\n');
  });

  it('allows the write once the agent has re-read', async () => {
    await readTool.run({ file_path: 'shared.ts' }, ctxFor(ALICE));
    await writeFile(join(root, 'shared.ts'), 'export const v = 99;\n', 'utf8');

    await readTool.run({ file_path: 'shared.ts' }, ctxFor(ALICE));
    const edit = await editTool.run(
      { file_path: 'shared.ts', old_string: 'const v = 99', new_string: 'const v = 100' },
      ctxFor(ALICE),
    );
    expect(edit.ok).toBe(true);
  });

  it('does not call an agent stale against its own write', async () => {
    // The obvious way to get this wrong: record what was read, write something
    // else, and then refuse the follow-up edit because the file no longer
    // matches the read. Every multi-step edit would fail on its second step.
    await readTool.run({ file_path: 'shared.ts' }, ctxFor(ALICE));
    await writeTool.run({ file_path: 'shared.ts', content: 'a\nb\n' }, ctxFor(ALICE));

    const edit = await editTool.run(
      { file_path: 'shared.ts', old_string: 'b', new_string: 'c' },
      ctxFor(ALICE),
    );
    expect(edit.ok).toBe(true);
    expect(await read('shared.ts')).toBe('a\nc\n');
  });

  it('lets an agent create a file it never read', async () => {
    // Staleness is only ever checked against what this agent actually read.
    // Requiring a read first would break generating a file from scratch, which
    // is most of what a worker does — and the clobber that rule might have
    // caught is prevented by the lease, which does not depend on either agent
    // having been careful.
    const made = await writeTool.run({ file_path: 'new.ts', content: 'fresh\n' }, ctxFor(ALICE));
    expect(made.ok).toBe(true);
  });

  it('keeps what an agent read across the end of a turn', () => {
    const path = join(root, 'shared.ts');
    leases.noteRead(path, ALICE, 'original');
    // A turn ends: files go back, memory does not. Clearing the ledger here
    // would turn every cross-turn edit from `stale` into `unread`, which is
    // permitted — quietly removing the protection where a long job needs it.
    leases.releaseHeld(ALICE);
    expect(leases.freshness(path, ALICE, 'changed').state).toBe('stale');
  });
});

describe('what the table is keyed by', () => {
  it('does not know about sessions at all', () => {
    /**
     * §9, verbatim: "Anyone tempted to key leases by `sessionId` should note
     * that it would silently reintroduce cross-session clobbering the moment
     * hierarchy is used."
     *
     * The table's whole surface is (path, agentId). There is nowhere for a
     * session to be passed in, which is the property being asserted — two
     * children of one tree working the same repo contend here exactly as two
     * agents in one session do, with no extra mechanism.
     */
    const path = join(root, 'shared.ts');
    expect(leases.acquire(path, ALICE).ok).toBe(true);
    // Bob might be in a different session, or a different session's child. The
    // table cannot tell, and that is the point.
    expect(leases.acquire(path, BOB).ok).toBe(false);
  });

  it('treats different paths as unrelated', () => {
    expect(leases.acquire(join(root, 'a.ts'), ALICE).ok).toBe(true);
    expect(leases.acquire(join(root, 'b.ts'), BOB).ok).toBe(true);
  });

  it('tells one agent from another when reading', () => {
    const path = join(root, 'shared.ts');
    leases.noteRead(path, ALICE, 'v1');
    // Alice's read says nothing about what Bob has seen. Sharing the ledger
    // would let one agent's read authorise another's blind overwrite.
    expect(leases.freshness(path, BOB, 'v1').state).toBe('unread');
    expect(leases.freshness(path, ALICE, 'v1').state).toBe('fresh');
  });
});
