/**
 * An interactive terminal on the machine that owns the workspace (§7, §8).
 *
 * ## Three panes, and this is the one you type into
 *
 * The read-only pane beside it (`TerminalView`) shows what a CLI seat printed
 * while a *model* drove it — which for a headless harness is a stream of NDJSON
 * and not a command line at all. That is the honest "what did the CLI say"
 * window and it stays.
 *
 * This one is a real PTY, and what runs in it is chosen by the person: their
 * shell, one of the agent CLIs the host detected — started the way they would
 * start it themselves, with no arguments — or Agbrte's own CLI, attached to the
 * session this window is showing. Running `claude` here is running `claude`: the
 * vendor's own full-screen interface, `/login` included, which a headless seat
 * cannot offer at all ("/login isn't available in this environment").
 *
 * ## Two of the three are outside the record, and the label has to say which
 *
 * For a shell and for a vendor CLI, nothing here produces an `AgbrteEvent`,
 * nothing is written to the event log, nothing is queued behind a turn, and
 * nothing passes §13's gate — that gate covers what a *model* asks the app for,
 * and this is somebody's own keyboard and somebody's own credential.
 *
 * Which is exactly why the label is not decoration. A pane running Claude Code
 * inside a session view reads as *this session's agent* unless it says
 * otherwise, and it is not one: it keeps no transcript here, spends against the
 * user's own allowance, and its edits arrive in the repo with nothing in the log
 * to explain them. The header says so every time it is on screen.
 *
 * **`{kind:'agbrte'}` is the deliberate opposite, and gets the opposite
 * sentence.** It runs `agbrte attach --session <id>` against the host that owns
 * this session — a real client, over the same socket the window uses (§8.1,
 * §17 Q15) — so a turn typed there queues by arrival with the chat pane's,
 * appears in this transcript, and is in `events.jsonl` afterwards. It exists
 * because a seat with no vendor binary (a harness on a local model) had no
 * interactive interface at all, and offering a bare prompt in its place was
 * offering the wrong thing. Carrying the "nothing here enters the transcript"
 * wording over to it would be the one place the pane's chrome lies.
 *
 * ## Bytes never touch React
 *
 * Output goes from the push callback straight into `term.write()`. Nothing is
 * held in state, nothing accumulates in an array, and no chunk causes a render —
 * a `useState` here would be one React commit per frame of a build log, and a
 * growing array would be §7's forbidden unbounded buffer with a new name.
 *
 * The bound is the emulator's own scrollback ring (`SHELL_SCROLLBACK`), which is
 * what "a windowed projection, never the whole log" means for a stream that has
 * no log to project from.
 *
 * ## Size, which a full-screen TUI is unforgiving about
 *
 * A shell at the wrong size wraps oddly. A TUI at the wrong size *draws its
 * frame off the edge of the screen* — it lays out to the size it was told at
 * startup and repaints absolutely, so an 80×24 program in a 140-column pane is a
 * box with its right-hand border in the middle and its status line orphaned.
 *
 * So the size is settled twice: measured before `shell.open`, and re-sent as
 * soon as the handle comes back. The second one is not belt and braces — the
 * first measurement happens in the same tick the pane mounted, and the round
 * trip to a detached host is long enough for the layout to have finished
 * differently. Without it the PTY kept whatever the first frame guessed until
 * somebody dragged the window.
 *
 * ## Lifetime
 *
 * One PTY per mount, and per *program*: switching what runs is a new terminal,
 * not a restart of an old one. Closing the pane, switching sessions, or closing
 * the window ends it — a terminal is a view, and a shell with no reader is a
 * program blocked on a prompt nobody can answer. Long-running work belongs to a
 * preview server (§6.8) or to an agent, both of which deliberately outlive their
 * client.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SHELL_SCROLLBACK, type ShellDto } from '@shared/ipc/contract.js';
import type { ShellProgram } from '../shared/types/index.js';
import '@xterm/xterm/css/xterm.css';

/**
 * Colours taken from the app's own palette rather than xterm's default.
 *
 * A terminal that ships its own black on an otherwise warm-neutral window reads
 * as an embedded iframe from another program — which is the opposite of the
 * impression wanted here, where the point is that this is *your* terminal in
 * *this* workspace.
 */
const THEME = {
  background: '#0e0e0d',
  foreground: '#e8e8e4',
  cursor: '#d9822b',
  selectionBackground: '#34342f',
} as const;

/** One thing this pane could run, as the parent worked it out from the host. */
export interface ShellChoice {
  /** Stable across renders and unique in the list: `shell`, `cli:claude-code`. */
  key: string;
  label: string;
  program: ShellProgram;
  /** Why it is offered, for the button's title. */
  hint: string;
}

export function Shell({
  sessionId,
  instanceId,
  program,
  choices,
  onChoose,
  /** Shown in the label so a person knows which machine they are typing on. */
  hostLabel,
}: {
  sessionId: string;
  instanceId: string;
  /** What to start. A selector the host resolves — never a name from here. */
  program: ShellProgram;
  /**
   * Everything this host said it could start, decided by the parent.
   *
   * Passed in rather than fetched here: the list is `HostInfo.available`
   * filtered to the CLI runtimes, which is the *same* list the agent picker
   * draws from, and a second fetch would be a second answer to a question that
   * already has one on screen.
   */
  choices: ShellChoice[];
  onChoose: (program: ShellProgram) => void;
  hostLabel: string;
}): JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const [shell, setShell] = useState<ShellDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState<number | null>(null);

  /*
   * The selector, flattened to a string for the dependency list.
   *
   * `program` is an object literal built in the parent's render, so it is a new
   * reference every time anything at all re-renders — and a `useEffect` keyed on
   * it would tear down the PTY and start another on every keystroke in the
   * composer. The string is stable, and it changes exactly when the choice does,
   * which is the only time this effect should run again.
   */
  const wanted =
    program.kind === 'cli' ? `cli:${program.cliId}` : program.kind === 'agbrte' ? 'agbrte' : 'shell';

  useEffect(() => {
    const mount = mountRef.current;
    if (mount === null) return;

    let alive = true;
    /**
     * The open terminal, held in a closure rather than in state.
     *
     * Every consumer of it — the data push, the resize observer, the teardown —
     * runs outside React's render cycle, and putting it in state would mean each
     * one reading a value one render behind the one it needs.
     */
    let opened: ShellDto | null = null;
    /** The last size the PTY was told, so a resize storm is not sent. */
    let sent: { cols: number; rows: number } | null = null;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: THEME,
      // The bound. Past this the oldest lines go, which is what a terminal has
      // always done and what keeps a week-long session from becoming a heap.
      scrollback: SHELL_SCROLLBACK,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);

    /**
     * Measure, and refuse to act on a measurement that cannot be right.
     *
     * `fit()` throws or produces nonsense while the pane is mid-layout or
     * hidden, which is a normal thing to happen — a tab switch, a window
     * animation. Sending a zero-column resize to a PTY makes some programs
     * divide by zero and others hang, so a bad measurement is dropped rather
     * than forwarded.
     */
    const measure = (): { cols: number; rows: number } | null => {
      try {
        const proposed = fit.proposeDimensions();
        if (
          proposed === undefined ||
          !Number.isFinite(proposed.cols) ||
          !Number.isFinite(proposed.rows) ||
          proposed.cols < 1 ||
          proposed.rows < 1
        ) {
          return null;
        }
        fit.fit();
        return { cols: term.cols, rows: term.rows };
      } catch {
        return null;
      }
    };

    /**
     * Make the PTY agree with the emulator, whatever changed.
     *
     * One function for both callers — the moment the handle arrives, and every
     * layout change after — because "the program believes a size the screen does
     * not have" is one bug with two ways in, and two code paths would have fixed
     * it in one of them.
     */
    const syncSize = (): void => {
      const next = measure();
      if (next === null || opened === null) return;
      if (sent !== null && sent.cols === next.cols && sent.rows === next.rows) return;
      sent = next;
      void window.agbrte.shell.resize(opened.shellId, next.cols, next.rows).catch(() => undefined);
    };

    const first = measure();
    if (first !== null) sent = first;

    void window.agbrte.shell
      .open({
        instanceId,
        sessionId,
        program,
        ...(first !== null ? { cols: first.cols, rows: first.rows } : {}),
      })
      .then(
        (handle) => {
          if (!alive) {
            // Opened while unmounting. Closed rather than leaked: the pane that
            // asked for it is already gone.
            void window.agbrte.shell.close(handle.shellId);
            return;
          }
          opened = handle;
          setShell(handle);
          // The pane has had a round trip's worth of time to settle since the
          // measurement that went out with the request. A full-screen TUI has
          // already drawn its frame by now, so a wrong size here is a wrong
          // size until somebody resizes the window (see the header).
          sent = { cols: handle.cols, rows: handle.rows };
          syncSize();
          term.focus();
        },
        (err: unknown) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : String(err));
        },
      );

    /*
     * Keystrokes go straight out, unbatched.
     *
     * There is nothing to batch: a keypress is a few bytes and its whole value
     * is arriving now. `onData` rather than `onKey` so pastes, IME composition
     * and control sequences all take the same path the emulator already
     * encoded — reimplementing that mapping is how a terminal ends up unable to
     * type a `[`.
     */
    const typed = term.onData((data) => {
      if (opened === null) return;
      void window.agbrte.shell.write(opened.shellId, data).catch(() => undefined);
    });

    const offData = window.agbrte.on.shell((chunk) => {
      if (opened === null || chunk.shellId !== opened.shellId) return;
      // Straight through. No state, no array, no render.
      term.write(chunk.data);
    });

    const offExit = window.agbrte.on.shellExit((exit) => {
      if (opened === null || exit.shellId !== opened.shellId) return;
      opened = null;
      setEnded(exit.exitCode);
      // Two different facts, and telling them apart is the whole value of the
      // message: `-1` is the *host* going away — the machine that owned the
      // workspace, not the program in the terminal — and "exited with code -1"
      // would send somebody looking for a bug in whatever they last ran.
      const why =
        exit.exitCode === -1
          ? 'the host went away, taking this terminal with it'
          : `it exited with code ${exit.exitCode}`;
      term.write(`\r\n\u001b[33m[${why} — reopen the pane for a new one]\u001b[0m\r\n`);
    });

    /*
     * Follow the pane's size, not the window's.
     *
     * A `resize` listener on `window` misses every layout change that is not a
     * window resize — the sidebar collapsing, a permission prompt appearing
     * below — and each of those leaves the PTY believing in a width that is no
     * longer there, which for a full-screen TUI is a frame drawn off the edge.
     */
    const observer = new ResizeObserver(() => syncSize());
    observer.observe(mount);

    return () => {
      alive = false;
      observer.disconnect();
      offData();
      offExit();
      typed.dispose();
      // The PTY dies with the pane. Awaiting it would be pointless — nothing is
      // left to tell — and the host closes it anyway when this client goes.
      if (opened !== null) void window.agbrte.shell.close(opened.shellId).catch(() => undefined);
      term.dispose();
    };
    // `program` itself is deliberately absent: see `wanted` above. Adding it
    // would restart the terminal on every unrelated render of the parent, and
    // `wanted` is the same information in a form that compares by value.
  }, [sessionId, instanceId, wanted]);

  const running =
    shell?.label ??
    (program.kind === 'cli'
      ? program.cliId
      : program.kind === 'agbrte'
        ? 'Agbrte CLI'
        : 'Your shell');

  return (
    <div data-testid="pty-terminal" className="flex min-h-0 flex-1 flex-col">
      {/* Says what this is, every time it is on screen. A pane of monospace
          output inside a session view reads as part of the session unless it
          says otherwise — and for two of the three programs it is not part of
          it, which matters *more*, not less, when the program is an agent.

          For the third it is, and the sentence says the opposite rather than
          being softened. Our own CLI attached to this session is a real client
          of the same host (§8.1): its turns queue with the window's, land in
          this transcript, and are in `events.jsonl` afterwards. Repeating
          "nothing here enters the transcript" over a pane that is appending to
          it would be the one lie in the pane whose label carries a promise. */}
      <div className="border-line text-muted flex shrink-0 flex-wrap items-baseline gap-x-2 border-b px-6 py-2 text-[11px]">
        <span data-testid="pty-running" className="text-ink font-medium">
          {running}
        </span>
        <span data-testid="pty-claim">
          {program.kind === 'cli'
            ? 'you are driving this yourself — it is not a seat in this session, and nothing here enters the transcript or the session log'
            : program.kind === 'agbrte'
              ? 'Agbrte’s own client, attached to this session — what you send here is a real turn: it queues with the chat pane’s, and it is in the transcript and the session log'
              : 'you are typing, not the agent — nothing here enters the transcript or the session log'}
        </span>
        {shell !== null && (
          <span data-testid="pty-where" className="ml-auto font-mono">
            {shell.program} in {shell.cwd} on {hostLabel}
          </span>
        )}
      </div>

      {/* The switcher, only where there is something to switch to. One button
          per choice rather than a dropdown: there are at most a handful, and the
          question "what is this pane running" is answered by the same control
          that changes it. Choosing is a *new* terminal — a PTY cannot change the
          program inside it, and pretending otherwise by keeping the scrollback
          would show one program's output under another's name. */}
      {choices.length > 1 && (
        <div
          data-testid="pty-choices"
          className="border-line flex shrink-0 flex-wrap gap-2 border-b px-6 py-1.5"
        >
          {choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              className="btn text-[11px]"
              data-testid="pty-choice"
              data-choice={choice.key}
              title={choice.hint}
              aria-pressed={choice.key === wanted}
              onClick={() => onChoose(choice.program)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      )}

      {error !== null && (
        <p data-testid="pty-error" className="text-state-fail px-6 py-3 text-xs">
          {error}
        </p>
      )}

      {ended !== null && (
        <p className="text-muted px-6 py-1 text-[11px]">
          {ended === -1
            ? 'The host went away, taking this terminal with it.'
            : `${running} exited (${ended}).`}{' '}
          Close and reopen this pane to start another.
        </p>
      )}

      {/* The emulator draws into this and owns everything inside it. `min-h-0`
          so it can shrink inside the flex column rather than pushing the
          composer off the bottom. Its own testid so a test can read what the
          *program* drew without the pane's own chrome mixed in — which matters
          when the chrome says "Claude Code" and the assertion is about whether
          Claude Code is really on screen. */}
      <div
        ref={mountRef}
        data-testid="pty-screen"
        className="min-h-0 flex-1 overflow-hidden px-4 py-2"
      />
    </div>
  );
}
