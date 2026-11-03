/**
 * The person's shell with the agent in it (`{kind:'terminal'}`, DESIGN.md §17
 * Q24), through the real app and a real host.
 *
 * What this proves that the unit tests cannot: the host runs the shell and the
 * routing itself, so on Windows — where our own CLI under Electron can never be
 * a terminal program — the agent is still in the terminal. A `?` typed into the
 * emulator goes renderer → main → host, is recognised at the shell's real
 * prompt, becomes a turn in the session's log attributed to this person, and the
 * agent's reply is drawn into the same terminal; a command typed afterwards runs
 * in the same shell and is in the log as a command, under the same person — it
 * was kept out until §17 Q23 steps 3 and 4 put the terminal in the session.
 */

import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession, fromComposerMenu } from './actions.js';

async function screen(page: Page): Promise<string> {
  return (await page.locator('[data-testid=pty-screen]').innerText()).replace(/\s+/g, ' ');
}

test('the shell with the agent in it: ? asks, the reply is drawn in the terminal, commands are logged as commands', async () => {
  const repo = await makeRepo();
  const agbrte = await launch(repo);
  const w = agbrte.window;
  const id = Date.now().toString(36);

  try {
    await createSession(w, 'Terminal session');
    await addAgent(w, 'echo');
    await fromComposerMenu(w, '[data-testid=show-shell][data-choice="terminal"]');

    const pane = w.locator('[data-testid=pty-terminal]');
    await expect(pane.locator('[data-testid=pty-running]')).toHaveText('Your shell, with the agent', {
      timeout: 30_000,
    });

    // The shell's own prompt, which names the folder the pane opened in.
    const folder = repo.split(/[\\/]/).pop()!;
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);

    await pane.click();
    await w.keyboard.type('?');
    await w.keyboard.type(`asked-${id}`);
    await w.keyboard.press('Enter');
    await expect
      .poll(async () => await screen(w), { timeout: 60_000, message: 'the agent’s reply never reached the terminal' })
      .toContain(`echo: asked-${id}`);

    // Back in the shell once the turn ended: a command runs there, as ever.
    await expect.poll(async () => (await screen(w)).split(`echo: asked-${id}`)[1] ?? '', { timeout: 30_000 }).toContain(folder);
    await w.keyboard.type(`echo shell-${id}`);
    await w.keyboard.press('Enter');
    await expect
      .poll(async () => (await screen(w)).split(`shell-${id}`).length - 1, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);

    const sessionsDir = join(repo, '.agbrte', 'sessions');
    const ids = await readdir(sessionsDir);
    const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
    const turn = log.split('\n').find((line) => line.includes('"user.turn"') && line.includes(`asked-${id}`));
    expect(turn, 'the message to the agent is a turn in the log').toBeDefined();
    expect(turn).toContain('"actor"');
    // The command is a `shell.block`, never a turn: it was run, not said.
    await expect
      .poll(async () => {
        const now = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
        return now.split('\n').find((line) => line.includes('"shell.block"') && line.includes(`echo shell-${id}`)) ?? '';
      }, { timeout: 30_000 })
      .toContain('"actor"');
    expect(log.split('\n').some((line) => line.includes('"user.turn"') && line.includes(`shell-${id}`))).toBe(false);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
