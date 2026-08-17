/**
 * Which model this session runs, and how tightly it is gated (§4.2, §10, §13).
 *
 * > **Fidelity is displayed per agent** — a `AgbrteHarness` agent and a
 * > wrapped-CLI agent do not enforce identical policy, and the UI must never
 * > imply they do.
 *
 * That sentence is why this exists, and it is a safety rule rather than a
 * decoration: an allowlist compiled before the process started and a gate that
 * checks every call are not the same protection, and a row that showed only a
 * model name would let the two read alike.
 *
 * ## One seat, and the filter that goes with it
 *
 * A session holds one agent by product decision (§4.2), so the ordinary render
 * is a single chip: no `Everyone` button, and the chip is not a filter, because
 * a filter with one option is a control that cannot change anything. Choosing
 * it would also *remove* rows — the user's own turns among them — which is a
 * worse outcome than the control simply not being there.
 *
 * ## Sessions that predate the rule still have rosters
 *
 * Two-seat sessions exist and keep working. Where there is genuinely more than
 * one live seat the `Everyone` button and the per-agent panes come back
 * unchanged: the unified timeline stays the default and the truth — one log,
 * one order, which is what makes "what happened here" answerable at all — and
 * selecting an agent filters to its pane rather than opening a second column,
 * because the interleaving is usually the thing you are trying to understand.
 *
 * ## Retired seats
 *
 * A seat replaced by a model change stays visible, greyed and unselectable,
 * below the live one. It is not a chip and cannot be sent to; it is there
 * because the transcript above still carries its name on every row it wrote,
 * and a reader who cannot see what `qwen2.5:7b` was would be reading a
 * conversation with an unexplained second voice.
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

  const live = agents.filter((a) => a.status !== 'retired');
  const retired = agents.filter((a) => a.status === 'retired');
  /*
   * The filter appears only where there is something to filter *between*.
   *
   * Two live seats is a session created before §4.2's cap; one is every session
   * created since. `Everyone` with a single option is noise, and worse than
   * noise — pressed, it is the only state that shows the whole log, so its
   * companion chip is a button whose effect is to hide the user's own turns.
   */
  const filterable = live.length > 1;

  return (
    <div
      data-testid="roster"
      // `shrink-0` for the same reason as every fixed row around the transcript
      // (see SessionHeader): a wrapped flex row is measured one line tall, so
      // without it this was the row the column chose to crush.
      className="border-line flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2"
    >
      {filterable && (
        <button
          type="button"
          className={`btn text-[11px] ${selected === null ? 'border-accent' : ''}`}
          data-testid="roster-all"
          aria-pressed={selected === null}
          onClick={() => onSelect(null)}
        >
          Everyone
        </button>
      )}

      {live.map((agent) => {
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
            {/*
              * A button where it selects something, a plain row where it would
              * not. The same content either way — the testid, the model, the
              * gate — because what a reader needs to see does not depend on how
              * many seats there are; only whether it is *pressable* does.
              */}
            {filterable ? (
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
            ) : (
              <div
                data-testid="roster-agent"
                data-agent={agent.agentId}
                data-role={agent.role}
                className="grid gap-1 px-2 py-1 text-left text-[11px]"
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
              </div>
            )}

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

      {/*
        * What used to be here, so the transcript above stays readable (§4.2).
        *
        * Named rather than counted — "was: lead · qwen2.5:7b" — because the
        * rows it wrote are labelled with that role, and a count would leave the
        * reader matching an unexplained voice to nothing. Not a control: it
        * cannot be selected, sent to, or given an effort, and rendering it as a
        * chip would imply all three.
        */}
      {retired.map((agent) => (
        <span
          key={agent.agentId}
          data-testid="roster-retired"
          data-agent={agent.agentId}
          className={`${LABEL} text-muted`}
          title="This seat was replaced when the session's model changed. Its earlier turns are still in the transcript."
        >
          was: {agent.role} · {agent.spec.model?.modelId ?? agent.spec.runtimeId}
        </span>
      ))}
    </div>
  );
}
