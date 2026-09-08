/**
 * Reading a workflow document and starting a run of it (DESIGN.md §4.4, §4.3).
 *
 * One function because there are two callers and they must not drift: the
 * `workflow.run` command, which is somebody pressing a button, and the schedule
 * runner, which is the same thing at nine in the morning with nobody watching.
 * A routine that validated differently from the button would be a routine that
 * ran documents the button refuses.
 */

import { listWorkflows } from './store/workflows.js';
import type { SessionManager } from './sessionManager.js';
import type { Actor, Session, SessionBudget } from '@shared/types/index.js';

/**
 * Start a run of the workflow this workspace holds under `workflowId`.
 *
 * **By id, and read from disk here.** The run is of the document *on that
 * machine* — the one a colleague pulling the repo also has. A body passed in
 * would let a caller run something the workspace does not contain, and the log
 * would then name a workflow nobody could find.
 *
 * **Findings refuse it, not just an unreadable file.** `listWorkflows` fills
 * `workflow` *and* `problems`, because §4.4 wants a document with a bad seam to
 * still have a graph worth drawing — that is what the editor needs to fix it.
 * So a parsed document says nothing about whether it can run, and checking only
 * for absence let a workflow whose `needs` named a node that does not exist
 * start anyway. `workflow.save` already refuses to write one, so a document
 * with findings arrives by hand or by `git pull`: exactly the copy a run meets,
 * and the one nobody validated.
 *
 * The findings travel with the refusal. "Invalid" would send somebody back to
 * the pane to learn what this already knew.
 */
export async function runWorkflowDocument(
  manager: SessionManager,
  workspaceRoot: string,
  workflowId: string,
  budget: SessionBudget,
  actor?: Actor,
): Promise<Session> {
  const files = await listWorkflows(workspaceRoot);
  const found = files.find((f) => f.id === workflowId);
  if (found === undefined) {
    throw new Error(
      `no workflow "${workflowId}" in this workspace — available: ` +
        `${files.map((f) => f.id).join(', ') || 'none'}`,
    );
  }
  if (found.workflow === undefined || found.problems.length > 0) {
    throw new Error(
      `workflow "${workflowId}" cannot run as written: ` +
        (found.problems.map((p) => p.message).join('; ') || 'it could not be read'),
    );
  }

  const workflow = found.workflow;
  const session = await manager.createSession(
    {
      title: workflow.name,
      goal: workflow.goal,
      workflow: workflow.id,
      workspaceRoot,
      /*
       * The caller's ceiling, and the document's only if it pinned one.
       *
       * A workflow that names a budget is an author saying what the graph
       * costs; a caller naming one is whoever will pay saying what they will
       * pay. The second decides, because they are the one who finds out.
       */
      budget,
    },
    actor,
  );
  await manager.workflowRuns.start(session.sessionId, workflow);
  return session;
}
