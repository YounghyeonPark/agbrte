/**
 * The terminal pane's half of command boundaries (DESIGN.md §17 Q23, step 1).
 *
 * The host teaches the shell to mark its prompts (`integration.ts`); this reads
 * the marks *inside the emulator's parser* and draws one bar beside each command
 * a person ran — yellow while it runs, then white for a success, red for a
 * failure, and dim where the shell cannot say (`cmd.exe`).
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
 * ## What counts as a command
 *
 * Whatever was typed after the prompt, read back off the screen when the command
 * starts or ends. Enter on an empty line produces marks too — PowerShell's
 * `ReadLine` reports an empty line, and `cmd.exe` cannot tell us either way — so
 * an empty line gets no bar: a column of bars beside blank prompts would be the
 * pane saying that nothing happened, repeatedly.
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

interface Drawn {
  decoration: IDecoration;
  state: CommandState;
  element: HTMLElement | null;
}

/**
 * Start reading marks in `term`. `onSummary` is called when a command finishes —
 * once per command, never per byte, so it can safely set React state.
 */
export function markCommands(term: Terminal, onSummary: (summary: CommandSummary) => void): IDisposable {
  /** Where the typed part of the current prompt starts: a line and a column. */
  let input: { marker: IMarker; x: number } | null = null;
  let running: Drawn | null = null;
  let sawOutput = false;
  let sawStatus = false;
  let sawPrompt = false;
  let commands = 0;
  let failed = 0;

  const level = (): IntegrationLevel =>
    sawOutput && sawStatus ? 'full' : sawPrompt ? 'prompt' : 'none';

  /** What was typed after the prompt, off the screen. Empty for an empty line. */
  const typed = (): string => {
    if (input === null || input.marker.isDisposed) return '';
    const line = term.buffer.active.getLine(input.marker.line);
    return line === undefined ? '' : line.translateToString(true).slice(input.x).trim();
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

  const finish = (exitCode: number | null): void => {
    const state: CommandState = exitCode === null ? 'unknown' : exitCode === 0 ? 'ok' : 'fail';
    let drawn = running;
    // No `C` came (`cmd.exe`): the command is whatever was typed, if anything was.
    if (drawn === null && typed() !== '') drawn = draw(state);
    if (drawn !== null) {
      drawn.state = state;
      paint(drawn);
      commands += 1;
      if (state === 'fail') failed += 1;
      onSummary({ level: level(), commands, failed });
    }
    running = null;
    input = null;
  };

  const read = (family: '133' | '633') => (data: string): boolean => {
    const mark = parseMark(family, data);
    if (mark === null) return false;
    switch (mark.kind) {
      case 'prompt':
        sawPrompt = true;
        break;
      case 'input':
        sawPrompt = true;
        input = { marker: term.registerMarker(0), x: term.buffer.active.cursorX };
        break;
      case 'output':
        sawOutput = true;
        if (running === null && typed() !== '') running = draw('running');
        break;
      case 'done':
        if (mark.exitCode !== null) sawStatus = true;
        finish(mark.exitCode);
        break;
      case 'command':
        // The exact line is the host's to record (step 3); the screen already
        // shows it.
        break;
    }
    return true;
  };

  const handlers = [
    term.parser.registerOscHandler(133, read('133')),
    term.parser.registerOscHandler(633, read('633')),
  ];
  return {
    dispose: () => {
      for (const h of handlers) h.dispose();
    },
  };
}
