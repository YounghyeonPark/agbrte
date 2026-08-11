/**
 * What a runtime can actually do, here (DESIGN.md §3.13).
 *
 * > Results publish as a **support matrix in the app**, so choosing a runtime
 * > shows what it can actually do here.
 *
 * Shown beside the runtime picker, because that is the moment the question is
 * being asked. One column at a time — the runtime you are about to choose —
 * rather than the whole grid: a 24-row table across five runtimes is a document,
 * and what is needed here is an answer.
 *
 * **Every state gets a word, not just a colour.** Six statuses reduced to red
 * and green would be exactly the collapse §3.13 forbids, and would also be
 * unreadable to anyone who does not see the difference. The colour is a second
 * channel, never the only one.
 */

import type { JSX } from 'react';
import { CONFORMANCE_SCENARIOS, type CellStatus, type MatrixCell } from '@shared/types/index.js';

/** Label and tone per status. The label is what carries the meaning. */
const LOOK: Readonly<Record<CellStatus, { label: string; className: string }>> = {
  verified: { label: 'verified', className: 'bg-emerald-500/15 text-emerald-300' },
  failed: { label: 'failing', className: 'bg-red-500/20 text-red-300' },
  stale: { label: 'stale', className: 'bg-amber-500/15 text-amber-300' },
  declared: { label: 'claimed', className: 'bg-sky-500/10 text-sky-300' },
  unsupported: { label: 'not supported', className: 'bg-white/5 text-muted' },
  'not-run': { label: 'not run', className: 'bg-white/5 text-muted' },
};

/** How a pass was earned, in the words a reader can act on. */
const EVIDENCE_WORDS: Readonly<Record<string, string>> = {
  'scripted-fixture': 'against a scripted response',
  'in-process': 'in process, across a real protocol',
  'real-subprocess': 'against a real subprocess',
  'live-endpoint': 'against a live endpoint',
};

export function SupportMatrix({
  cells,
  runtimeId,
}: {
  cells: MatrixCell[];
  runtimeId: string;
}): JSX.Element | null {
  const mine = cells.filter((c) => c.runtimeId === runtimeId);
  if (mine.length === 0) return null;

  const byId = new Map(mine.map((c) => [c.scenarioId, c]));
  const verified = mine.filter((c) => c.status === 'verified').length;
  const failing = mine.filter((c) => c.status === 'failed').length;

  return (
    <details className="rounded border border-white/10" data-testid="support-matrix">
      <summary className="text-muted cursor-pointer px-3 py-2 text-xs">
        {/* The headline counts only what ran. A runtime that declares everything
            and proves nothing must not read as the best-covered one. */}
        {verified} of {mine.length} scenarios verified
        {failing > 0 ? ` · ${failing} failing` : ''}
      </summary>

      <ul className="grid gap-px border-t border-white/10">
        {CONFORMANCE_SCENARIOS.map((scenario) => {
          const cell = byId.get(scenario.id);
          if (cell === undefined) return null;
          const look = LOOK[cell.status];
          return (
            <li
              key={scenario.id}
              className="flex items-start justify-between gap-3 px-3 py-2"
              data-testid={`scenario-${scenario.id}`}
            >
              <span className="grid gap-1">
                <span className="text-xs">{scenario.title}</span>
                <small className="text-muted text-[11px]">
                  {cell.detail ??
                    (cell.status === 'verified' && cell.evidence !== undefined
                      ? EVIDENCE_WORDS[cell.evidence]
                      : scenario.why)}
                </small>
              </span>
              <span
                className={`shrink-0 rounded px-2 py-1 text-[11px] ${look.className}`}
                data-status={cell.status}
              >
                {look.label}
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
