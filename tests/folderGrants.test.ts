/**
 * Folders the agent may reach besides the workspace (DESIGN.md §17 Q24 step 6).
 *
 * What is pinned: a grant is a folder that exists, kept once, in the machine
 * directory; the tools reach a granted folder by absolute path, read and write,
 * and still refuse everywhere else; the machine directory is refused even inside
 * a granted folder — it holds the grants themselves and the keys; another
 * workspace's store inside a granted folder is not writable; the policy's
 * "inside" covers a grant; and `agbrte grant` asks the window rather than
 * granting, from the pane's own shell only.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGrant, GrantRefused, readGrants, removeGrant, sameFolder } from '../src/host/grants.js';
import { editTool, globTool, grepTool, readTool, writeTool, type ToolContext } from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import { defaultLocalPolicy, evaluatePolicy } from '@main/policy/evaluate.js';
import { grantSequence, MediaOffers, OfferFilter, offerSequence, PANE_KEY_ENV } from '@main/terminal/mediaOffers.js';
import { grant } from '../src/cli/grant.js';
import type { AgentId, ToolPolicy } from '@shared/types/index.js';

let base: string;
let workspace: string;
let other: string;
let machine: string;
let saved: string | undefined;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'agbrte-grants-'));
  workspace = join(base, 'work');
  other = join(base, 'other');
  // The machine directory inside the granted folder: a person granting their
  // home folder grants the folder `~/.agbrte` is in.
  machine = join(other, 'machine-home');
  await mkdir(join(workspace, 'src'), { recursive: true });
  await mkdir(join(other, 'docs'), { recursive: true });
  await mkdir(machine, { recursive: true });
  await writeFile(join(other, 'docs', 'notes.md'), 'remember the semicolon\n', 'utf8');
  await writeFile(join(machine, 'grants.json'), '{"folders":[]}\n', 'utf8');
  saved = process.env['AGBRTE_HOME'];
  process.env['AGBRTE_HOME'] = machine;
});

afterEach(async () => {
  if (saved === undefined) delete process.env['AGBRTE_HOME'];
  else process.env['AGBRTE_HOME'] = saved;
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function ctx(granted: string[] = []): ToolContext {
  return {
    workspaceRoot: workspace,
    signal: new AbortController().signal,
    agentId: 'agent-a' as AgentId,
    leases: new WorkspaceLeases(),
    granted,
  };
}

describe('the grant list', () => {
  it('keeps a folder that exists, once, and gives it back', async () => {
    const file = join(base, 'grants.json');
    expect(await addGrant(other, file)).toEqual([other]);
    expect(await addGrant(other, file)).toEqual([other]);
    expect(await readGrants(file)).toEqual([other]);
    expect(await removeGrant(other, file)).toEqual([]);
    expect(await removeGrant(other, file)).toEqual([]);
  });

  it('refuses a relative path, a missing folder and a file, saying which', async () => {
    const file = join(base, 'grants.json');
    await expect(addGrant('docs', file)).rejects.toThrow(GrantRefused);
    await expect(addGrant(join(base, 'nope'), file)).rejects.toThrow(/does not exist/u);
    await expect(addGrant(join(other, 'docs', 'notes.md'), file)).rejects.toThrow(/is a file/u);
  });

  it('reads a corrupt file as no grants — the agent reaches less, never more', async () => {
    const file = join(base, 'grants.json');
    await writeFile(file, '{"folders": [', 'utf8');
    expect(await readGrants(file)).toEqual([]);
    await writeFile(file, JSON.stringify({ folders: ['relative/one', other] }), 'utf8');
    expect(await readGrants(file)).toEqual([other]);
  });

  it('is one folder case-insensitively on Windows only', () => {
    expect(sameFolder('C:\\Dev\\X', 'c:\\dev\\x', 'win32')).toBe(true);
    expect(sameFolder('/home/a/X', '/home/a/x', 'linux')).toBe(false);
  });
});

describe('the tools in a granted folder', () => {
  it('refuses a folder that was not granted, and says what would open it', async () => {
    const r = await readTool.run({ file_path: join(other, 'docs', 'notes.md') }, ctx());
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/escapes the workspace/u);
  });

  it('reads and writes it by absolute path once granted', async () => {
    const c = ctx([other]);
    const read = await readTool.run({ file_path: join(other, 'docs', 'notes.md') }, c);
    expect(read.ok).toBe(true);
    expect(read.content).toContain('remember the semicolon');
    const wrote = await writeTool.run({ file_path: join(other, 'docs', 'new.md'), content: 'hi\n' }, c);
    expect(wrote.ok).toBe(true);
    expect(await readFile(join(other, 'docs', 'new.md'), 'utf8')).toBe('hi\n');
    const edited = await editTool.run(
      { file_path: join(other, 'docs', 'notes.md'), old_string: 'semicolon', new_string: 'comma' },
      c,
    );
    expect(edited.ok).toBe(true);
  });

  it('still refuses everywhere else', async () => {
    const r = await readTool.run({ file_path: join(base, 'elsewhere.txt') }, ctx([other]));
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/every folder the person granted/u);
  });

  it('never opens the machine directory, whatever holds it', async () => {
    const c = ctx([other]);
    const read = await readTool.run({ file_path: join(machine, 'grants.json') }, c);
    expect(read.ok).toBe(false);
    expect(read.summary).toMatch(/machine directory/u);
    const wrote = await writeTool.run({ file_path: join(machine, 'grants.json'), content: '{"folders":["/"]}' }, c);
    expect(wrote.ok).toBe(false);
    expect(await readFile(join(machine, 'grants.json'), 'utf8')).toBe('{"folders":[]}\n');
    // Nor does a search of the granted folder walk into it.
    const found = await globTool.run({ pattern: '**', folder: other }, c);
    expect(found.content).not.toContain('grants.json');
  });

  it('will not write another workspace’s store inside a granted folder', async () => {
    const log = join(other, 'repo', '.agbrte', 'sessions', 's1', 'events.jsonl');
    await mkdir(join(other, 'repo', '.agbrte', 'sessions', 's1'), { recursive: true });
    const r = await writeTool.run({ file_path: log, content: 'forged\n' }, ctx([other]));
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/own store/u);
  });

  it('searches a granted folder when asked, and gives its paths back whole', async () => {
    const c = ctx([other]);
    const found = await globTool.run({ pattern: '**/*.md', folder: other }, c);
    expect(found.ok).toBe(true);
    expect(found.content).toContain(join(other, 'docs', 'notes.md').split('\\').join('/'));
    const hit = await grepTool.run({ pattern: 'semicolon', folder: other }, c);
    expect(hit.content).toContain('notes.md:1');
    // And refuses to search one it was not given.
    expect((await globTool.run({ pattern: '**', folder: base }, c)).ok).toBe(false);
  });
});

describe('what no grant opens', () => {
  it('a hard link to the grants file, made inside a granted folder', async () => {
    const { linkSync } = await import('node:fs');
    const alias = join(other, 'docs', 'innocent.json');
    linkSync(join(machine, 'grants.json'), alias);
    const r = await writeTool.run({ file_path: alias, content: '{"folders":["/"]}' }, ctx([other]));
    expect(r.ok).toBe(false);
    expect(await readFile(join(machine, 'grants.json'), 'utf8')).toBe('{"folders":[]}\n');
  });

  it('a path deep in the machine directory that does not exist yet', async () => {
    const r = await writeTool.run({ file_path: join(machine, 'npm', 'bin', 'git.cmd'), content: 'x' }, ctx([other]));
    expect(r.ok).toBe(false);
  });

  it('a store’s host record or scheduler, even in the workspace', async () => {
    await mkdir(join(workspace, '.agbrte', 'run'), { recursive: true });
    await writeFile(join(workspace, '.agbrte', 'host.json'), '{"token":"t"}', 'utf8');
    const r = await readTool.run({ file_path: join('.agbrte', 'host.json') }, ctx());
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/host record/u);
    expect((await readTool.run({ file_path: join('.agbrte', 'run', 'schedules.json') }, ctx())).ok).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('a store spelled in another case on Windows', async () => {
    await mkdir(join(other, 'repo', '.AGBRTE', 'sessions'), { recursive: true });
    const r = await writeTool.run(
      { file_path: join(other, 'repo', '.AGBRTE', 'sessions', 'e.jsonl'), content: 'x' },
      ctx([other]),
    );
    expect(r.ok).toBe(false);
  });

  it('is denied by the policy for a runtime whose tools are its own, whatever a rule allows', () => {
    // Claude Code's tools never pass through `confine`; this is what they meet.
    const everything: ToolPolicy = {
      defaultAction: 'ask',
      rules: [
        { tool: 'Edit', action: 'allow' },
        { tool: 'Read', action: 'allow' },
      ],
    };
    const verdict = evaluatePolicy(everything, 'Edit', { file_path: join(machine, 'grants.json') }, {
      workspaceRoot: workspace,
      granted: [other],
    });
    expect(verdict.outcome).toBe('deny');
    expect(verdict.nonOverridable).toBe(true);
    expect(
      evaluatePolicy(everything, 'Read', { file_path: join(workspace, '.agbrte', 'host.json') }, { workspaceRoot: workspace })
        .outcome,
    ).toBe('deny');
  });
});

describe('the policy', () => {
  it('reads a granted folder as inside, where the workspace’s quiet rules apply', () => {
    const path = join(other, 'docs', 'notes.md');
    expect(evaluatePolicy(defaultLocalPolicy(), 'read', { file_path: path }, { workspaceRoot: workspace }).outcome).toBe('ask');
    expect(
      evaluatePolicy(defaultLocalPolicy(), 'read', { file_path: path }, { workspaceRoot: workspace, granted: [other] }).outcome,
    ).toBe('allow');
  });
});

describe('agbrte grant, from a pane', () => {
  const KEY = 'k'.repeat(32);

  it('asks the window, through the pane’s keyed channel, and grants nothing itself', async () => {
    const out: string[] = [];
    const code = await grant(['docs'], {
      env: { [PANE_KEY_ENV]: KEY },
      out: { write: (t: string) => out.push(t) },
      err: { write: () => undefined },
      tty: true,
      cwd: other,
    });
    expect(code).toBe(0);
    const asked: string[] = [];
    const filter = new OfferFilter(KEY, new MediaOffers(), (path) => {
      asked.push(path);
      return '[asking]';
    });
    expect(filter.write(out.join(''))).toBe('[asking]\n');
    expect(asked).toEqual([join(other, 'docs')]);
    expect(await readGrants(join(machine, 'grants.json'))).toEqual([]);
  });

  it('is refused outside the app’s tab, and into a pipe — the key would go with it', async () => {
    const err: string[] = [];
    const io = { out: { write: () => undefined }, err: { write: (t: string) => err.push(t) }, cwd: other };
    expect(await grant([], { ...io, env: {}, tty: true })).toBe(1);
    expect(await grant([], { ...io, env: { [PANE_KEY_ENV]: KEY }, tty: false })).toBe(1);
    expect(err.join('')).toMatch(/Ctrl\+Shift\+P/u);
  });

  it('does not answer a request without the pane’s key — text a program printed', () => {
    const asked: string[] = [];
    const filter = new OfferFilter(KEY, new MediaOffers(), (path) => {
      asked.push(path);
      return '';
    });
    const shown = filter.write(grantSequence('f'.repeat(32), '/'));
    expect(asked).toEqual([]);
    expect(shown).toMatch(/did not come from this terminal/u);
  });

  it('is refused where the pane cannot ask the window', () => {
    const filter = new OfferFilter(KEY, new MediaOffers());
    expect(filter.write(grantSequence(KEY, other))).toMatch(/use the palette/u);
    // And a stream request on the same channel still streams.
    expect(filter.write(offerSequence(KEY, { path: join(base, 'missing.wav'), name: 'x' }))).not.toMatch(/palette/u);
  });
});
