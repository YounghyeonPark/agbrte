/**
 * On-disk layout of `.devagents/` (DESIGN.md §5.1).
 *
 * Identical whether the workspace is local or remote — the remote agent host
 * runs the same code against the same layout, which is why the local path
 * continuously exercises the remote one.
 */

import { join } from 'node:path';
import type { SessionId } from '@shared/types/index.js';

export const DEVAGENTS_DIR = '.devagents';
export const SCHEMA_VERSION = 4;

/**
 * `memory/` is tracked by default and safe to commit; `sessions/`, `index/`,
 * `run/`, and `instance.json` are excluded. A nested gitignore does this
 * without touching the user's root .gitignore (§1).
 */
export const NESTED_GITIGNORE = `# Written by Gilmok. Delete this file to exclude .devagents/ entirely.
sessions/
index/
run/
instance.json
`;

export interface WorkspaceLayout {
  readonly root: string;
  readonly devagents: string;
  readonly projectFile: string;
  readonly instanceFile: string;
  readonly gitignoreFile: string;
  readonly memoryDir: string;
  readonly memoryIndex: string;
  readonly sessionsDir: string;
  readonly indexDir: string;
  readonly indexDb: string;
  readonly runDir: string;
}

export function workspaceLayout(root: string): WorkspaceLayout {
  const devagents = join(root, DEVAGENTS_DIR);
  return {
    root,
    devagents,
    projectFile: join(devagents, 'project.json'),
    instanceFile: join(devagents, 'instance.json'),
    gitignoreFile: join(devagents, '.gitignore'),
    memoryDir: join(devagents, 'memory'),
    memoryIndex: join(devagents, 'memory', 'MEMORY.md'),
    sessionsDir: join(devagents, 'sessions'),
    indexDir: join(devagents, 'index'),
    indexDb: join(devagents, 'index', 'sessions.sqlite'),
    runDir: join(devagents, 'run'),
  };
}

export interface SessionLayout {
  readonly dir: string;
  readonly sessionFile: string;
  readonly eventLog: string;
  readonly checkpointsDir: string;
  readonly attachmentsDir: string;
}

export function sessionLayout(root: string, sessionId: SessionId): SessionLayout {
  const dir = join(workspaceLayout(root).sessionsDir, sessionId);
  return {
    dir,
    sessionFile: join(dir, 'session.json'),
    eventLog: join(dir, 'events.jsonl'),
    checkpointsDir: join(dir, 'checkpoints'),
    attachmentsDir: join(dir, 'attachments'),
  };
}

/** Checkpoints are zero-padded so lexical order is numeric order. */
export function checkpointName(seq: number): string {
  return `${String(seq).padStart(6, '0')}.json`;
}

/** Directory mode for anything that may hold transcripts or sockets (§13). */
export const PRIVATE_DIR_MODE = 0o700;
