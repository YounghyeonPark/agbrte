/**
 * Which agent a transcript row belongs to (DESIGN.md §4.2).
 *
 * Its own module rather than a helper inside `Roster.tsx`, because it is a
 * plain function over data and the component file is JSX. A test that wanted
 * this rule had to pull a whole `.tsx` into a project with no DOM lib, which is
 * a good sign the rule did not live where it belonged.
 */

import type { AgentRecord } from '../shared/types/index.js';

/**
 * The agent a row belongs to, for the unified view.
 *
 * Shown only when the session has held more than one agent, for the same reason
 * the roster's filter appears only then: with a single agent every row would
 * carry an identical label, which is noise that trains people to ignore labels
 * that do mean something.
 *
 * **`agents.length`, not the live count.** A session whose model was changed
 * has one live seat and one retired one, and its transcript is exactly the case
 * that needs labelling — the rows above the change came from a different model.
 * Counting only live seats would silence the labels on precisely the transcript
 * that cannot be read without them.
 *
 * The label is the *model* where the seat has one, falling back to the role.
 * Two seats in a changed session are usually both `lead`, so a role alone would
 * put the same word on both sides of the change and explain nothing (§4.2).
 */
export function agentLabel(agents: AgentRecord[], agentId: string | undefined): string | null {
  if (agents.length < 2 || agentId === undefined) return null;
  const agent = agents.find((a) => a.agentId === agentId);
  if (agent === undefined) return null;
  const model = agent.spec.model?.modelId;
  // Distinct roles carry more than a repeated model id would; identical roles
  // carry nothing, and the model is what actually differs.
  const distinctRoles = new Set(agents.map((a) => a.role)).size === agents.length;
  return distinctRoles || model === undefined ? agent.role : model;
}
