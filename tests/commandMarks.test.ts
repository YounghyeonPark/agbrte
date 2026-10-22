/**
 * Reading finished commands back off a real emulator's screen
 * (`src/renderer/commandMarks.ts`).
 *
 * xterm parses and keeps its buffer without ever being attached to a page, so
 * this drives the same `Terminal` the pane uses, in Node: the marks a taught
 * shell writes go in, and the blocks the session view will show come out. What
 * is pinned is the reason the block is read off the screen rather than out of
 * the stream — a line rewritten by `\r` is the line it became, a wrapped line is
 * one line — and the edges a real shell produces: an empty line, a shell that
 * marks only its prompts, an output longer than the screen.
 */

import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { markCommands, type CommandPhase, type ScreenBlock } from '../src/renderer/commandMarks.js';

const ESC = '\u001b';
const BEL = '\u0007';
const osc = (body: string): string => `${ESC}]${body}${BEL}`;

function setup(cols = 40, rows = 10): {
  term: Terminal;
  blocks: ScreenBlock[];
  phases: CommandPhase[];
  write: (data: string) => Promise<void>;
  marks: ReturnType<typeof markCommands>;
} {
  const term = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  const blocks: ScreenBlock[] = [];
  const phases: CommandPhase[] = [];
  const marks = markCommands(term, { block: (b) => blocks.push(b), phase: (p) => phases.push(p) });
  return {
    term,
    blocks,
    phases,
    marks,
    write: (data) => new Promise((done) => term.write(data, done)),
  };
}

/** One prompt and one command, the way bash writes them once taught. */
function bash(command: string, output: string, code: number, exact = true): string {
  return (
    osc('133;A') +
    'me@box:~/proj$ ' +
    osc('133;B') +
    command +
    '\r\n' +
    (exact ? osc(`633;E;${command.replace(/;/gu, '\\x3b')}`) : '') +
    osc('133;C') +
    output +
    osc(`133;D;${code}`)
  );
}

describe('a finished command, read off the screen', () => {
  it('is the prompt, the line, what it printed, and how it ended', async () => {
    const t = setup();
    await t.write(bash('ls', 'a.txt\r\nb.txt\r\n', 0) + osc('133;A') + 'me@box:~/proj$ ' + osc('133;B'));
    expect(t.blocks).toEqual([
      {
        prompt: 'me@box:~/proj$',
        command: 'ls',
        commandFrom: 'exact',
        output: 'a.txt\nb.txt',
        exitCode: 0,
        state: 'ok',
        truncated: false,
      },
    ]);
    expect(t.phases).toEqual(['prompt', 'running', 'prompt']);
    expect(t.marks.phase()).toBe('prompt');
  });

  it('shows a line rewritten in place as the line it became', async () => {
    // A progress bar: three states of one line, of which only the last was ever
    // on screen when the command ended.
    const t = setup();
    await t.write(bash('fetch', '10%\r50%\r100% done\r\n', 0));
    expect(t.blocks[0]?.output).toBe('100% done');
  });

  it('joins a line the terminal wrapped back into one', async () => {
    const t = setup(20);
    const long = 'x'.repeat(50);
    await t.write(bash('cat long', `${long}\r\n`, 0));
    expect(t.blocks[0]?.output).toBe(long);
  });

  it('reads a long command off the lines it wrapped onto, when the shell cannot report it', async () => {
    const t = setup(20);
    const command = `echo ${'y'.repeat(40)}`;
    await t.write(bash(command, 'y\r\n', 0, false));
    expect(t.blocks[0]).toMatchObject({ command, commandFrom: 'echo' });
  });

  it('says a failure is a failure', async () => {
    const t = setup();
    await t.write(bash('false', '', 1));
    expect(t.blocks[0]).toMatchObject({ exitCode: 1, state: 'fail', output: '' });
  });

  it('makes no block of an empty line', async () => {
    // bash runs no `PS0` for an empty line, so there is no `C`; PowerShell
    // reports the empty line exactly. Neither is a command somebody ran.
    const t = setup();
    await t.write(
      osc('133;A') + '$ ' + osc('133;B') + '\r\n' + osc('133;D;0') +
        osc('133;A') + '$ ' + osc('133;B') + '\r\n' + osc('633;E;') + osc('133;C') + osc('133;D;0'),
    );
    expect(t.blocks).toEqual([]);
    expect(t.phases).not.toContain('running');
  });

  it('finds the block in a shell that marks only its prompts, and does not guess its status', async () => {
    const t = setup();
    const prompt = osc('133;D') + osc('133;A') + 'C:\\proj>' + osc('133;B');
    await t.write(prompt + 'dir /b\r\na.txt\r\n\r\n' + prompt);
    expect(t.blocks).toEqual([
      expect.objectContaining({ prompt: 'C:\\proj>', command: 'dir /b', output: 'a.txt', exitCode: null, state: 'unknown' }),
    ]);
  });

  it('keeps the end of an output that scrolled out of the history, and says so', async () => {
    const term = new Terminal({ cols: 40, rows: 5, allowProposedApi: true, scrollback: 20 });
    const blocks: ScreenBlock[] = [];
    markCommands(term, { block: (b) => blocks.push(b) });
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\r\n');
    await new Promise<void>((done) => term.write(bash('seq', `${lines}\r\n`, 0), done));
    expect(blocks[0]?.truncated).toBe(true);
    expect(blocks[0]?.output.endsWith('line 99')).toBe(true);
    expect(blocks[0]?.output).not.toContain('line 0\n');
  });

  it('knows what has been typed at the prompt, so a prefix can be read before Enter', async () => {
    const t = setup();
    await t.write(osc('133;A') + '$ ' + osc('133;B'));
    expect(t.marks.typed()).toBe('');
    await t.write('git st');
    expect(t.marks.typed()).toBe('git st');
  });
});
