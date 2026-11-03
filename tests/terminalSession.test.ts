/**
 * Routing keys and output between a shell and an agent in one terminal
 * (`src/cli/terminal/session.ts`).
 *
 * A fake shell that speaks the marks a taught shell writes, and a fake agent
 * that records what it was asked. What is pinned is who gets each key and when
 * something may be drawn: a `?` in the middle of a command line is the shell's,
 * an agent reply that arrives while the person is typing waits for the prompt,
 * and every return to the shell gives it the Enter that makes it draw its own
 * prompt again.
 */

import { describe, expect, it, vi } from 'vitest';
import { MODE_KEY, TerminalSession, greeting } from '../src/main/terminal/mux/session.js';
import { plainStyle } from '../src/main/terminal/mux/markdown.js';
import type { Block } from '@shared/terminal/marks.js';
import type { AgbrteEvent, PermissionRequest } from '@shared/types/index.js';

const ESC = '\u001b';
const BEL = '\u0007';
const osc = (body: string): string => `${ESC}]${body}${BEL}`;
const PROMPT = osc('133;A') + '$ ' + osc('133;B');

/**
 * Off unless a test is about it: the greeting takes the first prompt and asks
 * the shell for another, which every other test here would have to step past.
 */
function harness(integration: 'full' | 'prompt' | 'none' = 'full', resync = false, greet = false, seated = true) {
  const screen: string[] = [];
  const toShell: string[] = [];
  const sent: string[] = [];
  const answers: Array<{ requestId: string; decision: unknown }> = [];
  const interrupts = vi.fn(async () => undefined);
  const exits: number[] = [];
  const records: Block[] = [];
  const session = new TerminalSession({
    out: (b) => screen.push(b),
    columns: () => 80,
    rows: () => 24,
    resync,
    shell: { write: (d) => toShell.push(d), resize: () => undefined, kill: () => undefined },
    integration,
    agent: {
      send: async (t) => {
        sent.push(t);
      },
      interrupt: interrupts,
      respond: async (requestId, decision) => {
        answers.push({ requestId, decision });
      },
      seated: () => seated,
      record: (b) => records.push(b),
    },
    style: plainStyle,
    exit: (code) => exits.push(code),
    greet,
    palette: true,
  });
  let seq = 0;
  const event = (body: Record<string, unknown>): void =>
    session.event({ seq: (seq += 1), id: `e${seq}`, at: '', ...body } as unknown as AgbrteEvent);
  return {
    session,
    screen: () => screen.join(''),
    clearScreen: () => screen.splice(0),
    toShell,
    sent,
    answers,
    interrupts,
    exits,
    records,
    event,
    prompt: () => session.shellOutput(PROMPT),
  };
}

describe('the greeting', () => {
  it('says how to reach the agent above the first prompt, once, and gives the shell its prompt back', () => {
    const h = harness('full', false, true);
    h.prompt();
    expect(h.screen()).toContain('? asks the agent once');
    expect(h.screen()).toContain('Ctrl+Space talks until Esc');
    expect(h.screen()).not.toContain('no agent');
    // The Enter on the empty line that makes the shell draw a fresh prompt.
    expect(h.toShell).toEqual(['\r']);
    h.prompt();
    h.clearScreen();
    h.prompt();
    expect(h.screen()).not.toContain('asks the agent');
    // And the first ? after it is the agent's, as on any prompt.
    h.session.input('?');
    expect(h.session.currentMode).toBe('agent');
  });

  it('says how to choose an agent when the tab has none', () => {
    const h = harness('full', false, true, false);
    h.prompt();
    expect(h.screen()).toContain('no agent in this tab yet');
    expect(h.screen()).toContain('Choose the agent for this tab');
  });

  it('is not drawn where ? cannot be recognised, nor names a palette a terminal does not have', () => {
    const h = harness('none', false, true);
    h.prompt();
    expect(h.screen()).not.toContain('asks the agent');
    const plain = greeting(plainStyle, { palette: false, seated: false }).join('\n');
    expect(plain).not.toContain('Ctrl+Shift+P');
    expect(plain).toContain('choose one in the app');
  });
});

describe('what is recorded', () => {
  it('hands each command the shell finished to the session, and never what the agent drew', async () => {
    const h = harness();
    h.prompt();
    h.session.input('ls\r');
    h.session.shellOutput(osc('633;E;ls') + osc('133;C') + 'a.txt\r\n' + osc('133;D;0'));
    h.prompt();
    expect(h.records).toHaveLength(1);
    expect(h.records[0]).toMatchObject({ command: 'ls', exitCode: 0 });
    expect(h.records[0]!.output).toContain('a.txt');

    // A reply drawn at the prompt, and the Enter that gives the screen back.
    h.session.input('?');
    h.session.input('hi\r');
    await Promise.resolve();
    h.event({ type: 'agent.text', text: 'the secret plan' });
    h.event({ type: 'session.state', from: 'working', to: 'idle' });
    h.prompt();
    expect(h.records.map((r) => r.output).join('')).not.toContain('secret plan');
  });

  it('says in the greeting that the agent sees the shell', () => {
    const h = harness('full', false, true);
    h.prompt();
    expect(h.screen()).toContain('the agent sees the commands you run here');
    expect(h.screen()).toContain('others may not be');
  });
});

describe('in the shell', () => {
  it('passes every key through and shows every byte the shell writes', () => {
    const h = harness();
    h.prompt();
    h.session.input('ls -la');
    h.session.input('\r');
    expect(h.toShell).toEqual(['ls -la', '\r']);
    expect(h.screen()).toContain('$ ');
    expect(h.session.currentMode).toBe('shell');
  });

  it('does not count the terminal’s own answers as typing', () => {
    /*
     * Windows' pseudoconsole asks where the cursor is as a shell starts, and
     * the terminal answers on the keyboard's wire. Counted as a key, it made
     * the prompt "not empty" and the first `?` went to `cmd.exe` as a command.
     */
    const h = harness();
    h.prompt();
    h.session.input(`${ESC}[12;40R`);
    h.session.input(`${ESC}[I`);
    h.session.input('?');
    expect(h.session.currentMode).toBe('agent');
    expect(h.toShell).toEqual([`${ESC}[12;40R`, `${ESC}[I`]);
  });

  it('does not count the answers a picture program gets as typing either', () => {
    // The window's size in pixels (`chafa` asks before drawing a sixel), and
    // kitty's answer about a picture — both arrive on the keyboard's wire.
    const h = harness();
    h.prompt();
    h.session.input(`${ESC}[4;600;800t`);
    h.session.input(`${ESC}_Gi=31;OK${ESC}\\`);
    h.session.input('?');
    expect(h.session.currentMode).toBe('agent');
  });

  it('leaves a ? that is part of a command line to the shell', () => {
    const h = harness();
    h.prompt();
    h.session.input('ls ');
    h.session.input('?');
    expect(h.toShell).toEqual(['ls ', '?']);
    expect(h.session.currentMode).toBe('shell');
  });

  it('leaves the mode key to a running program, where it may mean something', () => {
    const h = harness();
    h.prompt();
    h.session.input('vim\r');
    h.session.shellOutput(osc('133;C'));
    h.session.input(MODE_KEY);
    expect(h.toShell).toEqual(['vim\r', MODE_KEY]);
    expect(h.session.currentMode).toBe('shell');
  });
});

describe('to the agent and back', () => {
  it('takes ? at an empty prompt as one message, and returns when the turn ends', async () => {
    const h = harness();
    h.prompt();
    h.session.input('?');
    expect(h.session.currentMode).toBe('agent');
    expect(h.toShell).toEqual([]); // the ? never reached the shell
    h.session.input('why did it fail');
    h.session.input('\r');
    await Promise.resolve();
    expect(h.sent).toEqual(['why did it fail']);

    h.event({ type: 'session.state', from: 'awaiting_input', to: 'working' });
    h.event({ type: 'agent.text', text: 'The **test** expects `3`.' });
    expect(h.screen()).toContain('The test expects 3.');
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_input' });

    expect(h.session.currentMode).toBe('shell');
    // The Enter that makes the shell draw its prompt again.
    expect(h.toShell).toEqual(['\r']);
  });

  it('does not print its own turn a second time when the host logs it', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.input('only once\r');
    h.clearScreen();
    h.event({ type: 'user.turn', content: [{ type: 'text', text: 'only once' }], actor: { kind: 'human', label: 'me@laptop' } });
    expect(h.screen()).not.toContain('only once');
    // ...while a turn from another device is shown.
    h.event({ type: 'user.turn', content: [{ type: 'text', text: 'from the phone' }], actor: { kind: 'human', label: 'phone' } });
    expect(h.screen()).toContain('from the phone');
  });

  it('waits for the reply through planning, not only working', () => {
    // A turn passes through `planning` first. Reading every state but
    // `working` as "done" sent the person back to the shell before the reply.
    const h = harness();
    h.prompt();
    h.session.input('?');
    h.session.input('q');
    h.session.input(String.fromCharCode(13));
    h.event({ type: 'session.state', from: 'awaiting_input', to: 'planning' });
    h.event({ type: 'session.state', from: 'planning', to: 'working' });
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_permission' });
    expect(h.session.currentMode).toBe('agent');
    h.event({ type: 'session.state', from: 'awaiting_permission', to: 'working' });
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_input' });
    expect(h.session.currentMode).toBe('shell');
  });

  it('stays with the agent after the mode key until it is pressed again', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.input('hello\r');
    h.event({ type: 'session.state', from: 'awaiting_input', to: 'working' });
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_input' });
    expect(h.session.currentMode).toBe('agent');
    h.session.input(MODE_KEY);
    expect(h.session.currentMode).toBe('shell');
    expect(h.toShell).toEqual(['\r']);
  });

  it('runs a ! line in the shell and comes back at the next prompt', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.input('!git status\r');
    // No Ctrl+U in front: cmd.exe and PowerShell read it as a character.
    expect(h.toShell).toEqual(['git status\r']);
    expect(h.session.currentMode).toBe('shell');
    h.session.shellOutput(osc('133;C') + 'On branch main\r\n' + osc('133;D;0'));
    expect(h.screen()).toContain('On branch main');
    h.prompt();
    expect(h.session.currentMode).toBe('agent');
    expect(h.sent).toEqual([]);
  });

  it('holds the shell’s output while the agent has the screen, and shows it on the way back', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.clearScreen();
    h.session.shellOutput('[1]+  Done   sleep 5\r\n');
    expect(h.screen()).not.toContain('Done');
    h.session.input(MODE_KEY);
    expect(h.screen()).toContain('Done');
  });

  it('says why a message could not be sent, even when sending throws where it stands', async () => {
    // A session with no agent refused synchronously; the throw went past the
    // `.catch` and the prompt sat at "…" with nothing said.
    const shown: string[] = [];
    const session = new TerminalSession({
      out: (b) => shown.push(b),
      columns: () => 80,
      shell: { write: () => undefined, resize: () => undefined, kill: () => undefined },
      integration: 'full',
      agent: {
        send: () => {
          throw new Error('this session has no agent yet');
        },
        interrupt: async () => undefined,
        respond: async () => undefined,
      },
      style: plainStyle,
      exit: () => undefined,
      greet: false,
    });
    session.shellOutput(PROMPT);
    session.input('?');
    session.input('hello' + String.fromCharCode(13));
    await new Promise((r) => setTimeout(r, 0));
    expect(shown.join('')).toContain('could not send: this session has no agent yet');
    // A one-message visit has nothing left to wait for, so it is over.
    expect(session.currentMode).toBe('shell');
  });

  it('interrupts a running turn on Ctrl+C rather than leaving', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.input('go\r');
    h.event({ type: 'session.state', from: 'awaiting_input', to: 'working' });
    h.session.input('\u0003');
    expect(h.interrupts).toHaveBeenCalledTimes(1);
    expect(h.session.currentMode).toBe('agent');
  });
});

describe('drawing over a shell that thinks it owns the line', () => {
  it('keeps a reply that arrives mid-typing until the shell is back at an empty prompt', () => {
    const h = harness();
    h.prompt();
    h.session.input('git com');
    h.clearScreen();
    h.event({ type: 'agent.text', text: 'background reply' });
    expect(h.screen()).not.toContain('background reply');
    h.session.input('mit\r');
    h.prompt();
    expect(h.screen()).toContain('background reply');
    // ...and the shell is asked to draw its prompt again below it.
    expect(h.toShell[h.toShell.length - 1]).toBe('\r');
  });
});

describe('a permission request', () => {
  const request = { requestId: 'r1', tool: 'bash', args: { command: 'rm -rf build' } } as unknown as PermissionRequest;

  it('is a question on the line, answered with one key', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.input('clean up\r');
    h.session.permission(request);
    expect(h.screen()).toContain('allow? [y/N/a=session]');
    h.session.input('x'); // not an answer
    expect(h.answers).toEqual([]);
    h.session.input('y');
    expect(h.answers).toEqual([{ requestId: 'r1', decision: { result: 'allow', scope: 'once' } }]);
  });

  it('is dropped when another device answers first', () => {
    const h = harness();
    h.prompt();
    h.session.input(MODE_KEY);
    h.session.permission(request);
    h.event({ type: 'permission.decided', requestId: 'r1', tool: 'bash', args: {}, decision: { result: 'deny' }, via: 'human' });
    expect(h.screen()).toContain('answered elsewhere');
    h.session.input('y');
    expect(h.answers).toEqual([]);
  });
});

describe('a shell that was not taught', () => {
  it('cannot tell a prompt, so only the mode key reaches the agent', () => {
    const h = harness('none');
    h.session.input('?');
    expect(h.toShell).toEqual(['?']);
    h.session.input(MODE_KEY);
    expect(h.session.currentMode).toBe('agent');
  });
});

it('ends when the shell does, and says the session is still running', () => {
  const h = harness();
  h.session.shellExited(0);
  expect(h.exits).toEqual([0]);
  expect(h.screen()).toContain('the session keeps running');
});

describe('on Windows, where the pseudoconsole repaints by position', () => {
  it('puts the cursor back on the shell’s row before giving it the screen', async () => {
    /*
     * cmd.exe draws through the console, and its pseudoconsole repainted the
     * next prompt on the row *it* believed the cursor was on — over the agent's
     * reply. So the row is asked for on the way in, asked again on the way out,
     * and the reply scrolled up above it before the shell gets its Enter.
     */
    const h = harness('full', true);
    h.prompt();
    h.session.input('?');
    expect(h.screen()).toContain(`${ESC}[6n`);
    h.session.input(`${ESC}[10;3R`); // the prompt was on row 10
    await new Promise((r) => setTimeout(r, 0));
    h.session.input('q\r');
    h.event({ type: 'session.state', from: 'awaiting_input', to: 'working' });
    h.event({ type: 'agent.text', text: 'line one\nline two' });
    h.clearScreen();
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_input' });
    // Asked where the cursor is now; nothing is sent to the shell until it answers.
    expect(h.screen()).toContain(`${ESC}[6n`);
    expect(h.toShell).toEqual([]);
    // Typed meanwhile: held, so it cannot land before the shell's Enter.
    h.session.input('ls');
    h.session.input(`${ESC}[14;3R`);
    await new Promise((r) => setTimeout(r, 10));
    // Four rows drawn below row 10: scrolled up four, cursor back on row 10.
    expect(h.screen()).toContain(`${ESC}[24;1H\n\n\n\n${ESC}[10;1H`);
    expect(h.toShell).toEqual(['\r', 'ls']);
  });

  it('goes on without the answer from a terminal that never gives one', async () => {
    const h = harness('full', true);
    h.prompt();
    h.session.input('?');
    h.session.input('q\r');
    h.event({ type: 'session.state', from: 'awaiting_input', to: 'working' });
    h.event({ type: 'session.state', from: 'working', to: 'awaiting_input' });
    await new Promise((r) => setTimeout(r, 700));
    expect(h.toShell).toEqual(['\r']);
  });
});
