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

import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launch, makeRepo, modelAvailable, warmModel } from './harness.js';
import { tempFixture } from './fixtureDirs.js';
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
 * How long to wait for the model to produce its tool call, split across two
 * turns rather than spent waiting on one.
 *
 * The model is already resident by the time these run and a successful call
 * arrives in about four seconds, so this was a single sixty-second wait. The back
 * half of it was time spent watching a model that had already finished: the
 * failure mode is a refusal that ends the turn, not slowness. Asking again is the
 * only thing that can help, and both attempts together stay inside the old
 * single-attempt budget.
 */
const FIRST_ATTEMPT = 25_000;
const SECOND_ATTEMPT = 30_000;

/**
 * Every transcript row currently in the DOM, with its testid.
 *
 * The log says what happened; this says what a person would have seen. Asserting
 * on one missing row cannot tell "the decision row alone is absent" from "the
 * transcript is empty and the assertion happened to name that row first", and
 * those are different bugs in different processes.
 */
async function whatIsOnScreen(page: Page): Promise<string> {
  try {
    const rows = await page.locator('[data-testid^=row-]').evaluateAll((nodes) =>
      nodes.map((n) => `${n.getAttribute('data-testid')}: ${(n.textContent ?? '').slice(0, 80)}`),
    );
    return rows.length === 0
      ? 'On screen: no transcript rows at all.'
      : ['On screen:', ...rows.map((r) => `  ${r}`)].join('\n');
  } catch (err) {
    return `(could not read the screen: ${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * What the agent actually did, for a failure that would otherwise say nothing.
 *
 * Read from the log on disk rather than the window: the point of asking is that
 * something went wrong, and the UI is the layer most likely to be wrong with it.
 * Tool calls, decisions and stop reasons only — a full transcript buries the
 * answer in the model's prose.
 */
async function whatTheAgentDid(repo: string): Promise<string> {
  try {
    const dir = join(repo, '.agbrte', 'sessions');
    const ids = await readdir(dir);
    const log = await readFile(join(dir, ids[0]!, 'events.jsonl'), 'utf8');
    const interesting = log
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map(
        (l) =>
          JSON.parse(l) as {
            type?: string;
            tool?: string;
            text?: string;
            args?: unknown;
            via?: string;
            decision?: { result?: string };
            stop?: { kind?: string };
          },
      )
      .filter((e) =>
        [
          'agent.tool_use',
          'agent.stopped',
          'agent.text',
          // The claim under test is that §13 lets this through without asking.
          // A prompt sitting unanswered looks exactly like a slow model from
          // outside, and is the single most likely way this times out.
          'permission.requested',
          // And the decision itself, verbatim. "The row is missing" and "the
          // row says something other than allow-via-policy" look identical
          // through a `toContainText`, and only one of them is a gate bug.
          'permission.decided',
        ].includes(e.type ?? ''),
      )
      .map((e) =>
        e.type === 'agent.tool_use'
          ? `  called ${e.tool} ${JSON.stringify(e.args).slice(0, 100)}`
          : e.type === 'agent.stopped'
            ? `  stopped: ${e.stop?.kind}`
            : e.type === 'agent.text'
              ? `  said: ${(e.text ?? '').slice(0, 120)}`
              : e.type === 'permission.decided'
                ? `  decided ${e.tool}: ${e.decision?.result} via ${e.via}`
                : `  ASKED FOR PERMISSION for ${e.tool} (§13 says it should not have)`,
      );
    /*
     * The whole seq/type spine, not just the interesting rows.
     *
     * Main forwards events with `seq` greater than what it has already sent, so
     * an event written to the log out of order is dropped from the live stream
     * for good while remaining perfectly present on disk. That is
     * indistinguishable from "the renderer lost it" unless the numbers are
     * visible, and the two live in different processes.
     */
    const spine = log
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as { seq?: number; type?: string })
      .map((e) => `${e.seq}:${e.type}`)
      .join(' ');

    return [
      interesting.length === 0
        ? 'The agent produced no tool calls or text at all.'
        : ['What the agent did:', ...interesting].join('\n'),
      `Log spine: ${spine}`,
    ].join('\n');
  } catch (err) {
    return `(could not read the log: ${err instanceof Error ? err.message : String(err)})`;
  }
}

test.describe('the shell', () => {
  test('opens on the chosen workspace with runtimes available', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      // Proves main → preload → renderer all agreed on the host, which is the
      // whole IPC path in one assertion.
      const group = hostGroup(agbrte.window);
      // The machine, not the folder: a row is one host and a host is one per
      // machine (§8). Which folder a session is in is said on the session.
      await expect(group).toHaveAttribute('data-label', 'This machine');
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

  test('offers to start one only when there is none to open', async () => {
    /*
     * The greeting's button is for an empty app.
     *
     * This is the state a returning person actually opens into: sessions on
     * disk, none resumed yet, so the main pane greets rather than showing a
     * dashboard. A large accent button offering to make *another* competes
     * with the list of the ones they came back for, while being the rarer
     * intent — so it is absent here and the sidebar keeps the same act.
     *
     * The session is made by the CLI rather than through the window, because
     * a session created in the app is also *open* in it, and this is about
     * the screen you get when none is.
     */
    const repo = await makeRepo();
    execFileSync(
      process.execPath,
      [resolve('dist/cli/agbrte.js'), 'run', repo, '--runtime', 'echo', '--title', 'made earlier', 'go'],
      {
        stdio: 'ignore',
        env: {
          ...process.env,
          AGBRTE_HOST_LINGER_MS: '500',
          /*
           * Its own machine directory (§8), and the line it replaces is worth
           * recording because it looked correct and did nothing.
           *
           * It forwarded `process.env['AGBRTE_HOME']` *if set*, saying it wanted
           * "the same machine directory the app under test is using". Under
           * Playwright it is never set: `launch` builds that variable into each
           * child's environment and not into this process's. So the condition
           * was always false, this ran against the developer's real `~/.agbrte`,
           * and every full run left the real `workspaces.json` naming a fixture
           * repo that teardown then deleted. Found by diffing that file across a
           * run, after isolating `serveWebFixture` failed to stop it.
           *
           * Sharing a home with the app was never what makes this work anyway.
           * The session is found through the *workspace* store in `repo`, and
           * the two hosts are deliberately never alive at once — that is what
           * the 500ms linger and the wait below are for.
           */
          AGBRTE_HOME: await tempFixture('agbrte-madeearlier-'),
        },
      },
    );
    /*
     * Wait for that host to go.
     *
     * A host outlives the command that used it, and a session it still holds
     * is *loaded* — which is the dashboard's state, not the greeting's. The
     * short linger above is what makes this a wait rather than a hope.
     */
    await new Promise((done) => setTimeout(done, 3_000));
    const agbrte = await launch(repo);

    try {
      const welcome = agbrte.window.locator('[data-testid=welcome]');
      await expect(welcome).toBeVisible({ timeout: 25_000 });
      await expect(agbrte.window.locator('[data-testid=session]').first()).toBeVisible();

      await expect(welcome.locator('[data-testid=welcome-new-session]')).toHaveCount(0);
      await expect(welcome).toContainText('Pick a session');
      // The act itself did not go away, only its second copy.
      await expect(agbrte.window.locator('[data-testid=new-session-oneshot]')).toBeVisible();
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('remembers the agent choice, so the next session opens in the chat', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      // First session in a fresh profile: nothing is remembered, so the picker
      // shows exactly as it always has (createSession asserts it).
      await createSession(agbrte.window, 'First run');
      await addAgent(agbrte.window, 'echo');

      // Second session on the same host: the remembered choice is added
      // automatically and the composer is the first thing standing. Driven by
      // hand rather than through createSession, because that helper's picker
      // assertion is exactly what no longer holds here.
      const group = hostGroup(agbrte.window);
      await group.locator('[data-testid=new-session]').click();
      await group.locator('[data-testid=new-title]').fill('Second run');
      // In this workspace: what this test is about is the *agent* choice being
      // remembered, and a folder of its own would make it a different host.
      await group.locator('[data-testid=new-folder]').fill('');
      await group.locator('[data-testid=new-submit]').click();
      // The switch has to land before the pane is trusted: for a beat after
      // submit the *first* session's composer is still on screen, and a message
      // typed into it unmounts with it.
      await expect(agbrte.window.locator('[data-testid=session-title]')).toHaveText('Second run');
      await expect(agbrte.window.locator('[data-testid=composer-input]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=picker]')).toHaveCount(0);

      // A real seat, not a rendering: a turn runs with no further setup.
      await send(agbrte.window, 'straight to work');
      await expect(agbrte.window.locator('[data-testid=row-user]')).toContainText(
        'straight to work',
      );
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

      /*
       * The mid-session menu folds the same form back in, and choosing through
       * it *replaces* the seat rather than growing a roster (§4.2).
       *
       * The count is the assertion: a session holds one agent, so a second
       * choice leaves one live chip. The retired seat is shown separately —
       * greyed, unselectable, and named — because the turn above it is still in
       * the transcript and has to stay attributable.
       */
      await agbrte.window.click('[data-testid=change-agent]');
      await expect(agbrte.window.locator('[data-testid=picker]')).toBeVisible();
      await addAgent(agbrte.window, 'echo');
      await expect(agbrte.window.locator('[data-testid=picker]')).toHaveCount(0);
      await expect(agbrte.window.locator('[data-testid=roster-agent]')).toHaveCount(1);
      await expect(agbrte.window.locator('[data-testid=roster-retired]')).toHaveCount(1);
      // A filter with one option is noise, so there is no `Everyone` to press.
      await expect(agbrte.window.locator('[data-testid=roster-all]')).toHaveCount(0);
      // And the session is still usable afterwards: the new seat takes turns.
      await send(agbrte.window, 'after the change');
      await expect(agbrte.window.locator('[data-testid=row-user]').last()).toContainText(
        'after the change',
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

      const sessionsDir = join(repo, '.agbrte', 'sessions');
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

test.describe('two workspaces on one machine', () => {
  test('lists both folders under the one machine, and keeps them separate', async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();
    const labelA = repoA.split(/[\\/]/).pop()!;
    const labelB = repoB.split(/[\\/]/).pop()!;

    const agbrte = await launch(repoA, repoB);
    try {
      // §8's caps are per host and §10 badges every card, so watching more than
      // one place at once is the designed shape. Until the fleet landed, main
      // disposed the previous host on every workspace change.
      /*
       * One row, because a host is one process per machine (§8).
       *
       * This asserted two, which is what the sidebar drew while it was built
       * around the fleet's entries — one per *workspace*. Two folders on one
       * machine then looked like two machines with the same name, and what that
       * produced in real use was somebody reading an empty row and concluding
       * their sessions were gone.
       */
      expect(await attachedHosts(agbrte.window)).toEqual(['This machine']);

      await createSession(agbrte.window, 'work on A');
      await addAgent(agbrte.window, 'echo');
      await send(agbrte.window, 'a message for A');
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

      /*
       * By hand, and into the *other* folder.
       *
       * Two things changed with the machine row and this line met both: the
       * picker no longer appears for a second session on a machine whose agent
       * choice is remembered, and "which workspace" is now a question the form
       * asks rather than one the row answered.
       */
      const group = hostGroup(agbrte.window);
      await group.locator('[data-testid=new-session]').click();
      await group.locator('[data-testid=new-title]').fill('work on B');
      await group.locator('[data-testid=new-folder]').fill('');
      await group.locator('[data-testid=new-workspace]').selectOption({ label: labelB });
      await group.locator('[data-testid=new-submit]').click();
      await expect(agbrte.window.locator('[data-testid=session-title]')).toHaveText('work on B');
      /*
       * A seat for it, because the remembered choice is per *workspace*.
       *
       * The machine is one row, but the agent default is a fact about a folder —
       * so a session in a folder nobody has worked in yet still meets the picker,
       * which is the honest thing for it to do.
       */
      if ((await agbrte.window.locator('[data-testid=picker]').count()) > 0) {
        await addAgent(agbrte.window, 'echo');
      }
      await send(agbrte.window, 'a message for B');
      await expect(agbrte.window.locator('[data-testid=row-agent]')).toBeVisible();

      // Both under the machine, and each says which folder it is in — the
      // question the row used to answer and cannot any more, having become the
      // machine rather than the checkout.
      await expect(agbrte.window.locator('[data-testid=session]')).toHaveCount(2);
      const folders = await agbrte.window
        .locator('[data-testid=session-folder]')
        .evaluateAll((nodes) => nodes.map((n) => n.textContent ?? ''));
      expect(folders.sort()).toEqual([labelA, labelB].sort());

      // The transcripts are genuinely separate: two hosts, two logs, one writer
      // each (§5.1).
      await openSession(agbrte.window, 'work on A');
      await expect(agbrte.window.locator('[data-testid=row-user]')).toContainText('a message for A');
      await expect(agbrte.window.locator('[data-testid=row-user]')).toHaveCount(1);

      const logs = await Promise.all(
        [repoA, repoB].map(async (repo) => {
          const dir = join(repo, '.agbrte', 'sessions');
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

  test('detaching the machine lets go of every folder on it', async () => {
    const repoA = await makeRepo();
    const repoB = await makeRepo();

    const agbrte = await launch(repoA, repoB);
    try {
      await createSession(agbrte.window, 'stays');
      await addAgent(agbrte.window, 'echo');

      /*
       * Detaching a *machine* lets go of every folder it holds.
       *
       * The row is the machine (§8), so letting go of one checkout and leaving
       * the row behind is not what pressing × on it means. Detach is still
       * "stop watching" rather than "delete": the host keeps running, and the
       * session that was open keeps its transcript — which is what the send
       * below is asking.
       */
      await hostGroup(agbrte.window).locator('[data-testid=remove-host]').click();
      await expect(agbrte.window.locator('[data-testid=host]')).toHaveCount(0);

      // And nothing was deleted: opening the folder again finds the session
      // where it was left, which is the whole difference between detaching and
      // destroying (§5.4).
      await agbrte.window.click('[data-testid=new-session-oneshot]');
      await agbrte.window.fill('[data-testid=new-session-path]', repoA);
      await agbrte.window.fill('[data-testid=new-session-folder]', '');
      await agbrte.window.click('[data-testid=new-session-open]');
      // The panel lists what is already in the folder it just opened, which is
      // where a session that was detached rather than deleted turns up.
      await expect(agbrte.window.locator('[data-testid=new-session-existing]')).toContainText(
        'stays',
        { timeout: 30_000 },
      );
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

  /**
   * Compaction against a real provider (§3.7).
   *
   * The mechanism is unit-tested against a stub that accepts anything, which
   * proves the two halves talk to each other and nothing about whether a real
   * server accepts what comes out. `rehydrate()` emits `system` turns into the
   * middle of a history, and "an OpenAI-compatible server tolerates that" was an
   * assumption until something asked one.
   *
   * Cheap to observe, because compaction runs **before** the provider call: one
   * turn large enough to cross the high-water mark triggers it on the way in, so
   * this costs a single request rather than the dozens it would take to fill a
   * window honestly.
   *
   * The assertion is on the log rather than on the reply. Whether a 7B model
   * says anything sensible about a wall of text is its business; what is under
   * test is that the history was replaced, the replacement was accepted, and the
   * turn completed instead of being refused for a malformed history.
   */
  test('compacts a history that will not fit, and the model still answers', async () => {
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Compaction');
      await addAgent(agbrte.window, 'agbrte-harness', MODEL);

      /*
       * Just past 0.75 of the window, and no further.
       *
       * The first version used half again as much, which triggered compaction
       * and then spent a hundred seconds making a 7B model prefill the result —
       * close enough to the 180s ceiling to cross it about one run in five. What
       * is under test is that compaction happens and the server accepts what
       * comes out, and neither gets truer with a bigger wall.
       *
       * 32,768-token window, `estimateTokens` at three characters each, so the
       * mark is around 73,700 characters. Ordinary prose rather than one
       * repeated character, so the summariser has something to summarise.
       */
      const wall = 'The quick brown fox jumps over the lazy dog. '.repeat(1_750);
      await send(agbrte.window, `${wall}

In one short sentence: what animal was mentioned?`);

      /*
       * Compacted, and then accepted — `usage` is the moment the provider
       * answered, so a history it refused could not produce one.
       *
       * This waited for the turn to *finish*, which was the wrong end of the
       * proof and cost about a hundred seconds a run. Worse, it hung outright
       * roughly one run in five: handed a summary and asked a question, the
       * model sometimes reaches for a tool, `bash` falls through to §13's
       * `ask`, and a test that answers no prompt waits forever. The gate was
       * doing its job; the test was asking for something it did not need.
       */
      await expect(async () => {
        const log = await whatTheAgentDid(repo);
        expect(log, 'the history was never compacted').toContain('agent.compacted');
        expect(log, 'the provider never answered the compacted history').toContain('usage');
      }).toPass({ timeout: SECOND_ATTEMPT });

      /*
       * Settle the turn before tearing down.
       *
       * Handed a summary and asked a question, this model sometimes reaches for
       * a tool; `bash` falls through to §13's `ask` and the gate stops for a
       * person who, in a test, never comes. The assertion above had already
       * passed, so the failure showed up as teardown taking two minutes and
       * occasionally timing out — the gate doing its job, and the test leaving
       * a turn hanging on the way out.
       */
      const prompt = agbrte.window.locator('[data-testid=prompt]');
      if (await prompt.isVisible()) await agbrte.window.click('[data-testid=prompt-deny]');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
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
      const instruction =
        'Use the write tool to create a file named hello.txt containing exactly: hello from agbrte. ' +
        'Do it now with a single write call, then stop.';
      await send(agbrte.window, instruction);

      /** Whether hello.txt turns up within `ms`. */
      const written = async (ms: number): Promise<boolean> => {
        try {
          await expect(async () => {
            const contents = await readFile(join(repo, 'hello.txt'), 'utf8');
            expect(contents.toLowerCase()).toContain('hello');
          }).toPass({ timeout: ms });
          return true;
        } catch {
          return false;
        }
      };

      /*
       * §15's Phase 1 criterion: a real repo edited by a real model, through the
       * agent host process. Two turns, not one — and that is a real measurement
       * rather than a shrug.
       *
       * About one turn in ten, `qwen2.5:7b` answers this with *"as an AI, I
       * don't have direct access to local file systems"* and stops. It is a
       * refusal, not a delay: the stop reason is `end_turn`, so waiting longer
       * cannot help, and a longer timeout only made each loss slower. The
       * obvious fix — telling the model in a system prompt that its tools are
       * real — was implemented and measured, and made it three times worse (see
       * `agbrteHarness.ts`). What a person does instead is say it again, so that
       * is what this does.
       *
       * The retry sends the **same words**, not a firmer version of them. New
       * phrasing would make the second attempt a different test from the first,
       * and this is a coin the model flips, not an instruction it misread.
       *
       * Two attempts, and not three, because the coin is weighted by what came
       * before it. Independent refusals at the measured ~12% would put two in a
       * row at 1.4%, or one failure in seventy runs; the observed rate after this
       * change is one in twenty here and one in twelve for the denial test. Once
       * the model has answered in prose, that turn is in the transcript and reads
       * as precedent for the next one. A third identical ask buys much less than
       * the arithmetic suggests, so the residual is left visible rather than
       * papered over with more turns.
       *
       * A failure carries the transcript, because otherwise this reports
       * `Timeout exceeded` and nothing else — and "slow", "called `bash`
       * instead", and "refused outright" are three different problems that were
       * indistinguishable from the outside.
       */
      if (!(await written(FIRST_ATTEMPT))) {
        await send(agbrte.window, instruction);
        if (!(await written(SECOND_ATTEMPT))) {
          throw new Error(
            `hello.txt was never written, across two turns.\n\n${await whatTheAgentDid(repo)}`,
          );
        }
      }

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
      //
      // Carries the transcript for the same reason the file check does. This
      // assertion still couples to *which* tool the model reached for, and when
      // it failed it said only `toContainText failed` — which is consistent
      // with a broken gate and with the model having created the file some
      // other way, and those need opposite fixes.
      const decision = agbrte.window
        .locator('[data-testid=row-decision]')
        .filter({ hasText: 'write' })
        .first();
      try {
        await expect(decision).toContainText('allow');
        await expect(decision).toContainText('policy');
      } catch (err) {
        throw new Error(
          `hello.txt exists, but no allowed-by-policy decision row for \`write\`.\n` +
            `${(err as Error).message}\n\n${await whatTheAgentDid(repo)}\n\n` +
            `${await whatIsOnScreen(agbrte.window)}`,
        );
      }
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
      const instruction =
        "List the files in the current directory. You must use the bash tool with command 'ls -la'.";
      await send(agbrte.window, instruction);

      const prompt = agbrte.window.locator('[data-testid=prompt]');
      const asked = async (ms: number): Promise<boolean> => {
        try {
          await expect(prompt).toBeVisible({ timeout: ms });
          return true;
        } catch {
          return false;
        }
      };

      /*
       * Two turns, and a failure that carries the transcript — the same treatment
       * as the write test, for the same reason.
       *
       * Blunt phrasing reduced this model's refusal rate without removing it: it
       * still sometimes explains that it cannot run commands and ends the turn.
       * That is a refusal, so waiting longer cannot produce a prompt, and the
       * report said only `element(s) not found` — which is equally consistent
       * with a gate that failed to ask, and those need opposite fixes.
       */
      if (!(await asked(FIRST_ATTEMPT))) {
        await send(agbrte.window, instruction);
        if (!(await asked(SECOND_ATTEMPT))) {
          throw new Error(
            `no permission prompt appeared, across two turns.

` +
              `${await whatTheAgentDid(repo)}

${await whatIsOnScreen(agbrte.window)}`,
          );
        }
      }
      await expect(agbrte.window.locator('[data-testid=prompt-tool]')).toContainText('bash');

      // Denying rather than allowing: it has no side effects, and refusal is the
      // security-relevant direction. A gate that only works when you say yes is
      // not a gate.
      await agbrte.window.click('[data-testid=prompt-deny]');

      // Addressed by tool, not by position: a retried turn can put another
      // policy-settled decision above this one, and `.first()` would then assert
      // on a row that has nothing to do with the denial.
      await expect(
        agbrte.window.locator('[data-testid=row-decision]').filter({ hasText: 'bash' }).first(),
      ).toContainText('deny');
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
test.describe('the first screen, the guide, and about', () => {
  test('greets first, and keeps the explanation one button away', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const welcome = agbrte.window.locator('[data-testid=welcome]');
      const guide = agbrte.window.locator('[data-testid=start-guide]');

      // A host is already attached at launch, so this is the "attached, nothing
      // open" state — the one a returning user sees. It greets; it does not
      // explain. The explanation moved behind the button that names it.
      await expect(welcome).toBeVisible();
      await expect(welcome).toHaveAttribute('data-compact', 'true');
      await expect(guide).toBeHidden();

      // The promise that is not yet kept. §17 Q13 is open, there is no web
      // client, and an empty state is the last place anyone re-reads — so a
      // phone must not be advertised here until it works.
      await expect(welcome).not.toContainText(/phone/i);

      /*
       * The one-shot is on screen in both places it is promised.
       *
       * Presence, not a press: its first step is the native folder dialog,
       * which Playwright cannot answer, so clicking here would hang the run
       * rather than test it. What is checkable — and what actually regressed
       * before, for the guide — is whether a control exists anywhere a person
       * will look. The greeting points at the button beside it, so the old copy
       * naming a `+` three steps away must be gone.
       */
      await expect(welcome.locator('[data-testid=welcome-new-session]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=new-session-oneshot]')).toBeVisible();
      await expect(welcome).not.toContainText('press +');

      await createSession(agbrte.window, 'Guide check');
      await expect(welcome).toBeHidden();


      // The fast path is an addition, so the granular controls it shortcuts are
      // still here — and the header button survives a session being open, which
      // is when a second workspace is most likely to be wanted.
      await expect(agbrte.window.locator('[data-testid=new-session-oneshot]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=add-host]')).toBeVisible();
      await expect(hostGroup(agbrte.window).locator('[data-testid=new-session]')).toBeVisible();

      // Reachable with a session open: there is no way to deselect one, so
      // without this the guide is gone for good after the first minute.
      await agbrte.window.click('[data-testid=show-guide]');
      await expect(guide).toBeVisible();
      await expect(guide).toContainText('Sessions run on a host');
      // The usage half: what to press, in the order it can be pressed.
      // Naming a machine, not attaching a workspace: the two split when a host
      // became one per machine (§8), and the guide is the one place that says
      // the order out loud.
      await expect(guide.locator('[data-testid=guide-steps]')).toContainText('Name a machine');
      await expect(guide).not.toContainText(/phone/i);

      // The remote route opens the attach panel already on remote, rather than
      // dropping the user on the local tab to find it again.
      await agbrte.window.click('[data-testid=guide-attach-remote]');
      await expect(agbrte.window.locator('[data-testid=attach-panel]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=attach-alias]')).toBeVisible();
    } finally {
      await agbrte.close();
    }
  });

  test('about says what is running, from the process that knows', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await agbrte.window.click('[data-testid=show-about]');
      const about = agbrte.window.locator('[data-testid=about]');
      await expect(about).toBeVisible();

      // The version comes over IPC from `app.getVersion()` — the same
      // package.json the build was made from, not a copy in the bundle.
      /*
       * The version this checkout ships, not whatever the app path happened to
       * answer. `app.getVersion()` reads the `package.json` beside the entry,
       * and in development there is none — so it returned *Electron's* version,
       * which a `\d+\.\d+\.\d+` pattern accepts happily. §6.3's outdated-host
       * badge compares that number against the host bundle's stamp, so the
       * mismatch made every host look stale and the Update button permanent.
       */
      const shipping = JSON.parse(
        await readFile(join(process.cwd(), 'package.json'), 'utf8'),
      ).version as string;
      await expect(about.locator('[data-testid=about-version]')).toHaveText(shipping);
      await expect(about.locator('[data-testid=about-license]')).toHaveText('Apache-2.0');

      // A toggle, not a one-way door.
      await agbrte.window.click('[data-testid=show-about]');
      await expect(about).toBeHidden();
    } finally {
      await agbrte.close();
    }
  });
});

test.describe('reasoning effort', () => {
  /**
   * The control, end to end (§3.4).
   *
   * `AgentSpec.reasoning` was plumbed to the provider and nothing set it. A
   * select that changes a value main never stores is the same defect one layer
   * up, and a unit test cannot see it — the renderer, the IPC, the fleet, the
   * session protocol and the manager are five places this has to cross.
   */
  test('says so when the model takes no effort, rather than offering a dead control', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Effort');
      // `echo` reports `reasoningControl: 'none'`, which is the common case for
      // a local model and the one a greyed-out dropdown would misdescribe.
      await addAgent(agbrte.window, 'echo');

      await expect(agbrte.window.locator('[data-testid=roster-effort-unavailable]')).toBeVisible();
      await expect(agbrte.window.locator('[data-testid=roster-effort]')).toHaveCount(0);
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * The control actually moving the value, across the five places it must cross:
   * renderer, IPC, fleet, session protocol, manager.
   *
   * `qwen3:0.6b` is here because it reports `thinking` in its Ollama
   * capabilities — measured, not assumed — and is small enough to keep this
   * quick. The assertion is on the log, because that is where a change has to
   * land for a restart to keep it; a select showing a new value proves only that
   * React re-rendered.
   */
  test('moves the effort, and writes it down', async () => {
    const thinker = 'qwen3:0.6b';
    test.skip(!(await modelAvailable(thinker)), `needs ${thinker} — run \`ollama pull ${thinker}\``);

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Effort');
      await addAgent(agbrte.window, 'agbrte-harness', thinker);

      const effort = agbrte.window.locator('[data-testid=roster-effort]');
      // Admitted at the default rather than left for the person to set.
      await expect(effort).toHaveValue('max');

      await effort.selectOption('low');
      await expect(async () => {
        expect(await whatTheAgentDid(repo)).toContain('agent.reasoning_changed');
      }).toPass({ timeout: FIRST_ATTEMPT });
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  /**
   * The working-out reaching the transcript (§3.9).
   *
   * `reasoningVisible: 'raw'` is a claim that the model's thinking is available
   * through this adapter. It was `'none'` while the field came back on the wire
   * and the adapter dropped it — the row would have described something no
   * caller could reach. This is the test that makes the row true.
   */
  test('keeps what the model thought, folded away from what it said', async () => {
    const thinker = 'qwen3:0.6b';
    test.skip(!(await modelAvailable(thinker)), `needs ${thinker} — run \`ollama pull ${thinker}\``);

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Thinking');
      await addAgent(agbrte.window, 'agbrte-harness', thinker);
      await send(agbrte.window, 'What is 17 times 23?');

      const row = agbrte.window.locator('[data-testid=row-reasoning]');
      await expect(row).toBeVisible({ timeout: SECOND_ATTEMPT });
      // Folded: the answer is what a transcript is read for, and the working-out
      // is often several times its length.
      await expect(row).not.toHaveAttribute('open', /.*/);
      await expect(await whatTheAgentDid(repo)).toContain('agent.reasoning');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/*
 * Nothing in the sidebar is cut off, whatever a machine is called (§7).
 *
 * Reported from a real remote: the row for `cbk_ws_one` showed the machine and
 * two of its four controls, and *Update* and *Detach* were simply not there —
 * on the row for the machine that most needs them.
 *
 * The cause was one grid column. The rail is `display: grid`, and a bare `1fr`
 * is `minmax(auto, 1fr)`, so the column is at least the min-content of its
 * widest item. A host row's min-content includes four `shrink-0` buttons, which
 * cannot give anything back — so the column sized itself to 361px inside a
 * 300px rail and `overflow-x-hidden` cut off the difference.
 *
 * Invisible to everything this project runs. It type-checks, the classes all
 * exist so `lint:classes` is quiet, and every existing e2e assertion is about a
 * control being *present in the DOM* — which these were. Only a measurement
 * catches a control that is present and off-screen, so this measures.
 *
 * The label is set from the page rather than by attaching a remote, because
 * what is under test is the layout at a width, not the transport that produced
 * the name. A name long enough to need truncating is included for the same
 * reason the short one is: the fix is that the *label* yields and the controls
 * do not, and asserting only the easy case would pass on the version that
 * truncated the buttons instead.
 */
test('keeps every host control on screen, however long the machine is called', async () => {
  const agbrte = await launch(await makeRepo(), await makeRepo());

  try {
    const page = agbrte.window;
    await page.waitForSelector('[data-testid=host]', { timeout: 30_000 });

    for (const name of ['x', 'cbk_ws_one', 'build-box-frankfurt-gpu-04.internal.example.com']) {
      // Through a locator rather than `document`: these specs compile without
      // the DOM lib (see tsconfig.json), and the whole span is replaced because
      // what is measured is its width.
      await page
        .locator('[data-testid=host] .truncate-line')
        .evaluateAll((els, label: string) => {
          for (const el of els) el.textContent = label;
        }, name);

      const measured = await page
        .locator('[data-testid=host]')
        .first()
        .evaluate((el) => {
          const rail = el.parentElement!;
          const edge = rail.getBoundingClientRect().right;
          return {
            overflow: rail.scrollWidth - rail.clientWidth,
            past: [...el.querySelectorAll('button')].filter(
              (b) => b.getBoundingClientRect().right > edge + 1,
            ).length,
            buttons: el.querySelectorAll('button').length,
          };
        });

      // The rail scrolls vertically and hides horizontally, so anything wider
      // than it is not clipped politely — it is gone.
      expect(measured.overflow, `"${name}" made the rail overflow`).toBeLessThanOrEqual(0);
      expect(measured.past, `"${name}" pushed controls past the rail`).toBe(0);
      expect(measured.buttons).toBeGreaterThan(2);
    }
  } finally {
    await agbrte.close();
  }
});
