/**
 * Session templates, derived from sessions (DESIGN.md §17 Q12, §4.1, §13).
 *
 * > **Session templates** carrying rosters, checklists, a default target, and a
 * > model + auth assignment per role.
 *
 * Every one of those fields is already in a `Session`. So the feature is **"save
 * this as a template"** — a projection of a run that worked — and there is no
 * authoring format at all. That difference is most of the value. A template
 * format is a thing people configure once and drift away from; a captured
 * session is a thing already working in front of them at the moment they notice
 * they will want it again.
 *
 * It also inherits provenance for free. §5.1 records what each agent *resolved*,
 * not what was asked for, so a template says what ran rather than what was
 * intended — which is the difference between "gpt-4o-mini" and "whatever the CLI
 * defaulted to that week".
 *
 * ## Beside memory, and committed for the same reason
 *
 * `.devagents/`'s own `.gitignore` excludes `sessions/`, `index/`, `run/` and
 * `instance.json` — derived state — and commits `project.json` and `memory/`.
 * Templates belong on the committed side: "this is how we run a review session
 * in this repo" is a fact about the project, and it is the kind of thing a new
 * colleague should get by cloning rather than by being told.
 *
 * ## What is deliberately dropped
 *
 * Everything that describes *that particular run* rather than the shape of it:
 * ids, state, usage, resume tokens, artifacts, and `resolvedCapabilities` —
 * which is a snapshot of the host it ran on and would be a lie on any other.
 * Checklist items keep their text and lose their progress, because a template of
 * a finished checklist is a checklist that starts finished.
 *
 * **And never a credential.** `AuthMode` carries an `endpointId` or a `cliId` and
 * no secret, which is what makes this safe to commit at all — §13's rule is that
 * credentials never reach a file that travels, and this file is designed to
 * travel.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workspaceLayout } from './layout.js';
import type {
  AgentRole,
  AuthMode,
  ExecutionTarget,
  ModelRef,
  Session,
} from '@shared/types/index.js';

export const TEMPLATE_SCHEMA_VERSION = 1;

/** One seat in a template's roster. */
export interface TemplateRole {
  role: AgentRole;
  runtimeId: string;
  /** What actually ran, not what was asked for (§5.1). */
  model?: ModelRef;
  /** An endpoint or CLI id. Never a secret — see the header. */
  auth: AuthMode;
  isolation: 'shared' | 'worktree';
  systemPrompt?: string;
}

export interface SessionTemplate {
  schemaVersion: number;
  /** Stable, filesystem-safe, and what the file is named. */
  id: string;
  name: string;
  goal?: string;
  /**
   * Where sessions from this template run by default.
   *
   * Machine-specific on purpose: an ssh alias is exactly the useful part of "we
   * run this on the build box". A user who does not have that alias gets a
   * refusal naming it, which is more useful than silently running somewhere else
   * — the failure §16 already records for execution targets.
   */
  target?: ExecutionTarget;
  roles: TemplateRole[];
  /** Text only. A template of a finished checklist starts finished. */
  checklist: string[];
  createdAt: string;
  /** Which session this was taken from, for "where did this come from". */
  fromSessionId: string;
}

export class TemplateRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'TemplateRefused';
  }
}

export function templatesDir(workspaceRoot: string): string {
  return join(workspaceLayout(workspaceRoot).devagents, 'templates');
}

/**
 * A name a person typed, turned into a filename.
 *
 * The whole point is that this string reaches `join()`, so it is built from an
 * allow-list rather than by removing the dangerous parts of it: `..`, a
 * separator, a drive letter, a NUL and a leading dash are each their own way to
 * escape a directory or confuse a command, and a deny-list is a promise to have
 * thought of all of them.
 */
export function templateId(name: string): string {
  const id = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // Trimmed again: the slice can land mid-separator and leave `review-` as a
    // filename, which is nothing but untidy and is free to avoid.
    .replace(/-+$/, '');
  if (id === '') {
    throw new TemplateRefused(
      `"${name}" has no letters or digits in it, so there is nothing to name a template after`,
    );
  }
  return id;
}

/**
 * Take a template from a session.
 *
 * The only constructor, deliberately. There is no hand-authored shape to keep in
 * step with `Session`, which means a field added there is either projected here
 * on purpose or absent on purpose — and never silently half-supported.
 */
/**
 * Where the host being templated actually is, as the *client* names it.
 *
 * Passed in rather than read off the session, and that is the whole correction.
 * `session.target` was the obvious source and is always `{kind:'local'}` —
 * `session.create` carries only a title and a goal, and `spawnChild` refuses a
 * target that differs from its parent's, so every session on every host records
 * `local` and always will. `fromSession` skipped `local` as "the default
 * everywhere", so the field was unreachable: no template could ever carry a
 * target, and the refusal its documentation promised could never fire.
 *
 * The deeper reason it could not come from the session is that a target is not a
 * property of the host at all. A host on the build box does not know it is "the
 * build box"; it knows a workspace. `ssh build-01` is the *client's* name for the
 * route to it, held by `Fleet`, and it is the useful half of "we run this on the
 * build box". So it arrives from the side that knows it.
 */
export interface TemplateOrigin {
  target: ExecutionTarget;
}

export function fromSession(
  session: Session,
  name: string,
  origin?: TemplateOrigin,
  now = new Date(),
): SessionTemplate {
  const roles: TemplateRole[] = session.agents.map((agent) => ({
    role: agent.role,
    runtimeId: agent.spec.runtimeId,
    ...(agent.spec.model !== undefined ? { model: agent.spec.model } : {}),
    auth: agent.spec.auth,
    isolation: agent.isolation,
    ...(agent.spec.systemPrompt !== undefined ? { systemPrompt: agent.spec.systemPrompt } : {}),
  }));

  if (roles.length === 0) {
    // A roster is the substance of a template; without one this is a title and a
    // checklist, and saving it would teach the user the feature does nothing.
    throw new TemplateRefused('this session has no agents yet, so there is no roster to save');
  }

  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id: templateId(name),
    name: name.trim(),
    ...(session.goal.trim() === '' ? {} : { goal: session.goal }),
    // A local target is the default everywhere and says nothing; recording it
    // would make every template claim a locality it does not care about. The
    // test is on the *origin* now, for the reason given on `TemplateOrigin`:
    // reading `session.target` here meant the condition was never once false.
    ...(origin === undefined || origin.target.kind === 'local' ? {} : { target: origin.target }),
    roles,
    checklist: session.checklist.map((item) => item.text),
    createdAt: now.toISOString(),
    fromSessionId: session.sessionId,
  };
}

export async function saveTemplate(
  workspaceRoot: string,
  template: SessionTemplate,
): Promise<SessionTemplate> {
  const dir = templatesDir(workspaceRoot);
  // Not `PRIVATE_DIR_MODE`: this directory is meant to be committed and read by
  // colleagues, and it holds no secret by construction. The rest of
  // `.devagents/` stays `0700`.
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${template.id}.json`),
    `${JSON.stringify(template, null, 2)}\n`,
    'utf8',
  );
  return template;
}

export async function listTemplates(workspaceRoot: string): Promise<SessionTemplate[]> {
  const dir = templatesDir(workspaceRoot);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    // No templates directory is the ordinary state of a workspace nobody has
    // saved one in.
    return [];
  }

  const found: SessionTemplate[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const template = await readTemplateFile(join(dir, name));
    // A malformed file is skipped rather than fatal: these are committed and
    // hand-editable by design, so one bad merge must not take the list down.
    if (template !== null) found.push(template);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readTemplate(
  workspaceRoot: string,
  id: string,
): Promise<SessionTemplate | null> {
  // Through `templateId` again rather than trusting the caller: this string
  // reaches `join()`, and an id that arrived over IPC is an id someone else
  // chose.
  return readTemplateFile(join(templatesDir(workspaceRoot), `${templateId(id)}.json`));
}

export async function deleteTemplate(workspaceRoot: string, id: string): Promise<boolean> {
  const path = join(templatesDir(workspaceRoot), `${templateId(id)}.json`);
  try {
    await rm(path);
    return true;
  } catch {
    return false;
  }
}

async function readTemplateFile(path: string): Promise<SessionTemplate | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as SessionTemplate;
    if (typeof parsed.id !== 'string' || !Array.isArray(parsed.roles)) return null;
    if (parsed.schemaVersion > TEMPLATE_SCHEMA_VERSION) {
      // Written by a newer Agbrte. Skipped rather than half-read: a roster is
      // instructions for spending money on somebody's behalf, and guessing at a
      // shape we do not know is the wrong kind of forgiving.
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
