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

import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    const home = await mkdtemp(join(tmpdir(), 'agbrte-shots-home-'));
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
      repo: join(await mkdtemp(join(tmpdir(), 'agbrte-shots-')), 'probe'),
    });

    try {
      await fillRepo(web.repo);

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

      // The phone shape, which §12 and the CSS both take seriously.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(web.url);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${OUT}/03-phone.png` });
    } finally {
      await web.stop();
    }
  });
});
