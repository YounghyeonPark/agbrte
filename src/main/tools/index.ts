/**
 * The canonical tool suite (DESIGN.md §3.7).
 *
 * `AgbrteHarness` supplies these to any model provider, because a raw endpoint has
 * no tools of its own. One canonical schema set, degraded per target (§3.5).
 *
 * ## Two defenses, deliberately
 *
 * The permission gate (§13) decides *whether* a call may run. These
 * implementations additionally confine *what* it can reach: every path is
 * resolved and checked against the workspace root before any filesystem call.
 * That is not redundant — the gate is policy, which a user can widen, while this
 * is a property of the tool. A policy mistake should not become a filesystem
 * escape.
 *
 * Output is capped. A 7B model with a 32k window drowns in an unbounded `grep`
 * result, and the failure looks like the model being stupid rather than the
 * harness being careless.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { globMatch, isInsideWorkspace } from '../policy/evaluate.js';

export interface ToolContext {
  workspaceRoot: string;
  signal: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  /** Short line for the transcript and the dashboard. */
  summary: string;
  /** Full payload handed back to the model, already truncated. */
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  /** Canonical JSON Schema, before per-target degradation. */
  schema: object;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT = 8_000;
const MAX_FILES_SCANNED = 4_000;
const MAX_MATCHES = 100;
const BASH_TIMEOUT_MS = 60_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  const kept = text.slice(0, MAX_OUTPUT);
  return `${kept}\n\n[truncated — ${text.length - MAX_OUTPUT} more characters. Narrow the request.]`;
}

function fail(summary: string): ToolResult {
  return { ok: false, summary, content: summary };
}

/** Resolve a model-supplied path, refusing anything outside the workspace. */
function confine(ctx: ToolContext, raw: unknown): { path: string } | { error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: 'path must be a non-empty string' };
  }
  const abs = resolve(ctx.workspaceRoot, raw);
  if (!isInsideWorkspace(ctx.workspaceRoot, abs)) {
    // Refused by the tool, not only by policy — see the header.
    return { error: `path escapes the workspace: ${raw}` };
  }
  return { path: abs };
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'out', 'coverage', '.devagents']);

/** Depth-first walk of the workspace, bounded and skipping noise directories. */
async function walk(root: string, signal: AbortSignal): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];

  while (queue.length > 0 && found.length < MAX_FILES_SCANNED) {
    if (signal.aborted) break;
    const dir = queue.pop() as string;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(full);
      } else if (entry.isFile()) {
        found.push(full);
      }
    }
  }
  return found;
}

const toPosixRel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');

export const readTool: ToolDefinition = {
  name: 'read',
  description:
    'Read a UTF-8 text file from the workspace. Returns the file contents with 1-indexed line numbers.',
  schema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'Workspace-relative path' } },
    required: ['file_path'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const c = confine(ctx, args['file_path']);
    if ('error' in c) return fail(c.error);
    try {
      const text = await readFile(c.path, 'utf8');
      const numbered = text
        .split('\n')
        .map((line, i) => `${i + 1}\t${line}`)
        .join('\n');
      return {
        ok: true,
        summary: `read ${toPosixRel(ctx.workspaceRoot, c.path)} (${text.length} chars)`,
        content: truncate(numbered),
      };
    } catch (err) {
      return fail(`could not read: ${(err as Error).message}`);
    }
  },
};

export const writeTool: ToolDefinition = {
  name: 'write',
  description: 'Create or overwrite a file in the workspace with the given contents.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Workspace-relative path' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const c = confine(ctx, args['file_path']);
    if ('error' in c) return fail(c.error);
    const content = args['content'];
    if (typeof content !== 'string') return fail('content must be a string');
    try {
      await mkdir(dirname(c.path), { recursive: true });
      await writeFile(c.path, content, 'utf8');
      const rel = toPosixRel(ctx.workspaceRoot, c.path);
      return { ok: true, summary: `wrote ${rel} (${content.length} chars)`, content: `Wrote ${rel}.` };
    } catch (err) {
      return fail(`could not write: ${(err as Error).message}`);
    }
  },
};

export const editTool: ToolDefinition = {
  name: 'edit',
  description:
    'Replace an exact string in a file. The old string must appear exactly once, or the edit is refused.',
  schema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const c = confine(ctx, args['file_path']);
    if ('error' in c) return fail(c.error);
    const oldStr = args['old_string'];
    const newStr = args['new_string'];
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      return fail('old_string and new_string must be strings');
    }
    try {
      const text = await readFile(c.path, 'utf8');
      const occurrences = text.split(oldStr).length - 1;
      // Ambiguity is refused rather than guessed: a model that mis-locates an
      // edit should be told, not have one of several matches picked for it.
      if (occurrences === 0) return fail('old_string not found');
      if (occurrences > 1) return fail(`old_string appears ${occurrences} times; make it unique`);
      await writeFile(c.path, text.replace(oldStr, newStr), 'utf8');
      const rel = toPosixRel(ctx.workspaceRoot, c.path);
      return { ok: true, summary: `edited ${rel}`, content: `Edited ${rel}.` };
    } catch (err) {
      return fail(`could not edit: ${(err as Error).message}`);
    }
  },
};

export const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files whose workspace-relative path matches a glob pattern (* and ? supported), e.g. "src/**" or "*.ts".',
  schema: {
    type: 'object',
    properties: { pattern: { type: 'string' } },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string') return fail('pattern must be a string');
    const files = await walk(ctx.workspaceRoot, ctx.signal);
    const matches = files
      .map((f) => toPosixRel(ctx.workspaceRoot, f))
      .filter((rel) => globMatch(pattern, rel) || globMatch(pattern, `./${rel}`))
      .sort();
    return {
      ok: true,
      summary: `glob ${pattern} → ${matches.length} file(s)`,
      content: truncate(matches.length === 0 ? '(no matches)' : matches.join('\n')),
    };
  },
};

export const grepTool: ToolDefinition = {
  name: 'grep',
  description: 'Search workspace file contents for a regular expression. Returns matching lines with paths.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path_glob: { type: 'string', description: 'Optional glob to restrict which files are searched' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const pattern = args['pattern'];
    if (typeof pattern !== 'string') return fail('pattern must be a string');
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return fail(`invalid regular expression: ${(err as Error).message}`);
    }
    const restrict = typeof args['path_glob'] === 'string' ? (args['path_glob'] as string) : null;

    const files = await walk(ctx.workspaceRoot, ctx.signal);
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= MAX_MATCHES) break;
      const rel = toPosixRel(ctx.workspaceRoot, file);
      if (restrict && !globMatch(restrict, rel)) continue;
      let text: string;
      try {
        if ((await stat(file)).size > 2_000_000) continue;
        text = await readFile(file, 'utf8');
      } catch {
        continue; // binary or unreadable
      }
      text.split('\n').forEach((line, i) => {
        if (hits.length < MAX_MATCHES && re.test(line)) {
          hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
    return {
      ok: true,
      summary: `grep ${pattern} → ${hits.length} match(es)`,
      content: truncate(hits.length === 0 ? '(no matches)' : hits.join('\n')),
    };
  },
};

export const bashTool: ToolDefinition = {
  name: 'bash',
  description:
    'Run a shell command in the workspace directory. Returns combined stdout and stderr, and the exit code.',
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'One line on why this command is being run' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async run(args, ctx) {
    const command = args['command'];
    if (typeof command !== 'string') return fail('command must be a string');

    return new Promise<ToolResult>((resolveRun) => {
      const child = spawn(command, {
        shell: true,
        cwd: ctx.workspaceRoot,
        signal: ctx.signal,
        // Inherit nothing that looks like a credential: the tool runs on the
        // user's machine, but a command should not be handed API keys it never
        // needed (§13 keeps secrets out of the agent's reach).
        env: { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
      });

      let out = '';
      const cap = (chunk: Buffer) => {
        if (out.length < MAX_OUTPUT * 2) out += chunk.toString('utf8');
      };
      child.stdout?.on('data', cap);
      child.stderr?.on('data', cap);

      const timer = setTimeout(() => child.kill('SIGKILL'), BASH_TIMEOUT_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        resolveRun(fail(`could not run: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolveRun({
          ok: code === 0,
          summary: `bash exited ${code}`,
          content: truncate(`exit ${code}\n${out || '(no output)'}`),
        });
      });
    });
  },
};

/** The suite AgbrteHarness offers by default. */
export const DEFAULT_TOOLS: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  globTool,
  grepTool,
  bashTool,
];

export function toolByName(tools: ToolDefinition[], name: string): ToolDefinition | undefined {
  return tools.find((t) => t.name.toLowerCase() === name.toLowerCase());
}
