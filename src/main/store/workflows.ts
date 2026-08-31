/**
 * Reading a workflow document off disk (DESIGN.md §4.4, §5.1).
 *
 * Beside session templates, in `<workspace>/.agbrte/templates/`, which is
 * **tracked** — and that is the point rather than a filing decision. §4.4's
 * whole approval argument rests on it: an agent proposes a workflow by writing
 * a file and never by starting a run, so hand-written and agent-proposed
 * documents converge on one artifact reviewed in one medium, a diff, at the
 * reader's own pace. A twelve-node graph in an approval modal is not read.
 *
 * `.workflow.json` rather than `.json`, so one directory can hold both kinds
 * without either having to open the other's files to find out what they are.
 *
 * Tracked also puts these under §13: a workflow may name a credential and must
 * never carry one. Nothing here writes, so nothing here can leak one; when the
 * editor lands, that is the rule it has to keep.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateWorkflow, type WorkflowFinding } from '@shared/workflow/validate.js';
import type { Workflow } from '@shared/types/index.js';
import { templatesDir } from './templates.js';

/** The suffix that says which kind of template a file is. */
export const WORKFLOW_SUFFIX = '.workflow.json';

/**
 * A document that could not be used, and why — never a throw.
 *
 * A directory of workflows is read to be listed, and one unparseable file must
 * not take the listing down with it: the reason to look at a list is often that
 * something in it is broken. Same shape as `EndpointModels.error` (§3.8) and for
 * the same reason.
 */
export interface WorkflowFile {
  /** The file's stem, which is also the id a caller names it by. */
  id: string;
  path: string;
  workflow?: Workflow;
  /** Findings from `validateWorkflow`, or a single parse failure. */
  problems: WorkflowFinding[];
}

/** The shape a parsed file must have before `validateWorkflow` can say more. */
function looksLikeWorkflow(v: unknown): v is Workflow {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['name'] === 'string' && typeof o['goal'] === 'string' && Array.isArray(o['nodes']);
}

/**
 * One workflow, parsed and validated.
 *
 * Validated on read rather than on use, because the caller that reads it is the
 * caller that can still do something about it — and a document that reached a
 * runner unvalidated is a decomposition nobody checked, which is the thing §4.4
 * exists to prevent.
 *
 * `against` is passed through: while listing there is no root budget and the
 * shape is all that can be judged; before a run there is one, and the shortfall
 * is the finding that stops it.
 */
export async function readWorkflow(
  workspaceRoot: string,
  id: string,
  against?: Parameters<typeof validateWorkflow>[1],
): Promise<WorkflowFile> {
  // Through `basename`-style narrowing rather than trusting the caller: this
  // string reaches `join()`, and an id that arrived from anywhere else is an id
  // somebody else chose. `templates.ts` makes the same move for the same reason.
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, '-');
  const path = join(templatesDir(workspaceRoot), `${safe}${WORKFLOW_SUFFIX}`);
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    return { id: safe, path, problems: [{ message: `could not be read: ${String(err)}` }] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { id: safe, path, problems: [{ message: `is not valid JSON: ${String(err)}` }] };
  }
  if (!looksLikeWorkflow(parsed)) {
    // Reported as one finding rather than as six missing fields: a file this
    // far from the shape is usually the wrong file, not a workflow with typos.
    return {
      id: safe,
      path,
      problems: [{ message: 'is not a workflow — it needs a name, a goal and a list of nodes' }],
    };
  }
  return { id: safe, path, workflow: parsed, problems: validateWorkflow(parsed, against) };
}

/**
 * Every workflow in a workspace, broken ones included.
 *
 * Sorted by id so a listing is stable between runs — a directory read is not
 * ordered, and a list that reshuffles is one nobody can diff or scan twice.
 */
export async function listWorkflows(workspaceRoot: string): Promise<WorkflowFile[]> {
  let names: string[];
  try {
    names = await readdir(templatesDir(workspaceRoot));
  } catch {
    // No templates directory is a workspace with no workflows, which is the
    // ordinary case and not a failure.
    return [];
  }
  const ids = names
    .filter((n) => n.endsWith(WORKFLOW_SUFFIX))
    .map((n) => n.slice(0, -WORKFLOW_SUFFIX.length))
    .sort();
  return Promise.all(ids.map((id) => readWorkflow(workspaceRoot, id)));
}
