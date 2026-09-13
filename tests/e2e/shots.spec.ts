/**
 * Screenshots of the real UI, for looking at it.
 *
 * Not an assertion suite — it asserts almost nothing on purpose. Design work
 * done by reading JSX is design work done blind, and this project has spent
 * enough of this session on things that were correct in source and wrong in
 * fact. These run the real web client against real sessions and write PNGs.
 *
 * Kept out of the default run by its `@shots` tag, because writing files is not
 * a test result and a suite that always writes 300 KB of images teaches people
 * to ignore its output. The tag was only a claim until `playwright.config.ts`
 * was made to enforce it; the switch below is what turns it back on.
 *
 *   AGBRTE_WRITE_FIXTURES=1 npx playwright test shots --grep @shots
 *
 * ## These end up in the README, which changes what they owe a reader
 *
 * The first set was four `echo` sessions in an empty repo, and it showed: three
 * quarters of the frame was black, every card said the same thing, and one
 * title was literally *"a title that is quite a lot longer than the others, to
 * see what the card does with it"*. As a design aid that was fine — the long
 * title is there to test the card, and `echo` is there to keep the suite
 * offline. As the first picture of the product anybody sees it was a picture of
 * placeholder text, and a reader who then downloaded the app would find
 * something better than they had been shown.
 *
 * So: a repository with files in it, titles that are work rather than fixtures,
 * enough sessions that the grid is a grid, and **a real model when one is
 * running**. `qwen2.5:7b` through Ollama is what `README.md` tells people to
 * install, so it is what the pictures are taken with.
 *
 * It still falls back to `echo` when no model is there, and the fallback is not
 * a lesser test — it is the same UI with cheaper turns. What it is not is
 * something to publish, so the two are told apart in the console rather than
 * silently producing different pictures under one name.
 */

import { tempFixture } from './fixtureDirs.js';
import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { modelAvailable, serveWebFixture, warmModel } from './harness.js';

const OUT = resolve('.shots');
const MODEL = 'qwen2.5:7b';

/**
 * Sessions with the variety a dashboard actually has to render.
 *
 * The long title stays, because a card that cannot take one is a bug worth
 * seeing, but it is now a plausible sentence rather than an instruction to the
 * reader. The rest are the shape of a real queue: a bug, a doc, an
 * investigation, a rename, a question.
 */
const WORK = [
  {
    title: 'why does parseProbe return an empty Map?',
    prompt: 'Read src/probe.js and say in two sentences when parseProbe returns an empty Map.',
  },
  {
    title: 'add a test for a line with no equals sign',
    prompt: 'Read src/probe.js. In two sentences, what should a test for a line with no "=" assert?',
  },
  {
    title: 'draft the README section on parsing probe output',
    prompt: 'Read README.md and draft two sentences for a section about parsing probe output.',
  },
  {
    title: 'rename parseProbe to parseProbeLines and update the callers',
    prompt: 'Read src/probe.js and list, in two sentences, what a rename of parseProbe would touch.',
  },
  {
    title: 'investigate the flake in detachedHost',
    prompt: 'Two hosts in one test run shared a socket. Name the likeliest cause in two sentences.',
  },
  {
    title: 'work out whether the host record can be trusted after a reboot',
    prompt: 'In two sentences: why is a file naming a process weaker evidence than a socket answering?',
  },
  {
    title: 'decide what a value containing an equals sign should do',
    prompt: 'Read src/probe.js. In two sentences: what happens to a line like a=b=c, and is that right?',
  },
  {
    title: 'trim the trailing carriage return a Windows shell leaves',
    prompt: 'In two sentences: why does a line read from a Windows shell often end in a stray \\r?',
  },
  {
    title: 'the parser silently drops a duplicated key',
    prompt: 'Read src/probe.js. In two sentences: what happens when the same key appears twice?',
  },
  {
    title: 'write the changelog entry for 0.2.0',
    prompt: 'In two sentences, draft a changelog entry for a parser that now skips malformed lines.',
  },
  {
    title: 'is a Map the right return type here?',
    prompt: 'Read src/probe.js. In two sentences, argue for or against returning a Map.',
  },
  {
    title: 'add the CI job that runs the parser tests on Windows',
    prompt: 'In two sentences: what does a Windows CI job need that a Linux one does not?',
  },
  {
    title: 'should a blank line be an error or a skip?',
    prompt: 'Read src/probe.js. In two sentences: is skipping a blank line the right call?',
  },
  {
    title: 'document what the probe promises about ordering',
    prompt: 'In two sentences: does a Map preserve insertion order, and does that matter here?',
  },
  {
    title: 'benchmark the parser against a 10k-line probe',
    prompt: 'In two sentences: what would dominate the cost of parsing ten thousand lines?',
  },
  {
    title: 'the README example does not match the code',
    prompt: 'Read README.md and src/probe.js. In two sentences, say whether they agree.',
  },
];

/** A repository with something in it, so a turn has something to be about. */
/**
 * What a project declares, as files in the repository it declares them in.
 *
 * These are the pictures the README was missing. A workflow, a skill and an MCP
 * server are all *files in `templates/`*, which is the whole argument for them
 * (§17 Q12, §4.4) — and an argument made only in prose is one nobody can see. A
 * reader looking at the form finds a list that came from a folder, which is the
 * thing the sentence is about.
 *
 * Real content rather than `foo`/`bar`, for `WORK`'s reason one screen up: these
 * end up in the README, and placeholder text there is a picture of placeholder
 * text.
 */
async function declareThings(repo: string): Promise<void> {
  const dir = join(repo, '.agbrte', 'templates');
  await mkdir(dir, { recursive: true });

  const node = (
    id: string,
    scope: string,
    needs?: string[],
  ): Record<string, unknown> => ({
    id,
    title: id,
    scope,
    outOfScope: ['anything outside src/'],
    acceptance: ['it is written down'],
    contract: { summaryMaxTokens: 800, artifacts: [] },
    tokenCeiling: 20_000,
    ...(needs === undefined ? {} : { needs }),
  });

  // A join — two parts meeting at one — because that is the shape a session tree
  // cannot express and therefore the reason the picture is worth taking.
  await writeFile(
    join(dir, 'review.workflow.json'),
    JSON.stringify(
      {
        id: 'review',
        name: 'review this branch',
        goal: 'find what is broken before anybody else does',
        nodes: [
          node('scan', 'list every file the branch touched'),
          node('tests', 'run the suite and report what failed', ['scan']),
          node('lint', 'run the linters and report what they said', ['scan']),
          node('report', 'write up what the two found, together', ['tests', 'lint']),
        ],
      },
      null,
      2,
    ),
    'utf8',
  );

  await writeFile(
    join(dir, 'commits.skill.md'),
    [
      '---',
      'description: How commit messages are written in this repository',
      '---',
      '',
      'They say why, and they record what broke: the defect that produced the',
      'line, what the wrong version cost, and which alternative was rejected.',
      '',
    ].join('\n'),
    'utf8',
  );

  // Declared but not yet usable on this machine, which is the honest state and
  // the more informative picture: the form asks for the one value it needs, by
  // name, and the key is never in the file.
  await writeFile(
    join(dir, 'search.mcp.json'),
    JSON.stringify(
      { command: 'npx', args: ['-y', 'mcp-searxng@2.2.0'], envFrom: { SEARXNG_URL: 'SEARXNG_URL' } },
      null,
      2,
    ),
    'utf8',
  );
}

async function fillRepo(repo: string): Promise<void> {
  await writeFile(
    join(repo, 'README.md'),
    '# probe\n\nParses `key=value` lines out of what a remote shell prints back.\n',
    'utf8',
  );
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(
    join(repo, 'src', 'probe.js'),
    [
      '/** Parse `key=value` lines. A line without `=` is skipped rather than thrown on. */',
      'export function parseProbe(text) {',
      '  const out = new Map();',
      '  for (const line of text.split("\\n")) {',
      '    const at = line.indexOf("=");',
      '    if (at > 0) out.set(line.slice(0, at).trim(), line.slice(at + 1).trim());',
      '  }',
      '  return out;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

test.describe('@shots', () => {
  test('captures the app at the sizes people use it', async ({ page }) => {
    test.setTimeout(900_000);
    await mkdir(OUT, { recursive: true });

    const live = await modelAvailable(MODEL);
    // Its own machine directory and its own endpoint file, so this neither reads
    // nor writes the developer's `~/.agbrte` (§8) — the alternative is a run
    // that quietly depends on how the person running it configured their models.
    const home = await tempFixture('agbrte-shots-home-');
    if (live) {
      await writeFile(
        join(home, 'endpoints.json'),
        JSON.stringify({
          endpoints: [{ id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' }],
          default: 'local',
        }),
        'utf8',
      );
      await warmModel(MODEL);
    }
    process.stdout.write(
      live
        ? `\n  shots: ${MODEL} through Ollama — these are publishable\n\n`
        : `\n  shots: no ${MODEL}, falling back to the echo runtime — do NOT publish these\n\n`,
    );

    // A folder with a name, because the session header prints it and
    // `agbrte-e2e-repo-5Y5Z4U` in a published screenshot says "test fixture".
    const web = await serveWebFixture({
      home,
      repo: join(await tempFixture('agbrte-shots-'), 'probe'),
    });

    try {
      await fillRepo(web.repo);
      await declareThings(web.repo);

      for (const { title, prompt } of WORK) {
        execFileSync(
          process.execPath,
          [
            resolve('dist/cli/agbrte.js'),
            'run',
            web.repo,
            '--title',
            title,
            // `--yes` because the repo is a throwaway temp directory and a denied
            // read is the one thing these pictures must not be full of. It is
            // also what makes a transcript worth photographing: the model
            // actually opens the file it was asked about.
            '--yes',
            ...(live ? ['--endpoint', 'local', '--model', MODEL] : ['--runtime', 'echo']),
            prompt,
          ],
          { stdio: 'ignore', env: { ...process.env, AGBRTE_HOME: home } },
        );
      }

      /*
       * Two desktop heights, one per view, and that is framing rather than a lie
       * about the layout.
       *
       * The dashboard is a grid that grows downwards: on a tall window sixteen
       * sessions still leave half the frame black. That is genuinely what the app
       * looks like, and it is also a picture that is mostly nothing once it is
       * scaled to the width of a README column. A session is the opposite shape —
       * the composer is pinned to the bottom, so a short window squeezes the
       * transcript that is the whole point of the picture.
       *
       * So each gets a window height somebody actually has, chosen for what is in
       * it. The width never changes, because that is what decides the layout.
       */
      await page.setViewportSize({ width: 1440, height: 560 });
      await page.goto(web.url);
      await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/01-dashboard.png` });

      // A session opened: the transcript, the roster, the composer. Named rather
      // than `.first()`, so the picture does not change meaning when the
      // dashboard's ordering does.
      await page.setViewportSize({ width: 1440, height: 760 });
      await page.waitForTimeout(400);
      const card = page.getByText(WORK[0]!.title, { exact: false }).first();
      if (await card.isVisible()) {
        await card.click();
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${OUT}/02-session.png` });
      }

      /*
       * The phone shape, which §12 and the CSS both take seriously — and it
       * stays *here*, before the two shots below.
       *
       * Which pane and which session are open both survive a reload, so this
       * came out as a picture of the workflows pane — captioned in the README as
       * a dashboard on a phone. Nothing here asserts, the file was the right size
       * and the right date, and only looking at the PNG caught it.
       *
       * Ordering it before those two was not enough: a *session* survives the
       * reload as well, and on a phone one pane fills the screen (§12), so the
       * shot came back as a transcript. So it says which view it wants.
       *
       * `back-to-list` and not `show-main`, which was the first attempt and is
       * the opposite control: `show-main` gives the pane to the *session*, which
       * is where this already was. `phone.spec.ts` drives the right one, and
       * reading it beat guessing from a testid that sounded plausible.
       */
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(web.url);
      await page.waitForTimeout(1500);
      const back = page.locator('[data-testid=back-to-list]');
      if (await back.isVisible()) {
        await back.click();
        await page.waitForTimeout(600);
      }
      await page.screenshot({ path: `${OUT}/03-phone.png` });

      /*
       * What a project declares, which is three features and one picture.
       *
       * The new-session form is where a workflow, a skill and an MCP server all
       * arrive, because all three are files in `templates/` and the form lists
       * what the folder holds. A reader who has only been *told* that sees a
       * sentence; here they see a list that came from a directory, with the MCP
       * server asking for the one value it needs by name and the key nowhere in
       * it (§13).
       *
       * Taller than the session shot, because this form is the tallest thing in
       * the app when everything a project can declare is in one workspace.
       */
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(web.url);
      await page.waitForSelector('[data-testid=host]', { timeout: 30_000 });
      await page.locator('[data-testid=new-session]').first().click();
      await page.waitForSelector('[data-testid=new-servers]', { timeout: 20_000 });
      // Opened, because a folded `details` photographs as a word.
      await page.locator('[data-testid=new-server-catalogue] summary').click();
      // Ticked, so the row shows the question it asks rather than only the offer.
      await page.locator('[data-testid=new-server][data-id=search] [data-testid=new-server-pick]').check();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/04-declared.png` });

      /*
       * The workflow, drawn.
       *
       * §4.4's argument is that a decomposition written down is reviewable in a
       * diff and a picture at the same time, and the join — two parts meeting at
       * one — is the thing a session tree cannot express. That is why the
       * fixture has one, and why this is a picture rather than a paragraph.
       */
      await page.locator('[data-testid=open-workflows]').first().click();
      await page.waitForSelector('[data-testid=workflow-row]', { timeout: 20_000 });
      /*
       * Shorter than the form above, for the reason the dashboard is shorter
       * than a session: one document and a four-node graph end around 520px, and
       * the 900 this was first taken at left the bottom two thirds black — which
       * is the exact criticism this file's own header makes of the first set.
       */
      await page.setViewportSize({ width: 1440, height: 600 });
      await page.locator('[data-testid=workflow-shape] summary').first().click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${OUT}/05-workflow.png` });
    } finally {
      await web.stop();
    }
  });
});
