/**
 * Phase 1's acceptance criterion, driven through the UI (DESIGN.md §15).
 *
 * > *Done when:* a text-only session edits a real repo and the transcript
 * > survives an app restart.
 *
 * Both halves are here. The restart half runs against the echo runtime so it is
 * deterministic and always runs. The "edits a real repo" half needs a model that
 * can call a tool, so it runs against a local Ollama server and **skips loudly**
 * when one is absent — a criterion that silently passes because its test was
 * skipped is worse than no test.
 */

import { expect, test } from '@playwright/test';
import { readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo, modelAvailable } from './harness.js';
import { addAgent, createSession, openSession, runtimeOptions, send } from './actions.js';

const MODEL = 'qwen2.5:7b';

test.describe('the shell', () => {
  test('opens on the chosen workspace with runtimes available', async () => {
    const repo = await makeRepo();
    const loom = await launch(repo);

    try {
      // Proves main → preload → renderer all agreed on the workspace, which is
      // the whole IPC path in one assertion.
      await expect(loom.window.locator('[data-testid=workspace-path]')).toContainText(
        repo.split(/[\\/]/).pop()!,
      );

      await createSession(loom.window, 'Shell check');

      // Both ids come from the agent host's `ready` handshake, so a host that
      // failed to start shows up here as an empty list.
      expect(await runtimeOptions(loom.window)).toEqual(
        expect.arrayContaining(['echo', 'loom-harness']),
      );
    } finally {
      await loom.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a transcript survives an app restart', async () => {
    const repo = await makeRepo();

    // ---- first run: create a session and take a turn
    const first = await launch(repo);
    try {
      await createSession(first.window, 'Restart me', 'prove durability');
      await addAgent(first.window, 'echo');
      await send(first.window, 'hello before the restart');

      await expect(first.window.locator('[data-testid=row-user]')).toContainText(
        'hello before the restart',
      );
      await expect(first.window.locator('[data-testid=row-agent]')).toBeVisible();
    } finally {
      await first.close();
    }

    // ---- second run: a different process, same folder
    const second = await launch(repo);
    try {
      // The session is not loaded at boot — it exists only on disk, which is what
      // makes this a test of the log rather than of a cache.
      await openSession(second.window, 'Restart me');

      await expect(second.window.locator('[data-testid=row-user]')).toContainText(
        'hello before the restart',
      );
      await expect(second.window.locator('[data-testid=row-agent]')).toBeVisible();

      // And it is still usable, not merely readable.
      await send(second.window, 'and after');
      await expect(second.window.locator('[data-testid=row-user]').nth(1)).toContainText(
        'and after',
      );
    } finally {
      await second.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('the log on disk is what the UI is reading', async () => {
    const repo = await makeRepo();
    const loom = await launch(repo);

    try {
      await createSession(loom.window, 'On disk');
      await addAgent(loom.window, 'echo');
      await send(loom.window, 'write something down');
      await expect(loom.window.locator('[data-testid=row-agent]')).toBeVisible();

      const sessionsDir = join(repo, '.devagents', 'sessions');
      const ids = await readdir(sessionsDir);
      expect(ids).toHaveLength(1);

      const log = await readFile(join(sessionsDir, ids[0]!, 'events.jsonl'), 'utf8');
      const types = log
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => (JSON.parse(line) as { type: string }).type);

      // Append-only JSONL, one event per line, greppable (§5.1, §14).
      expect(types).toContain('session.created');
      expect(types).toContain('user.turn');
      expect(types).toContain('agent.text');
    } finally {
      await loom.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * These need a local model that can call a tool, so they **skip loudly** when
 * one is absent. Both are slow: a 7B model takes tens of seconds per turn cold.
 */
test.describe('a real model against a real repo', () => {
  test('writes a file, with no prompt because §13 allows it', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const loom = await launch(repo);

    try {
      await createSession(loom.window, 'Real edit', 'create a file');
      await addAgent(loom.window, 'loom-harness', MODEL);
      await send(
        loom.window,
        'Use the write tool to create a file named hello.txt containing exactly: hello from loom. ' +
          'Do it now with a single write call, then stop.',
      );

      // §15's Phase 1 criterion: a real repo edited by a real model, through the
      // agent host process.
      await expect(async () => {
        const contents = await readFile(join(repo, 'hello.txt'), 'utf8');
        expect(contents.toLowerCase()).toContain('hello');
      }).toPass({ timeout: 150_000 });

      // Deliberately asserting the *absence* of a prompt. A write inside the
      // workspace is `allow` under §13's defaults, so requiring approval here
      // would mean the policy had not been applied. The gate still ran and still
      // logged, which is what §13 actually requires.
      await expect(loom.window.locator('[data-testid=prompt]')).toHaveCount(0);
      const decision = loom.window.locator('[data-testid=row-decision]').first();
      await expect(decision).toContainText('allow');
      await expect(decision).toContainText('policy');
    } finally {
      await loom.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('prompts before a shell command and honors a denial', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const loom = await launch(repo);

    try {
      await createSession(loom.window, 'Gate check');
      await addAgent(loom.window, 'loom-harness', MODEL);

      // `bash` has no allow rule, so it falls through to `defaultAction: 'ask'` —
      // the one tool here that reaches a human. The instruction is blunt because
      // softer phrasing made this model answer in prose instead of calling it.
      await send(
        loom.window,
        "List the files in the current directory. You must use the bash tool with command 'ls -la'.",
      );

      const prompt = loom.window.locator('[data-testid=prompt]');
      await expect(prompt).toBeVisible({ timeout: 150_000 });
      await expect(loom.window.locator('[data-testid=prompt-tool]')).toContainText('bash');

      // Denying rather than allowing: it has no side effects, and refusal is the
      // security-relevant direction. A gate that only works when you say yes is
      // not a gate.
      await loom.window.click('[data-testid=prompt-deny]');

      await expect(loom.window.locator('[data-testid=row-decision]').first()).toContainText('deny');
      // The denial reaches the model as a failed tool result rather than killing
      // the turn, so the agent can respond to it (§13's deny-ask-resume flow).
      await expect(loom.window.locator('[data-testid=row-result-failed]').first()).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await loom.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
