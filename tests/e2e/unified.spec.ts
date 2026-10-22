/**
 * The shell inside the session view (DESIGN.md §17 Q23, step 2), through the
 * real app.
 *
 * End to end for the same reason `shell.spec.ts` is: a keystroke goes renderer
 * → preload → main → the detached host → a pty and back, and here it then has
 * to come out of the emulator's parser as a block in the right place in a
 * scrollback that the agent's turns are also arriving in. What is asserted is
 * what a person would see go wrong:
 *
 *   - a command they ran shows up as a block of its own, with its output, after
 *     the agent turn that came before it rather than at the top or the bottom;
 *   - the three ways between shell and agent — the mode button, `?` at an empty
 *     prompt, and `!` in front of a line — each send keys where they say;
 *   - none of it reaches the session log, which is still true until step 3 and
 *     is what every block says.
 *
 * The shell is this machine's default — `cmd.exe` on Windows, which marks only
 * its prompts — so nothing here depends on an exit status; `integration.test.ts`
 * covers the shells that report one.
 */

import { expect, test } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession, send } from './actions.js';

test.describe('one scrollback for the shell and the agent', () => {
  test('a command run in the session view lands as a block, in order, and the input moves between them', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);
    const w = agbrte.window;
    const id = Date.now().toString(36);

    try {
      await createSession(w, 'Unified session');
      await addAgent(w, 'echo');

      // An agent turn first, so there is something for the block to come after.
      await send(w, `before-${id}`);
      await expect(w.locator('[data-testid=transcript]')).toContainText(`echo: before-${id}`, { timeout: 30_000 });

      /*
       * The mode, shown and switched with a pointer. The shell is started only
       * now — opening a session must not start a process on its machine.
       */
      const mode = w.locator('[data-testid=input-mode]');
      await expect(mode).toHaveAttribute('data-mode', 'agent');
      await expect(w.locator('[data-testid=live-shell]')).toHaveAttribute('data-status', 'closed');
      await mode.click();
      await expect(mode).toHaveAttribute('data-mode', 'shell');
      const live = w.locator('[data-testid=live-shell]');
      await expect(live).toHaveAttribute('data-phase', 'prompt', { timeout: 30_000 });
      await expect(w.locator('[data-testid=composer-shell-hint]')).toBeVisible();

      // Typed into the shell's own prompt, as keys.
      await w.keyboard.type(`echo shell-${id}`);
      await w.keyboard.press('Enter');
      const blocks = w.locator('[data-testid=shell-block]');
      await expect(blocks).toHaveCount(1, { timeout: 30_000 });
      await expect(blocks.first().locator('[data-testid=shell-block-command]')).toHaveText(`echo shell-${id}`);
      await expect(blocks.first().locator('[data-testid=shell-block-output]')).toHaveText(`shell-${id}`);
      await expect(blocks.first()).toContainText('not recorded, not seen by the agent');

      /*
       * In order: after the agent's reply, not wherever the list happened to
       * end. Compared in the document, which is the order a reader meets them.
       */
      const order = await w.locator('[data-testid=transcript]').evaluate((root, marker) => {
        const all = [...root.querySelectorAll('*')];
        const reply = all.findIndex((el) => el.children.length === 0 && el.textContent?.includes(`echo: before-${marker}`));
        const block = all.findIndex((el) => el.getAttribute('data-testid') === 'shell-block');
        return { reply, block };
      }, id);
      expect(order.reply).toBeGreaterThan(-1);
      expect(order.block).toBeGreaterThan(order.reply);

      /*
       * `?` at an empty prompt: one message to the agent, then the shell again.
       * The `?` itself must not land in the box it moved the keys to.
       */
      await w.keyboard.press('?');
      await expect(mode).toHaveAttribute('data-mode', 'agent');
      const input = w.locator('[data-testid=composer-input]');
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('');
      await w.keyboard.type(`asked-${id}`);
      await w.keyboard.press('Enter');
      await expect(w.locator('[data-testid=transcript]')).toContainText(`echo: asked-${id}`, { timeout: 30_000 });
      await expect(mode).toHaveAttribute('data-mode', 'shell');

      // The mode key, from the shell back to the agent, and it stays there.
      await w.keyboard.press('Control+Backquote');
      await expect(mode).toHaveAttribute('data-mode', 'agent');
      await expect(input).toBeFocused();

      // `!` in agent mode runs one line in the shell without switching.
      await input.fill(`!echo bang-${id}`);
      await expect(w.locator('[data-testid=composer-send]')).toHaveText('Run');
      await w.keyboard.press('Enter');
      await expect(blocks).toHaveCount(2, { timeout: 30_000 });
      await expect(blocks.nth(1).locator('[data-testid=shell-block-output]')).toHaveText(`bang-${id}`);
      await expect(mode).toHaveAttribute('data-mode', 'agent');
      await expect(w.locator('[data-testid=transcript]')).not.toContainText(`echo: !echo bang-${id}`);

      // And none of the shell reached the log; the agent's turns did.
      const sessionsDir = join(repo, '.agbrte', 'sessions');
      const ids = await readdir(sessionsDir);
      const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
      expect(log).toContain(`before-${id}`);
      expect(log).toContain(`asked-${id}`);
      expect(log).not.toContain(`shell-${id}`);
      expect(log).not.toContain(`bang-${id}`);
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
    }
  });
});
