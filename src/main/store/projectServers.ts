/**
 * MCP servers a workspace declares (DESIGN.md §17 Q20, §17 Q12, §13, §5.1).
 *
 * ## What this is
 *
 * A project that uses an MCP server has, until now, had no way to say so. Q20
 * put the declaration in the creation form — command, arguments, environment,
 * typed by the person making the session — which is right about *when* the
 * decision is made and leaves the project itself mute: a colleague who clones
 * the repository gets a README paragraph, if somebody wrote one.
 *
 * So a server is a file here, beside the workflows and the skills, in
 * `<workspace>/.agbrte/templates/` — the tracked directory whose whole argument
 * (§17 Q12) is that a new colleague should get project facts by cloning.
 *
 * ## The credential is kept out by the *shape*, not by a filter
 *
 * This file travels. §13's line is that a credential never reaches one that
 * does, so the type has **no field a value fits in**: `envFrom` maps the
 * variable a server wants to the *name* this machine stores it under, and both
 * sides are validated as environment-variable names. A key pasted into either
 * half fails the name rule; a key that somehow passed it would be used as a
 * lookup and resolve to nothing.
 *
 * That is deliberately stronger than validating `env` values against
 * `${SOMETHING}`. A refusal on read stops a bad file being *used* — it does not
 * stop it being *committed*, and by then the secret is in everybody's clone.
 * `workflows.ts` makes the same argument for the same reason: "a `Workflow` has
 * no field a secret fits in, no `env`, no headers, no command".
 *
 * Values come from the machine (`host/secrets.ts`), which is outside every
 * workspace and in no repository.
 *
 * ## One file per server, like its neighbours
 *
 * `<id>.mcp.json`, so the id is the filename stem and the id rule is enforced
 * by the same mechanism the other two use. It also makes adding a server a *new
 * file* in a diff rather than a line inside a map — which matters more here than
 * anywhere else in this directory, because the thing being reviewed is what a
 * machine will be asked to execute.
 *
 * ## This reads; it does not attach
 *
 * Nothing here attaches anything, and a session still gets what a person named
 * when they made it. Q20 refused an app-level registry and this is not one: it
 * is one project's declaration, travelling only to people who have that project.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { templatesDir } from './templates.js';

/** The suffix that says which kind of template a file is. */
export const PROJECT_SERVER_SUFFIX = '.mcp.json';

/**
 * The id rule, which is `SessionManager`'s `assertMcpId` and must stay it.
 *
 * The id becomes part of `mcp__<id>__<tool>`, a tool name policy rules match
 * on, so a stem that breaks this is refused by name rather than sanitised into
 * something its author never wrote.
 */
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** An environment variable name, on both sides of `envFrom`. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/**
 * One server as a workspace declares it.
 *
 * No `env`, deliberately — see the header. `envFrom` is
 * `{ what the server wants: what this machine calls it }`, which is what lets a
 * server expecting `API_KEY` be fed by a machine that stores `SEARCH_API_KEY`
 * without either name having to change.
 */
export interface ProjectServer {
  id: string;
  command: string;
  args?: string[];
  /** Workspace-relative, resolved by whoever spawns it. Never absolute here. */
  cwd?: string;
  envFrom?: Record<string, string>;
}

/**
 * A declaration that could not be used, and why — never a throw.
 *
 * Same shape and same reasoning as `SkillFile` and `WorkflowFile`: a directory
 * is read to be listed, and the reason to look at the list is often that one of
 * them is wrong.
 */
export interface ProjectServerFile {
  id: string;
  path: string;
  /** Absent when the declaration would be refused. */
  server?: ProjectServer;
  problems: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** One declaration, read and checked against what a spawn would accept. */
export async function readProjectServer(
  workspaceRoot: string,
  id: string,
): Promise<ProjectServerFile> {
  // Narrowed before it reaches `join()`, like its two neighbours: an id that
  // arrived from anywhere else is an id somebody else chose.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const path = join(templatesDir(workspaceRoot), `${safe}${PROJECT_SERVER_SUFFIX}`);

  // Judged before the file is opened, which is the ordering `skills.ts` arrived
  // at the expensive way: sanitising for the path and then reading under the
  // sanitised name reports a file plainly on disk as missing.
  if (!ID.test(id)) {
    return {
      id: safe,
      path,
      problems: [
        `"${id}" cannot be an MCP server id — lowercase letters, digits, - and _ only, ` +
          'because the id becomes part of the tool names policy rules match on',
      ],
    };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return { id: safe, path, problems: [`could not be read: ${String(err)}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    return { id: safe, path, problems: [`is not valid JSON: ${String(err)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { id: safe, path, problems: ['is not an object'] };
  }

  const o = parsed as Record<string, unknown>;
  const problems: string[] = [];

  const command = o['command'];
  if (typeof command !== 'string' || command === '') {
    problems.push('has no command — that is the program the host will run');
  }

  const args = o['args'];
  if (args !== undefined && !isStringArray(args)) problems.push('args must be a list of strings');

  const cwd = o['cwd'];
  if (cwd !== undefined && typeof cwd !== 'string') problems.push('cwd must be a string');
  if (typeof cwd === 'string' && /^([/\\]|[A-Za-z]:[/\\]|\\\\)/.test(cwd)) {
    // An absolute path in a tracked file names a directory on the author's
    // machine and nothing on a colleague's (§5.4b). Relative to the workspace
    // is the only reading that survives a clone.
    problems.push('cwd must be relative to the workspace, not an absolute path');
  }

  /*
   * `env` is refused by name rather than ignored.
   *
   * Somebody writing this file will reach for the field the creation form has,
   * and a silently dropped `env` would be a server that starts without its
   * credentials and fails somewhere far away. Saying so here also says *why* —
   * which is the sentence that stops them pasting a key into the next attempt.
   */
  if (o['env'] !== undefined) {
    problems.push(
      'has an env block — this file is committed, so it names variables rather than holding ' +
        'them: use envFrom, and keep the value on the machine',
    );
  }

  const envFrom = o['envFrom'];
  const mapped: Record<string, string> = {};
  if (envFrom !== undefined) {
    if (typeof envFrom !== 'object' || envFrom === null || Array.isArray(envFrom)) {
      problems.push('envFrom must be an object of { variable: name-on-this-machine }');
    } else {
      for (const [wants, named] of Object.entries(envFrom as Record<string, unknown>)) {
        if (!ENV_NAME.test(wants)) {
          problems.push(`"${wants}" is not an environment variable name`);
          continue;
        }
        if (typeof named !== 'string' || !ENV_NAME.test(named)) {
          // Which is also what a pasted key fails on, and the message says the
          // thing the author needs to hear rather than repeating the value.
          problems.push(
            `${wants} must name a secret held on the machine, not hold a value — ` +
              'a name is letters, digits and underscores',
          );
          continue;
        }
        mapped[wants] = named;
      }
    }
  }

  if (problems.length > 0) return { id: safe, path, problems };
  return {
    id: safe,
    path,
    server: {
      id: safe,
      command: command as string,
      ...(args !== undefined ? { args: args as string[] } : {}),
      ...(cwd !== undefined ? { cwd: cwd as string } : {}),
      ...(Object.keys(mapped).length > 0 ? { envFrom: mapped } : {}),
    },
    problems,
  };
}

/**
 * Write a declaration into the workspace (§17 Q20, §17 Q12).
 *
 * `workflows.ts` argues for its own writer on the grounds that §4.4 wants an
 * agent able to *propose* a decomposition. Nothing proposes a server, so this
 * one is here for a different reason: the app knows a handful of well-known
 * servers (`shared/mcp/catalogue.ts`), and picking one has to produce the same
 * artifact a person writes by hand — a tracked file, reviewed in a diff, that a
 * colleague gets by cloning. A catalogue that configured something invisible
 * instead would be the app-level registry Q20 refused, wearing a button.
 *
 * **Refused rather than replaced**, like `addEndpoint` and unlike `setSecret`.
 * The id is the prefix of `mcp__<id>__*`, which policy rules match on, so
 * swapping the command under an existing one silently changes what every rule
 * pointing at it now permits. The remedy is in the refusal: edit the file, or
 * pick another id.
 *
 * The body is built here from the fields this type has rather than serialised
 * from the caller's object, which is what keeps §13's guarantee a property of
 * the *writer*: there is no path by which an `env` block reaches the file, so a
 * caller that grew one could not put a credential in a repository by accident.
 */
export async function writeProjectServer(
  workspaceRoot: string,
  server: ProjectServer,
): Promise<{ id: string; path: string }> {
  /*
   * The id first, before the disk is touched — which is `readProjectServer`'s
   * ordering above and is here for the second time the same mistake was made.
   *
   * With the checks the other way round, an illegal id like `Search` read back
   * as a *problem* rather than as "could not be read", the duplicate check took
   * that for a file, and the refusal said this workspace already had a server
   * called `Search`. A sentence that is both false and unactionable, about a
   * file that does not exist.
   */
  if (!ID.test(server.id)) {
    throw new ProjectServerRefused(
      `"${server.id}" cannot be an MCP server id — lowercase letters, digits, - and _ only`,
    );
  }
  const existing = await readProjectServer(workspaceRoot, server.id);
  if (existing.problems.length === 0 || !existing.problems[0]?.startsWith('could not be read')) {
    // Anything but "not there" means a file is there: a broken declaration is
    // still one somebody wrote, and overwriting it would throw away the thing
    // they were part-way through fixing.
    throw new ProjectServerRefused(
      `this workspace already has an MCP server called "${server.id}" — its tools are ` +
        `mcp__${server.id}__*, and two declarations cannot share that name. Edit ` +
        `${server.id}${PROJECT_SERVER_SUFFIX} instead, or pick another id.`,
    );
  }

  const dir = templatesDir(workspaceRoot);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${server.id}${PROJECT_SERVER_SUFFIX}`);
  const body = {
    command: server.command,
    ...(server.args !== undefined ? { args: server.args } : {}),
    ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
    ...(server.envFrom !== undefined ? { envFrom: server.envFrom } : {}),
  };
  // Two-space JSON with a trailing newline, like `saveWorkflow`: the file is
  // going into somebody's repository and a diff on it should read like the rest
  // of the tree rather than like output.
  await writeFile(path, `${JSON.stringify(body, null, 2)}
`, 'utf8');
  return { id: server.id, path };
}

export class ProjectServerRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProjectServerRefused';
  }
}

/**
 * Every server this workspace declares, broken ones included.
 *
 * Sorted by id so a listing is stable between runs — a directory read is not
 * ordered, and a list nobody can scan twice is a list nobody reads.
 */
export async function listProjectServers(workspaceRoot: string): Promise<ProjectServerFile[]> {
  let names: string[];
  try {
    names = await readdir(templatesDir(workspaceRoot));
  } catch {
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith(PROJECT_SERVER_SUFFIX))
    .map((n) => n.slice(0, -PROJECT_SERVER_SUFFIX.length))
    .sort();
  return Promise.all(ids.map((id) => readProjectServer(workspaceRoot, id)));
}

/**
 * The machine names a declaration needs, in the order it named them.
 *
 * Separate from the reader because the *machine* answers whether they are held
 * and the workspace only says which are wanted — two facts owned by two places,
 * joined by whoever has both (`sessionServer`).
 */
export function neededNames(server: ProjectServer): string[] {
  return Object.values(server.envFrom ?? {});
}
