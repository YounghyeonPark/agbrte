/**
 * A real terminal, driven through the real app (DESIGN.md §7, §8).
 *
 * This one is deliberately end-to-end and not a unit test, because the property
 * it exists to prove spans every process in the design and is false if any of
 * them is wrong: a keystroke goes renderer → preload → main → the detached host
 * → a pseudoterminal, and the bytes come back the other way over a channel that
 * touches neither the event log nor `ipc/eventBridge.ts`. A fake anywhere in
 * that chain would prove nothing about the part that was hard.
 *
 * It also covers the thing the dependency decision rests on: the session host
 * runs as `electron.exe` with `ELECTRON_RUN_AS_NODE=1`, so if the prebuilt PTY
 * binary needed an `electron-rebuild` the shell would fail to open **here** and
 * nowhere else.
 *
 * ## Two shapes of test, and only one of them can be unconditional
 *
 * The shell case runs everywhere: every machine has a login shell. The CLI case
 * needs Claude Code installed on the machine running the suite, so it is
 * **skipped by what the app itself detected** rather than by a probe of its own
 * — `[data-testid=pty-choice]` is drawn from `HostInfo.available`, which is the
 * host's answer, so a skip here means "this host has no CLI" and never "the test
 * asked the wrong question".
 */

import { expect, test, type Page } from '@playwright/test';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo } from './harness.js';
import { addAgent, createSession } from './actions.js';

/**
 * What the *program* has drawn, without the pane's own chrome.
 *
 * Scoped to the emulator's mount and not to the pane, which matters more than it
 * looks: the pane's header now says `Claude Code (installed CLI)` on its own, so
 * an assertion against the whole pane that Claude Code is running would pass
 * against a pane that had drawn nothing at all.
 */
async function screen(page: Page): Promise<string> {
  return (await page.locator('[data-testid=pty-screen]').innerText()).replace(/\s+/g, ' ');
}

/**
 * Remove the workspace, allowing for everything still standing in it.
 *
 * This pane is the one place a test's temp directory is some *other* process's
 * working directory, and Windows will not remove a directory anybody is standing
 * in. Two things let go on their own clock after `app.close()`: the pane's
 * program, once the host kills the pty (measured at well under a second, and
 * never orphaned — a kill at 100 ms into startup leaves nothing behind), and the
 * detached host itself, which lingers `AGBRTE_HOST_LINGER_MS` — 3 s in this
 * suite — before exiting and releasing the files it has open under `.agbrte`.
 *
 * So the window has to be comfortably longer than the linger, not merely longer
 * than the pty teardown: at 3 s of retries this failed about one run in three,
 * with `EBUSY` in the cleanup of a test whose assertions had all passed, which
 * is the least useful failure available.
 */
async function removeRepo(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
}

test.describe('your own terminal', () => {
  test('runs an installed CLI interactively, and shows the CLI’s own interface', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'CLI terminal');
      await addAgent(agbrte.window, 'echo');
      await agbrte.window.click('[data-testid=show-shell]');

      const pane = agbrte.window.locator('[data-testid=pty-terminal]');
      await expect(pane).toBeVisible();

      // The app's own answer about this machine, not a second detection here:
      // the button exists exactly when `HostInfo.available` carries the runtime,
      // so a skip means "this host has no Claude Code" and never "the test asked
      // the wrong question".
      const claude = agbrte.window.locator('[data-testid=pty-choice][data-choice="cli:claude-code"]');
      test.skip(
        (await claude.count()) === 0,
        'this host did not detect Claude Code, so there is no CLI pane to open',
      );
      await claude.click();

      // The label says what is running. It is not decoration: a pane of
      // monospace output inside a session view reads as part of the session
      // unless it says otherwise, and this one is deliberately outside the
      // record — which matters *more* when the program in it is an agent.
      await expect(pane.locator('[data-testid=pty-running]')).toHaveText(/Claude Code/);
      await expect(pane).toContainText('nothing here enters the transcript');

      // Opened by the host that owns the workspace, so `cwd` is the workspace by
      // construction rather than by agreement — and `program` is the file the
      // *host* resolved, which is how a person checks what is actually running.
      const where = agbrte.window.locator('[data-testid=pty-where]');
      await expect(where).toBeVisible({ timeout: 30_000 });
      await expect(where).toContainText(repo.split(/[\\/]/).pop()!);
      await expect(where).toContainText(/claude/i);

      /*
       * The CLI's own startup screen, which only a real interactive run draws.
       *
       * Two alternatives because Claude Code has two openings and both are its
       * interface: the banner with the version and the tips box, and — in a
       * directory it has not seen before, which a throwaway repo always is — the
       * trust prompt. A headless `-p` run draws neither; a shell draws neither;
       * the only way this string appears is a TUI that started, sized itself,
       * and painted.
       */
      await expect
        .poll(async () => await screen(agbrte.window), {
          timeout: 90_000,
          message: 'the CLI never drew its own interface in the pane',
        })
        .toMatch(/Yes, I trust this folder|Tips for getting started|for shortcuts/);

      // And it is unmistakably not a shell prompt, which is the complaint this
      // whole change answers.
      const drawn = await screen(agbrte.window);
      expect(drawn).toContain('Claude Code');
      expect(drawn).not.toMatch(/PS [A-Z]:\\/);

      /*
       * None of it reached the durable record (§7, §13).
       *
       * The strongest half of this test, and stronger now than it was: the
       * program in the pane *is* an agent, driven by a person with their own
       * credential, and the pane's label promises that this session's log does
       * not contain it. A terminal that worked and quietly appended would break
       * that promise with nothing on screen to show it.
       */
      const sessionsDir = join(repo, '.agbrte', 'sessions');
      const ids = await readdir(sessionsDir);
      const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
      expect(log).not.toContain('claude-code');
      expect(log).not.toContain('shell');
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  /**
   * The pane on a seat with no vendor CLI, which is the case this exists for.
   *
   * An `echo` seat has no binary anywhere on the machine — same shape as a
   * harness on a local model, and deterministic enough to assert against — so
   * before this the pane could only offer a shell prompt. Now it opens Agbrte's
   * own CLI against *this* session, and the property worth proving is the one
   * that makes it different from every other program in the pane: it is a real
   * client (§8.1, §17 Q15), so a turn sent from it belongs in the transcript.
   *
   * "Exactly once" is the assertion rather than "appears", because two clients
   * on one session is precisely where a duplicate would come from: the CLI
   * echoes what it sends, the window renders what the host pushes, and both read
   * the same log. One `user.turn` in `events.jsonl` and one row in the chat pane
   * is the difference between one session with two views and two sessions.
   */
  test('runs Agbrte’s own CLI against this session, and a turn sent from it lands once', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'CLI client');
      // No vendor CLI anywhere in this: the seat is a harness-shaped runtime,
      // which is what makes the pane's third choice the only one that can open
      // on the session at all.
      await addAgent(agbrte.window, 'echo');
      await agbrte.window.click('[data-testid=show-shell]');

      const pane = agbrte.window.locator('[data-testid=pty-terminal]');
      await expect(pane).toBeVisible();

      // Offered, and the default: nothing was clicked to get here.
      await expect(pane.locator('[data-testid=pty-running]')).toHaveText('Agbrte CLI', {
        timeout: 30_000,
      });

      // The label says the opposite of what it says for a shell, and that is the
      // point of item 4: this one *is* in the record.
      await expect(pane.locator('[data-testid=pty-claim]')).toContainText(
        'it is in the transcript and the session log',
      );
      await expect(pane).not.toContainText('nothing here enters the transcript');

      /*
       * Attached to *this* session, not asking which.
       *
       * The CLI prints the workspace, the host's pid and the role it was
       * granted, then goes straight to its prompt — no session list, because
       * `--session` named one. A pane that had made a second session would show
       * the picker here instead.
       */
      await expect
        .poll(async () => await screen(agbrte.window), {
          timeout: 90_000,
          message: 'the Agbrte CLI never attached in the pane',
        })
        .toMatch(/type to send/);
      const attached = await screen(agbrte.window);
      expect(attached).toContain('read-write');
      expect(attached).not.toContain('number, or Enter for a new session');

      const marker = `from-the-pane-${Date.now().toString(36)}`;
      await pane.click();
      await agbrte.window.keyboard.type(marker);
      await agbrte.window.keyboard.press('Enter');

      // The agent answered, which means the turn went through the host's own
      // queue rather than being echoed locally by the CLI.
      await expect
        .poll(async () => await screen(agbrte.window), {
          timeout: 60_000,
          message: 'the turn sent from the pane never produced a reply',
        })
        .toContain('echo:');

      /*
       * Now the other direction, with **both clients live at once** (§17 Q15).
       *
       * The window sends through its own connection while the CLI is still
       * attached in the pane — the composer cannot be used for this because
       * switching panes unmounts the terminal and ends the client, so the turn
       * goes through the same preload method the composer calls. That makes
       * this the real two-client case rather than two clients taking turns:
       * both hold a connection to one host, roles are per connection, and turns
       * are ordered by arrival at the owner.
       */
      const fromWindow = `from-the-window-${Date.now().toString(36)}`;
      await agbrte.window.evaluate(async (text: string) => {
        const api = (
          globalThis as unknown as {
            agbrte: {
              sessions: {
                list(): Promise<Array<{ sessionId: string; agents: Array<{ agentId: string }> }>>;
                send(r: { sessionId: string; agentId: string; text: string }): Promise<void>;
              };
            };
          }
        ).agbrte;
        const session = (await api.sessions.list())[0]!;
        await api.sessions.send({
          sessionId: session.sessionId,
          agentId: session.agents[0]!.agentId,
          text,
        });
      }, fromWindow);

      // The CLI is told about it, because it subscribed to the session and not
      // to whoever happened to be typing. A client that only saw its own turns
      // would be a private view of a shared thing.
      await expect
        .poll(async () => await screen(agbrte.window), {
          timeout: 60_000,
          message: 'the pane never saw the turn the window sent',
        })
        .toContain(fromWindow);

      /*
       * Back to the chat, which never saw the terminal at all.
       *
       * The window subscribes to the session's mirror, not to a connection, so
       * a second client sending a turn is indistinguishable from the composer
       * doing it — that is the claim, and this is where it is checked.
       */
      await agbrte.window.click('[data-testid=show-chat]');
      for (const text of [marker, fromWindow]) {
        await expect(
          agbrte.window.locator(`[data-testid=row-user]:has-text("${text}")`),
        ).toHaveCount(1, { timeout: 30_000 });
      }

      const sessionsDir = join(repo, '.agbrte', 'sessions');
      const ids = await readdir(sessionsDir);
      // One session, not two: `--session` attaches and never creates.
      expect(ids).toHaveLength(1);

      const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
      const turns = log.split('\n').filter((line) => line.includes('"user.turn"'));
      // Once each, and in the order they arrived at the host — which is the
      // only ordering that exists when two clients cannot see each other.
      expect(turns.filter((line) => line.includes(marker))).toHaveLength(1);
      expect(turns.filter((line) => line.includes(fromWindow))).toHaveLength(1);
      expect(turns.findIndex((line) => line.includes(marker))).toBeLessThan(
        turns.findIndex((line) => line.includes(fromWindow)),
      );
      // And each is attributed, because a turn from a terminal is still
      // somebody acting: §8.2's actor is what tells the clients apart after.
      for (const line of turns) expect(line).toContain('"actor"');
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  test('runs a command you type in the shell and shows what it printed', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Shell session');
      await addAgent(agbrte.window, 'echo');

      // Three named panes, not one toggle with a changing label: `Raw output`
      // and `Terminal` are easy to confuse and must not be.
      await agbrte.window.click('[data-testid=show-shell]');

      const pane = agbrte.window.locator('[data-testid=pty-terminal]');
      await expect(pane).toBeVisible();

      /*
       * The shell is always offered, and is last: it is what somebody needs when
       * the CLI is the broken thing — a PATH to fix, a `git status` to read.
       *
       * The switcher itself only appears where there is more than one choice, so
       * on a machine with no CLI installed the shell is already what opened and
       * there is nothing to click. Both are the same end state, which is why the
       * assertion below is unconditional and only the click is not.
       */
      const toShell = agbrte.window.locator('[data-testid=pty-choice][data-choice="shell"]');
      if ((await toShell.count()) > 0) await toShell.click();
      await expect(pane.locator('[data-testid=pty-running]')).toHaveText('Your shell');
      await expect(pane).toContainText('nothing here enters the transcript');

      const where = agbrte.window.locator('[data-testid=pty-where]');
      await expect(where).toBeVisible({ timeout: 30_000 });
      await expect(where).toContainText(repo.split(/[\\/]/).pop()!);

      /*
       * Typed rather than injected, and typed into the emulator.
       *
       * `page.keyboard.type` puts real key events on the canvas xterm is
       * listening to, which is the only way this exercises `onData` — the path
       * that has to survive pastes, IME composition and control sequences. A
       * direct `shell.write` would skip exactly the layer most likely to be
       * broken.
       */
      const marker = `pty-${Date.now().toString(36)}`;
      await pane.click(); // focus the emulator
      await agbrte.window.keyboard.type(`echo ${marker}`);
      await agbrte.window.keyboard.press('Enter');

      /*
       * Asserted **twice**, which is the whole point.
       *
       * Once is the shell echoing what was typed — which a pipe would also do,
       * and which proves only that the keystrokes arrived. The second is the
       * command's own output, which exists only if a program actually ran on the
       * other end and wrote to a terminal.
       */
      await expect
        .poll(async () => (await screen(agbrte.window)).split(marker).length - 1, {
          timeout: 60_000,
          message: 'the shell never echoed the command and printed its output',
        })
        .toBeGreaterThanOrEqual(2);

      /*
       * And none of it reached the durable record (§7, §13).
       *
       * A terminal that worked but quietly appended to the session log would
       * break the promise the pane makes in its own label, and nothing about the
       * screen would show it.
       */
      const sessionsDir = join(repo, '.agbrte', 'sessions');
      const ids = await readdir(sessionsDir);
      const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
      expect(log).not.toContain(marker);
      expect(log).not.toContain('shell');
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  test('refuses a CLI the host did not detect, by name and with the reason', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Refusal');
      await addAgent(agbrte.window, 'echo');
      await agbrte.window.click('[data-testid=show-shell]');
      await expect(agbrte.window.locator('[data-testid=pty-where]')).toBeVisible({
        timeout: 30_000,
      });

      /*
       * Asked through the preload, which is the surface a hostile renderer has.
       *
       * The pane will not offer an undetected CLI, so the only way to reach the
       * refusal is to ask for one directly — and that is exactly the case worth
       * testing, because the UI not offering something is a convenience and the
       * host refusing it is the property. `gemini-cli` is a real manifest that
       * this machine almost certainly does not have installed; the second id is
       * not a manifest at all, and is a path, which is the shape somebody would
       * reach for if this field were the hole it deliberately is not.
       */
      const refusals = await agbrte.window.evaluate(async (ids: string[]) => {
        const api = (
          globalThis as unknown as {
            agbrte: {
              hosts: { list(): Promise<Array<{ instanceId: string }>> };
              sessions: { list(): Promise<Array<{ sessionId: string }>> };
              shell: {
                open(r: {
                  instanceId: string;
                  sessionId: string;
                  program: { kind: 'cli'; cliId: string };
                }): Promise<{ shellId: string }>;
              };
            };
          }
        ).agbrte;

        const instanceId = (await api.hosts.list())[0]?.instanceId ?? '';
        const sessionId = (await api.sessions.list())[0]?.sessionId ?? '';

        const out: string[] = [];
        for (const cliId of ids) {
          try {
            await api.shell.open({ instanceId, sessionId, program: { kind: 'cli', cliId } });
            out.push('OPENED');
          } catch (err) {
            out.push(err instanceof Error ? err.message : String(err));
          }
        }
        return out;
      }, ['gemini-cli', '../../../bin/sh']);

      // Refused by name — not silently downgraded to a shell under a CLI's
      // label, which is the failure mode that would be invisible on screen —
      // and carrying the host's own detection sentence, the one the runtime
      // picker already shows for the same tool on the same machine.
      expect(refusals[0]).not.toBe('OPENED');
      expect(refusals[0]).toContain('Gemini CLI');
      expect(refusals[0]).toMatch(/gemini/);

      // A path is not a special case that needed handling — it is simply not one
      // of the ids this host detected, which is what a closed set buys.
      expect(refusals[1]).toContain('is not a CLI this app knows about');
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });

  test('closing the pane ends the terminal, and reopening starts a new one', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Shell lifetime');
      await addAgent(agbrte.window, 'echo');

      await agbrte.window.click('[data-testid=show-shell]');
      await expect(agbrte.window.locator('[data-testid=pty-where]')).toBeVisible({
        timeout: 30_000,
      });
      const first = await agbrte.window.locator('[data-testid=pty-where]').innerText();

      // Back to the transcript. The PTY goes with the pane — a terminal is a
      // view, and one with no reader is a program blocked on a prompt nobody can
      // answer. The chat is still there, because none of this touched it.
      await agbrte.window.click('[data-testid=show-chat]');
      await expect(agbrte.window.locator('[data-testid=pty-terminal]')).toHaveCount(0);
      await expect(agbrte.window.locator('[data-testid=composer-input]')).toBeVisible();

      await agbrte.window.click('[data-testid=show-shell]');
      await expect(agbrte.window.locator('[data-testid=pty-where]')).toBeVisible({
        timeout: 30_000,
      });
      // A new terminal in the same workspace rather than the old one restored:
      // there is no scrollback to come back to, which is the honest behaviour
      // for a stream that is deliberately not in any log.
      expect(await agbrte.window.locator('[data-testid=pty-where]').innerText()).toBe(first);
    } finally {
      await agbrte.close();
      await removeRepo(repo);
    }
  });
});
