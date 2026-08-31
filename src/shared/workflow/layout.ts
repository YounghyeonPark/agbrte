/**
 * Where a workflow's nodes go when it is drawn (DESIGN.md §4.4).
 *
 * Pure, and beside the validator rather than inside the component, for the
 * reason `setupRoutes.ts` gives about the picker: what a graph looks like is a
 * function of the document, and a function of the document can be checked in
 * states nobody's screen is in. It is also the half that will not change when
 * the same component starts drawing a *run* — a running node is the same box
 * with a colour, and where the box goes is decided here either way.
 *
 * ## Layered left to right, because a pipeline reads that way
 *
 * A node's column is the **longest** path to it, not the shortest: with
 * `report` needing both `tests` and `lint`, the shortest path would put it one
 * column after whichever of them was found first and draw an edge running
 * backwards. The longest path puts every node strictly to the right of
 * everything it waits on, which is the property that makes the picture readable
 * — every arrow points the same way.
 *
 * ## Nothing here measures anything
 *
 * Fixed boxes and computed coordinates rather than DOM measurement and a layout
 * effect. Measuring would make this untestable without a browser and would
 * reflow on every render; the cost is that a long name is truncated rather than
 * wrapped, which node ids are already shaped for — §4.4 chose names over
 * generated ids precisely because people write and read these.
 */

import type { WorkflowNode } from '../types/index.js';

/** One box, in the units the SVG uses. */
export const NODE_WIDTH = 148;
export const NODE_HEIGHT = 44;
/** Between columns, which is where the arrows live. */
export const COLUMN_GAP = 64;
export const ROW_GAP = 18;
/** Around the whole drawing, so an arrowhead is not clipped by the viewBox. */
export const PADDING = 12;

export interface PlacedNode {
  id: string;
  title: string;
  /** Column, from zero. Its own facts are decided by the caller. */
  level: number;
  x: number;
  y: number;
}

export interface PlacedEdge {
  from: string;
  to: string;
  /** An SVG path, already in the same coordinates as the boxes. */
  d: string;
}

export interface GraphLayout {
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  width: number;
  height: number;
}

/**
 * Longest-path column for every node, or `null` when the graph has a cycle.
 *
 * `null` rather than a partial drawing: a workflow whose order cannot be decided
 * has no picture, and `validateWorkflow` has already said so in words naming the
 * nodes involved. Drawing most of it would suggest the rest is merely offscreen.
 */
function levels(nodes: WorkflowNode[]): Map<string, number> | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const level = new Map<string, number>();
  // Iterative rather than recursive, and bounded by the node count: a cycle
  // would otherwise be a stack overflow, which is a worse way to report the
  // thing the validator reports properly.
  for (let pass = 0; pass <= nodes.length; pass += 1) {
    let moved = false;
    for (const node of nodes) {
      // Edges to nodes that are not here are ignored, exactly as `topoOrder`
      // ignores them: a dangling `needs` is its own finding, and letting it
      // shift a column would report it twice in two different vocabularies.
      const deps = (node.needs ?? []).filter((d) => byId.has(d) && d !== node.id);
      const want =
        deps.length === 0 ? 0 : Math.max(...deps.map((d) => (level.get(d) ?? 0) + 1));
      if (want !== (level.get(node.id) ?? 0)) {
        level.set(node.id, want);
        moved = true;
      } else if (!level.has(node.id)) {
        level.set(node.id, want);
      }
    }
    if (!moved) return level;
  }
  return null;
}

/**
 * An edge from the right edge of one box to the left edge of another.
 *
 * A cubic with horizontal control points, so a line between two columns leaves
 * and arrives level and the join at `report` reads as two strands meeting rather
 * than two diagonals crossing. Straight lines were tried first and are worse at
 * exactly the shape this exists to draw.
 */
function edgePath(from: PlacedNode, to: PlacedNode): string {
  const x1 = from.x + NODE_WIDTH;
  const y1 = from.y + NODE_HEIGHT / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_HEIGHT / 2;
  const bend = Math.max(18, (x2 - x1) / 2);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

/**
 * Place every node and route every edge, or `null` for a graph with a cycle.
 *
 * Order within a column is the order the document lists them, which is the one
 * thing here a person controls: reordering the nodes in the file reorders the
 * column, and nothing else about the picture moves.
 */
export function layoutWorkflow(nodes: WorkflowNode[]): GraphLayout | null {
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };
  const level = levels(nodes);
  if (level === null) return null;

  const inColumn = new Map<number, number>();
  const placed: PlacedNode[] = nodes.map((node) => {
    const col = level.get(node.id) ?? 0;
    const row = inColumn.get(col) ?? 0;
    inColumn.set(col, row + 1);
    return {
      id: node.id,
      title: node.title,
      level: col,
      x: PADDING + col * (NODE_WIDTH + COLUMN_GAP),
      y: PADDING + row * (NODE_HEIGHT + ROW_GAP),
    };
  });

  const byId = new Map(placed.map((p) => [p.id, p]));
  const edges: PlacedEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.needs ?? []) {
      const from = byId.get(dep);
      const to = byId.get(node.id);
      if (from === undefined || to === undefined || dep === node.id) continue;
      edges.push({ from: dep, to: node.id, d: edgePath(from, to) });
    }
  }

  return {
    nodes: placed,
    edges,
    width: PADDING * 2 + Math.max(...placed.map((p) => p.x + NODE_WIDTH)) - PADDING,
    height: PADDING * 2 + Math.max(...placed.map((p) => p.y + NODE_HEIGHT)) - PADDING,
  };
}
