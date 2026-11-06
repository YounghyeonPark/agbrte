/**
 * Where one command ends and the next begins, read from a terminal's own output
 * (DESIGN.md §17 Q23, step 1).
 *
 * The direction is one interface for the shell and the agent, and its unit is a
 * **block**: one command, its output, and how it ended. A terminal does not have
 * blocks. It has a byte stream in which a prompt, the keys somebody typed, and
 * whatever the program printed are indistinguishable — so the shell is taught to
 * say where they are, and this reads what it says.
 *
 * ## The marks, and why these ones
 *
 * FinalTerm's `OSC 133` is what VS Code, iTerm2, WezTerm, kitty and Warp all
 * read, and it is four letters:
 *
 *     ESC ] 133 ; A BEL     a prompt starts
 *     ESC ] 133 ; B BEL     the prompt ends; what follows is typed
 *     ESC ] 133 ; C BEL     the line was accepted; what follows is its output
 *     ESC ] 133 ; D;n BEL   it finished, with exit status n (absent: unknown)
 *
 * `OSC 633` is VS Code's extension of the same, and one of its letters is the
 * one thing 133 cannot say: `E;<command line>`, the line exactly as the shell
 * read it. Without it the command has to be reconstructed from the echo of the
 * keys, which is a terminal emulator's job and gets an edited line wrong. The
 * shells that can report it do (`integration.ts`); the ones that cannot fall back
 * to the echo, and a block records which it was.
 *
 * Both families are accepted with either terminator — `BEL`, or `ESC \` — since
 * `cmd.exe` can only produce the second.
 *
 * ## Marks anybody could print
 *
 * The marks are bytes in the output, and so is everything a program prints: a
 * `cat` of a hostile file, a test that echoes its fixture, a page the agent
 * fetched and printed. The host believes the marks about *what the person
 * ran*: a block goes into the log under the person and into the agent's next
 * turn as theirs. A file holding `D`, `A`, `B`, a line, `C`, some text and
 * `D` was, when printed, a whole command the person never typed, with
 * whatever output the file liked — and an `E` alone could rename the command
 * that printed it.
 *
 * So every mark the host's shells write carries a nonce, as VS Code's `E`
 * does: minted by the host for that one shell, handed to its startup script in
 * the environment, and taken out again before anything else runs
 * (`integration.ts`). It is the last field — `A;<n>`, `B;<n>`, `C;<n>`,
 * `D;<status>;<n>`, `E;<line>;<n>` — so a reader that does not know it, like
 * the renderer drawing decorations, reads the marks as before. A `BlockStream`
 * that knows it treats a mark without it as text in whatever region it came,
 * which is what a printed file is. `cmd.exe` holds its nonce in `PROMPT`,
 * where a program it starts can read it; what this defends against is text,
 * and text cannot know a value minted after it was written.
 *
 * ## Where this runs
 *
 * Here in `shared`, because both ends need it. The renderer reads marks to put a
 * decoration beside each command in the terminal; the host will read whole blocks
 * to record them (step 3) and to show the agent recent output (step 4). One
 * reading of the stream, so the scrollback a person sees and the record the host
 * keeps cannot disagree about where a command was.
 */

/**
 * One thing a shell said about itself. `nonce` is the mark's last field where
 * it has one past what the letter needs (see "Marks anybody could print").
 */
export type Mark = (
  | { kind: 'prompt' }
  | { kind: 'input' }
  | { kind: 'output' }
  | { kind: 'done'; exitCode: number | null }
  | { kind: 'command'; line: string }
) & { nonce?: string };

function vouched<M extends Mark>(mark: M, nonce: string | undefined): M {
  return nonce === undefined || nonce === '' ? mark : { ...mark, nonce };
}

/** How much a terminal has told us about its commands. */
export type IntegrationLevel =
  /** Prompts, the start of output, exit codes: every block is exact. */
  | 'full'
  /** Prompts only (`cmd.exe`): blocks are found, the command is read from the echo, the exit code is unknown. */
  | 'prompt'
  /** Nothing: a plain terminal, with no blocks in it. */
  | 'none';

/**
 * Undo `OSC 633`'s escaping of a command line: `\\` for a backslash and `\xNN`
 * for anything that would end or split the sequence — a `;`, a newline, a BEL.
 */
export function unescapeCommandLine(text: string): string {
  return text.replace(/\\(\\|x([0-9a-fA-F]{2}))/gu, (_whole, _escaped: string, hex?: string) =>
    hex !== undefined ? String.fromCharCode(parseInt(hex, 16)) : '\\',
  );
}

/**
 * Read the payload of one `OSC 133` or `OSC 633` sequence — everything after
 * `133;` or `633;` — or answer `null` for one this does not use.
 */
export function parseMark(family: '133' | '633', payload: string): Mark | null {
  const letter = payload.charAt(0);
  const rest = payload.length > 1 && payload.charAt(1) === ';' ? payload.slice(2) : '';
  const fields = rest === '' ? [] : rest.split(';');
  switch (letter) {
    case 'A':
      return vouched({ kind: 'prompt' }, fields[0]);
    case 'B':
      return vouched({ kind: 'input' }, fields[0]);
    case 'C':
      return vouched({ kind: 'output' }, fields[0]);
    case 'D': {
      // The status is the first field, empty where the shell cannot say; the
      // second is the nonce where there is one.
      const first = fields[0] ?? '';
      const code = /^-?\d+$/u.test(first) ? Number(first) : null;
      return vouched({ kind: 'done', exitCode: code }, fields[1]);
    }
    case 'E': {
      // Only VS Code's family carries a command line, and an `E` claiming to be
      // one under 133 is something else that happens to use the letter.
      if (family !== '633') return null;
      // The line's own `;` travel escaped, so the first one left ends it.
      const split = rest.indexOf(';');
      if (split === -1) return { kind: 'command', line: unescapeCommandLine(rest) };
      return vouched({ kind: 'command', line: unescapeCommandLine(rest.slice(0, split)) }, rest.slice(split + 1));
    }
    default:
      return null;
  }
}

/** One command, as the terminal showed it. */
export interface Block {
  /** The line that was run. */
  command: string;
  /** Reported by the shell (`exact`), or read back from the echo of the keys (`echo`). */
  commandFrom: 'exact' | 'echo';
  /** What it printed, escape sequences and all — the terminal's own rendering of it. */
  output: string;
  /** Exit status, or `null` where the shell cannot say (`cmd.exe`). */
  exitCode: number | null;
  /** The output was longer than the cap and only its end is kept. */
  truncated: boolean;
}

/** The end of a long output is kept rather than its start: that is where an error is. */
export const DEFAULT_MAX_OUTPUT = 256 * 1024;

/**
 * Strip what a terminal draws but a reader of the text does not see.
 *
 * A carriage return goes back to the start of the line and what follows writes
 * *over* it, as on a screen. Dropping `\r` instead kept every state a progress
 * bar passed through, and kept zsh's end-of-line mark — a `%` and a line of
 * spaces it prints after any output and then rubs out with `\r` — as part of
 * the output it follows. Trailing spaces on a line are not something a reader
 * can see either, so they go.
 */
export function plainText(raw: string): string {
  const lines: string[][] = [[]];
  let col = 0;
  for (const ch of raw
    // CSI (colours, cursor moves), OSC (titles, marks), and two-byte escapes.
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/gu, '')
    .replace(/\u001b[@-Z\\-_]/gu, '')) {
    const line = lines[lines.length - 1]!;
    if (ch === '\n') {
      lines.push([]);
      col = 0;
    } else if (ch === '\r') col = 0;
    else if (ch === '\b') col = Math.max(0, col - 1);
    else {
      line[col] = ch;
      col += 1;
    }
  }
  return lines.map((line) => Array.from(line, (ch) => ch ?? ' ').join('').trimEnd()).join('\n');
}

type Region = 'idle' | 'prompt' | 'input' | 'output';

/**
 * A terminal's output in, finished blocks out.
 *
 * Fed in whatever pieces the pty delivers, which split anywhere — including in
 * the middle of an escape sequence, so an unfinished `ESC ]` at the end of a
 * piece is held until the next one completes it rather than read as text.
 *
 * Tolerant in the directions a real shell is untidy: a `D` with no command
 * before it (an empty line, the very first prompt) finishes nothing; a prompt
 * that never said `C` (`cmd.exe`) has its command read from the first line typed
 * after `B` and its output from the lines after that.
 */
export class BlockStream {
  private readonly maxOutput: number;
  private carry = '';
  private region: Region = 'idle';
  private input = '';
  private output = '';
  private truncated = false;
  private reported: string | null = null;
  private seen = new Set<Mark['kind']>();
  private exitKnown = false;
  private prompts = 0;
  private readonly nonce: string | undefined;

  /**
   * `nonce`: the one the shell was given. With it, a mark that does not carry
   * it is text; without it — a shell this host did not teach, or the renderer,
   * which only draws — every mark is believed, as before.
   */
  constructor(opts: { maxOutput?: number; nonce?: string } = {}) {
    this.maxOutput = opts.maxOutput ?? DEFAULT_MAX_OUTPUT;
    this.nonce = opts.nonce;
  }

  /**
   * Where the shell is between its marks: `input` from the end of a prompt
   * until the line is accepted, `output` while a command runs. A shell that
   * marks only its prompts (`cmd.exe`) stays in `input` while its command runs,
   * so a caller asking "is it waiting for a line" must also know whether a line
   * was sent since — the terminal client tracks that from the keys it forwards.
   */
  get position(): 'idle' | 'prompt' | 'input' | 'output' {
    return this.region;
  }

  /**
   * How many prompts have ended so far (`B` marks). Compared before and after a
   * push, it says a prompt was drawn even when the position reads the same on
   * both sides — `cmd.exe` never leaves `input`, so its next prompt is visible
   * only as another `B`.
   */
  get promptCount(): number {
    return this.prompts;
  }

  /** What this terminal has shown it can do so far. */
  get level(): IntegrationLevel {
    if (this.seen.has('output') && this.exitKnown) return 'full';
    if (this.seen.has('prompt') || this.seen.has('input')) return 'prompt';
    return 'none';
  }

  /** Read one more piece of output; answer the blocks it finished. */
  push(chunk: string): Block[] {
    const finished: Block[] = [];
    let text = this.carry + chunk;
    this.carry = '';

    while (text.length > 0) {
      const at = text.indexOf('\u001b]');
      if (at === -1) {
        /*
         * A piece can end between the `ESC` and the `]`. Read as text, that lone
         * `ESC` would go into the block and the `]633;…` that follows would arrive
         * as text too — the mark lost, and with it the exact command line. Found
         * by the test that cuts one stream at every position; it failed at one.
         */
        if (text.endsWith('\u001b')) {
          this.take(text.slice(0, -1));
          this.carry = '\u001b';
        } else {
          this.take(text);
        }
        break;
      }
      this.take(text.slice(0, at));
      const rest = text.slice(at + 2);
      const bel = rest.indexOf('\u0007');
      const st = rest.indexOf('\u001b\\');
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
      if (end === -1) {
        // Unfinished: hold it for the next piece. Bounded, because a program that
        // prints `ESC ]` and never ends it must not make this hold everything.
        if (rest.length < 4096) this.carry = text.slice(at);
        else this.take(text.slice(at));
        break;
      }
      const body = rest.slice(0, end);
      const after = end + (end === bel ? 1 : 2);
      const semi = body.indexOf(';');
      const family = semi === -1 ? body : body.slice(0, semi);
      const parsed =
        family === '133' || family === '633' ? parseMark(family, body.slice(semi + 1)) : null;
      // Printed by something other than the shell: text, like any other.
      const mark = parsed !== null && this.nonce !== undefined && parsed.nonce !== this.nonce ? null : parsed;
      if (mark === null) {
        // Not ours — a window title, a hyperlink. It belongs to whatever region
        // it arrived in, exactly as the terminal will draw it.
        this.take(text.slice(at, at + 2 + after));
      } else {
        const block = this.apply(mark);
        if (block !== null) finished.push(block);
      }
      text = rest.slice(after);
    }
    return finished;
  }

  private take(text: string): void {
    if (text === '') return;
    if (this.region === 'input') this.input += text;
    else if (this.region === 'output') {
      this.output += text;
      if (this.output.length > this.maxOutput) {
        this.output = this.output.slice(this.output.length - this.maxOutput);
        this.truncated = true;
      }
    }
    // Prompt and idle text is the shell's own decoration, not part of a block.
  }

  private apply(mark: Mark): Block | null {
    this.seen.add(mark.kind);
    switch (mark.kind) {
      case 'prompt':
        this.region = 'prompt';
        return null;
      case 'input':
        this.prompts += 1;
        this.region = 'input';
        this.input = '';
        this.output = '';
        this.truncated = false;
        this.reported = null;
        return null;
      case 'command':
        this.reported = mark.line;
        return null;
      case 'output':
        this.region = 'output';
        return null;
      case 'done': {
        if (mark.exitCode !== null) this.exitKnown = true;
        const block = this.finish(mark.exitCode);
        this.region = 'idle';
        this.input = '';
        this.output = '';
        this.truncated = false;
        this.reported = null;
        return block;
      }
    }
  }

  private finish(exitCode: number | null): Block | null {
    if (this.region === 'output') {
      const command = this.reported ?? plainText(this.input).trim();
      if (command === '') return null;
      return {
        command,
        commandFrom: this.reported !== null ? 'exact' : 'echo',
        output: trimTrailingBreaks(this.output),
        exitCode,
        truncated: this.truncated,
      };
    }
    if (this.region === 'input') {
      // No `C`: the first line typed is the command, the rest is its output.
      const raw = this.input;
      const plain = plainText(raw);
      const newline = plain.indexOf('\n');
      const command = (newline === -1 ? plain : plain.slice(0, newline)).trim();
      if (command === '') return null;
      const breakAt = raw.indexOf('\n');
      const output = breakAt === -1 ? '' : raw.slice(breakAt + 1);
      return {
        command: this.reported ?? command,
        commandFrom: this.reported !== null ? 'exact' : 'echo',
        output: trimTrailingBreaks(
          output.length > this.maxOutput ? output.slice(output.length - this.maxOutput) : output,
        ),
        exitCode,
        truncated: output.length > this.maxOutput,
      };
    }
    // A `D` with no command before it: the first prompt, or an empty line.
    return null;
  }
}

function trimTrailingBreaks(text: string): string {
  return text.replace(/[\r\n]+$/u, '');
}
