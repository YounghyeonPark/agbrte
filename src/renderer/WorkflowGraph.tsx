/**
 * A workflow, drawn (DESIGN.md §4.4).
 *
 * **One component for the document and for the run.** Today it draws the static
 * shape; when a run exists, the same boxes carry its state, because where a box
 * goes is a function of the document either way and `layoutWorkflow` already
 * decides it. Building this before the runner is §4.4's stated order: a picture
 * of the document is how anyone tells whether the format is right, and a
 * scheduler built first would rest on a shape nobody had looked at.
 *
 * It draws and does not edit. The review of a workflow happens in a diff — that
 * is the whole of §4.4's approval argument — so this answers *what is here*,
 * and the editor that answers *change it* comes next, with this as its left
 * pane.
 *
 * ## Why SVG rather than boxes and a line library
 *
 * The edges are the content. A join — two predecessors meeting at one node — is
 * the thing a session tree cannot express and the reason `needs` exists at all,
 * and it is invisible in any rendering that cannot draw a line. Nothing is
 * measured: `layoutWorkflow` computes every coordinate, so this is a pure
 * function of the document and reflows only when the document changes.
 */

import type { JSX } from 'react';
import type { Workflow } from '../shared/types/index.js';
import { layoutWorkflow, NODE_HEIGHT, NODE_WIDTH } from '../shared/workflow/layout.js';

/**
 * Node ids that could not be used, so the picture agrees with the list above it.
 *
 * A findings list and a clean drawing side by side would make the reader decide
 * which to believe. Marked rather than hidden, for the same reason
 * `validateWorkflow` returns a list rather than throwing: the broken node is the
 * one somebody is looking for.
 */
function refusedNodes(problems: Array<{ node?: string }>): Set<string> {
  return new Set(problems.map((p) => p.node).filter((n): n is string => n !== undefined));
}

/** As much of a name as a fixed box holds, with an ellipsis when it does not. */
function fit(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

export function WorkflowGraph({
  workflow,
  problems = [],
}: {
  workflow: Workflow;
  problems?: Array<{ node?: string; message: string }>;
}): JSX.Element {
  const laid = layoutWorkflow(workflow.nodes);
  const refused = refusedNodes(problems);

  if (laid === null) {
    /*
     * A cycle has no picture. Drawing most of it would say the rest is merely
     * offscreen, and `validateWorkflow` has already named the nodes involved in
     * words — which is the more useful form of the same fact.
     */
    return (
      <p className="text-state-fail text-[12px]" data-testid="workflow-graph-cycle">
        These nodes wait on each other, so there is no order to draw.
      </p>
    );
  }
  if (laid.nodes.length === 0) return <></>;

  return (
    /* Its own scroller. A six-stage pipeline is wider than any pane it will sit
       in, and a graph that widened the page instead would push the list it
       belongs to off the side. */
    <div className="overflow-x-auto" data-testid="workflow-graph" data-nodes={laid.nodes.length}>
      <svg
        width={laid.width}
        height={laid.height}
        viewBox={`0 0 ${laid.width} ${laid.height}`}
        role="img"
        aria-label={`${workflow.name}: ${laid.nodes.length} nodes`}
      >
        <defs>
          <marker
            id="wf-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 1 L 7 4 L 0 7 z" className="fill-line" />
          </marker>
        </defs>

        {/* Edges first, so a box always covers the line arriving at it. */}
        {laid.edges.map((edge) => (
          <path
            key={`${edge.from}->${edge.to}`}
            d={edge.d}
            fill="none"
            className="stroke-line"
            strokeWidth={1.5}
            markerEnd="url(#wf-arrow)"
            data-testid="workflow-edge"
            data-from={edge.from}
            data-to={edge.to}
          />
        ))}

        {laid.nodes.map((node) => {
          const bad = refused.has(node.id);
          return (
            <g key={node.id} data-testid="workflow-node" data-id={node.id} data-ok={bad ? 'no' : 'yes'}>
              <rect
                x={node.x}
                y={node.y}
                width={NODE_WIDTH}
                height={NODE_HEIGHT}
                rx={2}
                /* Spelled out per branch rather than composed, for the reason
                   `CapabilityBadges` gives: a class name built from a variable
                   is invisible to Tailwind's scanner and to
                   `scripts/inert-classes.mjs`, which is how one goes silently
                   dead. */
                className={bad ? 'fill-panel stroke-state-fail' : 'fill-panel stroke-line'}
              />
              <text
                x={node.x + 10}
                y={node.y + 18}
                className="fill-ink text-[11px]"
                data-testid="workflow-node-id"
              >
                {fit(node.id, 18)}
              </text>
              <text x={node.x + 10} y={node.y + 33} className="fill-muted text-[10px]">
                {fit(node.title === node.id ? '' : node.title, 20)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
