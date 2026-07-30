/**
 * Workspace identity (DESIGN.md §5.2).
 *
 * Two ids, because one breaks as soon as `memory/` is committed and the repo is
 * cloned onto a second machine — normal once sessions can be remote.
 *
 *   lineageId   tracked in project.json    follows a clone; keys project memory
 *   instanceId  gitignored in instance.json  one checkout on one machine; keys sessions
 *
 * Both files live inside the workspace, so both move with the folder. Identity
 * is never derived from a path — that is what makes relocation (§5.3) possible
 * at all.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  newInstanceId,
  newLineageId,
  type InstanceId,
  type LineageId,
} from '@shared/types/index.js';
import {
  NESTED_GITIGNORE,
  PRIVATE_DIR_MODE,
  SCHEMA_VERSION,
  workspaceLayout,
  type WorkspaceLayout,
} from './layout.js';

export interface ProjectFile {
  schemaVersion: number;
  lineageId: LineageId;
  displayName: string;
}

export interface InstanceFile {
  instanceId: InstanceId;
  createdAt: string;
}

export interface WorkspaceIdentity {
  layout: WorkspaceLayout;
  lineageId: LineageId;
  instanceId: InstanceId;
  /** How this open resolved — surfaced in the UI so a clone is never a surprise. */
  origin: 'created' | 'existing' | 'cloned';
}

const MEMORY_INDEX_HEADER = `# Project memory

One fact per file. Each entry below links to a file in this directory.
Written by agents via the \`remember\` tool; edits by hand are welcome.
`;

/**
 * Open (or initialize) a workspace.
 *
 * The three outcomes are meaningfully different:
 *
 *   created  neither file present — a fresh workspace
 *   existing both present — the normal case
 *   cloned   project.json present, instance.json absent — someone cloned a
 *            repo whose memory/ was committed. The clone inherits project
 *            memory under the existing lineage and starts with no sessions,
 *            which is correct and falls out of the model rather than being
 *            special-cased.
 */
export async function openWorkspace(
  root: string,
  opts: { displayName?: string } = {},
): Promise<WorkspaceIdentity> {
  const layout = workspaceLayout(root);

  // §13 specifies 0700 for `.devagents/`. `memory/` holds agent-written project
  // knowledge plus the identity files, so it is covered too — an earlier version
  // left both at the 0755 default, readable by every co-tenant on a shared host.
  await mkdir(layout.devagents, { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(layout.memoryDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(layout.sessionsDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(layout.indexDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await mkdir(layout.runDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  await writeIfAbsent(layout.gitignoreFile, NESTED_GITIGNORE);
  await writeIfAbsent(layout.memoryIndex, MEMORY_INDEX_HEADER);

  const existingProject = await readJson<ProjectFile>(layout.projectFile);
  const existingInstance = await readJson<InstanceFile>(layout.instanceFile);

  const project: ProjectFile =
    existingProject ??
    {
      schemaVersion: SCHEMA_VERSION,
      lineageId: newLineageId(),
      displayName: opts.displayName ?? basename(root),
    };

  if (!existingProject) {
    await writeJson(layout.projectFile, project);
  } else if (project.schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `workspace at ${root} was written by a newer Loom (schema ${project.schemaVersion} > ${SCHEMA_VERSION})`,
    );
  }

  const instance: InstanceFile =
    existingInstance ?? { instanceId: newInstanceId(), createdAt: new Date().toISOString() };

  if (!existingInstance) {
    await writeJson(layout.instanceFile, instance);
  }

  const origin: WorkspaceIdentity['origin'] = !existingProject
    ? 'created'
    : existingInstance
      ? 'existing'
      : 'cloned';

  return { layout, lineageId: project.lineageId, instanceId: instance.instanceId, origin };
}

/** Read identity without creating anything — used by the resolver (§5.3). */
export async function peekIdentity(
  root: string,
): Promise<{ lineageId: LineageId; instanceId: InstanceId | null } | null> {
  const layout = workspaceLayout(root);
  const project = await readJson<ProjectFile>(layout.projectFile);
  if (!project) return null;
  const instance = await readJson<InstanceFile>(layout.instanceFile);
  return { lineageId: project.lineageId, instanceId: instance?.instanceId ?? null };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function writeIfAbsent(path: string, contents: string): Promise<void> {
  try {
    await readFile(path);
  } catch {
    await writeFile(path, contents, 'utf8');
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? 'workspace';
}
