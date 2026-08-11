/**
 * Who is in this session, and how tightly each one is gated (§4.2, §10, §13).
 *
 * > **Fidelity is displayed per agent** — a `AgbrteHarness` agent and a
 * > wrapped-CLI agent do not enforce identical policy, and the UI must never
 * > imply they do.
 *
 * That sentence is why this exists, and it is a safety rule rather than a
 * decoration. §4.2's payoff is a heterogeneous roster: a frontier lead, two
 * cheap workers, a reviewer on a different provider. Those agents are gated
 * *differently* — one has every call checked before it runs, another only has an
 * allowlist compiled before it started — and a transcript that shows their work
 * in one undifferentiated stream tells the reader they are the same.
 *
 * ## Per-agent panes over a unified timeline
 *
 * The unified timeline is the default and stays the truth: one log, one order,
 * which is what makes "what happened in this session" answerable at all.
 * Selecting an agent filters to its pane. Splitting the log into permanent
 * side-by-side columns would lose the interleaving, and the interleaving is
 * usually the thing you are trying to understand when a roster misbehaves.
 *
 * ## Only when there is something to disambiguate
 *
 * With one agent the roster says nothing the session header does not, so it does
 * not render. The same rule the dashboard uses for its host badge: a label that
 * is always present and always the same teaches people to stop reading labels.
 */

import type { JSX } from 'react';
import type { AgentRecord, PermissionFidelity } from '../shared/types/index.js';
import { LABEL } from './App.js';

/** Plain words. A badge whose meaning lives in a legend is not a badge. */
const GATE: Readonly<Record<PermissionFidelity, { text: string; tone: string }>> = {
  callback: { text: 'gated per call', tone: 'text-state-done' },
  'precomputed-allowlist': { text: 'allowlist only', tone: 'text-state-paused' },
  // The one that matters most to see: nothing checks its calls, so its
  // filesystem view is the only boundary (§9).
  'all-or-nothing': { text: 'sandbox only', tone: 'text-state-fail' },
};

const AUTH: Readonly<Record<string, string>> = {
  'api-key': 'api key',
  'vendor-cli-session': 'your CLI',
  none: 'local',
};

export function Roster({
  agents,
  selected,
  onSelect,
}: {
  agents: AgentRecord[];
  /** `null` is the unified timeline, which is the default and the truth. */
  selected: string | null;
  onSelect: (agentId: string | null) => void;
}): JSX.Element | null {
  if (agents.length < 2) return null;

  return (
    <div
      data-testid="roster"
      className="border-line flex flex-wrap items-center gap-2 border-b px-4 py-2"
    >
      <button
        type="button"
        className={`btn text-[11px] ${selected === null ? 'border-accent' : ''}`}
        data-testid="roster-all"
        aria-pressed={selected === null}
        onClick={() => onSelect(null)}
      >
        Everyone
      </button>

      {agents.map((agent) => {
        const gate = GATE[agent.resolvedCapabilities.permissionFidelity];
        const isOpen = selected === agent.agentId;
        return (
          <button
            key={agent.agentId}
            type="button"
            data-testid="roster-agent"
            data-agent={agent.agentId}
            data-role={agent.role}
            aria-pressed={isOpen}
            className={`btn grid gap-1 text-left text-[11px] ${isOpen ? 'border-accent' : ''}`}
            onClick={() => onSelect(isOpen ? null : agent.agentId)}
          >
            <span className="flex items-baseline gap-2">
              <span>{agent.role}</span>
              <span className="text-muted">{agent.spec.model?.modelId ?? agent.spec.runtimeId}</span>
            </span>
            <span className={`${LABEL} flex gap-2`}>
              <span className="text-muted">{AUTH[agent.spec.auth.kind] ?? agent.spec.auth.kind}</span>
              {/* §13: never imply two agents enforce the same policy. */}
              <span className={gate.tone} data-testid="roster-fidelity">
                {gate.text}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
