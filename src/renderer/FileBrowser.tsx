/**
 * The workspace a session is working on (DESIGN.md §6.6, §7).
 *
 * ## The case this exists for is the remote one
 *
 * A session on a build box edits files on that box. The transcript names them,
 * the diffs quote them, and until this existed there was no way to *look* at
 * one — the workspace was a path in a header. So the listing is asked of the
 * host, exactly like `preview.detect` and `shell.open`, and the local case falls
 * out for free rather than being the case the feature was built around.
 *
 * ## Two rails, right of the pane
 *
 * `FileBrowser` is the tree and `FileViewer` is one file, and they are two
 * *columns* rather than two states of one: main pane | file tree | file viewer,
 * left to right. The arrangement is the feature. A file opened *into* the pane
 * replaced the transcript, so reading a file and reading what the agent said
 * about it were alternatives — and the reason to open a file mid-session is
 * almost always that a line of the transcript just named it.
 *
 * Each rail collapses on its own: the tree from the `Files` toggle, the viewer
 * from its own close control, and closing either returns its width to the
 * transcript rather than to the other rail. That independence is what two pieces
 * of state buy over one — browsing with no file open, and reading a file with
 * the tree put away, are both ordinary.
 *
 * ## Expanding is a request, and the shape refuses to hide that
 *
 * One directory per call, fetched when a folder is opened and **dropped when it
 * is closed**. No prefetch, no recursive walk, and nothing held for a folder
 * that is not on screen. Two reasons, and the second is the one that decided it:
 *
 *  - A recursive listing of `node_modules` over ssh is a hang with nothing to
 *    explain it. There is no parameter here that could ask for one.
 *  - §7 forbids the renderer holding an unbounded projection. A tree that kept
 *    every listing it had ever fetched would be `events.push(...)` with a
 *    different name — a week-long session where somebody browsed would grow
 *    without a bound anybody had chosen. Bounded here by *what is expanded*,
 *    and each node is bounded by the host's own entry cap.
 *
 * Measured rather than assumed, driving the real app: forty expand/collapse
 * cycles over twelve 500-entry folders — 960 clicks — moved the renderer heap
 * from 5.88 MB to 6.25 MB, both read with everything collapsed and a GC forced
 * first, and re-expanding all twelve then took it to 7.33 MB. So what is held
 * tracks what is open and comes back when it closes, which is the bound. The
 * 0.37 MB the cycling left behind is not a per-cycle cost — 480 of those would
 * be impossible to miss. The rows themselves are windowed (see `Rows`), because
 * the DOM is part of what the renderer holds.
 *
 * ## A cap that bites says so
 *
 * `truncated` is a count, so the row reads "20 more — this host lists 500 per
 * folder" rather than a directory that silently appears to hold exactly 500
 * things. The same applies to a file: an oversized or binary file comes back as
 * a *refusal with a name on it*, and the rail prints the host's sentence instead
 * of an empty box.
 *
 * ## Nothing here is a session event
 *
 * No `AgbrteEvent` is written, the turn queue is untouched, and the transcript is
 * identical afterwards. It is also not §13-gated, and that is worth stating
 * where somebody would otherwise wonder: §13 covers what a **model** asks the
 * app for — an agent reading a file goes through the `read` tool and the
 * session's policy. This is a person looking at their own workspace, and asking
 * them to approve their own click is the prompt-fatigue §13 warns about.
 */

import { useCallback, useEffect, useState, type CSSProperties, type JSX } from 'react';
import type { DirListing, WorkspaceEntry } from '@shared/types/index.js';

/**
 * Where three columns stop fitting, and what the rails do below it.
 *
 * `lg` (1024px) rather than `md`, and the number came from the layout rather
 * than from taste: the host sidebar is a fixed 300px, so an `md` window (768px)
 * leaves the session column 468px — less than the viewer's floor and the tree
 * together, before the transcript gets anything at all. Three columns need about
 * 1024px to exist, and the app's own window opens at 1180.
 *
 * Below that the rails are **overlays, one at a time**, and they cover the whole
 * session column rather than only the transcript. Covering all of it is what
 * keeps the mode toggle honest: that row is the app's statement of what is in
 * the main pane, and a rail that hid the transcript while leaving `Chat` lit
 * would make the one piece of chrome whose job is to say "what am I looking at"
 * wrong exactly when it matters. Off screen it cannot say anything, and the
 * rail's own header says what it is.
 *
 * `absolute` against `main` rather than against the row: the row is
 * `overflow-hidden`, and an absolutely positioned box is not clipped by an
 * ancestor that sits *below* its containing block — which is what lets one class
 * list be a column at `lg` and a full-pane overlay under it.
 *
 * Expressed as `lg:` variants and nowhere else — no `matchMedia`, no width in
 * state. A breakpoint duplicated in JavaScript is a breakpoint that drifts from
 * the stylesheet, and the drift shows up at exactly one window size.
 */
const RAIL_OVERLAY = 'absolute inset-0 z-20 w-full lg:relative lg:inset-auto lg:z-auto';

/** Bytes, in the shortest form that is still honest about the magnitude. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One expanded directory's state.
 *
 * `listing: null` while in flight, so a folder opened over a slow link says
 * *listing…* rather than looking empty — the difference between "this folder has
 * nothing in it" and "we have not heard back" is the whole reason the remote
 * case was unusable before.
 */
interface Node {
  listing: DirListing | null;
  error: string | null;
}

export function FileBrowser({
  instanceId,
  selected,
  onOpenFile,
  onClose,
}: {
  instanceId: string;
  /** The path currently in the viewer rail, so the tree can mark it. */
  selected: string | null;
  onOpenFile: (path: string) => void;
  onClose: () => void;
}): JSX.Element {
  // Keyed by workspace-relative path; `''` is the root, which is always open.
  const [nodes, setNodes] = useState<Record<string, Node>>({});

  const load = useCallback(
    (path: string): void => {
      setNodes((current) => ({ ...current, [path]: { listing: null, error: null } }));
      void window.agbrte.files.list({ instanceId, path }).then(
        (listing) => setNodes((current) => ({ ...current, [path]: { listing, error: null } })),
        (err: unknown) =>
          setNodes((current) => ({ ...current, [path]: { listing: null, error: message(err) } })),
      );
    },
    [instanceId],
  );

  /*
   * The root, re-fetched when the host changes.
   *
   * Everything else is dropped with it: a tree of paths from one workspace has
   * no meaning in another, and carrying it over would render one machine's
   * folders under another machine's root.
   */
  useEffect(() => {
    setNodes({});
    load('');
  }, [instanceId, load]);

  const toggle = (path: string): void => {
    if (nodes[path] !== undefined) {
      // Collapsing drops the listing, and everything under it. Held state should
      // match what is on screen; a cache of closed folders is memory nobody
      // asked for and a stale answer waiting to be shown on the next open.
      setNodes((current) => {
        const next = { ...current };
        for (const key of Object.keys(next)) {
          if (key === path || key.startsWith(`${path}/`)) delete next[key];
        }
        return next;
      });
      return;
    }
    load(path);
  };

  return (
    /*
     * A column *beside* the pane, not a row above it.
     *
     * That is a layout decision with a rule behind it: fixed rows in the session
     * column must hold their height, and the transcript is the only child
     * allowed to give any up (see `SessionHeader`). A rail placed in that stack
     * would take height from the transcript on every session, whether or not it
     * was being used. In the horizontal row it takes width and no height at all,
     * and its own scroll keeps a 500-entry directory inside itself rather than
     * stretching the row.
     *
     * `hidden lg:flex` while a file is open is the narrow-window rule: below
     * `lg` the rails overlay one at a time, and the one that wins is the one
     * just asked for by name. Closing the file brings the tree straight back —
     * the toggle was never turned off, so nothing has to be pressed twice.
     */
    <aside
      data-testid="file-browser"
      className={`border-line bg-bg ${RAIL_OVERLAY} min-h-0 shrink-0 flex-col overflow-hidden border-l lg:w-56 ${
        selected !== null ? 'hidden lg:flex' : 'flex'
      }`}
    >
      <div className="border-line flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-muted text-[11px] tracking-wider uppercase">Files</span>
        <button
          className="btn-quiet text-[11px]"
          data-testid="file-browser-close"
          title="Hide the file tree"
          onClick={onClose}
        >
          hide
        </button>
      </div>
      <Rows
        rows={flatten('', 0, nodes)}
        selected={selected}
        onToggle={toggle}
        onOpenFile={onOpenFile}
      />
    </aside>
  );
}

// ------------------------------------------------------------------- rendering

/**
 * The tree, flattened to the rows a person can actually see.
 *
 * Two shapes: an entry, and a *note* — listing, empty, an error, or the "N more"
 * that says a cap bit. Notes are rows rather than something appended outside the
 * list, because the windowing below can only skip what it can count, and a note
 * living outside the row array would be the one element that rendered no matter
 * how far off screen it was.
 */
type Row =
  | { kind: 'entry'; key: string; depth: number; entry: WorkspaceEntry; expanded: boolean }
  | {
      kind: 'note';
      key: string;
      depth: number;
      text: string;
      testid: string;
      tone: 'muted' | 'fail';
    };

/** Row height in pixels, pinned by `h-5` on every row so windowing is arithmetic. */
const ROW_H = 20;

/** Rows kept above and below the viewport, so a fast scroll is never blank. */
const OVERSCAN = 12;

/**
 * Depth-first over what is expanded — and only over what is expanded.
 *
 * The recursion is in the *renderer*, walking state already in hand; the host is
 * never asked to walk anything. Recomputed per render rather than memoized: the
 * array is bounded by the folders somebody opened by hand, each of those by the
 * host's own 500-entry cap, and a memo would be a second copy of the tree to
 * keep in step with the first.
 */
function flatten(path: string, depth: number, nodes: Record<string, Node>): Row[] {
  const node = nodes[path];
  if (node === undefined) return [];

  if (node.error !== null) {
    return [
      {
        kind: 'note',
        key: `${path}!err`,
        depth,
        text: node.error,
        testid: 'file-tree-error',
        tone: 'fail',
      },
    ];
  }
  if (node.listing === null) {
    return [
      {
        kind: 'note',
        key: `${path}!load`,
        depth,
        text: 'listing…',
        testid: 'file-tree-loading',
        tone: 'muted',
      },
    ];
  }

  const { entries, truncated, limit } = node.listing;
  if (entries.length === 0) {
    return [
      {
        kind: 'note',
        key: `${path}!empty`,
        depth,
        text: 'empty',
        testid: 'file-tree-empty',
        tone: 'muted',
      },
    ];
  }

  const rows: Row[] = [];
  for (const entry of entries) {
    const expanded = nodes[entry.path] !== undefined;
    rows.push({ kind: 'entry', key: entry.path, depth, entry, expanded });
    if (entry.kind === 'dir' && expanded) rows.push(...flatten(entry.path, depth + 1, nodes));
  }
  if (truncated > 0) {
    /* The cap, said out loud. A directory that stopped at 500 and did not
       mention it is a directory that looks like it holds exactly 500 things, and
       somebody hunting the file that is not there has no way to learn it was the
       browser rather than the repo. */
    rows.push({
      kind: 'note',
      key: `${path}!cap`,
      depth,
      text: `${truncated} more — this host lists ${limit} per folder`,
      testid: 'file-tree-truncated',
      tone: 'muted',
    });
  }
  return rows;
}

/**
 * A windowed list, because §7's rule about unbounded projections is about what
 * the renderer *holds*, and the DOM is part of what it holds.
 *
 * Re-measured for the two-rail layout, rather than carried over: the window is
 * arithmetic on a box that changed shape and position, and a figure taken
 * against the old box would be a claim about a box that no longer exists.
 *
 * Twelve 500-entry folders and a six-deep nest expanded at once — **6,028 rows
 * of state** — with both rails open, driving the real app, `querySelectorAll('*')`
 * for the element counts and a GC forced through CDP before each
 * `Runtime.getHeapUsage`. The right column is a second run of the same script
 * against the same tree, with this window taken out and the app rebuilt for it:
 *
 *                          windowed      every row rendered
 *     elements in the page       232                  24,194
 *     ⌐ inside this rail         135                  24,097
 *     rows rendered               34                   6,028
 *     renderer heap          6.78 MB                19.39 MB
 *     scroll to the end        36 ms                  205 ms
 *
 * Unwindowed it *worked* — Chromium is not fragile — but it scaled with how much
 * somebody had clicked, and "fine at twelve folders" is not a bound. 200 ms to
 * move a scrollbar is also the difference between dragging and waiting.
 *
 * Closing the viewer rail beside it changes none of the left column — 135 rail
 * elements and 34 rows either way — because this rail's height does not depend
 * on the other one. That is the horizontal row's property, measured rather than
 * assumed, and the number this whole file most wants to be told about if it ever
 * starts moving.
 *
 * Fixed row height rather than measured, which is the simplification that makes
 * this forty lines rather than a dependency: every row is `h-5`, so row *n* sits
 * at `n * ROW_H` and there is nothing to cache or invalidate. The two spacers
 * hold the scrollbar at the full height, so the position and the thumb are real.
 */
function Rows({
  rows,
  selected,
  onToggle,
  onOpenFile,
}: {
  rows: Row[];
  selected: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const [scrollTop, setScrollTop] = useState(0);
  /*
   * Starts tall rather than at zero.
   *
   * The height is not known until the element is measured, and a first render
   * believing the viewport was zero pixels would paint an empty rail and then
   * fill it — a flash every time it opens. Over-rendering for one frame is the
   * cheaper mistake.
   */
  const [viewport, setViewport] = useState(800);
  const [box, setBox] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (box === null) return undefined;
    setViewport(box.clientHeight);
    // The rail is resized by the window, by itself opening, by the viewer rail
    // opening beside it, and by the roster wrapping to a second line — none of
    // which is a scroll or a React update, so an observer is the only thing that
    // sees all four.
    const observer = new ResizeObserver(() => setViewport(box.clientHeight));
    observer.observe(box);
    return () => observer.disconnect();
  }, [box]);

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewport) / ROW_H) + OVERSCAN);
  const shown = rows.slice(first, last);

  return (
    <div
      ref={setBox}
      data-testid="file-tree"
      className="min-h-0 flex-1 overflow-y-auto px-1 py-1"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: `${first * ROW_H}px` }} />
      {shown.map((row) =>
        row.kind === 'note' ? (
          <p
            key={row.key}
            data-testid={row.testid}
            className={`truncate-line flex h-5 items-center px-2 text-[11px] ${
              row.tone === 'fail' ? 'text-state-fail' : 'text-muted italic'
            }`}
            style={{ paddingLeft: `${8 + row.depth * 10}px` }}
            title={row.text}
          >
            {row.text}
          </p>
        ) : (
          <Row
            key={row.key}
            entry={row.entry}
            depth={row.depth}
            expanded={row.expanded}
            selected={selected === row.entry.path}
            onToggle={onToggle}
            onOpenFile={onOpenFile}
          />
        ),
      )}
      <div style={{ height: `${(rows.length - last) * ROW_H}px` }} />
    </div>
  );
}

/** One row, at exactly `ROW_H` so the window above can do arithmetic on it. */
function Row({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
  onOpenFile,
}: {
  entry: WorkspaceEntry;
  depth: number;
  expanded: boolean;
  selected: boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}): JSX.Element {
  const openable = entry.kind === 'dir' || entry.kind === 'file';

  return (
    <button
      data-testid={entry.kind === 'dir' ? 'file-tree-dir' : 'file-tree-file'}
      data-path={entry.path}
      className={`flex h-5 w-full items-center gap-1 rounded-mark px-2 text-left text-[11px] ${
        selected ? 'bg-panel text-ink' : 'text-muted hover:text-ink'
      } ${openable ? '' : 'cursor-default opacity-60'}`}
      style={{ paddingLeft: `${8 + depth * 10}px` }}
      aria-expanded={entry.kind === 'dir' ? expanded : undefined}
      title={
        entry.kind === 'link'
          ? // Not followed on purpose: the target is decided on the host, may
            // leave the workspace, and would be refused on the click — so it is
            // shown rather than offered as a control that fails.
            `${entry.path} — a link, not followed`
          : entry.kind === 'other'
            ? `${entry.path} — not a file or a folder`
            : entry.path
      }
      disabled={!openable}
      onClick={() => {
        if (entry.kind === 'dir') onToggle(entry.path);
        else if (entry.kind === 'file') onOpenFile(entry.path);
      }}
    >
      <span className="shrink-0 font-mono">
        {entry.kind === 'dir' ? (expanded ? '▾' : '▸') : entry.kind === 'link' ? '↗' : ' '}
      </span>
      <span className="truncate-line min-w-0 flex-1">{entry.name}</span>
      {entry.size !== undefined && (
        <span className="shrink-0 text-[10px] opacity-70">{humanSize(entry.size)}</span>
      )}
    </button>
  );
}

// ------------------------------------------------------------------ the viewer

/**
 * The viewer rail's width, in pixels.
 *
 * `MIN` is the number this rail exists to defend. The tree is 224px and that is
 * right for names; a *code* file at 224px wraps or clips at about thirty
 * columns, which is not reading — it is confirming that a file exists. 320px is
 * roughly 47 monospace columns at 11px, which holds an import line and most
 * signatures, and it is the width below which the rail should be closed rather
 * than kept.
 *
 * `DEFAULT` is wider than `MIN` on purpose: opening a file should land on
 * something readable, not on the floor. 384px is 58 columns, and at the app's
 * own 1180px window it measures 224 tree + 384 file + **256 transcript** with
 * everything open — narrow, and still a transcript you can read *while* you read
 * the file, which is the arrangement's whole claim. Hiding the tree makes it
 * 480.
 *
 * The other end of the range is not a percentage but a *floor under the
 * transcript*: `lg:min-w-44` on the pane, with this rail shrinkable above its
 * own 320. A percentage cap was tried first and got the trade backwards — it
 * pinned the file at 45% of the row whether or not anybody was reading the
 * transcript, so somebody who wanted the tree closed and the file wide could not
 * have it. As a floor the rail takes whatever it is dragged to and the
 * transcript keeps 176px, which is the width at which it stops being a column of
 * text at all. The three minima add to 720 and the narrowest row that reaches
 * them is 724, so the layout is never over-constrained above `lg`.
 */
const VIEWER_MIN = 320;
const VIEWER_MAX = 1200;
export const VIEWER_DEFAULT = 384;

/** Keeps a dragged or nudged width inside the range above. */
function clampWidth(px: number): number {
  return Math.max(VIEWER_MIN, Math.min(VIEWER_MAX, Math.round(px)));
}

/**
 * One file, in a rail of its own to the right of the tree.
 *
 * **A column rather than a pane mode**, which is the change that retired a
 * fourth `sessionPane` value. As a mode it was an *alternative* to the
 * transcript: you could read `sessionManager.ts` or read what the agent said
 * about it, never both, and the reason to open a file mid-session is almost
 * always that a line of the transcript just named it. As a column both are on
 * screen, the mode toggle goes back to describing only the main pane, and the
 * `File` entry that used to sit in that row — a mode that existed only after a
 * click somewhere else — is gone rather than left dead.
 *
 * The width is the caller's, not this component's: a rail dragged wider must
 * still be that wide after this file is closed and another opened, and state
 * that lives here dies with the unmount. See `viewerWidth` in `App`.
 */
export function FileViewer({
  instanceId,
  path,
  width,
  onWidth,
  onClose,
}: {
  instanceId: string;
  path: string;
  width: number;
  onWidth: (px: number) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState<string | null>(null);
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    void window.agbrte.files.read({ instanceId, path }).then(
      (preview) => {
        // A reply for a file nobody is looking at any more is dropped rather
        // than rendered: clicking twice quickly must not paint the first file
        // under the second one's name.
        if (!live) return;
        setText(preview.text);
        setBytes(preview.bytes);
      },
      (err: unknown) => {
        if (!live) return;
        // The host's own sentence, not a generic failure. `FileTooLarge` and
        // `FileNotText` are refusals with a reason and a remedy in them, and
        // replacing them with "could not open file" would throw that away.
        setError(message(err));
      },
    );
    return () => {
      live = false;
    };
  }, [instanceId, path]);

  /*
   * The width as a custom property, rather than as `style.width`.
   *
   * Below `lg` this rail is `absolute inset-0` and must be full width; an inline
   * `width` would beat every class, and an over-constrained absolute box drops
   * `right` — so a phone would get a 448px rail pinned to the left edge with the
   * transcript showing beside it. As a variable the number is only *read*, by
   * `lg:w-[var(--viewer-w)]`, so the breakpoint still decides the layout and the
   * drag only decides a number.
   */
  const railWidth = { '--viewer-w': `${width}px` } as CSSProperties;

  return (
    <aside
      data-testid="file-viewer"
      style={railWidth}
      className={`border-line bg-bg ${RAIL_OVERLAY} flex min-h-0 shrink flex-col overflow-hidden border-l lg:w-[var(--viewer-w)] lg:min-w-80`}
    >
      {/*
        The drag handle, and the reason this rail is resizable at all.

        A file viewer has no right width. 320px reads an import list, 700px reads
        a function with its arguments on one line, and which of those somebody
        wants changes between two clicks in the same session — so the alternative
        to a handle is not "a better default", it is picking a side in an
        argument the user is having with themselves. The transcript absorbs
        whatever this takes, down to the floor it keeps for itself; past that the
        `shrink` here is what gives way, so a drag can never push the layout
        wider than the window.

        Hidden below `lg`, where the rail is a full-width overlay and there is
        nothing to resize. Keyboard-operable, because a drag handle that answers
        only to a mouse is a control some people simply do not have — and it
        lights on `focus-visible` as well as on hover, because the app's global
        focus ring is scoped to buttons and fields and would have left this the
        one control a keyboard could reach and not see.

        At rest the mark is the rail's own `border-l`: the strip is six pixels of
        hit area over a line that is already drawn, rather than a second line
        beside it. The cursor is what promises the drag, which is the one place
        this file leans on a convention instead of a mark.
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the file viewer"
        aria-valuenow={width}
        aria-valuemin={VIEWER_MIN}
        aria-valuemax={VIEWER_MAX}
        tabIndex={0}
        data-testid="file-viewer-resize"
        title="Drag, or ← →, to resize"
        className="hover:bg-accent focus-visible:bg-accent absolute inset-y-0 left-0 z-10 hidden w-1.5 cursor-col-resize touch-none lg:block"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') onWidth(clampWidth(width + 16));
          else if (e.key === 'ArrowRight') onWidth(clampWidth(width - 16));
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          /* Pointer capture rather than listeners on `window`: the moves arrive
             here even while the pointer is over the transcript, and a drag that
             ends off screen — or with this rail unmounted out from under it —
             takes its listeners with it instead of leaving them behind. */
          e.preventDefault();
          const handle = e.currentTarget;
          const startX = e.clientX;
          const startWidth = width;
          handle.setPointerCapture(e.pointerId);
          // Leftwards widens: this rail's left edge is what is being dragged.
          const move = (ev: PointerEvent): void =>
            onWidth(clampWidth(startWidth + (startX - ev.clientX)));
          const stop = (): void => {
            handle.releasePointerCapture(e.pointerId);
            handle.removeEventListener('pointermove', move);
            handle.removeEventListener('pointerup', stop);
            handle.removeEventListener('pointercancel', stop);
          };
          handle.addEventListener('pointermove', move);
          handle.addEventListener('pointerup', stop);
          handle.addEventListener('pointercancel', stop);
        }}
      />
      <div className="border-line flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-muted text-[11px] tracking-wider uppercase">File</span>
        <button
          className="btn-quiet text-[11px]"
          data-testid="file-viewer-close"
          title="Close the file and give the width back to the transcript"
          onClick={onClose}
        >
          close
        </button>
      </div>
      {/* Two lines rather than one: in a 320px rail a path, a size and a
          disclaimer on one row is three ellipses, and the path is the one of the
          three somebody is checking. */}
      <div className="border-line shrink-0 border-b px-3 py-1.5">
        <p
          data-testid="file-viewer-path"
          className="text-ink truncate-line font-mono text-[11px]"
          /* The whole path, for the rail too narrow to hold it: `src/…/index.ts`
             is not an answer to "which file am I looking at". */
          title={path}
        >
          {path}
        </p>
        <p className="text-muted text-[10px]">
          {text !== null && `${humanSize(bytes)} · `}read-only · not in the transcript
        </p>
      </div>
      {error !== null ? (
        /* `wrap-anywhere`, because the host's refusal is a sentence with a path
           in it and a path does not break at a space. Clipped to the rail's
           width it would lose the cap and the remedy, which are the two things
           in it worth reading. */
        <p
          data-testid="file-viewer-error"
          className="text-state-fail wrap-anywhere px-3 py-2 text-xs"
        >
          {error}
        </p>
      ) : text === null ? (
        <p className="text-muted px-3 py-2 text-xs">reading…</p>
      ) : (
        /* `whitespace-pre` and a scroll in both directions: a source file with a
           long line should scroll rather than reflow, because a wrapped line is
           a line that no longer matches the editor beside it. */
        <pre
          data-testid="file-viewer-text"
          className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre"
        >
          {text}
        </pre>
      )}
    </aside>
  );
}
