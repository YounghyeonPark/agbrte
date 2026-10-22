/**
 * The person's shell inside the session view (DESIGN.md §17 Q23, step 2).
 *
 * Step 1 taught the shell to mark its commands. This is what the marks are for:
 * one scrollback in which the agent's turns and the commands a person ran sit
 * in the order they happened, and one input whose prompt says which of the two
 * it is talking to. The separate terminal pane still exists — it is how a CLI
 * is driven, and a raw pty is still the honest answer for somebody who wants
 * one — but the shell no longer has to be a place you go to.
 *
 * ## The shape on screen
 *
 * One emulator per session view, kept for as long as the view is, and shown
 * through a window rather than whole:
 *
 *   - **At a prompt** the window is the prompt's own rows and nothing else. It
 *     reads as the input line, because it is the shell's input line — with its
 *     completion, its history and its key bindings, which a text box imitating
 *     a shell would each get slightly wrong.
 *   - **While a command runs** the window grows with the output, from the
 *     command's line down, up to the emulator's height: the running command is
 *     the live block at the end of the scrollback.
 *   - **When it ends** the block is read off the screen (`commandMarks.ts`) and
 *     becomes a row in the scrollback, and the window closes back to the next
 *     prompt. The emulator keeps its history; it is only no longer the place
 *     anybody reads it.
 *   - **A full-screen program** — `vim`, `top`, `less` — switches the emulator
 *     to its alternate screen, and the window becomes the whole pane until it
 *     switches back. Such a program has no output to keep; its block is the line
 *     that started it and how it ended.
 *
 * The window is the emulator positioned behind a clipping box, never resized:
 * changing a pty's rows on every prompt would send the shell a `SIGWINCH` per
 * command and make it redraw a prompt nobody asked it to.
 *
 * ## Started when somebody asks for it
 *
 * Not when the session opens. A pty is a process on the machine that owns the
 * workspace — possibly a server somebody else is also using — and opening every
 * session would start one per glance. The shell starts the first time the input
 * is switched to it or a line is sent to it.
 *
 * ## What it does not do yet
 *
 * A block lives in this view and dies with it, exactly as the old pane's
 * scrollback did: nothing here is recorded (step 3) or sent to a model (step 4),
 * and each block says so, because a scrollback that looks like the transcript
 * would otherwise be assumed to be one. Blocks are plain text — the colours of
 * the original output stay in the emulator.
 */

import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SHELL_SCROLLBACK, type ShellDto } from '@shared/ipc/contract.js';
import { markCommands, type CommandMarks, type CommandPhase, type ScreenBlock } from './commandMarks.js';
import { terminalTheme } from './Shell.js';

/** A finished command in the scrollback, and where in the transcript it goes. */
export interface LiveBlock extends ScreenBlock {
  key: string;
  /**
   * The newest event the view had when the command ended. The block is drawn
   * after it, which is "in the order it happened" without comparing two clocks:
   * an event's time is the host's, a block's would be this window's.
   */
  afterSeq: number;
}

export type LiveStatus = 'closed' | 'opening' | 'open' | 'ended';

export interface LiveShell {
  status: LiveStatus;
  error: string | null;
  blocks: LiveBlock[];
  phase: CommandPhase;
  fullscreen: boolean;
  shell: ShellDto | null;
  /** Start the shell if it is not running. Idempotent. */
  open(): void;
  /** Run one line, starting the shell first if need be; queued until a prompt. */
  sendLine(line: string): void;
  focus(): void;
  /** For `LiveShellArea`: the box the emulator is drawn into. */
  mount(element: HTMLDivElement | null): void;
  /** For `LiveShellArea`: the clipping window around it. */
  frame(element: HTMLDivElement | null): void;
  /** For `LiveShellArea`: whether the window is on screen at all, and place it again. */
  show(shown: boolean): void;
}

/** The emulator's height in rows outside a full-screen program. */
export const LIVE_ROWS = 16;

/**
 * Whether a key is the one that switches the input between shell and agent.
 *
 * Ctrl+` because nothing a shell or a terminal program does is bound to it, and
 * it is the key an editor's integrated terminal already uses to mean "between
 * the terminal and the rest" — the closest thing to a convention there is.
 */
export function isModeKey(e: { ctrlKey: boolean; altKey: boolean; metaKey: boolean; key: string; code: string }): boolean {
  return e.ctrlKey && !e.altKey && !e.metaKey && (e.key === '`' || e.code === 'Backquote');
}

export function useLiveShell({
  instanceId,
  sessionId,
  lastSeq,
  onAgentKey,
}: {
  instanceId: string | null;
  sessionId: string | null;
  /** The newest event's `seq` in the view, read when a block finishes. */
  lastSeq: number;
  /**
   * The person asked for the agent from inside the shell: the mode key
   * (`oneLine` false), or `?` at an empty prompt (`oneLine` true — one message,
   * then back to the shell).
   */
  onAgentKey: (oneLine: boolean) => void;
}): LiveShell {
  const [status, setStatus] = useState<LiveStatus>('closed');
  const [error, setError] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<LiveBlock[]>([]);
  const [phase, setPhase] = useState<CommandPhase>('starting');
  const [fullscreen, setFullscreen] = useState(false);
  const [shell, setShell] = useState<ShellDto | null>(null);

  const lastSeqRef = useRef(lastSeq);
  lastSeqRef.current = lastSeq;
  const onAgentKeyRef = useRef(onAgentKey);
  onAgentKeyRef.current = onAgentKey;

  /*
   * Everything the emulator touches lives in one mutable record rather than in
   * state: every consumer of it — the data push, the resize observer, the
   * parser's mark handlers — runs outside React's render, and reading state
   * from there reads a value one render old.
   */
  const live = useRef<{
    term: Terminal | null;
    fit: FitAddon | null;
    marks: CommandMarks | null;
    opened: ShellDto | null;
    mountEl: HTMLDivElement | null;
    frameEl: HTMLDivElement | null;
    shown: boolean;
    status: LiveStatus;
    pending: string[];
    sent: { cols: number; rows: number } | null;
    cleanup: Array<() => void>;
    counter: number;
  }>({
    term: null,
    fit: null,
    marks: null,
    opened: null,
    mountEl: null,
    frameEl: null,
    shown: false,
    status: 'closed',
    pending: [],
    sent: null,
    cleanup: [],
    counter: 0,
  });

  const setLiveStatus = (next: LiveStatus): void => {
    live.current.status = next;
    setStatus(next);
  };

  /** Place the window: the prompt's rows at a prompt, the output below them while running. */
  const layout = useCallback((): void => {
    const { term, marks, frameEl, mountEl } = live.current;
    if (frameEl === null || mountEl === null) return;
    /*
     * Hidden by height, never by `display: none`. An emulator opened inside a
     * box with no layout measures its characters as zero by zero, and every
     * size it proposes afterwards is nonsense until something forces it to look
     * again.
     */
    if (term === null || live.current.status === 'closed' || !live.current.shown) {
      frameEl.style.height = '0px';
      return;
    }
    const buffer = term.buffer.active;
    if (buffer.type === 'alternate') {
      frameEl.style.height = '';
      mountEl.style.transform = '';
      return;
    }
    const screen = mountEl.querySelector('.xterm-screen');
    const cell = screen !== null && term.rows > 0 ? screen.getBoundingClientRect().height / term.rows : 0;
    if (cell <= 0) return;
    term.scrollToBottom();
    const cursor = buffer.baseY + buffer.cursorY;
    /*
     * From the prompt's first line with something on it. Many prompts begin
     * with a newline — Git for Windows' does — to put space between commands,
     * and the scrollback already spaces its blocks; the blank row would be the
     * window's top edge drawn twice.
     */
    let start = marks?.promptStart() ?? 0;
    while (start < cursor && (buffer.getLine(start)?.translateToString(true).trim() ?? '') === '') start += 1;
    const first = Math.max(start, buffer.baseY, cursor - term.rows + 1);
    const rows = cursor - first + 1;
    frameEl.style.height = `${rows * cell}px`;
    mountEl.style.transform = `translateY(${-(first - buffer.baseY) * cell}px)`;
  }, []);

  const flush = useCallback((): void => {
    const { opened, pending } = live.current;
    if (opened === null || pending.length === 0) return;
    for (const line of pending.splice(0)) {
      void window.agbrte.shell.write(opened.shellId, `${line}\r`).catch(() => undefined);
    }
  }, []);

  const syncSize = useCallback((): void => {
    const { term, fit, opened } = live.current;
    if (term === null || fit === null) return;
    try {
      const proposed = fit.proposeDimensions();
      if (proposed === undefined || !Number.isFinite(proposed.cols) || proposed.cols < 1) return;
      const rows = term.buffer.active.type === 'alternate' && Number.isFinite(proposed.rows) && proposed.rows > 0 ? proposed.rows : LIVE_ROWS;
      if (proposed.cols !== term.cols || rows !== term.rows) term.resize(proposed.cols, rows);
    } catch {
      return;
    }
    if (opened === null) return;
    const sent = live.current.sent;
    if (sent !== null && sent.cols === term.cols && sent.rows === term.rows) return;
    live.current.sent = { cols: term.cols, rows: term.rows };
    void window.agbrte.shell.resize(opened.shellId, term.cols, term.rows).catch(() => undefined);
  }, []);

  const open = useCallback((): void => {
    const state = live.current;
    if (state.status !== 'closed' || instanceId === null || sessionId === null) return;
    if (state.mountEl === null) return;
    setLiveStatus('opening');
    setError(null);

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: terminalTheme(),
      /*
       * A program picks its own colours for a black terminal, and on navy some
       * of them stop being text: ANSI blue, and the purple Git for Windows puts
       * in its prompt, measured under 2:1. xterm lightens a foreground that
       * falls below this ratio against its background, which keeps the
       * program's hue and makes it readable — 4.5 is WCAG's floor for text.
       */
      minimumContrastRatio: 4.5,
      scrollback: SHELL_SCROLLBACK,
      rows: LIVE_ROWS,
      // Decorations — the bars — are behind xterm's proposed switch.
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(state.mountEl);
    state.term = term;
    state.fit = fit;

    const marks = markCommands(term, {
      block: (block) => {
        state.counter += 1;
        const key = `block-${state.counter}`;
        setBlocks((prev) => [...prev, { ...block, key, afterSeq: lastSeqRef.current }]);
      },
      phase: (next) => {
        setPhase(next);
        if (next === 'prompt') flush();
      },
    });
    state.marks = marks;

    /*
     * The two keys that leave the shell for the agent, taken before xterm sees
     * them. `preventDefault` as well as `false`: the focus moves to the composer
     * during this keydown, and without it the browser would deliver the `?` to
     * the box it just moved to.
     */
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return !(e.key === '?' && state.marks?.phase() === 'prompt' && state.marks.typed() === '');
      if (isModeKey(e)) {
        e.preventDefault();
        onAgentKeyRef.current(false);
        return false;
      }
      if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey && marks.phase() === 'prompt' && marks.typed() === '') {
        e.preventDefault();
        onAgentKeyRef.current(true);
        return false;
      }
      return true;
    });

    const parsed = term.onWriteParsed(() => layout());
    const moved = term.onCursorMove(() => layout());
    const switched = term.buffer.onBufferChange((buffer) => {
      setFullscreen(buffer.type === 'alternate');
      // The pane changes size around a full-screen program; the emulator follows
      // on the next frame, once the layout has.
      // Placed first, so the box has its new size before it is measured: the
      // window's height is set inline, and measuring under it proposed the
      // old sixteen rows to a full-screen program that had the whole pane.
      requestAnimationFrame(() => {
        layout();
        syncSize();
        layout();
      });
    });
    const typed = term.onData((data) => {
      if (state.opened === null) return;
      void window.agbrte.shell.write(state.opened.shellId, data).catch(() => undefined);
    });
    const offData = window.agbrte.on.shell((chunk) => {
      if (state.opened === null || chunk.shellId !== state.opened.shellId) return;
      term.write(chunk.data);
    });
    const offExit = window.agbrte.on.shellExit((exit) => {
      if (state.opened === null || exit.shellId !== state.opened.shellId) return;
      state.opened = null;
      setLiveStatus('ended');
      setError(
        exit.exitCode === -1
          ? 'The host went away, taking this shell with it.'
          : `The shell exited (${exit.exitCode}).`,
      );
    });
    const observer = new ResizeObserver(() => {
      syncSize();
      layout();
    });
    observer.observe(state.mountEl);
    state.cleanup.push(
      () => observer.disconnect(),
      () => parsed.dispose(),
      () => moved.dispose(),
      () => switched.dispose(),
      () => typed.dispose(),
      offData,
      offExit,
      () => marks.dispose(),
    );

    syncSize();
    void window.agbrte.shell
      .open({ instanceId, sessionId, program: { kind: 'shell' }, cols: term.cols, rows: term.rows })
      .then(
        (handle) => {
          if (state.term !== term) {
            void window.agbrte.shell.close(handle.shellId).catch(() => undefined);
            return;
          }
          state.opened = handle;
          state.sent = { cols: handle.cols, rows: handle.rows };
          setShell(handle);
          setLiveStatus('open');
          syncSize();
          layout();
          // A shell that was not taught never reaches a prompt mark, so a line
          // waiting for one would wait for ever. It goes now, as typing would.
          if (handle.integration !== 'full' && handle.integration !== 'prompt') flush();
        },
        (err: unknown) => {
          if (state.term !== term) return;
          setLiveStatus('ended');
          setError(err instanceof Error ? err.message : String(err));
        },
      );
  }, [instanceId, sessionId, flush, layout, syncSize]);

  // A different session is a different workspace: the shell ends with the view
  // of the one it was opened in, as the separate pane's always did.
  useEffect(() => {
    const state = live.current;
    return () => {
      for (const fn of state.cleanup.splice(0)) fn();
      if (state.opened !== null) void window.agbrte.shell.close(state.opened.shellId).catch(() => undefined);
      state.term?.dispose();
      state.term = null;
      state.fit = null;
      state.marks = null;
      state.opened = null;
      state.pending = [];
      state.sent = null;
      state.status = 'closed';
      setStatus('closed');
      setBlocks([]);
      setPhase('starting');
      setFullscreen(false);
      setShell(null);
      setError(null);
    };
  }, [instanceId, sessionId]);

  const sendLine = useCallback(
    (line: string): void => {
      const state = live.current;
      state.pending.push(line);
      if (state.status === 'closed') {
        open();
        return;
      }
      const taught = state.opened?.integration === 'full' || state.opened?.integration === 'prompt';
      if (!taught || state.marks?.phase() === 'prompt') flush();
    },
    [open, flush],
  );

  const mount = useCallback((element: HTMLDivElement | null): void => {
    const state = live.current;
    state.mountEl = element;
    // Back from another pane: the emulator moves into the new box rather than
    // being made again, so the shell and its history survive the visit.
    if (element !== null && state.term?.element !== undefined && state.term.element.parentElement !== element) {
      element.appendChild(state.term.element);
    }
  }, []);

  const frame = useCallback(
    (element: HTMLDivElement | null): void => {
      live.current.frameEl = element;
      layout();
    },
    [layout],
  );

  const focus = useCallback((): void => {
    live.current.term?.focus();
  }, []);

  const show = useCallback(
    (shown: boolean): void => {
      live.current.shown = shown;
      layout();
    },
    [layout],
  );

  return { status, error, blocks, phase, fullscreen, shell, open, sendLine, focus, mount, frame, show };
}

/**
 * The window onto the emulator: the prompt, or the running command, or a
 * full-screen program filling the pane.
 */
export function LiveShellArea({ live, shellMode }: { live: LiveShell; shellMode: boolean }): JSX.Element {
  /*
   * Shown in shell mode, and in agent mode only while a command is still
   * running — output somebody started does not vanish because they turned to
   * ask the agent about it.
   */
  const shown =
    live.status !== 'closed' && (shellMode || live.phase === 'running' || live.fullscreen);
  const { show } = live;
  useEffect(() => show(shown), [show, shown]);
  return (
    <div
      data-testid="live-shell"
      data-phase={live.phase}
      data-status={live.status}
      className={
        live.fullscreen
          ? 'live-shell flex min-h-0 flex-1 flex-col px-4 py-2'
          : `live-shell mx-auto w-full max-w-3xl shrink-0 px-6 ${shown ? 'py-2' : ''}`
      }
    >
      <div
        ref={live.frame}
        /* Edged in white like every other box, once it is on screen: on the
           same navy as the scrollback, an unedged prompt was a line of text
           floating above the composer. `box-content`, because the height set
           on this box is the emulator's rows, and the edge must not eat one. No vertical padding either:
           the box clips at its padding edge, so padding above the rows
           showed the bottom of the line before them. */
        className={
          live.fullscreen
            ? 'relative min-h-0 flex-1 overflow-hidden'
            : `relative box-content overflow-hidden ${shown ? 'border-line border px-2' : ''}`
        }
      >
        <div ref={live.mount} className={live.fullscreen ? 'h-full' : ''} />
      </div>
      {live.error !== null && (
        <p data-testid="live-shell-error" className="text-state-fail py-1 text-xs">
          {live.error}
        </p>
      )}
    </div>
  );
}

/**
 * One command a person ran, in the scrollback.
 *
 * Drawn unlike anything an agent produces — a bar in the colour of how it
 * ended, the prompt it was typed at, and "you" — because the one thing the
 * unified scrollback must never do is let a person's command and an agent's be
 * mistaken for each other (§17 Q23).
 */
export function ShellBlockRow({ block }: { block: LiveBlock }): JSX.Element {
  const promptLine = block.prompt.split('\n').pop() ?? '';
  const bar =
    block.state === 'fail' ? 'border-state-fail' : block.state === 'ok' ? 'border-ink' : 'border-muted';
  return (
    <div data-testid="shell-block" data-state={block.state} className={`min-w-0 border-l-2 pl-3 ${bar}`}>
      <div className="text-muted flex flex-wrap items-baseline gap-x-2 text-[11px]">
        <span className="text-ink">you</span>
        <span>in your shell — not recorded, not seen by the agent</span>
        {block.state === 'fail' && <span className="text-state-fail">exit {block.exitCode}</span>}
        {block.state === 'unknown' && <span>exit status unknown in this shell</span>}
      </div>
      <pre className="overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
        {promptLine !== '' && <span className="text-muted">{promptLine} </span>}
        <span data-testid="shell-block-command" className="text-ink">
          {block.command}
        </span>
      </pre>
      {block.output !== '' && (
        <pre
          data-testid="shell-block-output"
          className="border-line text-ink mt-1 max-h-96 overflow-auto border px-2 py-1 font-mono text-xs whitespace-pre-wrap break-all"
        >
          {block.truncated && <span className="text-muted">… earlier output is in the terminal’s history only{'\n'}</span>}
          {block.output}
        </pre>
      )}
    </div>
  );
}
