/**
 * Drawing on a capture before it is sent (DESIGN.md §12.3).
 *
 * > Rectangle, arrow, freehand, text label, blackout, crop.
 *
 * The surface, and only the surface. Every decision is made in main: what gets
 * painted into the bytes, what stays a vector, what is stored and where. This
 * file collects gestures and hands them over.
 *
 * ## It draws on a preview, and reports in the preview's pixels
 *
 * The stored frame can be 2560px wide; sending that to a renderer per capture
 * would be felt. So main returns a downscaled rendering and remembers how wide
 * it made it, and the marks come back in *those* coordinates to be converted on
 * the side that knows both numbers. The alternative — scaling here — is the same
 * mistake the region overlay avoids, and it fails the same way: a rectangle in
 * the right place around the wrong thing.
 *
 * ## Nothing is stored until Attach
 *
 * The frame is held in main, unwritten, for exactly this window. §12.1 promises
 * the unredacted frame never reaches disk and §12.3 wants it editable first;
 * both hold only because the store happens after this component is done.
 * Cancelling therefore has to *say so* — `discard` is not tidiness, it is the
 * difference between a screenshot of somebody's desktop living five more
 * minutes and living none.
 */

import { useEffect, useRef, useState, type JSX, type PointerEvent } from 'react';
import type { CapturePreviewDto } from '@shared/ipc/contract.js';
import type { Annotation, AnnotationColour } from '@shared/types/index.js';

const agbrte = (): Window['agbrte'] => window.agbrte;

type Tool = 'blackout' | 'rectangle' | 'arrow' | 'freehand';

const TOOLS: ReadonlyArray<{ id: Tool; label: string; hint: string }> = [
  // Blackout first, and not alphabetically: it is the only one that changes the
  // bytes, the only one that cannot be undone after Attach, and the reason this
  // surface exists before the store rather than after it.
  { id: 'blackout', label: 'Black out', hint: 'Painted into the image. Cannot be undone once sent.' },
  { id: 'rectangle', label: 'Box', hint: 'Stays editable; the original is kept.' },
  { id: 'arrow', label: 'Arrow', hint: 'Described by its tip, which is what a model attends to.' },
  { id: 'freehand', label: 'Draw', hint: 'Stays editable; the original is kept.' },
];

const COLOURS: readonly AnnotationColour[] = ['red', 'yellow', 'green', 'blue', 'white'];

const CSS: Readonly<Record<AnnotationColour, string>> = {
  red: '#ff3b30',
  yellow: '#ffd60a',
  green: '#34c759',
  blue: '#0a84ff',
  white: '#ffffff',
  black: '#000000',
};

interface Drag {
  from: { x: number; y: number };
  to: { x: number; y: number };
  points: Array<{ x: number; y: number }>;
}

export function Annotator({
  capture,
  sessionId,
  onAttached,
  onClose,
}: {
  capture: CapturePreviewDto;
  sessionId: string;
  onAttached: (block: import('@shared/types/index.js').ImageBlock, scanned: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const [tool, setTool] = useState<Tool>('blackout');
  const [colour, setColour] = useState<AnnotationColour>('red');
  const [marks, setMarks] = useState<Annotation[]>([]);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  /**
   * The held frame outlives this component unless somebody says otherwise.
   *
   * Registered as an unmount effect rather than only on the Cancel button,
   * because the window closing and the user pressing Escape are the same event
   * as far as the frame is concerned — and the button is the path least likely
   * to be missed.
   */
  const attached = useRef(false);
  useEffect(
    () => () => {
      if (!attached.current) void agbrte().capture.discard(capture.pendingId);
    },
    [capture.pendingId],
  );

  const at = (e: PointerEvent): { x: number; y: number } => {
    const box = surface.current!.getBoundingClientRect();
    // Reported in the preview's own pixels, which is what main expects — the
    // element may be laid out at a different size than the image it shows.
    return {
      x: ((e.clientX - box.left) / box.width) * capture.preview.width,
      y: ((e.clientY - box.top) / box.height) * capture.preview.height,
    };
  };

  const finish = (d: Drag): void => {
    const rect = {
      x: Math.min(d.from.x, d.to.x),
      y: Math.min(d.from.y, d.to.y),
      w: Math.abs(d.to.x - d.from.x),
      h: Math.abs(d.to.y - d.from.y),
    };
    // A click is not a mark. Without this every stray tap leaves a zero-sized
    // rectangle in the vector list and a line in the description about nothing.
    if (tool !== 'freehand' && rect.w < 4 && rect.h < 4) return;

    const mark: Annotation =
      tool === 'blackout'
        ? { kind: 'blackout', rect }
        : tool === 'rectangle'
          ? { kind: 'rectangle', colour, rect }
          : tool === 'arrow'
            ? { kind: 'arrow', colour, from: d.from, to: d.to }
            : { kind: 'freehand', colour, points: d.points };

    if (tool === 'freehand' && d.points.length < 2) return;
    setMarks((prev) => [...prev, mark]);
  };

  const attach = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await agbrte().capture.commit({
        pendingId: capture.pendingId,
        sessionId,
        ...(marks.length > 0 ? { annotations: marks } : {}),
      });
      attached.current = true;
      onAttached(result.block, result.scanned);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const blackouts = marks.filter((m) => m.kind === 'blackout').length;

  return (
    <div className="bg-panel border-line absolute bottom-full left-4 z-10 mb-2 w-[46rem] rounded border p-3 shadow-lg">
      <div className="mb-2 flex items-center gap-2">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            title={t.hint}
            data-testid={`tool-${t.id}`}
            className={`btn-quiet text-xs ${tool === t.id ? 'text-accent' : ''}`}
            onClick={() => setTool(t.id)}
          >
            {t.label}
          </button>
        ))}

        <span className="ml-1 flex items-center gap-1">
          {COLOURS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={c}
              className={`h-4 w-4 rounded-full border ${colour === c ? 'border-fg' : 'border-line'}`}
              style={{ background: CSS[c] }}
              onClick={() => setColour(c)}
            />
          ))}
        </span>

        <span className="ml-auto flex items-center gap-2">
          {marks.length > 0 && (
            <button
              type="button"
              className="btn-quiet text-xs"
              onClick={() => setMarks((prev) => prev.slice(0, -1))}
            >
              Undo
            </button>
          )}
          <button type="button" className="btn-quiet text-xs" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn text-xs"
            data-testid="annotator-attach"
            disabled={busy}
            onClick={() => void attach()}
          >
            {busy ? 'Attaching…' : 'Attach'}
          </button>
        </span>
      </div>

      {error !== null && <p className="text-state-failed mb-2 text-xs">{error}</p>}

      <div
        ref={surface}
        className="relative select-none"
        style={{ cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = at(e);
          setDrag({ from: p, to: p, points: [p] });
        }}
        onPointerMove={(e) => {
          if (drag === null) return;
          const p = at(e);
          setDrag({ ...drag, to: p, points: [...drag.points, p] });
        }}
        onPointerUp={() => {
          if (drag !== null) finish(drag);
          setDrag(null);
        }}
      >
        <img src={capture.preview.dataUrl} alt="" className="block w-full" draggable={false} />
        <svg
          className="pointer-events-none absolute inset-0 h-full w-full"
          viewBox={`0 0 ${capture.preview.width} ${capture.preview.height}`}
          preserveAspectRatio="none"
        >
          {[...marks, ...(drag === null ? [] : [previewOf(drag, tool, colour)])].map((m, i) => (
            <Mark key={i} mark={m} />
          ))}
        </svg>
      </div>

      <p className="text-muted mt-2 text-xs">
        {capture.stored.width}×{capture.stored.height}
        {/* Named plainly, because it is the one irreversible thing on this
            surface and the moment to say so is before Attach, not after. */}
        {blackouts > 0 &&
          ` · ${blackouts} blackout${blackouts > 1 ? 's' : ''} will be painted into the stored image`}
      </p>
    </div>
  );
}

/** The mark being dragged right now, so the hand gets feedback. */
function previewOf(drag: Drag, tool: Tool, colour: AnnotationColour): Annotation {
  const rect = {
    x: Math.min(drag.from.x, drag.to.x),
    y: Math.min(drag.from.y, drag.to.y),
    w: Math.abs(drag.to.x - drag.from.x),
    h: Math.abs(drag.to.y - drag.from.y),
  };
  if (tool === 'blackout') return { kind: 'blackout', rect };
  if (tool === 'rectangle') return { kind: 'rectangle', colour, rect };
  if (tool === 'arrow') return { kind: 'arrow', colour, from: drag.from, to: drag.to };
  return { kind: 'freehand', colour, points: drag.points };
}

function Mark({ mark }: { mark: Annotation }): JSX.Element | null {
  switch (mark.kind) {
    case 'blackout':
      // Opaque here as well as in the bytes. A translucent preview of a
      // blackout would show the user something readable and store something
      // that is not, which is the wrong direction for this particular tool to
      // be wrong in.
      return <rect x={mark.rect.x} y={mark.rect.y} width={mark.rect.w} height={mark.rect.h} fill="#000" />;
    case 'rectangle':
      return (
        <rect
          x={mark.rect.x}
          y={mark.rect.y}
          width={mark.rect.w}
          height={mark.rect.h}
          fill="none"
          stroke={CSS[mark.colour]}
          strokeWidth={3}
        />
      );
    case 'arrow':
      return (
        <g stroke={CSS[mark.colour]} strokeWidth={3} fill="none">
          <line x1={mark.from.x} y1={mark.from.y} x2={mark.to.x} y2={mark.to.y} />
          <circle cx={mark.to.x} cy={mark.to.y} r={5} fill={CSS[mark.colour]} />
        </g>
      );
    case 'freehand':
      return (
        <polyline
          points={mark.points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={CSS[mark.colour]}
          strokeWidth={3}
        />
      );
    default:
      return null;
  }
}
