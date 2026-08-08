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
 * Shown only when the roster has more than one, for the same reason the roster
 * itself is: with a single agent every row would carry an identical label, which
 * is noise that trains people to ignore labels that do mean something.
 */
export function agentLabel(agents: AgentRecord[], agentId: string | undefined): string | null {
  if (agents.length < 2 || agentId === undefined) return null;
  return agents.find((a) => a.agentId === agentId)?.role ?? null;
}
