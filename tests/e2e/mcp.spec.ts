/**
 * Attaching an MCP server from the app, end to end (DESIGN.md §17 Q20, §3.5).
 *
 * `tests/mcp.test.ts` proves the *owner* half — a real server, spawned by
 * `SessionManager`, its tools gated per call. What it cannot prove is that a
 * person can get one attached, because it calls `createSession` directly. This
 * file drives the form: the fields in the sidebar, through the store, the
 * preload, the fleet, the host protocol's `session.create`, and back out as the
 * row that says what the server contributed.
 *
 * That chain is the regression risk. Every link in it is typed except the two
 * that matter — `input` on the wire is `CreateSessionInput` shaped, and the
 * renderer's drafts are strings — so a rename or a dropped spread would leave
 * every unit test passing and the field silently ignored.
 *
 * ## The deterministic tests use a fixture server, not the web
 *
 * `tests/fixtures/mcpServer.cjs` speaks the real stdio transport and answers in
 * microseconds. The web one is the *live* test at the bottom, which skips loudly
 * — a wiring test that fails when DuckDuckGo rate-limits a CI runner is a test
 * that gets deleted.
 */

import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch, makeRepo, modelAvailable, warmModel, ROOT } from './harness.js';
import { addAgent, createSession, send } from './actions.js';

/** The fixture, quoted because a temp path on any platform may contain a space. */
const FIXTURE = `"${join(ROOT, 'tests', 'fixtures', 'mcpServer.cjs').replace(/\\/g, '/')}"`;
/** The node running this test — a real absolute path, and never `npx`. */
const NODE = process.execPath;

const MODEL = 'qwen2.5:7b';

/** Every event of a type, from the one session's log on disk. */
async function logRows(repo: string): Promise<Array<Record<string, unknown>>> {
  const dir = join(repo, '.devagents', 'sessions');
  const ids = await readdir(dir);
  const log = await readFile(join(dir, ids[0]!, 'events.jsonl'), 'utf8');
  return log
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

test.describe('a server named on the creation form', () => {
  test('attaches, and the session says what it contributed', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'With tools', undefined, [
        {
          id: 'fixture',
          command: NODE,
          args: FIXTURE,
          // The credential half of §13, driven through the UI: this value must
          // reach the *process* and appear in neither the log nor the screen.
          env: [['AGBRTE_E2E_TOKEN', 'sekrit-value-1234']],
        },
      ]);

      /*
       * Visible before a model is chosen, which is the point of where it
       * renders: the servers were decided on the form, so the answer about them
       * cannot wait for a seat.
       */
      const attached = agbrte.window.locator('[data-testid=mcp-attached]');
      await expect(attached).toBeVisible();
      await expect(attached.locator('[data-testid=mcp-server][data-server=fixture]')).toBeVisible();
      await expect(attached.locator('[data-testid=mcp-tool]')).toHaveText('mcp__fixture__lookup');

      // And the same fact in the transcript, which is where it survives a
      // restart — the live row cannot, because the connection deliberately does
      // not (§17 Q20).
      await addAgent(agbrte.window, 'echo');
      await expect(agbrte.window.locator('[data-testid=row-mcp-attached]')).toContainText(
        'mcp__fixture__lookup',
      );

      /*
       * The env name, never the env value — asserted against the whole log
       * rather than one field, because the leak this guards against is a field
       * somebody adds later, not the one the code writes today.
       */
      const rows = await logRows(repo);
      const attachedRow = rows.find((r) => r['type'] === 'mcp.attached');
      expect(attachedRow?.['envKeys']).toEqual(['AGBRTE_E2E_TOKEN']);
      expect(JSON.stringify(rows), 'a credential reached the log').not.toContain(
        'sekrit-value-1234',
      );
      const onScreen = await agbrte.window.locator('body').innerHTML();
      expect(onScreen, 'a credential reached the screen').not.toContain('sekrit-value-1234');
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('says why when it does not start, where its tools would have been', async () => {
    // §3.5: the session is still made and still runs. A degradation nobody is
    // told about is indistinguishable from the feature being broken, which is
    // why this asserts on a sentence rather than on an absence.
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Broken tools', undefined, [
        { id: 'dead', command: NODE, args: '-e "process.exit(3)"' },
      ]);

      const attached = agbrte.window.locator('[data-testid=mcp-attached]');
      await expect(attached.locator('[data-testid=mcp-failed]')).toBeVisible();
      await expect(attached.locator('[data-testid=mcp-failed]')).toContainText('did not start');
      // Nothing claimed a tool that does not exist.
      await expect(attached.locator('[data-testid=mcp-tool]')).toHaveCount(0);

      // And the session is usable, which is the other half of §3.5's promise.
      await addAgent(agbrte.window, 'echo');
      await expect(agbrte.window.locator('[data-testid=row-mcp-failed]')).toBeVisible();
      await send(agbrte.window, 'still works');
      await expect(agbrte.window.locator('[data-testid=row-agent]').first()).toBeVisible();
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('refuses a name that could not become a tool name, before creating anything', async () => {
    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      const group = agbrte.window.locator('[data-testid=host]').first();
      await group.locator('[data-testid=new-session]').click();
      await group.locator('[data-testid=new-title]').fill('Bad name');
      await group.locator('[data-testid=mcp-fields] summary').click();
      await group.locator('[data-testid=mcp-add]').click();
      await group.locator('[data-testid=mcp-id]').fill('Bad Id!');
      await group.locator('[data-testid=mcp-command]').fill(NODE);

      // The reason, while the field is still in front of the person — and the
      // create held, rather than a round trip that makes nothing and says so
      // afterwards. The host refuses this too; that refusal is the boundary.
      await expect(group.locator('[data-testid=mcp-problem]')).toContainText('lowercase');
      await expect(group.locator('[data-testid=new-submit]')).toBeDisabled();
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The same wiring against a real web-search server and a real local model.
 *
 * Skipped loudly rather than silently, like the Ollama tests in `app.spec.ts`:
 * this one needs a network, a model that can call tools, and a package that is
 * not a dependency of this repo — and a criterion that passes because its test
 * was skipped is worse than no test.
 *
 * `@oevortex/ddg_search` is the server, and the reason is a survey rather than a
 * preference: every *reference* web-search MCP server needs an API key (Brave,
 * Exa, Tavily all do), the official fetch server is Python-only, and this one is
 * the credible keyless option — Apache-2.0, stdio, one `web-search` tool, no
 * account. It is not a dependency here because a skipped test must not cost
 * everyone an install.
 */
const webServerBin = ((): string | null => {
  const fromEnv = process.env['AGBRTE_MCP_WEB_SERVER'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  try {
    return createRequire(import.meta.url).resolve('@oevortex/ddg_search/bin/cli.js');
  } catch {
    return null;
  }
})();

test.describe('a real search server, called by a real model', () => {
  test.beforeAll(async () => {
    if (await modelAvailable(MODEL)) await warmModel(MODEL);
  });

  test('the model searches the web and the gate records the decision', async () => {
    test.skip(
      webServerBin === null,
      'needs a keyless web-search MCP server — `npm i -D @oevortex/ddg_search`, ' +
        'or point AGBRTE_MCP_WEB_SERVER at another server’s entry script',
    );
    test.skip(
      !(await modelAvailable(MODEL)),
      `needs a local Ollama server with ${MODEL} — run \`ollama pull ${MODEL}\``,
    );

    const repo = await makeRepo();
    const agbrte = await launch(repo);

    try {
      await createSession(agbrte.window, 'Web search', undefined, [
        { id: 'search', command: NODE, args: `"${webServerBin!.replace(/\\/g, '/')}" --server` },
      ]);
      await expect(agbrte.window.locator('[data-testid=mcp-tool]')).toHaveText(
        'mcp__search__web-search',
      );

      await addAgent(agbrte.window, 'agbrte-harness', MODEL);
      await send(
        agbrte.window,
        'Search the web and tell me in one sentence which company introduced the ' +
          'Model Context Protocol, and in which month and year.',
      );

      /*
       * The gate first, and it is not a formality: `mcp__…` is not in §13's
       * designated-argument table, so it falls to `ask` — fail-closed by
       * construction — and a run that never showed this prompt would mean the
       * namespacing had stopped protecting anything.
       */
      const prompt = agbrte.window.locator('[data-testid=prompt]');
      await expect(prompt).toBeVisible({ timeout: 60_000 });
      await expect(agbrte.window.locator('[data-testid=prompt-tool]')).toHaveText(
        'mcp__search__web-search',
      );
      await agbrte.window.click('[data-testid=prompt-allow]');

      // The result came back, and the decision is in the log where §13 requires
      // it. Asserted on the log rather than the reply: whether a 7B model reads
      // its own search results correctly is the model's business, and it is not
      // what this test is for.
      await expect(async () => {
        const rows = await logRows(repo);
        const decided = rows.find(
          (r) => r['type'] === 'permission.decided' && r['tool'] === 'mcp__search__web-search',
        );
        expect(decided, 'no decision was recorded for the search tool').toBeDefined();
        const result = rows.find((r) => r['type'] === 'agent.tool_result' && r['ok'] === true);
        expect(result, 'the search never returned').toBeDefined();
      }).toPass({ timeout: 60_000 });
    } finally {
      await agbrte.close();
      await rm(repo, { recursive: true, force: true });
    }
  });
});
