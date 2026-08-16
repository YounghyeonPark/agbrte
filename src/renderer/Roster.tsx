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
import type { ReasoningMode } from '../shared/ipc/contract.js';
import { LABEL } from './App.js';

/** Plain words. A badge whose meaning lives in a legend is not a badge. */
const EFFORTS = ['auto', 'low', 'medium', 'high', 'max'] as const;

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
  onEffort,
}: {
  agents: AgentRecord[];
  /** `null` is the unified timeline, which is the default and the truth. */
  selected: string | null;
  onSelect: (agentId: string | null) => void;
  /** Rejects on a target that takes no effort, so failures surface here (§3.4). */
  onEffort: (agentId: string, mode: ReasoningMode) => Promise<void>;
}): JSX.Element | null {
  /*
   * Hidden only when there is nothing to show, where it used to hide below two.
   *
   * That guard was right while this was purely a selector — one option to choose
   * between is not a choice. The row carries a seat's effort now, which is
   * information about the single-agent session too, and hiding it there would
   * put a control behind a condition most sessions never meet.
   */
  if (agents.length === 0) return null;

  return (
    <div
      data-testid="roster"
      // `shrink-0` for the same reason as every fixed row around the transcript
      // (see SessionHeader): a wrapped flex row is measured one line tall, so
      // without it this was the row the column chose to crush.
      className="border-line flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
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
        const takesEffort = agent.resolvedCapabilities.reasoningControl === 'effort';
        return (
          /*
           * The row and its effort control are siblings, not nested.
           *
           * The row is a `<button>`, and a `<select>` inside one is neither
           * clickable nor reachable by keyboard — the browser swallows the
           * events for the button. Splitting them is the only shape that leaves
           * both operable.
           */
          <div key={agent.agentId} className="grid gap-1">
            <button
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
                <span className="text-muted">
                  {agent.spec.model?.modelId ?? agent.spec.runtimeId}
                </span>
              </span>
              <span className={`${LABEL} flex gap-2`}>
                <span className="text-muted">
                  {AUTH[agent.spec.auth.kind] ?? agent.spec.auth.kind}
                </span>
                {/* §13: never imply two agents enforce the same policy. */}
                <span className={gate.tone} data-testid="roster-fidelity">
                  {gate.text}
                </span>
              </span>
            </button>

            {/*
              * Shown only where the target takes one, and said out loud where it
              * does not (§3.3). A disabled control would read as "not now"; the
              * truth is "not this model", and an effort sent to a model without
              * the capability is a rejected request rather than a wasted one.
              */}
            {takesEffort ? (
              <label className={`${LABEL} flex items-center gap-2 pl-1`}>
                <span className="text-muted">effort</span>
                <select
                  data-testid="roster-effort"
                  data-agent={agent.agentId}
                  className="btn text-[11px]"
                  value={agent.spec.reasoning?.mode ?? 'auto'}
                  onChange={(e) => void onEffort(agent.agentId, e.target.value as ReasoningMode)}
                >
                  {EFFORTS.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span
                className={`${LABEL} text-muted pl-1`}
                data-testid="roster-effort-unavailable"
              >
                this model does not take a reasoning effort
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
