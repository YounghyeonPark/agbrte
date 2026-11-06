/**
 * The end of a session's past, drawn above a fresh shell's first prompt
 * (`src/main/terminal/mux/earlier.ts`, `session.ts`).
 *
 * A tab reopened after a restart is a new shell over an old session, and its
 * screen was empty. What is pinned: the past is drawn from the log in the order
 * it happened and above the greeting; the greeting waits for it, but not for
 * ever; a new session draws nothing; the replay is bounded and cannot carry a
 * cursor move onto the screen; and an event that is both in the log read and
 * sent live is drawn once.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EARLIER_WAIT_MS, TerminalSession } from '../src/main/terminal/mux/session.js';
import { EARLIER_MAX_LINES, earlierLines } from '../src/main/terminal/mux/earlier.js';
import { plainStyle } from '../src/main/terminal/mux/markdown.js';
import type { AgbrteEvent } from '@shared/types/index.js';

const ESC = '\u001b';
const BEL = '\u0007';
const osc = (body: string): string => `${ESC}]${body}${BEL}`;
const PROMPT = osc('133;A') + '$ ' + osc('133;B');

let seq = 0;
const ev = (body: Record<string, unknown>): AgbrteEvent =>
  ({ seq: (seq += 1), id: `e${seq}`, at: '', ...body }) as unknown as AgbrteEvent;

const shellBlock = (command: string, output: string): AgbrteEvent =>
  ev({ type: 'shell.block', command, commandFrom: 'exact', output, exitCode: 1, truncated: false, masked: 0 });
const asked = (text: string): AgbrteEvent =>
  ev({ type: 'user.turn', content: [{ type: 'text', text }], actor: { kind: 'client', label: 'this window' } });
const said = (text: string): AgbrteEvent => ev({ type: 'agent.text', text });

function terminal(history: () => Promise<readonly AgbrteEvent[]>) {
  const screen: string[] = [];
  const toShell: string[] = [];
  const session = new TerminalSession({
    out: (b) => screen.push(b),
    columns: () => 80,
    rows: () => 24,
    shell: { write: (d) => toShell.push(d), resize: () => undefined, kill: () => undefined },
    integration: 'full',
    agent: {
      send: async () => undefined,
      interrupt: async () => undefined,
      respond: async () => undefined,
      seated: () => true,
      history,
    },
    style: plainStyle,
    exit: () => undefined,
    palette: true,
  });
  return { session, screen: () => screen.join(''), toShell, prompt: () => session.shellOutput(PROMPT) };
}

/** Let the history promise and its `.then` run. */
const settle = async (): Promise<void> => {
  await new Promise((done) => setTimeout(done, 0));
};

afterEach(() => {
  vi.useRealTimers();
});

describe('a terminal opened on a session with a past', () => {
  it('draws the end of the conversation above the greeting, in order, and gives the shell its prompt back', async () => {
    const past = [
      ev({ type: 'session.created' }),
      shellBlock('node test.js', 'FAIL expected 2'),
      asked('why did that fail?'),
      said('The value is a string.'),
    ];
    const t = terminal(async () => past);
    await settle();
    t.prompt();
    const screen = t.screen();
    const order = [
      '── earlier in this session ──',
      '$ node test.js',
      'FAIL expected 2',
      '? why did that fail?',
      'The value is a string.',
      '── a new shell ──',
      '? asks the agent once',
    ].map((line) => screen.indexOf(line));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // One Enter, as for the greeting alone: the shell draws a fresh prompt.
    expect(t.toShell).toEqual(['\r']);
  });

  it('holds the greeting at a prompt that comes before the log is read, then draws both', async () => {
    let answer: (events: readonly AgbrteEvent[]) => void = () => undefined;
    const t = terminal(() => new Promise((done) => (answer = done)));
    t.prompt();
    expect(t.screen()).not.toContain('asks the agent');
    expect(t.toShell).toEqual([]);
    answer([shellBlock('ls', 'a.txt')]);
    await settle();
    expect(t.screen()).toContain('$ ls');
    expect(t.screen().indexOf('$ ls')).toBeLessThan(t.screen().indexOf('asks the agent'));
    expect(t.toShell).toEqual(['\r']);
  });

  it('does not wait for ever for a log that does not answer', async () => {
    vi.useFakeTimers();
    const t = terminal(() => new Promise(() => undefined));
    t.prompt();
    expect(t.screen()).not.toContain('asks the agent');
    await vi.advanceTimersByTimeAsync(EARLIER_WAIT_MS);
    expect(t.screen()).toContain('asks the agent');
    expect(t.screen()).not.toContain('earlier in this session');
  });

  it('greets as before when the log cannot be read', async () => {
    const t = terminal(() => Promise.reject(new Error('gone')));
    await settle();
    t.prompt();
    expect(t.screen()).toContain('asks the agent');
    expect(t.screen()).not.toContain('earlier in this session');
  });

  it('draws nothing over a new session, whose log holds only its creation', async () => {
    const t = terminal(async () => [ev({ type: 'session.created' }), ev({ type: 'session.state', to: 'idle' })]);
    await settle();
    t.prompt();
    expect(t.screen()).not.toContain('earlier');
    expect(t.screen()).toContain('asks the agent');
  });

  it('draws an event once when it is in the log read and also sent live', async () => {
    let answer: (events: readonly AgbrteEvent[]) => void = () => undefined;
    const t = terminal(() => new Promise((done) => (answer = done)));
    const both = said('said exactly once');
    answer([shellBlock('ls', 'a.txt'), both]);
    await settle();
    t.session.event(both);
    t.prompt();
    expect(t.screen().split('said exactly once')).toHaveLength(2);
  });

  it('leaves to the live terminal what arrived live before the log was read', async () => {
    let answer: (events: readonly AgbrteEvent[]) => void = () => undefined;
    const t = terminal(() => new Promise((done) => (answer = done)));
    const early = said('arrived live first');
    t.session.event(early);
    answer([shellBlock('ls', 'a.txt'), early]);
    await settle();
    t.prompt();
    expect(t.screen().split('arrived live first')).toHaveLength(2);
  });
});

describe('the replay itself', () => {
  it('keeps the end of a long past, and says where the rest is', () => {
    const past = Array.from({ length: 200 }, (_, i) => shellBlock(`echo ${i}`, `${i}`));
    const lines = earlierLines(past, plainStyle, 80, { palette: true });
    expect(lines).toHaveLength(EARLIER_MAX_LINES);
    expect(lines[0]).toContain('Ctrl+Shift+P');
    expect(lines.join('\n')).toContain('$ echo 199');
    expect(lines.join('\n')).not.toContain('$ echo 0\n');
    // Outside the app there is no palette to name.
    expect(earlierLines(past, plainStyle, 80, { palette: false })[0]).not.toContain('Ctrl+Shift+P');
  });

  it('keeps the end of a command’s output, which is where a failure says why', () => {
    const output = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const text = earlierLines([shellBlock('make', output)], plainStyle, 80, { palette: true }).join('\n');
    expect(text).toContain('line 29');
    expect(text).not.toContain('line 0\n');
    expect(text).toContain('lines above');
  });

  it('carries no cursor move or screen clear from the log onto the screen', () => {
    const text = earlierLines(
      [shellBlock(`echo ${ESC}[2J`, `${ESC}[H${ESC}[2Jcleared`), said(`text ${ESC}[3A up`)],
      plainStyle,
      80,
      { palette: true },
    ).join('\n');
    expect(text).not.toContain(ESC);
    expect(text).toContain('cleared');
  });
});
