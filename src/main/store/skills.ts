/**
 * Reading skill documents out of a workspace (DESIGN.md §17 Q21, §17 Q12, §5.1).
 *
 * §17 Q21 named this as the thing that comes next, and named the reason:
 *
 * > **Unbuilt, deliberately:** skill *templates* (a skill is exactly the kind of
 * > project fact Q12's "by cloning" argument covers, and belongs there next)
 *
 * Until now a skill could only be typed into a session at creation, which made
 * "how we write commit messages in this repo" a thing every person retyped into
 * every session. That is a project fact, and §17 Q12's argument for templates is
 * that a new colleague should get project facts by cloning rather than by being
 * told.
 *
 * ## Why the workspace and not the machine
 *
 * `~/.agbrte` is where this *install* keeps its identity (§5.1). A skill about a
 * project put there would not travel to the colleague who has the project, and
 * would leak into every unrelated checkout on the same box. So it goes beside
 * the workflows and the session templates, in `<workspace>/.agbrte/templates/`,
 * which is tracked.
 *
 * This is emphatically **not** an app-level registry. §17 Q20 refused one for
 * MCP servers — "any tool-triggered skill discovery from disk, which would be
 * the app-level drift Q20 refused wearing a filesystem path" — and nothing here
 * discovers or attaches anything on its own. A person picks from this list at
 * creation, exactly as they picked before by typing; the log still records the
 * whole body, and what a session could reach is still exactly what its
 * transcript says it could.
 *
 * ## Markdown, where a workflow is JSON
 *
 * A workflow is a graph: structure, and JSON is the honest spelling of it. A
 * skill is *prose somebody reads* — and the reason it lives in a tracked
 * directory at all is that a diff is where it gets reviewed (§4.4's approval
 * argument, which this borrows wholesale). `"instructions": "Line one\nLine
 * two\n…"` is one line in a diff for a whole rewrite, so a JSON skill would put
 * the document in the reviewable place and make it unreviewable.
 *
 * The frontmatter is read by hand rather than by a YAML parser. It is two keys
 * on their own lines and this project has eight runtime dependencies on purpose;
 * a dependency for `description:` would be the wrong trade twice over.
 *
 * ## No writer here, and that is a decision
 *
 * `workflows.ts` has `saveWorkflow` because §4.4 wants an agent able to *propose*
 * a decomposition by writing a file. Nothing proposes a skill: it is written by a
 * person in an editor, like the README beside it. A save command would be a way
 * for a session to write its own instructions, which is the loop §17 Q21's
 * "explicit, inspectable rule" exists to keep out.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillConfig } from '@shared/types/index.js';
import { truncateToolOutput } from '../tools/index.js';
import { templatesDir } from './templates.js';

/** The suffix that says which kind of template a file is, like `.workflow.json`. */
export const SKILL_SUFFIX = '.skill.md';

/**
 * A skill that could not be used, and why — never a throw.
 *
 * The same shape and the same reason as `WorkflowFile`: a directory is read to
 * be listed, and one bad file must not take the listing down with it, because
 * the reason to look at the list is often that something in it is wrong.
 *
 * `problems` is plain strings rather than `WorkflowFinding`s. A finding points
 * at a node inside a graph; a skill is one document, so there is nothing for the
 * extra field to point at and an empty one would be a shape promising a
 * precision this cannot have.
 */
export interface SkillFile {
  /** The file's stem, which is also the id a caller names it by. */
  id: string;
  path: string;
  /** Absent when the file could not be read or would be refused at creation. */
  skill?: SkillConfig;
  problems: string[];
}

/**
 * The id rule, which is `SessionManager`'s rule and must stay it.
 *
 * The id becomes `skill__<id>` — a tool name that policy rules match on — so a
 * file whose stem breaks this is refused *by name* here rather than sanitised
 * into something else. Sanitising is right for a path (below) and wrong for an
 * identifier: a file called `Review Notes.skill.md` silently becoming
 * `review-notes` would put a rule on a name its author never wrote.
 */
const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * `---` frontmatter, then the body.
 *
 * Deliberately small: the opening fence must be the first line, keys are
 * `name: value` up to the closing fence, and everything after it is the skill.
 * Anything more elaborate would be a YAML implementation, and a half-YAML that
 * handles some documents is worse than one that handles a documented shape.
 */
function frontmatter(raw: string): { keys: Record<string, string>; body: string } | null {
  // Both line endings: a file written on Windows and one written on a Linux
  // build box are the same document, and the person who wrote it did not choose.
  const text = raw.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return null;
  const keys: Record<string, string> = {};
  for (const line of text.slice(4, end).split('\n')) {
    const at = line.indexOf(':');
    if (at === -1) continue;
    keys[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { keys, body: text.slice(end + 4).replace(/^\n+/, '') };
}

/** One skill, read and checked against what `createSession` would accept. */
export async function readSkill(workspaceRoot: string, id: string): Promise<SkillFile> {
  // Narrowed before it reaches `join()`, like `readWorkflow` and `templates.ts`:
  // an id that arrived from anywhere else is an id somebody else chose.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const path = join(templatesDir(workspaceRoot), `${safe}${SKILL_SUFFIX}`);

  /*
   * The id is judged before the file is opened, and that ordering is the fix
   * for a bug this had on its first run.
   *
   * The check used to sit below the read, so a file called `Review
   * Notes.skill.md` — found by `listSkills`, which reads the directory — was
   * sanitised to `Review-Notes`, opened, and reported as *missing*. A file
   * plainly on disk, named as absent. Judging first means an id that cannot be
   * a tool name never reaches `join()` at all, which is both the honest answer
   * and the safer one.
   *
   * The raw name is in the message and `safe` is in the field: the message is
   * read by a person looking for the file, and the field may come back over the
   * wire.
   */
  if (!ID.test(id)) {
    return {
      id: safe,
      path,
      problems: [
        `"${id}" cannot be a skill id — lowercase letters, digits, - and _ only, ` +
          'because the id becomes the tool name policy rules match on',
      ],
    };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return { id: safe, path, problems: [`could not be read: ${String(err)}`] };
  }

  const parsed = frontmatter(raw);
  if (parsed === null) {
    return {
      id: safe,
      path,
      problems: ['has no frontmatter — it needs a --- block with a description in it'],
    };
  }

  const problems: string[] = [];
  const description = parsed.keys['description'] ?? '';
  if (description === '') {
    // The description is what the model reads when deciding whether to load the
    // body (§17 Q21). Without it the skill is a tool nothing can tell apart from
    // the others, so this is a refusal rather than a default.
    problems.push('has no description — that is the line the model reads before loading it');
  }
  if (parsed.body.trim() === '') problems.push('has no instructions under its frontmatter');
  /*
   * Q7's cap, checked here as well as at creation.
   *
   * `createSession` throws on an oversized body, and a file that would throw is
   * a file the list has to be able to say is unusable — the alternative is an
   * offer that fails on press, which is §3.5's shape.
   */
  if (truncateToolOutput(parsed.body) !== parsed.body) {
    problems.push(
      `is ${parsed.body.length} characters; tool output is capped at 8,000, ` +
        'so it would reach the model truncated — split it',
    );
  }

  if (problems.length > 0) return { id: safe, path, problems };
  return {
    id: safe,
    path,
    skill: { id: safe, description, instructions: parsed.body },
    problems,
  };
}

/**
 * Every skill in a workspace, broken ones included.
 *
 * Sorted by id so a listing is stable between runs — a directory read is not
 * ordered, and a list that reshuffles is one nobody can scan twice.
 */
export async function listSkills(workspaceRoot: string): Promise<SkillFile[]> {
  let names: string[];
  try {
    names = await readdir(templatesDir(workspaceRoot));
  } catch {
    // No templates directory is a workspace with no skills, which is the
    // ordinary case and not a failure.
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith(SKILL_SUFFIX))
    .map((n) => n.slice(0, -SKILL_SUFFIX.length))
    .sort();
  return Promise.all(ids.map((id) => readSkill(workspaceRoot, id)));
}
