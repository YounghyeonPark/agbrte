/**
 * The terminal pane's half of command boundaries (DESIGN.md §17 Q23, steps 1–2).
 *
 * The host teaches the shell to mark its prompts (`integration.ts`); this reads
 * the marks *inside the emulator's parser*. It does two things with them: draws
 * one bar beside each command a person ran — yellow while it runs, then white for
 * a success, red for a failure, and dim where the shell cannot say (`cmd.exe`) —
 * and, when a command ends, reads the finished block back off the screen so the
 * session view can show it in its scrollback (`LiveShell.tsx`).
 *
 * ## Why in the parser, and not from the data stream
 *
 * `BlockStream` reads the same marks from the raw output, and the host will use
 * it to record blocks. The pane cannot: a bar has to sit on the *line* the
 * command was typed on, and only the emulator knows which line that is once
 * wrapping, a resize and a full-screen program have had their way with the
 * buffer. An OSC handler runs at the exact point in the parse where the mark
 * arrived, so a marker registered there is on the right line by construction.
 *
 * ## Why the block is read off the screen, not out of the stream
 *
 * What a person saw is the emulator's *rendering* of the bytes: a progress bar
 * that rewrote one line a hundred times is one line, and a typo fixed with
 * backspace is the fixed line. The raw stream holds every intermediate state,
 * and showing it as text would be showing something that was never on screen.
 * So the scrollback's copy is the buffer's lines between the marks, wrapped
 * lines joined back into the line they were.
 *
 * ## What counts as a command
 *
 * Whatever was typed after the prompt, read back off the screen when the command
 * starts or ends. Enter on an empty line produces marks too — PowerShell's
 * `ReadLine` reports an empty line, and `cmd.exe` cannot tell us either way — so
 * an empty line gets no bar and no block: a column of them beside blank prompts
 * would be the pane saying that nothing happened, repeatedly.
 */

import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { parseMark, type IntegrationLevel } from '@shared/terminal/marks.js';

export type CommandState = 'running' | 'ok' | 'fail' | 'unknown';

/** What the pane says about the marks it has seen. */
export interface CommandSummary {
  /** What the shell has shown it can say, which may be less than it was taught. */
  level: IntegrationLevel;
  commands: number;
  failed: number;
}

/** One finished command, as the screen showed it. */
export interface ScreenBlock {
  /** The prompt it was typed at, which carries the folder and the branch. */
  prompt: string;
  command: string;
  /** Reported by the shell (`exact`), or read off the screen (`echo`). */
  commandFrom: 'exact' | 'echo';
  output: string;
  exitCode: number | null;
  state: Exclude<CommandState, 'running'>;
  /** The start of the output had already scrolled out of the terminal's history. */
  truncated: boolean;
}

/** Where the shell is, between its marks. */
export type CommandPhase =
  /** Nothing marked yet: the shell is starting, or was never taught. */
  | 'starting'
  /** At a prompt, waiting for a line. */
  | 'prompt'
  /** A line was accepted and has not finished. */
  | 'running';

/** The most of one block's output kept for the scrollback, from its end. */
export const MAX_BLOCK_LINES = 5000;

export interface CommandMarks extends IDisposable {
  /** The buffer line the current prompt starts on, or `null` before the first. */
  promptStart(): number | null;
  phase(): CommandPhase;
  /** What has been typed at the current prompt so far, off the screen. */
  typed(): string;
}

interface Drawn {
  decoration: IDecoration;
  state: CommandState;
  element: HTMLElement | null;
}

/**
 * Start reading marks in `term`. The callbacks are called when a command
 * finishes or the shell changes phase — never per byte, so they can safely set
 * React state.
 */
export function markCommands(
  term: Terminal,
  on: {
    summary?: (summary: CommandSummary) => void;
    block?: (block: ScreenBlock) => void;
    phase?: (phase: CommandPhase) => void;
  },
): CommandMarks {
  /** Where the current prompt starts. */
  let prompt: IMarker | null = null;
  /** Where the typed part of the current prompt starts: a line and a column. */
  let input: { marker: IMarker; x: number } | null = null;
  /** Where the current command's output starts (`C`). */
  let output: IMarker | null = null;
  /** The exact line, when the shell reported one (`633;E`). */
  let reported: string | null = null;
  /**
   * The prompt and the line, read when the command started. An output longer
   * than the terminal's history scrolls the line it was typed on out of the
   * buffer, and the block must still say what ran.
   */
  let started: { prompt: string; command: string } | null = null;
  let running: Drawn | null = null;
  let phase: CommandPhase = 'starting';
  let sawOutput = false;
  let sawStatus = false;
  let sawPrompt = false;
  let commands = 0;
  let failed = 0;

  const level = (): IntegrationLevel =>
    sawOutput && sawStatus ? 'full' : sawPrompt ? 'prompt' : 'none';

  const setPhase = (next: CommandPhase): void => {
    if (next === phase) return;
    phase = next;
    on.phase?.(next);
  };

  /** Lines `[from, to]` of the buffer as text, wrapped lines joined back together. */
  const text = (from: number, to: number): string[] => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let y = Math.max(0, from); y <= to; y += 1) {
      const line = buffer.getLine(y);
      if (line === undefined) continue;
      const row = line.translateToString(true);
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += row;
      else lines.push(row);
    }
    return lines;
  };

  /**
   * What was typed after the prompt, off the screen. Empty for an empty line.
   *
   * Read from the input line *and the lines it wrapped onto*, which a long
   * command does; the first line alone would cut it at the terminal's width.
   */
  const typed = (): string => {
    if (input === null || input.marker.isDisposed) return '';
    const buffer = term.buffer.active;
    let line = buffer.getLine(input.marker.line);
    if (line === undefined) return '';
    let out = line.translateToString(true).slice(input.x);
    for (let y = input.marker.line + 1; ; y += 1) {
      line = buffer.getLine(y);
      if (line === undefined || !line.isWrapped) break;
      out += line.translateToString(true);
    }
    return out.trim();
  };

  const paint = (drawn: Drawn): void => {
    if (drawn.element === null) return;
    drawn.element.dataset['state'] = drawn.state;
    drawn.element.title =
      drawn.state === 'running'
        ? 'running'
        : drawn.state === 'unknown'
          ? 'finished — this shell does not report an exit status'
          : drawn.state === 'ok'
            ? 'succeeded'
            : 'failed';
  };

  /** A bar on the input line. `undefined` in a full-screen program's buffer, which has no history. */
  const draw = (state: CommandState): Drawn | null => {
    if (input === null || input.marker.isDisposed) return null;
    const decoration = term.registerDecoration({ marker: input.marker, x: 0, width: 1, layer: 'bottom' });
    if (decoration === undefined) return null;
    const drawn: Drawn = { decoration, state, element: null };
    decoration.onRender((element) => {
      if (drawn.element !== element) {
        drawn.element = element;
        element.classList.add('term-mark');
        element.dataset['testid'] = 'command-mark';
      }
      paint(drawn);
    });
    return drawn;
  };

  /** The prompt's lines, the last one only up to where typing began. */
  const promptText = (): string => {
    if (input === null || input.marker.isDisposed) return '';
    if (prompt === null || prompt.isDisposed || prompt.line > input.marker.line) return '';
    const lines = text(prompt.line, input.marker.line);
    lines[lines.length - 1] = (lines[lines.length - 1] ?? '').slice(0, input.x);
    return lines.join('\n').trimEnd();
  };

  /** The finished command, read off the screen. `null` for an empty line. */
  const capture = (exitCode: number | null): ScreenBlock | null => {
    const inputGone = input === null || input.marker.isDisposed;
    if (inputGone && started === null) return null;
    const command = started?.command ?? reported ?? typed();
    if (command === '') return null;
    const buffer = term.buffer.active;
    const end = buffer.baseY + buffer.cursorY;

    /*
     * The output: from `C`, or — for a shell that never says it (`cmd.exe`) —
     * from the first line after the command's own. A marker whose line has
     * scrolled out of the terminal's history is disposed, and what is left is
     * the end of the output, which is the half worth keeping.
     */
    let from: number;
    let truncated = false;
    if (output !== null) {
      if (output.isDisposed) {
        from = 0;
        truncated = true;
      } else from = output.line;
    } else if (input === null || input.marker.isDisposed) {
      from = 0;
      truncated = true;
    } else {
      let after = input.marker.line + 1;
      while (buffer.getLine(after)?.isWrapped === true) after += 1;
      from = after;
    }
    let lines = text(from, end);
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();
    if (lines.length > MAX_BLOCK_LINES) {
      lines = lines.slice(lines.length - MAX_BLOCK_LINES);
      truncated = true;
    }
    return {
      prompt: started?.prompt ?? promptText(),
      command,
      commandFrom: reported !== null ? 'exact' : 'echo',
      output: lines.map((l) => l.trimEnd()).join('\n'),
      exitCode,
      state: exitCode === null ? 'unknown' : exitCode === 0 ? 'ok' : 'fail',
      truncated,
    };
  };

  const finish = (exitCode: number | null): void => {
    const block = capture(exitCode);
    let drawn = running;
    // No `C` came (`cmd.exe`): the command is whatever was typed, if anything was.
    if (drawn === null && block !== null) drawn = draw(block.state);
    if (drawn !== null && block !== null) {
      drawn.state = block.state;
      paint(drawn);
      commands += 1;
      if (block.state === 'fail') failed += 1;
      on.summary?.({ level: level(), commands, failed });
    }
    if (block !== null) on.block?.(block);
    running = null;
    input = null;
    output = null;
    reported = null;
    started = null;
  };

  const read = (family: '133' | '633') => (data: string): boolean => {
    const mark = parseMark(family, data);
    if (mark === null) return false;
    switch (mark.kind) {
      case 'prompt':
        sawPrompt = true;
        prompt = term.registerMarker(0);
        setPhase('prompt');
        break;
      case 'input':
        sawPrompt = true;
        input = { marker: term.registerMarker(0), x: term.buffer.active.cursorX };
        output = null;
        reported = null;
        started = null;
        setPhase('prompt');
        break;
      case 'command':
        reported = mark.line;
        break;
      case 'output':
        sawOutput = true;
        if ((reported ?? typed()) !== '') {
          started = { prompt: promptText(), command: reported ?? typed() };
          output = term.registerMarker(0);
          if (running === null) running = draw('running');
          setPhase('running');
        }
        break;
      case 'done':
        if (mark.exitCode !== null) sawStatus = true;
        finish(mark.exitCode);
        break;
    }
    return true;
  };

  const handlers = [
    term.parser.registerOscHandler(133, read('133')),
    term.parser.registerOscHandler(633, read('633')),
  ];
  return {
    promptStart: () => (prompt === null || prompt.isDisposed ? null : prompt.line),
    phase: () => phase,
    typed,
    dispose: () => {
      for (const h of handlers) h.dispose();
    },
  };
}
