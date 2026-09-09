/**
 * An agent may not write Agbrte's own store (DESIGN.md §5.1, §4.4, §13).
 *
 * `confine` asks whether a path is inside the workspace, and `.agbrte/` is —
 * it is the app's bookkeeping kept inside the folder the agent works in. So
 * `write` and `edit` could reach `sessions/<id>/events.jsonl`, the append-only
 * record §5.1 calls the truth; `instance.json`, the workspace's identity; and
 * `run/schedules.json`, which is what fires with nobody watching.
 *
 * That was an oversight rather than a decision: `glob` and `grep` have skipped
 * this directory since they existed, on the grounds that "walking one is
 * walking our own bookkeeping". Reading stays allowed — an agent reading its
 * own session log is a fair thing to want, and the record is worth citing.
 *
 * **`templates/` and `memory/` stay writable, and that is the point rather than
 * an exception.** §4.4 wants an agent able to propose a decomposition *by
 * writing a file*, so the whole approval argument rests on a document it can
 * write and a person can read as a diff. Skills and MCP declarations live in
 * the same directory under the same argument.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editTool, readTool, writeTool, type ToolContext } from '../src/main/tools/index.js';
import { WorkspaceLeases } from '../src/main/tools/leases.js';
import type { AgentId } from '@shared/types/index.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<{ root: string; ctx: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-storeguard-'));
  made.push(root);
  await mkdir(join(root, '.agbrte', 'sessions', 'one'), { recursive: true });
  await mkdir(join(root, '.agbrte', 'run'), { recursive: true });
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  await mkdir(join(root, '.agbrte', 'memory'), { recursive: true });
  await writeFile(join(root, '.agbrte', 'sessions', 'one', 'events.jsonl'), 'the record\n', 'utf8');
  await writeFile(join(root, '.agbrte', 'instance.json'), '{"id":"real"}', 'utf8');
  await writeFile(join(root, '.agbrte', 'run', 'schedules.json'), '{"schedules":[]}', 'utf8');
  const ctx: ToolContext = {
    workspaceRoot: root,
    agentId: 'agent-1' as AgentId,
    leases: new WorkspaceLeases(),
    signal: new AbortController().signal,
  };
  return { root, ctx };
}

const REFUSED = [
  ['the append-only record', join('.agbrte', 'sessions', 'one', 'events.jsonl')],
  ["the workspace's identity", join('.agbrte', 'instance.json')],
  ['what runs with nobody watching', join('.agbrte', 'run', 'schedules.json')],
  ['the search index', join('.agbrte', 'index', 'sessions.sqlite')],
  ['a folder from before the rename', join('.devagents', 'sessions', 'one', 'events.jsonl')],
] as const;

describe('writing into the store', () => {
  for (const [what, path] of REFUSED) {
    it(`refuses ${what}`, async () => {
      const { root, ctx } = await workspace();
      const result = await writeTool.run({ file_path: path, content: 'mine now' }, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain("Agbrte's own store");
      // And nothing happened. A refusal that wrote first would be a worse bug
      // than no refusal, because the message would say it had not.
      const on = join(root, path);
      const before = await readFile(on, 'utf8').catch(() => null);
      if (before !== null) expect(before).not.toContain('mine now');
    });
  }

  it('refuses an edit as well as a write, since both take a path', async () => {
    const { ctx } = await workspace();
    const result = await editTool.run(
      {
        file_path: join('.agbrte', 'sessions', 'one', 'events.jsonl'),
        old_string: 'the record',
        new_string: 'not any more',
      },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("Agbrte's own store");
  });

  it('refuses the store directory itself, not only files under it', async () => {
    const { ctx } = await workspace();
    const result = await writeTool.run({ file_path: join('.agbrte', 'anything'), content: 'x' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('says which parts are writable, because a bare refusal teaches nothing', async () => {
    const { ctx } = await workspace();
    const result = await writeTool.run({ file_path: join('.agbrte', 'instance.json'), content: 'x' }, ctx);
    expect(result.summary).toContain('templates');
    expect(result.summary).toContain('memory');
  });
});

describe('what stays writable', () => {
  it('lets an agent write a workflow, which §4.4 asks for by name', async () => {
    const { root, ctx } = await workspace();
    /*
     * The whole approval argument rests on this: "an agent proposes a workflow
     * by writing a file and never by starting a run", so hand-written and
     * agent-proposed documents converge on one artifact reviewed in a diff.
     * A guard that closed this would fix one directory by breaking a design.
     */
    const result = await writeTool.run(
      {
        file_path: join('.agbrte', 'templates', 'sweep.workflow.json'),
        content: '{"id":"sweep","name":"s","goal":"g","nodes":[]}',
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, '.agbrte', 'templates', 'sweep.workflow.json'), 'utf8')).toContain(
      'sweep',
    );
  });

  it('lets it write a skill and an MCP declaration, which live in the same directory', async () => {
    const { ctx } = await workspace();
    for (const name of ['commits.skill.md', 'search.mcp.json']) {
      const result = await writeTool.run(
        { file_path: join('.agbrte', 'templates', name), content: 'x' },
        ctx,
      );
      expect(result.ok, name).toBe(true);
    }
  });

  it('lets it write memory, which is content rather than bookkeeping', async () => {
    const { ctx } = await workspace();
    const result = await writeTool.run(
      { file_path: join('.agbrte', 'memory', 'how-we-deploy.md'), content: 'notes' },
      ctx,
    );
    expect(result.ok).toBe(true);
  });

  it('leaves the rest of the workspace exactly as it was', async () => {
    const { ctx } = await workspace();
    // The guard is about one directory. A file that merely *mentions* it in its
    // name is an ordinary file, and a prefix check would have caught it.
    for (const path of ['src/app.ts', '.agbrte-notes.md', 'docs/.agbrte.md']) {
      const result = await writeTool.run({ file_path: path, content: 'x' }, ctx);
      expect(result.ok, path).toBe(true);
    }
  });
});

describe('reading', () => {
  it('is untouched, because citing the record is the point of keeping one', async () => {
    const { ctx } = await workspace();
    const result = await readTool.run(
      { file_path: join('.agbrte', 'sessions', 'one', 'events.jsonl') },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.content).toContain('the record');
  });
});
