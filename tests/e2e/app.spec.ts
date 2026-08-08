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
import { launch, makeRepo, modelAvailable, warmModel } from './harness.js';
import {
  addAgent,
  attachedHosts,
  createSession,
  hostGroup,
  openSession,
  runtimeOptions,
  send,
} from './actions.js';

const MODEL = 'qwen2.5:7b';

/**
 * How long to wait for the model to produce its tool call.
 *
 * The model is already resident by the time these run, and a successful call
 * arrives in about four seconds. Sixty is generous rather than tight — and
 * keeping it short matters because the failure mode is a retry, so a 150s
 * timeout only made every coin-flip loss two and a half minutes long.
 */
const LIVE_TIMEOUT = 60_000;

test.describe('the shell', () => {
  test('opens on the chosen workspace with runtimes available', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      // Proves main → preload → renderer all agreed on the host, which is the
      // whole IPC path in one assertion.
      const group = hostGroup(agbrte.window);
      await expect(group).toHaveAttribute('data-label', repo.split(/[\\/]/).pop()!);
      await expect(group.locator('[data-testid=host-badge]')).toContainText('local');

      await createSession(agbrte.window, 'Shell check');

      // Both ids come from the agent host's `ready` handshake, so a host that
      // failed to start shows up here as an empty list.
      expect(await runtimeOptions(agbrte.window)).toEqual(
        expect.arrayContaining(['echo', 'agbrte-harness']),
      );
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a transcript survives an app restart', async () => {
    const repo = await makeRepo();

    // ---- first run: create a session and take a turn
    const first = await launch(repo);
    try {
      await createSession(first.window, 'Restart me');
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
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'On disk');
      await addAgent(agbrte.window, 'echo');
      await send(agbrte.window, 'write something down');
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

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
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

test.describe('several hosts at once', () => {
  test('shows sessions from two hosts, grouped and independent', async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    const labelA = repoA.split(/[\\/]/).pop()!;
    const labelB = repoB.split(/[\\/]/).pop()!;

    const agbrte = await launch(repoA, repoB);
    try {
      // §8's caps are per host and §10 badges every card, so watching more than
      // one place at once is the designed shape. Until the fleet landed, main
      // disposed the previous host on every workspace change.
      expect((await attachedHosts(agbrte.window)).sort()).toEqual([labelA, labelB].sort());

      await createSession(agbrte.window, 'work on A', labelA);
      await addAgent(agbrte.window, 'echo');
      await send(agbrte.window, 'a message for A');
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

      await createSession(agbrte.window, 'work on B', labelB);
      await addAgent(agbrte.window, 'echo');
      await send(agbrte.window, 'a message for B');
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

      // Each session sits under its own host, so "where does this run" is
      // answerable without opening it.
      await expect(
        hostGroup(agbrte.window, labelA).locator('[data-testid=session]'),
      ).toHaveCount(1);
      await expect(
        hostGroup(agbrte.window, labelB).locator('[data-testid=session]'),
      ).toHaveCount(1);
      await expect(agbrte.window.locator('[data-testid=active-host]')).toContainText(labelB);

      // The transcripts are genuinely separate: two hosts, two logs, one writer
      // each (§5.1).
      await openSession(agbrte.window, 'work on A', labelA);
      await expect(agbrte.window.locator('[data-testid=row-user]')).toContainText('a message for A');
      await expect(agbrte.window.locator('[data-testid=row-user]')).toHaveCount(1);

      const logs = await Promise.all(
        [repoA, repoB].map(async (repo) => {
          const dir = join(repo, '.devagents', 'sessions');
          const ids = await readdir(dir);
          return readFile(join(dir, ids[0]!, 'events.jsonl'), 'utf8');
        }),
      );
      expect(logs[0]).toContain('a message for A');
      expect(logs[0]).not.toContain('a message for B');
      expect(logs[1]).toContain('a message for B');
      expect(logs[1]).not.toContain('a message for A');
    } finally {
      await agbrte.close();
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  });

  test('detaching one host leaves the other running', async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    const labelA = repoA.split(/[\\/]/).pop()!;
    const labelB = repoB.split(/[\\/]/).pop()!;

    const agbrte = await launch(repoA, repoB);
    try {
      await createSession(agbrte.window, 'stays', labelB);
      await addAgent(agbrte.window, 'echo');

      await hostGroup(agbrte.window, labelA).locator('[data-testid=remove-host]').click();

      await expect(agbrte.window.locator('[data-testid=host]')).toHaveCount(1);
      expect(await attachedHosts(agbrte.window)).toEqual([labelB]);

      // Detach is "stop watching", not "delete", and it must not disturb the
      // host next to it.
      await send(agbrte.window, 'still working');
      await expect(agbrte.window.locator('[data-testid=row-user]')).toContainText('still working');
    } finally {
      await agbrte.close();
      await rm(repoA, { recursive: true, force: true });
      await rm(repoB, { recursive: true, force: true });
    }
  });
});

/**
 * These need a local model that can call a tool, so they **skip loudly** when
 * one is absent. Both are slow: a 7B model takes tens of seconds per turn cold.
 */
test.describe('a real model against a real repo', () => {
  /**
   * Retries here, and nowhere else in this suite.
   *
   * Measured over repeated full runs, roughly one in three of these fails by
   * timing out while the model answers in prose instead of calling the tool it
   * was told to call. That is sampling in a 7B model, not a defect in the app:
   * the same test passes three times out of three in isolation, and the two
   * tests fail interchangeably.
   *
   * The config-level `retries: 0` stays, with the same reasoning as before —
   * retrying a deterministic test masks exactly the flakiness worth knowing
   * about. That argument does not extend to a non-deterministic *dependency*.
   * Scoping retries to this block keeps the shell tests honest while stopping a
   * coin flip from failing the suite.
   *
   * If these start failing on every attempt, that is a real signal: it means the
   * failure is no longer a sampling artefact.
   */
  test.describe.configure({ retries: 2 });

  /**
   * Load the model once, before any test needs it.
   *
   * A cold start is tens of seconds to minutes of disk read, and absorbing it
   * inside a test made whichever ran first fail intermittently with "the file
   * was never written" — a message about the app, describing a fact about the
   * machine. Warming separately means a failure below is the app's fault.
   */
  test.beforeAll(async () => {
    if (await modelAvailable(MODEL)) await warmModel(MODEL);
  });

  test('writes a file, with no prompt because §13 allows it', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Real edit');
      await addAgent(agbrte.window, 'agbrte-harness', MODEL);
      await send(
        agbrte.window,
        'Use the write tool to create a file named hello.txt containing exactly: hello from agbrte. ' +
          'Do it now with a single write call, then stop.',
      );

      // §15's Phase 1 criterion: a real repo edited by a real model, through the
      // agent host process.
      await expect(async () => {
        const contents = await readFile(join(repo, 'hello.txt'), 'utf8');
        expect(contents.toLowerCase()).toContain('hello');
      }).toPass({ timeout: LIVE_TIMEOUT });

      // A write inside the workspace is `allow` under §13's defaults, so the
      // gate must have run, recorded, and asked nobody.
      //
      // Asserted on the decision row *for `write`* rather than on the first
      // decision row, and via `policy` rather than the absence of any prompt.
      // Both of those were coupling to something the model controls: which tool
      // it calls first, and whether it calls extra tools at all. A run where it
      // also reached for `bash` would fail a global no-prompt assertion for a
      // reason that says nothing about the write.
      //
      // `via: 'policy'` is also the *stronger* claim — it proves no human was
      // consulted for this call, which a prompt count can only imply.
      const decision = agbrte.window
        .locator('[data-testid=row-decision]')
        .filter({ hasText: 'write' })
        .first();
      await expect(decision).toContainText('allow');
      await expect(decision).toContainText('policy');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('prompts before a shell command and honors a denial', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Gate check');
      await addAgent(agbrte.window, 'agbrte-harness', MODEL);

      // `bash` has no allow rule, so it falls through to `defaultAction: 'ask'` —
      // the one tool here that reaches a human. The instruction is blunt because
      // softer phrasing made this model answer in prose instead of calling it.
      await send(
        agbrte.window,
        "List the files in the current directory. You must use the bash tool with command 'ls -la'.",
      );

      const prompt = agbrte.window.locator('[data-testid=prompt]');
      await expect(prompt).toBeVisible({ timeout: LIVE_TIMEOUT });
      await expect(agbrte.window.locator('[data-testid=prompt-tool]')).toContainText('bash');

      // Denying rather than allowing: it has no side effects, and refusal is the
      // security-relevant direction. A gate that only works when you say yes is
      // not a gate.
      await agbrte.window.click('[data-testid=prompt-deny]');

      await expect(agbrte.window.locator('[data-testid=row-decision]').first()).toContainText('deny');
      // The denial reaches the model as a failed tool result rather than killing
      // the turn, so the agent can respond to it (§13's deny-ask-resume flow).
      await expect(agbrte.window.locator('[data-testid=row-result-failed]').first()).toBeVisible({
        timeout: 60_000,
      });
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The empty window (§10).
 *
 * Worth an e2e test rather than a unit one because the thing being checked is
 * that it *appears* — a guide rendered only under a condition nobody hits is the
 * same as no guide, and that is a wiring fact, not a component fact.
 */
test.describe('the start guide', () => {
  test('explains the app before a session is open, and stays reachable after', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const guide = agbrte.window.locator('[data-testid=start-guide]');

      // A host is already attached at launch, so this is the "attached, nothing
      // open" state — the one a returning user sees.
      await expect(guide).toBeVisible();
      await expect(guide).toHaveAttribute('data-compact', 'true');
      await expect(guide).toContainText('Sessions run on a host');

      // The promise that is not yet kept. §17 Q13 is open, there is no web
      // client, and an empty state is the last place anyone re-reads — so a
      // phone must not be advertised here until it works.
      await expect(guide).not.toContainText(/phone/i);

      await createSession(agbrte.window, 'Guide check');
      await expect(guide).toBeHidden();

      // Reachable with a session open: there is no way to deselect one, so
      // without this the guide is gone for good after the first minute.
      await agbrte.window.click('[data-testid=show-guide]');
      await expect(guide).toBeVisible();

      // The remote route opens the attach panel already on remote, rather than
      // dropping the user on the local tab to find it again.
      await agbrte.window.click('[data-testid=guide-attach-remote]');
      await expect(agbrte.window.locator('[data-testid=attach-panel]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=attach-alias]')).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });
});
