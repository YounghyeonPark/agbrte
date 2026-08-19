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
import { resolve } from 'node:path';
import {
  newInstanceId,
  newLineageId,
  type InstanceId,
  type LineageId,
} from '@shared/types/index.js';
import {
  assertNotInstallRoot,
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
  /**
   * Where this checkout was last opened.
   *
   * The one thing that makes a move *detectable*. Identity is deliberately never
   * derived from a path — that is what allows relocation at all (§5.3) — but the
   * consequence is that a moved workspace is byte-identical to one that never
   * moved: `instance.json` travels with the folder, so every field matches. The
   * only way to notice is to have written down where it was.
   *
   * In `instance.json` and not `project.json` because this file is gitignored
   * and per-checkout. A clone must not inherit the previous machine's path and
   * then believe it has been relocated.
   *
   * Absent on files written before this existed. Absent means "unknown", not
   * "unmoved" — the first open after an upgrade records it and claims nothing.
   */
  lastKnownPath?: string;
}

export interface WorkspaceIdentity {
  layout: WorkspaceLayout;
  lineageId: LineageId;
  instanceId: InstanceId;
  /** How this open resolved — surfaced in the UI so a clone is never a surprise. */
  /**
   * How this workspace came to be here.
   *
   * `relocated` is the one with a consequence rather than a label: a native
   * resume token was minted by a vendor against the *old* location, and the
   * honest assumption is that it no longer describes anything. See
   * `SessionManager.openHandle`.
   */
  origin: 'created' | 'existing' | 'cloned' | 'relocated';
  /** Where it was, when it has moved. For saying so rather than just knowing. */
  movedFrom?: string;
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
export interface OpenOptions {
  displayName?: string;
  /**
   * Whether to write down that the workspace is now here.
   *
   * **Off by default, deliberately.** Recording *consumes* the relocation
   * signal: once `lastKnownPath` matches, the next open reports `existing` and
   * the move is gone. Only the process that owns the workspace should do that —
   * the host — and it was a client that reached the folder first, so a client
   * that recorded on the way past would swallow the move before the host ever
   * saw it. That is not hypothetical; it is what happened, and the resume after
   * a real move came back with no `workspace.relocated` in the log.
   *
   * Defaulting to off means a caller added later cannot consume it by accident.
   */
  record?: boolean;
}

export async function openWorkspace(
  root: string,
  opts: OpenOptions = {},
): Promise<WorkspaceIdentity> {
  // Before anything is created. `<root>/.agbrte` and the machine's own
  // `~/.agbrte` are the same directory when root is `$HOME`, and the two are
  // different things that must not share a folder — see `assertNotInstallRoot`.
  assertNotInstallRoot(root);
  const layout = workspaceLayout(root);

  // §13 specifies 0700 for `.agbrte/`. `memory/` holds agent-written project
  // knowledge plus the identity files, so it is covered too — an earlier version
  // left both at the 0755 default, readable by every co-tenant on a shared host.
  await mkdir(layout.dir, { recursive: true, mode: PRIVATE_DIR_MODE });
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
      `workspace at ${root} was written by a newer Agbrte (schema ${project.schemaVersion} > ${SCHEMA_VERSION})`,
    );
  }

  const instance: InstanceFile =
    existingInstance ?? { instanceId: newInstanceId(), createdAt: new Date().toISOString() };

  // Compared before it is overwritten, and normalised first: the same directory
  // reached as `C:\dev\x` and `C:/dev/x` is not a move, and reporting one would
  // throw away every native resume token for a path separator.
  const here = resolve(root);
  const before = instance.lastKnownPath;
  const moved = before !== undefined && resolve(before) !== here;

  if (!existingInstance) {
    // A brand-new instance file has to be written whatever the caller wanted;
    // there is nothing to consume yet.
    await writeJson(layout.instanceFile, { ...instance, lastKnownPath: here });
  } else if (opts.record === true && before !== here) {
    await writeJson(layout.instanceFile, { ...instance, lastKnownPath: here });
  }

  const origin: WorkspaceIdentity['origin'] = !existingProject
    ? 'created'
    : !existingInstance
      ? 'cloned'
      : moved
        ? 'relocated'
        : 'existing';

  return {
    layout,
    lineageId: project.lineageId,
    instanceId: instance.instanceId,
    origin,
    ...(moved && before !== undefined ? { movedFrom: before } : {}),
  };
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
