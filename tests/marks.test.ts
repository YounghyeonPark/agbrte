/**
 * Reading command boundaries out of a terminal stream (`src/shared/terminal/marks.ts`).
 *
 * The streams here are written the way the shells write them: an `OSC 133` mark
 * on each side of a prompt, the echo of what was typed, the output, and a `D`
 * with the status. `integration.test.ts` spawns the real shells; this pins the
 * reading of what they say, including the two ways a pty is untidy — pieces that
 * split anywhere, and shells that say less than the others.
 */

import { describe, expect, it } from 'vitest';
import { BlockStream, parseMark, plainText, unescapeCommandLine, type Block } from '../src/shared/terminal/marks.js';

const ESC = '\u001b';
const BEL = '\u0007';
const osc = (body: string, end: 'bel' | 'st' = 'bel'): string => `${ESC}]${body}${end === 'bel' ? BEL : `${ESC}\\`}`;

/** One prompt, one command, as bash and PowerShell write it once integrated. */
function fullCommand(command: string, output: string, code: number): string {
  return (
    osc('133;A') +
    'user@box:~/proj$ ' +
    osc('133;B') +
    command +
    '\r\n' +
    osc(`633;E;${command.replace(/\\/gu, '\\\\').replace(/;/gu, '\\x3b')}`) +
    osc('133;C') +
    output +
    osc(`133;D;${code}`)
  );
}

function feed(stream: BlockStream, pieces: string[]): Block[] {
  return pieces.flatMap((piece) => stream.push(piece));
}

describe('a mark', () => {
  it('reads the four letters and the status', () => {
    expect(parseMark('133', 'A')).toEqual({ kind: 'prompt' });
    expect(parseMark('133', 'B')).toEqual({ kind: 'input' });
    expect(parseMark('133', 'C')).toEqual({ kind: 'output' });
    expect(parseMark('133', 'D;0')).toEqual({ kind: 'done', exitCode: 0 });
    expect(parseMark('133', 'D;127')).toEqual({ kind: 'done', exitCode: 127 });
    // No status is "unknown", which `cmd.exe` is, and never a success.
    expect(parseMark('133', 'D')).toEqual({ kind: 'done', exitCode: null });
  });

  it('takes a command line only from the family that defines one', () => {
    expect(parseMark('633', 'E;git status')).toEqual({ kind: 'command', line: 'git status' });
    expect(parseMark('133', 'E;git status')).toBeNull();
  });

  it('undoes the escaping a command line travels in', () => {
    // A `;` would end the field and a newline would end the line, so they travel
    // as `\x3b` and `\x0a`; a real backslash travels doubled.
    expect(unescapeCommandLine('echo a\\x3b b')).toBe('echo a; b');
    expect(unescapeCommandLine('dir C:\\\\Users')).toBe('dir C:\\Users');
    expect(unescapeCommandLine('for x\\x0ado y')).toBe('for x\ndo y');
  });
});

describe('a stream of them', () => {
  it('turns one prompt and one command into one block', () => {
    const stream = new BlockStream();
    const blocks = stream.push(fullCommand('ls -la', 'a.txt\r\nb.txt\r\n', 0));
    expect(blocks).toEqual([
      { command: 'ls -la', commandFrom: 'exact', output: 'a.txt\r\nb.txt', exitCode: 0, truncated: false },
    ]);
    expect(stream.level).toBe('full');
  });

  it('carries the status through, and the escaped line exactly', () => {
    const stream = new BlockStream();
    const blocks = stream.push(fullCommand('grep x; false', '', 1));
    expect(blocks[0]?.command).toBe('grep x; false');
    expect(blocks[0]?.exitCode).toBe(1);
  });

  it('gives the same blocks however the stream is cut', () => {
    /*
     * A pty delivers pieces wherever its buffer filled, including inside an
     * escape sequence. An `ESC ]` read as text at the end of one piece would
     * put a mark into somebody's output and lose the boundary it was.
     */
    const whole = fullCommand('echo one', 'one\r\n', 0) + fullCommand('cd /tmp', '', 0) + fullCommand('nope', 'not found\r\n', 127);
    const expected = new BlockStream().push(whole);
    expect(expected).toHaveLength(3);

    for (let cut = 1; cut < whole.length; cut += 1) {
      const blocks = feed(new BlockStream(), [whole.slice(0, cut), whole.slice(cut)]);
      expect(blocks, `cut at ${cut}`).toEqual(expected);
    }
    // And one character at a time, which is every cut at once.
    expect(feed(new BlockStream(), [...whole])).toEqual(expected);
  });

  it('accepts the other terminator', () => {
    const stream = new BlockStream();
    const text =
      osc('133;A', 'st') + '$ ' + osc('133;B', 'st') + 'pwd\r\n' + osc('133;C', 'st') + '/home\r\n' + osc('133;D;0', 'st');
    expect(stream.push(text)).toEqual([
      { command: 'pwd', commandFrom: 'echo', output: '/home', exitCode: 0, truncated: false },
    ]);
  });

  it('makes no block of an empty line or of the first prompt', () => {
    // The first `D` arrives before anything ran, and Enter on an empty line is a
    // prompt followed by a prompt. Neither is a command somebody ran.
    const stream = new BlockStream();
    const text = osc('133;D;0') + osc('133;A') + '$ ' + osc('133;B') + '\r\n' + osc('133;D;0') + osc('133;A') + '$ ' + osc('133;B');
    expect(stream.push(text)).toEqual([]);
  });

  it('reads the command from the echo when the shell cannot report it', () => {
    // A line typed with a mistake and fixed: the echo of a backspace is
    // "\b \b", which has to come out as the line the shell actually ran.
    const stream = new BlockStream();
    const text = osc('133;A') + '$ ' + osc('133;B') + 'lsx\b \b -1\r\n' + osc('133;C') + 'a\r\n' + osc('133;D;0');
    expect(stream.push(text)[0]).toMatchObject({ command: 'ls -1', commandFrom: 'echo' });
  });

  it('finds blocks in a shell that marks only its prompts', () => {
    /*
     * `cmd.exe` can draw marks into its prompt and has no way to say when a
     * command starts running or how it ended. So the first line typed after the
     * prompt is the command, the lines after it are the output, and the status
     * is unknown — said, not guessed.
     */
    const stream = new BlockStream();
    const prompt = osc('133;D', 'st') + osc('133;A', 'st') + 'C:\\proj>' + osc('133;B', 'st');
    const blocks = stream.push(prompt + 'dir /b\r\na.txt\r\nb.txt\r\n\r\n' + prompt);
    expect(blocks).toEqual([
      { command: 'dir /b', commandFrom: 'echo', output: 'a.txt\r\nb.txt', exitCode: null, truncated: false },
    ]);
    expect(stream.level).toBe('prompt');
  });

  it('keeps the end of an output that is too long, and says so', () => {
    const stream = new BlockStream({ maxOutput: 10 });
    const blocks = stream.push(fullCommand('make', 'line 1\r\nline 2\r\nerror: here', 2));
    expect(blocks[0]?.output).toBe('rror: here');
    expect(blocks[0]?.truncated).toBe(true);
  });

  it('leaves somebody else’s escape sequences in the output', () => {
    // A program setting the window title is part of what it printed.
    const stream = new BlockStream();
    const title = osc('0;building');
    expect(stream.push(fullCommand('make', `${title}done\r\n`, 0))[0]?.output).toBe(`${title}done`);
  });

  it('does not hold an unfinished sequence for ever', () => {
    // A program that prints `ESC ]` and never ends it must not make the stream
    // swallow everything after it waiting for a terminator.
    const stream = new BlockStream();
    stream.push(osc('133;A') + '$ ' + osc('133;B') + 'cat x\r\n' + osc('133;C'));
    stream.push(`${ESC}]${'z'.repeat(5000)}`);
    const blocks = stream.push(osc('133;D;0'));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.output.length).toBeGreaterThan(5000);
  });

  it('knows what it has been told, and nothing about a plain terminal', () => {
    const stream = new BlockStream();
    stream.push('plain output with no marks\r\n');
    expect(stream.level).toBe('none');
  });
});

describe('plain text', () => {
  it('is what a reader sees, without colours or cursor moves', () => {
    expect(plainText(`${ESC}[31mred${ESC}[0m and ${ESC}[1;32mgreen${ESC}[0m`)).toBe('red and green');
    expect(plainText('a\r\nb')).toBe('a\nb');
  });
});
