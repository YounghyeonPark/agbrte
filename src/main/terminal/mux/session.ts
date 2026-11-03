/**
 * One terminal, the person's shell and the agent in it (DESIGN.md §17 Q24).
 *
 * The app is becoming a terminal, and the agent is becoming something that
 * happens *in* a terminal rather than in a chat pane beside one. This is the
 * program that makes that true: it runs on the machine that owns the session,
 * keeps the person's own shell inside a pseudoterminal of its own, and gives the
 * keys to one of the two:
 *
 *   - **The shell**, by default. Every byte goes through untouched and every
 *     byte of output comes back untouched, so completion, history, `vim` and
 *     Ctrl+C are the shell's own. The shell was taught to mark its prompts
 *     (`integration.ts`), which is how this knows when it is waiting for a line.
 *   - **The agent**, from a prompt: `?` on an empty line sends one message and
 *     comes back; the mode key (Ctrl+Space, Ctrl+` or Ctrl+@ — terminals send
 *     all three as one byte) stays until it is pressed again. The agent's line
 *     is edited here (`lineEditor.ts`), its replies are drawn here
 *     (`markdown.ts`), and a permission it asks for is a `y/N/a` on the line.
 *     `!` in front of an agent line runs that line in the shell and comes back.
 *
 * Because it is a program in a terminal, it is the same in the app's terminal
 * and in any other: Windows Terminal, iTerm, a tmux pane over ssh.
 *
 * ## Writing over a shell that thinks it owns the screen
 *
 * The shell's line editor believes it knows what is on the line. Anything
 * drawn under it is drawn only when the shell is at an empty prompt, and the
 * shell is then given an Enter on that empty line, which every shell answers by
 * drawing a fresh prompt and running nothing. Drawing over a half-typed line or
 * a running command would leave the shell's idea of the screen wrong, so output
 * that arrives then waits for the next prompt.
 *
 * Everything that touches a process or a socket is passed in, so the whole of
 * the routing is driven by a test with a fake shell and a fake agent.
 */

import { BlockStream } from '@shared/terminal/marks.js';
import type { IntegrationLevel } from '@shared/terminal/marks.js';
import type { AgbrteEvent, PermissionDecision, PermissionRequest } from '@shared/types/index.js';
import { KeyReader, type Key } from './keys.js';
import { draw, edit, emptyLine, type LineState } from './lineEditor.js';
import { renderMarkdown, type Style } from './markdown.js';

/** The shell, as this needs it. A `Pty` from `shell.ts` satisfies it. */
export interface ShellLink {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** The session, as this needs it. `HostConnection` calls behind each. */
export interface AgentLink {
  send(text: string): Promise<unknown>;
  interrupt(): Promise<unknown>;
  respond(requestId: string, decision: PermissionDecision): Promise<unknown>;
  /**
   * A picture the session holds, as the bytes that draw it on this terminal —
   * or `null` where the terminal cannot draw one, the blob is gone, or it is not
   * a picture. Absent: this terminal shows no pictures, and says where they are.
   */
  picture?(blob: { sha256: string; mime?: string }): Promise<string | null>;
}

export interface TerminalSessionOptions {
  out: (bytes: string) => void;
  columns: () => number;
  /** The terminal's height, for putting the cursor back where the shell left it (`resync`). */
  rows?: () => number;
  /**
   * Put the cursor back on the row the shell's pseudoconsole believes it is on
   * before handing the screen back. Needed on Windows, where the pseudoconsole
   * keeps its own copy of the screen and draws the shell's next prompt by
   * absolute position: without this, cmd.exe drew its prompt over the agent's
   * reply. Not needed where a pty is a byte stream (Linux, macOS).
   */
  resync?: boolean;
  shell: ShellLink;
  /** What the shell was taught to say; `none` means `?` cannot be recognised and only the mode key works. */
  integration: IntegrationLevel;
  agent: AgentLink;
  style: Style;
  /** Called once, when the shell exits. */
  exit: (code: number) => void;
}

/**
 * How long a picture may hold up what the agent says after it. A blob read is
 * local on the host and a round trip from the standalone client; past this the
 * transcript goes on without it rather than stalling on a picture.
 */
export const PICTURE_WAIT_MS = 5000;

/** The session states in which the turn is still the agent's. */
const TURN_RUNNING: ReadonlySet<string> = new Set(['planning', 'working', 'verifying', 'awaiting_permission']);

/**
 * What a terminal sends unasked: cursor reports, device attributes, window
 * sizes (`CSI 4;h;w t`, which a sixel program asks for), focus in/out, OSC and
 * DCS answers, and kitty's answers about a picture (an APC).
 */
const TERMINAL_REPLY =
  /^(?:\u001b\[\??[\d;]*[Rcnt]|\u001b\[[IO]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[P_][^\u001b]*\u001b\\)+$/u;

/** The byte terminals send for Ctrl+Space, Ctrl+` and Ctrl+@. */
export const MODE_KEY = '\u0000';

type Typed =
  /** Nothing typed since the prompt was drawn. */
  | 'empty'
  /** Something typed, or a key whose effect on the line cannot be known (an arrow, Tab). */
  | 'dirty'
  /** A line was sent and the shell has not drawn its next prompt. */
  | 'busy';

export class TerminalSession {
  private mode: 'shell' | 'agent' = 'shell';
  /** Entered with `?`: back to the shell once the agent's turn ends. */
  private oneShot = false;
  /** A `!` line is running in the shell; back to the agent at the next prompt. */
  private returnToAgent = false;
  private line: LineState = emptyLine();
  private drawn = { rows: 1, cursorRow: 0 };
  private turn: 'idle' | 'running' = 'idle';
  private typed: Typed = 'busy';
  private readonly marks = new BlockStream();
  private readonly keys = new KeyReader();
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lines for the screen, waiting for a moment the shell is not using it. */
  private waiting: string[] = [];
  /** Shell output that arrived while the agent had the screen. */
  private held = '';
  private questions: Array<{ request: PermissionRequest }> = [];
  /**
   * Turns sent from here and not yet seen coming back. The host logs a turn
   * with the sender's actor, which is also what marks a turn from another
   * device, so without this every message was printed twice: as typed, and
   * again as if somebody elsewhere had sent it.
   */
  private sentTexts: string[] = [];
  private asking = false;
  private ended = false;
  /** The row the shell's cursor was on when this took the screen (`resync`). */
  private anchor: number | null = null;
  private anchorPending = false;
  private rowWaiter: ((row: number | null) => void) | null = null;
  /** Handing the screen back is in progress; keys wait so none lands before the shell's Enter. */
  private givingBack = false;
  private queued = '';
  /**
   * Events that arrived while a picture was being fetched, in order. A picture
   * is a blob read and the text after it is not, so without this the agent's
   * next sentence printed above the screenshot it was about.
   */
  private behind: AgbrteEvent[] | null = null;

  constructor(private readonly o: TerminalSessionOptions) {}

  get currentMode(): 'shell' | 'agent' {
    return this.mode;
  }

  // ------------------------------------------------------------------ input

  /** Bytes from the person's keyboard. */
  input(chunk: string): void {
    if (this.ended) return;
    // The answer to a cursor-position question this session asked, which is
    // this session's and not a key for anybody.
    if (this.rowWaiter !== null) {
      const m = /\u001b\[(\d+);(\d+)R/u.exec(chunk);
      if (m !== null) {
        const resolve = this.rowWaiter;
        this.rowWaiter = null;
        resolve(Number(m[1]));
        chunk = chunk.slice(0, m.index) + chunk.slice(m.index + m[0].length);
        if (chunk === '') return;
      }
    }
    if (this.givingBack) {
      this.queued += chunk;
      return;
    }
    if (this.mode === 'shell' && !this.asking) {
      this.shellInput(chunk);
      return;
    }
    for (const key of this.keys.push(chunk)) this.agentKey(key);
    // A lone ESC is the Escape key only if nothing follows it soon.
    if (this.escTimer !== null) clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      this.escTimer = null;
      for (const key of this.keys.flushPending()) this.agentKey(key);
    }, 30);
  }

  private atEmptyPrompt(): boolean {
    return this.marks.position === 'input' && this.typed === 'empty';
  }

  private shellInput(chunk: string): void {
    const recognises = this.o.integration !== 'none';
    // The mode key, at a prompt. Anywhere else it is the running program's —
    // Ctrl+Space is set-mark in an editor.
    if (chunk === MODE_KEY && (!recognises || this.atEmptyPrompt())) {
      this.enterAgent(false);
      return;
    }
    if (chunk === '?' && recognises && this.atEmptyPrompt()) {
      this.enterAgent(true);
      return;
    }
    this.track(chunk);
    this.o.shell.write(chunk);
  }

  /** Follow what the keys did to the shell's line, as far as the keys can say. */
  private track(chunk: string): void {
    /*
     * Not every byte from the terminal is a key. Asked where its cursor is —
     * which Windows' pseudoconsole does as a shell starts — a terminal answers
     * `ESC [ row ; col R` down the same wire as the keyboard, and so do focus
     * reports and device attributes. Read as typing, that answer made the
     * prompt "not empty" before anybody touched a key, and the first `?` went
     * to `cmd.exe` as a command. Found in the app, not in a test of this file.
     */
    if (TERMINAL_REPLY.test(chunk)) return;
    if (this.typed === 'busy') {
      // Keys typed ahead while a command runs belong to the next line; the
      // prompt that comes back resets this either way.
      return;
    }
    for (const ch of chunk) {
      if (ch === '\r' || ch === '\n') this.typed = 'busy';
      else if (ch === '\u0003' || ch === '\u0015') this.typed = 'empty';
      else if (ch === '\u007f' || ch === '\b') {
        // Backspace may have emptied the line; it may not. Unknown is dirty.
        this.typed = 'dirty';
      } else this.typed = 'dirty';
      if (this.typed === 'busy') return;
    }
  }

  private agentKey(key: Key): void {
    if (this.asking) {
      this.answerKey(key);
      return;
    }
    if (key.kind === 'ctrl' && key.key === '@') {
      this.leaveAgent();
      return;
    }
    const { state, outcome } = edit(this.line, key);
    this.line = state;
    switch (outcome.kind) {
      case 'edit':
        this.redraw();
        return;
      case 'submit':
        this.submit(outcome.line);
        return;
      case 'pass':
        this.passed(outcome.key);
        return;
    }
  }

  private passed(key: Key): void {
    if (key.kind === 'ctrl' && key.key === 'c') {
      if (this.turn === 'running') {
        void this.o.agent.interrupt().catch(() => undefined);
        this.print([this.o.style.dim('interrupted')]);
      } else {
        this.line = emptyLine(this.line.history);
        this.redraw();
      }
      return;
    }
    if ((key.kind === 'ctrl' && key.key === 'd') || key.kind === 'escape') {
      // Back to the shell, as Ctrl+D leaves a shell's own sub-prompt.
      this.leaveAgent();
    }
  }

  private submit(text: string): void {
    const trimmed = text.trim();
    // The line stays on screen as it was typed, as a shell leaves a command.
    this.finishLine();
    if (trimmed === '') {
      if (this.oneShot) this.leaveAgent(false);
      else this.redraw();
      return;
    }
    if (trimmed.startsWith('!')) {
      const command = trimmed.slice(1).trim();
      if (command === '') {
        this.redraw();
        return;
      }
      // Into the shell for one line, then back here at its next prompt.
      this.returnToAgent = true;
      this.mode = 'shell';
      this.out('\u001b[?2004l');
      this.out(this.held);
      this.held = '';
      // As typed, onto the empty line the agent was entered from. This sent a
      // Ctrl+U first to clear the line, which bash reads as that and cmd.exe
      // and PowerShell read as a character: they ran `^Uecho bang`.
      this.giveBack(`${command}\r`);
      return;
    }
    this.turn = 'running';
    this.redraw();
    this.sentTexts.push(trimmed);
    // Through a promise even if `send` throws where it stands: a session with
    // no agent refused synchronously, the throw went past the `.catch`, and the
    // prompt sat at "…" for ever with nothing said.
    void Promise.resolve()
      .then(() => this.o.agent.send(trimmed))
      .catch((err: unknown) => {
        this.turn = 'idle';
        this.sentTexts = this.sentTexts.filter((t) => t !== trimmed);
        this.print([this.o.style.dim(`could not send: ${err instanceof Error ? err.message : String(err)}`)]);
        // Nothing will end this turn, so a one-message visit ends here.
        if (this.oneShot && this.mode === 'agent') this.leaveAgent();
      });
  }

  // ------------------------------------------------------------- the modes

  private enterAgent(oneShot: boolean): void {
    this.takeScreen();
    this.mode = 'agent';
    this.oneShot = oneShot;
    // The prompt's line is taken over; the shell is given it back on the way out.
    this.out('\r\u001b[2K');
    // A paste is a paste, not a run of Enters.
    this.out('\u001b[?2004h');
    this.drawn = { rows: 1, cursorRow: 0 };
    this.flushWaiting();
    this.drawLine();
  }

  private leaveAgent(clear = true): void {
    if (this.mode !== 'agent') return;
    if (clear) this.out(this.clearLine());
    this.mode = 'shell';
    this.oneShot = false;
    this.out('\u001b[?2004l');
    this.out(this.held);
    this.held = '';
    // An Enter on the shell's empty line: it draws a fresh prompt and runs nothing.
    this.giveBack('\r');
  }

  // ----------------------------------------------------------- shell output

  /** Bytes from the shell's pseudoterminal. */
  shellOutput(data: string): void {
    if (this.ended) return;
    const before = this.marks.promptCount;
    this.marks.push(data);
    if (this.mode === 'agent') {
      this.held += data;
      return;
    }
    this.out(data);
    if (this.marks.promptCount !== before) this.atPrompt();
  }

  /** The shell has just drawn a prompt and is waiting for a line. */
  private atPrompt(): void {
    this.typed = 'empty';
    if (this.returnToAgent) {
      this.returnToAgent = false;
      this.enterAgent(false);
      return;
    }
    if (this.waiting.length > 0 || this.questions.length > 0) {
      this.takeScreen();
      this.out('\r\u001b[2K');
      this.flushWaiting();
      if (this.questions.length > 0) {
        this.ask();
        return;
      }
      this.giveBack('\r');
    }
  }

  shellExited(code: number): void {
    if (this.ended) return;
    this.ended = true;
    if (this.mode === 'agent') this.out(this.clearLine());
    this.out('\u001b[?2004l');
    this.out(`\r\n${this.o.style.dim('shell exited — the session keeps running')}\r\n`);
    this.o.exit(code);
  }

  resize(cols: number, rows: number): void {
    this.o.shell.resize(cols, rows);
    if (this.mode === 'agent' && !this.asking) this.redraw();
  }

  // ------------------------------------------------------------ the agent

  /** One event from the session, already filtered to this session and deduplicated. */
  event(e: AgbrteEvent): void {
    if (this.behind !== null) {
      this.behind.push(e);
      return;
    }
    this.handle(e);
  }

  private handle(e: AgbrteEvent): void {
    if (e.type === 'session.state') {
      const was = this.turn;
      /*
       * Still the agent's turn while it plans, works, checks its work or waits
       * on a permission this terminal is about to ask. This was `to ===
       * 'working'`, and a turn passes through `planning` first: the `?` that
       * asked was answered by the shell's prompt coming straight back, before
       * the reply — on every run once the host was fast enough to send the
       * state before the text.
       */
      this.turn = TURN_RUNNING.has(e.to) ? 'running' : 'idle';
      if (was === 'running' && this.turn === 'idle' && this.mode === 'agent') {
        if (this.oneShot && !this.asking && this.questions.length === 0) {
          this.leaveAgent();
          return;
        }
        this.redraw();
      }
      return;
    }
    // A question this terminal is holding, settled somewhere else or by nobody:
    // the agent that asked is gone, or another device answered first.
    if (
      (e.type === 'permission.withdrawn' || e.type === 'permission.decided') &&
      this.questions.some((q) => q.request.requestId === e.requestId)
    ) {
      this.withdraw(e.requestId);
    }
    if (e.type === 'user.turn') {
      const text = e.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      const own = this.sentTexts.indexOf(text);
      if (own !== -1) {
        this.sentTexts.splice(own, 1);
        return;
      }
    }
    const lines = renderEvent(e, this.o.style, this.o.columns());
    if (lines.length > 0) this.print(lines);
    const blob = pictureOf(e);
    if (blob !== null && this.o.agent.picture !== undefined) this.showPicture(this.o.agent.picture(blob));
  }

  /**
   * Draw a picture the agent produced, holding back what came after it until it
   * is drawn or has taken too long. Drawn like any other line: now if the screen
   * is the agent's, at the next empty prompt if the shell is busy.
   */
  private showPicture(fetching: Promise<string | null>): void {
    this.behind = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PICTURE_WAIT_MS);
    });
    void Promise.race([fetching.catch(() => null), late]).then((drawn) => {
      if (timer !== null) clearTimeout(timer);
      if (drawn !== null && drawn !== '' && !this.ended) this.print([drawn.replace(/\r?\n$/u, '')]);
      const later = this.behind ?? [];
      this.behind = null;
      for (let k = 0; k < later.length; k += 1) {
        // Another picture among them holds the rest again.
        if (this.behind !== null) {
          (this.behind as AgbrteEvent[]).push(...later.slice(k));
          return;
        }
        this.handle(later[k]!);
      }
    });
  }

  /** A permission request: a question on the line, answered with one key. */
  permission(request: PermissionRequest): void {
    this.questions.push({ request });
    if (this.mode === 'agent') {
      if (!this.asking) this.ask();
    } else if (this.atEmptyPrompt()) {
      this.takeScreen();
      this.out('\r\u001b[2K');
      this.ask();
    }
  }

  /** Someone else answered first, or the request went away. */
  withdraw(requestId: string): void {
    const first = this.questions[0];
    this.questions = this.questions.filter((q) => q.request.requestId !== requestId);
    if (this.asking && first?.request.requestId === requestId) {
      this.asking = false;
      this.out(`${this.o.style.dim('answered elsewhere')}\r\n`);
      this.afterQuestion();
    }
  }

  private ask(): void {
    const next = this.questions[0];
    if (next === undefined) return;
    if (this.mode === 'agent' && !this.asking) this.out(this.clearLine());
    this.asking = true;
    const s = this.o.style;
    this.out(
      `${s.accent('◆')} ${s.bold(next.request.tool)} ${s.dim(previewArgs(next.request.args))}\r\n` +
        `  allow? [y/N/a=session] `,
    );
  }

  private answerKey(key: Key): void {
    const next = this.questions[0];
    if (next === undefined) {
      this.asking = false;
      return;
    }
    // y, n, a or Enter (no). Any other key is ignored rather than read as a
    // refusal: one stray key must not answer a question for somebody.
    const text = key.kind === 'text' ? key.text.toLowerCase() : key.kind === 'enter' ? '' : null;
    if (text === null || !['y', 'n', 'a', ''].includes(text)) return;
    const decision: PermissionDecision =
      text === 'y'
        ? { result: 'allow', scope: 'once' }
        : text === 'a'
          ? { result: 'allow', scope: 'session' }
          : { result: 'deny', reason: 'denied at the terminal' };
    this.out(`${decision.result === 'allow' ? text : 'n'}\r\n`);
    this.questions.shift();
    this.asking = false;
    void this.o.agent.respond(next.request.requestId, decision).catch(() => undefined);
    this.afterQuestion();
  }

  private afterQuestion(): void {
    if (this.questions.length > 0) {
      this.ask();
      return;
    }
    if (this.mode === 'agent') {
      this.drawn = { rows: 1, cursorRow: 0 };
      this.drawLine();
    } else {
      // Asked over the shell's empty prompt: give it back.
      this.giveBack('\r');
    }
  }

  // ------------------------------------------------- the shell's screen

  /** Ask the terminal which row the cursor is on. `null` if it does not answer. */
  private askRow(): Promise<number | null> {
    return new Promise((resolve) => {
      this.rowWaiter = resolve;
      this.out('\u001b[6n');
      setTimeout(() => {
        if (this.rowWaiter === resolve) {
          this.rowWaiter = null;
          resolve(null);
        }
      }, 300);
    });
  }

  /**
   * About to draw over the shell's prompt: remember the row it is on, which is
   * where the shell's pseudoconsole will go on believing the cursor is.
   */
  private takeScreen(): void {
    if (this.o.resync !== true || this.anchor !== null || this.anchorPending) return;
    this.anchorPending = true;
    void this.askRow().then((row) => {
      this.anchorPending = false;
      this.anchor = row;
    });
  }

  /**
   * Give the screen back to the shell with `keys` — an Enter on its empty line,
   * or a command from `!`.
   *
   * With `resync`, first scroll what was drawn up above the row the shell's
   * pseudoconsole believes it is on, and put the cursor there: the
   * pseudoconsole then draws the next prompt on the row it expects, below
   * what the agent said rather than over it. Done with line feeds at the bottom
   * of the screen rather than a scroll command, because a line feed keeps what
   * scrolls off in the terminal's history and a scroll command discards it.
   */
  private giveBack(keys: string): void {
    this.typed = 'busy';
    if (this.o.resync !== true) {
      this.o.shell.write(keys);
      return;
    }
    this.givingBack = true;
    void (async () => {
      while (this.anchorPending) await new Promise((r) => setTimeout(r, 5));
      const anchor = this.anchor;
      this.anchor = null;
      if (anchor !== null) {
        const row = await this.askRow();
        const rows = this.o.rows?.() ?? 24;
        if (row !== null && row > anchor) {
          this.out(`\u001b[${rows};1H${'\n'.repeat(row - anchor)}\u001b[${anchor};1H`);
        }
      }
      this.givingBack = false;
      this.o.shell.write(keys);
      const waiting = this.queued;
      this.queued = '';
      if (waiting !== '') this.input(waiting);
    })();
  }

  // ------------------------------------------------------------- drawing

  private print(lines: string[]): void {
    if (this.mode === 'agent' && !this.asking) {
      this.out(this.clearLine());
      this.out(lines.map((l) => `${l}\r\n`).join(''));
      this.drawn = { rows: 1, cursorRow: 0 };
      this.drawLine();
      return;
    }
    if (this.mode === 'shell' && this.atEmptyPrompt()) {
      this.takeScreen();
      this.out('\r\u001b[2K');
      this.out(lines.map((l) => `${l}\r\n`).join(''));
      this.giveBack('\r');
      return;
    }
    this.waiting.push(...lines);
  }

  private flushWaiting(): void {
    if (this.waiting.length === 0) return;
    this.out(this.waiting.map((l) => `${l}\r\n`).join(''));
    this.waiting = [];
  }

  private prompt(): string {
    const s = this.o.style;
    return this.turn === 'running' ? `${s.dim('…')} ` : `${s.accent('›')} `;
  }

  private drawLine(): void {
    const next = draw(this.line, this.prompt(), this.o.columns(), this.drawn);
    this.out(next.bytes);
    this.drawn = { rows: next.rows, cursorRow: next.cursorRow };
  }

  private redraw(): void {
    if (this.mode !== 'agent' || this.asking) return;
    this.drawLine();
  }

  /** Erase the drawn line and leave the cursor at its start. */
  private clearLine(): string {
    const up = this.drawn.cursorRow > 0 ? `\u001b[${this.drawn.cursorRow}A` : '';
    this.drawn = { rows: 1, cursorRow: 0 };
    return `${up}\r\u001b[J`;
  }

  /** Leave the submitted line on screen and move below it. */
  private finishLine(): void {
    const below = this.drawn.rows - 1 - this.drawn.cursorRow;
    this.out(`${below > 0 ? `\u001b[${below}B` : ''}\r\n`);
    this.drawn = { rows: 1, cursorRow: 0 };
  }

  private out(bytes: string): void {
    if (bytes !== '') this.o.out(bytes);
  }
}

/** The picture an event carries, if it carries one: a capture, or a tool's first result blob. */
export function pictureOf(e: AgbrteEvent): { sha256: string; mime?: string } | null {
  if (e.type === 'capture.attached') return { sha256: e.sha256, mime: e.mime };
  if (e.type === 'agent.tool_result' && e.resultBlobs !== undefined && e.resultBlobs.length > 0) {
    return { sha256: e.resultBlobs[0]! };
  }
  return null;
}

/** Shorten a tool's arguments for one line. */
function previewArgs(value: unknown, max = 100): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * An event as terminal lines, or none for what a person reading along does not
 * need. State changes are left out on purpose: a terminal that printed
 * "planning → working" on every turn would be a log, not a conversation; the
 * prompt's own `›` and `…` say whether the agent is busy.
 */
export function renderEvent(e: AgbrteEvent, s: Style, columns: number): string[] {
  switch (e.type) {
    case 'agent.text':
      return renderMarkdown(e.text, s, columns);
    case 'user.turn':
      // Our own turn is already on screen as typed. Another client's is not.
      if (e.actor === undefined) return [];
      return [s.dim(`‹ ${e.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ')} · ${e.actor.label ?? 'elsewhere'}`)];
    case 'agent.tool_use':
      return [`${s.accent('⚒')} ${e.tool} ${s.dim(previewArgs(e.args))}`];
    case 'agent.tool_result':
      return [`${e.ok ? '✓' : '✗'} ${s.dim(previewArgs(e.summary))}`];
    case 'permission.decided':
      return e.via === 'policy' ? [] : [s.dim(`  ${e.decision.result} ${e.tool}`)];
    case 'agent.stopped':
      // The ordinary end of a turn is the prompt coming back; anything else is news.
      return e.stop.kind === 'end_turn' ? [] : [s.dim(`— ${e.stop.kind}`)];
    default:
      return [];
  }
}
