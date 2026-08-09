/**
 * The tool suite's own defenses (DESIGN.md §3.7, §13).
 *
 * The permission gate decides *whether* a call runs; these tests cover what a
 * call can reach once allowed. That separation is deliberate — the gate is
 * policy, which a user can widen, while confinement is a property of the tool.
 * A policy mistake must not become a filesystem escape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_TOOLS,
  bashTool,
  editTool,
  globTool,
  grepTool,
  readTool,
  toolByName,
  writeTool,
  type ToolContext,
} from '@main/tools/index.js';
import { WorkspaceLeases } from '@main/tools/leases.js';
import type { AgentId } from '@shared/types/index.js';

let root: string;
let ctx: ToolContext;
let leases: WorkspaceLeases;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-tools-'));
  leases = new WorkspaceLeases();
  ctx = {
    workspaceRoot: root,
    signal: new AbortController().signal,
    agentId: 'agent-a' as AgentId,
    leases,
  };
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\nconst secret = 2;\n', 'utf8');
  await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;\n', 'utf8');
  await writeFile(join(root, 'README.md'), '# Title\n', 'utf8');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('confinement — refused by the tool, not only by policy', () => {
  const escapes = [
    '../outside.txt',
    '../../etc/passwd',
    'src/../../escape.txt',
    resolve('/etc/hosts'),
  ];

  for (const path of escapes) {
    it(`read refuses ${path}`, async () => {
      const result = await readTool.run({ file_path: path }, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/escapes the workspace/);
    });

    it(`write refuses ${path}`, async () => {
      const result = await writeTool.run({ file_path: path, content: 'x' }, ctx);
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/escapes the workspace/);
    });
  }

  it('allows a path that traverses but stays inside', async () => {
    const result = await readTool.run({ file_path: 'src/../README.md' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-string or empty path rather than coercing it', async () => {
    expect((await readTool.run({ file_path: 42 }, ctx)).ok).toBe(false);
    expect((await readTool.run({ file_path: '' }, ctx)).ok).toBe(false);
    expect((await readTool.run({}, ctx)).ok).toBe(false);
  });
});

describe('read', () => {
  it('returns 1-indexed numbered lines', async () => {
    const result = await readTool.run({ file_path: 'src/a.ts' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('1\texport const a = 1;');
    expect(result.content).toContain('2\tconst secret = 2;');
  });

  it('reports a missing file as an error, not an exception', async () => {
    const result = await readTool.run({ file_path: 'nope.ts' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/could not read/);
  });

  it('truncates a large file with an explicit notice', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(50_000), 'utf8');
    const result = await readTool.run({ file_path: 'big.txt' }, ctx);
    // A 7B model with a 32k window drowns in unbounded output, and the failure
    // looks like the model being stupid rather than the harness being careless.
    expect(result.content).toMatch(/\[truncated — \d+ more characters/);
    expect(result.content.length).toBeLessThan(20_000);
  });
});

describe('write', () => {
  it('creates parent directories', async () => {
    const result = await writeTool.run({ file_path: 'deep/nested/x.ts', content: 'hi' }, ctx);
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'deep', 'nested', 'x.ts'), 'utf8')).toBe('hi');
  });

  it('overwrites an existing file', async () => {
    await writeTool.run({ file_path: 'README.md', content: 'replaced' }, ctx);
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('replaced');
  });

  it('requires content to be a string', async () => {
    expect((await writeTool.run({ file_path: 'x.ts', content: 5 }, ctx)).ok).toBe(false);
  });
});

describe('edit', () => {
  it('replaces a unique occurrence', async () => {
    const result = await editTool.run(
      { file_path: 'src/b.ts', old_string: 'const b = 2', new_string: 'const b = 3' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await readFile(join(root, 'src', 'b.ts'), 'utf8')).toContain('const b = 3');
  });

  it('refuses an ambiguous edit rather than guessing which match to take', async () => {
    await writeFile(join(root, 'dup.ts'), 'let x = 1;\nlet x = 1;\n', 'utf8');
    const result = await editTool.run(
      { file_path: 'dup.ts', old_string: 'let x = 1;', new_string: 'let y = 1;' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/appears 2 times; make it unique/);
    // The file must be untouched when the edit is refused.
    expect(await readFile(join(root, 'dup.ts'), 'utf8')).toBe('let x = 1;\nlet x = 1;\n');
  });

  it('reports a missing old_string', async () => {
    const result = await editTool.run(
      { file_path: 'src/b.ts', old_string: 'absent', new_string: 'x' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/not found/);
  });
});

describe('glob', () => {
  it('matches workspace-relative paths with POSIX separators', async () => {
    const result = await globTool.run({ pattern: 'src/*.ts' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/a.ts');
    expect(result.content).toContain('src/b.ts');
    expect(result.content).not.toContain('README.md');
  });

  it('reports no matches plainly', async () => {
    const result = await globTool.run({ pattern: '*.rs' }, ctx);
    expect(result.content).toBe('(no matches)');
  });

  it('skips noise directories', async () => {
    await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(root, 'node_modules', 'pkg', 'index.ts'), 'x', 'utf8');
    const result = await globTool.run({ pattern: '*' }, ctx);
    expect(result.content).not.toContain('node_modules');
  });
});

describe('grep', () => {
  it('returns path, line number, and matching line', async () => {
    const result = await grepTool.run({ pattern: 'secret' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toMatch(/src\/a\.ts:2: const secret = 2;/);
  });

  it('restricts the search with path_glob', async () => {
    const result = await grepTool.run({ pattern: 'export', path_glob: 'src/b.ts' }, ctx);
    expect(result.content).toContain('src/b.ts');
    expect(result.content).not.toContain('src/a.ts');
  });

  it('reports an invalid regular expression instead of throwing', async () => {
    const result = await grepTool.run({ pattern: '([unclosed' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/invalid regular expression/);
  });
});

describe('bash', () => {
  it('runs a command and reports the exit code', async () => {
    const result = await bashTool.run({ command: 'node -e "console.log(2+2)"' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('4');
    expect(result.content).toContain('exit 0');
  });

  it('reports a non-zero exit as not ok', async () => {
    const result = await bashTool.run({ command: 'node -e "process.exit(3)"' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toContain('exit 3');
  });

  it('runs in the workspace directory', async () => {
    const result = await bashTool.run({ command: 'node -e "console.log(process.cwd())"' }, ctx);
    expect(result.content.toLowerCase()).toContain(root.toLowerCase().slice(-12));
  });

  it('does not hand the agent credentials it never needed', async () => {
    const result = await bashTool.run(
      { command: 'node -e "console.log(JSON.stringify(process.env.ANTHROPIC_API_KEY ?? null))"' },
      ctx,
    );
    // §13 keeps secrets out of the agent's reach; a shell command inherits an
    // emptied value rather than whatever the host happened to have.
    expect(result.content).toMatch(/""|null/);
  });

  it('captures stderr alongside stdout', async () => {
    const result = await bashTool.run({ command: 'node -e "console.error(\'to stderr\')"' }, ctx);
    expect(result.content).toContain('to stderr');
  });
});

describe('the suite', () => {
  it('exposes the tools AgbrteHarness offers, resolvable case-insensitively', () => {
    expect(DEFAULT_TOOLS.map((t) => t.name)).toEqual([
      'read',
      'write',
      'edit',
      'glob',
      'grep',
      'bash',
      'message',
      'propose_split',
      'screenshot',
    ]);
    expect(toolByName(DEFAULT_TOOLS, 'READ')).toBe(readTool);
    expect(toolByName(DEFAULT_TOOLS, 'nope')).toBeUndefined();
  });

  it('gives every tool a schema that names its required arguments', () => {
    for (const tool of DEFAULT_TOOLS) {
      const schema = tool.schema as { type: string; required?: string[]; additionalProperties?: boolean };
      expect(schema.type).toBe('object');
      expect(schema.required?.length).toBeGreaterThan(0);
      // Strict schemas are what let a small model produce valid arguments.
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
