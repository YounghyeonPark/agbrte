/**
 * A pane that is the person's shell with the agent in it (`{kind:'terminal'}`),
 * as the host runs it (`Shells.open` with an `AgentBinding`).
 *
 * `terminalSession.test.ts` pins the routing. This pins the wiring around it:
 * that keys from the client go through the routing rather than straight into
 * the pty, that the session's events and permission requests reach the screen
 * the client sees, and that closing the pane stops listening to the session —
 * a pane that kept a listener after it closed would be a leak on a host that
 * runs for weeks.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { Shells, type AgentBinding, type Pty, type PtySpawner } from '../src/main/terminal/shell.js';
import { TerminalPrograms } from '../src/main/terminal/programs.js';
import type { AgbrteEvent, PermissionRequest } from '@shared/types/index.js';

const ESC = '\u001b';
const osc = (body: string): string => `${ESC}]${body}\u0007`;
const PROMPT = osc('133;A') + '$ ' + osc('133;B');

class FakePty implements Pty {
  readonly pid = 1;
  written: string[] = [];
  private data: ((d: string) => void) | null = null;
  private exit: ((e: { exitCode: number }) => void) | null = null;
  onData(cb: (d: string) => void): void {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exit = cb;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(): void {}
  kill(): void {}
  emit(d: string): void {
    this.data?.(d);
  }
  end(code: number): void {
    this.exit?.({ exitCode: code });
  }
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function harness() {
  const integrationDir = mkdtempSync(join(tmpdir(), 'agbrte-mux-'));
  dirs.push(integrationDir);
  const ptys: FakePty[] = [];
  const spawns: Array<{ file: string; args: string[] | string }> = [];
  const spawn: PtySpawner = (file, args) => {
    spawns.push({ file, args });
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };
  const screen: string[] = [];
  const scheduled: Array<() => void> = [];
  const sent: string[] = [];
  const listeners: Array<{ event(e: AgbrteEvent): void; permission(r: PermissionRequest): void }> = [];
  const binding: AgentBinding = {
    link: {
      send: async (t) => {
        sent.push(t);
      },
      interrupt: async () => undefined,
      respond: async () => undefined,
    },
    subscribe: (on) => {
      listeners.push(on);
      return () => listeners.splice(listeners.indexOf(on), 1);
    },
    pending: () => [],
  };
  const shells = new Shells<object>('/work', {
    onData: (_id, data) => screen.push(data),
    onExit: () => undefined,
    spawn,
    // Held and run when the screen is read: the property under test is what
    // reaches the client, not when. (Running it inside `setTimer` leaves the
    // coalescer believing a timer is still pending, and nothing flushes again.)
    setTimer: (fn) => {
      scheduled.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
    env: { AGBRTE_SHELL: '/bin/bash' },
    programs: new TerminalPrograms({ env: { AGBRTE_SHELL: '/bin/bash' }, lookup: (n) => (n === '/bin/bash' ? '/bin/bash' : null) }),
    integrationDir,
  });
  /**
   * A new shell's first prompt, which the routing answers with its greeting and
   * an Enter, and the fresh prompt the shell draws for that Enter — as a real
   * one would. After this the pane is at an empty prompt with nothing written.
   * Waited for, because on Windows the Enter follows a question about the
   * cursor that this fake terminal never answers (`resync`).
   */
  const started = async (pty: FakePty): Promise<void> => {
    pty.emit(PROMPT);
    await vi.waitFor(() => expect(pty.written).toEqual(['\r']));
    pty.written.splice(0);
    pty.emit(PROMPT);
  };
  const read = (): string => {
    for (const fn of scheduled.splice(0)) fn();
    return screen.join('');
  };
  return { shells, ptys, spawns, screen: read, sent, listeners, binding, started };
}

describe('a terminal with the agent in it', () => {
  it('starts the person’s shell, taught, and says what it is', () => {
    const h = harness();
    const handle = h.shells.open({}, { program: { kind: 'terminal' }, agent: h.binding });
    expect(handle.label).toBe('Your shell, with the agent');
    expect(handle.integration).toBe('full');
    expect(h.spawns[0]?.args).toContain('--init-file');
  });

  it('is refused without the session to put in it', () => {
    const h = harness();
    expect(() => h.shells.open({}, { program: { kind: 'terminal' } })).toThrow(/agent in a terminal/);
  });

  it('sends keys through the routing, so ? at a prompt reaches the agent and not the shell', async () => {
    const h = harness();
    const owner = {};
    const { shellId } = h.shells.open(owner, { program: { kind: 'terminal' }, agent: h.binding });
    const pty = h.ptys[0]!;
    await h.started(pty);
    expect(h.screen()).toContain('asks the agent once');
    h.shells.write(owner, shellId, 'ls');
    expect(pty.written).toEqual(['ls']);
    h.shells.write(owner, shellId, '\u0015');
    h.shells.write(owner, shellId, '\r');
    pty.emit(PROMPT);
    h.shells.write(owner, shellId, '?');
    h.shells.write(owner, shellId, 'hello\r');
    await Promise.resolve();
    expect(h.sent).toEqual(['hello']);
    expect(pty.written).not.toContain('?');
  });

  it('shows the session’s replies on the screen the client sees', async () => {
    const h = harness();
    const owner = {};
    const { shellId } = h.shells.open(owner, { program: { kind: 'terminal' }, agent: h.binding });
    await h.started(h.ptys[0]!);
    h.shells.write(owner, shellId, '\u0000');
    h.listeners[0]!.event({ seq: 1, id: 'e1', at: '', type: 'agent.text', text: 'hi **there**' } as unknown as AgbrteEvent);
    expect(h.screen()).toContain('there');
  });

  it('stops listening to the session when the pane closes, and when the shell exits', () => {
    const h = harness();
    const owner = {};
    const a = h.shells.open(owner, { program: { kind: 'terminal' }, agent: h.binding });
    h.shells.open(owner, { program: { kind: 'terminal' }, agent: h.binding });
    expect(h.listeners).toHaveLength(2);
    h.shells.close(owner, a.shellId);
    expect(h.listeners).toHaveLength(1);
    h.ptys[1]!.end(0);
    expect(h.listeners).toHaveLength(0);
  });
});
