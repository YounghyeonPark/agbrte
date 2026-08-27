/**
 * Records a real session log into the file the published client replays (§7).
 *
 * ## Why a recording exists at all
 *
 * The published copy of the app at `/app/` opens on a screen asking where your
 * host is. For somebody who has one that is two fields and a paste. For everyone
 * else — which is nearly everybody arriving from a link — it is a locked door
 * with no handle, and the measured behaviour of a locked door is that people
 * leave. A landing page can describe a transcript; only the program can show
 * one, and the program will not start without a machine to run on.
 *
 * So the client learns to run against a *recording*: the real renderer, the real
 * dashboard, the real transcript, answering from a file instead of a socket.
 * Nothing is running, nothing is reachable, and no permission is asked — which
 * is precisely what makes it safe to hand a stranger.
 *
 * ## Recorded at the socket, not written by hand
 *
 * The temptation is to author `recording.json` as a fixture. That produces a
 * demo of a program that does not exist: the shapes drift from the contract the
 * moment anybody adds a field, and the drift is invisible because nothing type
 * checks a JSON blob against `AgbrteApi`.
 *
 * This instead patches `WebSocket` ahead of the page's own scripts and tees
 * every frame. What lands in the file is literally what a host answered a real
 * renderer, including channels nobody thought to enumerate — the boot sequence
 * records itself. When the contract changes, re-running this produces a
 * recording of the new one; a hand-written fixture would have needed somebody to
 * notice.
 *
 * ## Kept out of the default run
 *
 * `@recording`, like `@shots`, because it writes a file into the repository and
 * a suite that edits tracked files on every `npm test` is a suite people learn
 * to distrust. It also wants a real model — the whole point is a transcript
 * worth reading, and the echo runtime produces a transcript that reads like a
 * test fixture, because it is one.
 *
 *   npx playwright test recording --grep @recording
 */

import { test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { modelAvailable, serveWebFixture, warmModel } from './harness.js';

/** Where the published site picks it up: `docs/` is copied to the site root. */
const OUT = resolve('docs/app/recording.json');
const MODEL = 'qwen2.5:7b';

/**
 * Fewer sessions than the screenshots, and every one of them load-bearing.
 *
 * The dashboard picture wants sixteen cards because a grid with four is not a
 * grid. A recording wants the opposite: each session here is one a stranger may
 * open and read to the end, so each has to be worth reading to the end, and each
 * costs a real turn against a real model to produce. Six is where the grid still
 * looks like a queue and the file still fits in a page load.
 */
const WORK = [
  {
    title: 'why does parseProbe return an empty Map?',
    prompt:
      'Read src/probe.js and explain in a short paragraph when parseProbe returns an empty Map.',
  },
  {
    title: 'the parser silently drops a duplicated key',
    prompt:
      'Read src/probe.js. In a short paragraph: what happens when the same key appears twice, and is that the right call?',
  },
  {
    title: 'decide what a value containing an equals sign should do',
    prompt:
      'Read src/probe.js. In a short paragraph: what happens to a line like a=b=c, and is that right?',
  },
  {
    title: 'work out whether the host record can be trusted after a reboot',
    prompt:
      'In a short paragraph: why is a file naming a process weaker evidence than a socket answering?',
  },
  {
    title: 'document what the probe promises about ordering',
    prompt:
      'Read src/probe.js. In a short paragraph: does a Map preserve insertion order, and does that matter here?',
  },
  {
    title: 'add a test for a line with no equals sign',
    prompt:
      'Read src/probe.js. In a short paragraph, say what a test for a line with no "=" should assert.',
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

/**
 * Tees every frame on every socket the page opens, before the page opens any.
 *
 * `addInitScript` is what makes this possible: it runs ahead of the document's
 * own scripts, and the shim is injected into `<head>` precisely so it is early.
 * Subclassing rather than replacing keeps `instanceof`, the constants and the
 * event plumbing intact — the bridge reads `WebSocket.OPEN` and would otherwise
 * be talking to something that is not a WebSocket.
 */
const TEE = `
  window.__frames = [];
  const Real = WebSocket;
  class Teed extends Real {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', (e) => {
        window.__frames.push({ dir: 'in', data: String(e.data) });
      });
    }
    send(frame) {
      window.__frames.push({ dir: 'out', data: String(frame) });
      return super.send(frame);
    }
  }
  Teed.OPEN = Real.OPEN;
  Teed.CLOSED = Real.CLOSED;
  Teed.CONNECTING = Real.CONNECTING;
  Teed.CLOSING = Real.CLOSING;
  window.WebSocket = Teed;
`;

type Frame = { dir: 'in' | 'out'; data: string };

test.describe('@recording', () => {
  test('records a real session log for the published client', async ({ page }) => {
    test.setTimeout(900_000);

    const live = await modelAvailable(MODEL);
    const home = await mkdtemp(join(tmpdir(), 'agbrte-rec-home-'));
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
    /*
     * The echo runtime is not a lesser recording, it is a different artifact:
     * a transcript that says `echo` to a stranger who was promised a coding
     * agent. Refused by name rather than written out, because the failure of the
     * quiet version is a published demo nobody notices is fake.
     */
    if (!live) {
      throw new Error(
        `no ${MODEL} on this machine. This recording is published to strangers, so it is not ` +
          `taken with the echo runtime — start Ollama and pull the model first.`,
      );
    }

    const web = await serveWebFixture({
      home,
      repo: join(await mkdtemp(join(tmpdir(), 'agbrte-rec-')), 'probe'),
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
            // A denied read would be recorded as a denied read, and the
            // transcript people are shown would be one of the agent being told
            // no. The repository is a throwaway temp folder.
            '--yes',
            '--endpoint',
            'local',
            '--model',
            MODEL,
            prompt,
          ],
          { stdio: 'ignore', env: { ...process.env, AGBRTE_HOME: home } },
        );
      }

      await page.addInitScript(TEE);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(web.url);
      await page.waitForSelector('[data-testid=dashboard]', { timeout: 30_000 });
      await page.waitForTimeout(1200);

      /*
       * Every session opened, not just the first.
       *
       * `sessions.snapshot` is per id and the renderer only asks for the one it
       * is showing, so a recording taken from the dashboard alone replays into a
       * demo where every card opens onto nothing. The recorder has to walk the
       * app the way the visitor will.
       *
       * Through the sidebar switcher rather than back to the dashboard each
       * time. Two earlier versions went back — `goBack`, then a reload — and
       * both sat in a thirty-second timeout waiting for a dashboard that never
       * returned: once a session is open the app is showing the switcher, and
       * every session is already in it. Which is also the cheaper walk, and the
       * one a person actually takes.
       */
      await page.locator('[data-testid=session-card]').first().click();
      await page.waitForSelector('[data-testid=composer-input]', { timeout: 30_000 });
      await page.waitForTimeout(1500);

      for (const { title } of WORK) {
        const entry = page.locator(`[data-testid=session][data-title="${title}"]`);
        if ((await entry.count()) === 0) continue;
        await entry.first().click();
        await page.waitForTimeout(1500);
      }

      // `globalThis`, not `window`: this file is typechecked by the node project,
      // which has no DOM lib. The callback runs in the browser either way.
      const frames = (await page.evaluate(
        () => (globalThis as unknown as { __frames: Frame[] }).__frames,
      )) as Frame[];

      /*
       * Requests paired to replies by id, which is the only way round: a reply
       * carries an id and no channel, so a bare list of inbound frames cannot
       * say what any of them answered.
       */
      const asked = new Map<number, { channel: string; args: unknown[] }>();
      const calls: { channel: string; args: unknown[]; value: unknown }[] = [];
      const seen = new Set<string>();
      for (const frame of frames) {
        const message = JSON.parse(frame.data) as {
          id?: number;
          channel?: string;
          args?: unknown[];
          value?: unknown;
          error?: string;
        };
        if (frame.dir === 'out') {
          if (message.id !== undefined && message.channel !== undefined) {
            asked.set(message.id, { channel: message.channel, args: message.args ?? [] });
          }
          continue;
        }
        if (message.id === undefined || message.error !== undefined) continue;
        const question = asked.get(message.id);
        if (question === undefined) continue;
        // The renderer polls: `sessions.list` is asked for over and over with
        // the same arguments and the same answer. Last one wins and the rest are
        // dropped, or the file is mostly duplicates of its own boot.
        const key = `${question.channel} ${JSON.stringify(question.args)}`;
        if (seen.has(key)) {
          const at = calls.findIndex(
            (c) => `${c.channel} ${JSON.stringify(c.args)}` === key,
          );
          calls[at] = { ...question, value: message.value };
          continue;
        }
        seen.add(key);
        calls.push({ ...question, value: message.value });
      }

      /*
       * The machine this was taken on, removed before the file leaves it.
       *
       * Not a credential and still not publishable: a real log names the person
       * who ran it and the box they ran it on, in the actor label on every
       * event, in the workspace path, and in the temp directory the fixture
       * lived in. Thirty-seven copies of a username and thirty-six of a hostname
       * is what the first recording carried, and it was headed for a public
       * page. Nobody would have written that fixture by hand; it arrives because
       * the recording is *real*, which is the same property that makes it worth
       * publishing.
       *
       * Substituted rather than stripped, because the fields have to stay the
       * shape the renderer expects — an actor with no label draws an empty
       * byline. `you` and `your-machine` also read correctly to a visitor, who
       * is being shown what their own session would look like.
       *
       * Walked over the parsed values rather than run across the serialized
       * text: a Windows path is escaped inside a JSON string, so a replacement
       * at the text level has to reason about backslashes, and the version that
       * gets that subtly wrong produces a file that no longer parses.
       */
      const { userInfo, hostname } = await import('node:os');
      const { sep } = await import('node:path');
      const bothSeparators = (p: string): string[] => [p, p.split(sep).join('/')];
      const swaps: [string, string][] = [
        // Longest first: the paths contain the username, so replacing the
        // username first would leave a path this no longer recognises.
        ...bothSeparators(web.repo).map((p): [string, string] => [p, '/home/you/probe']),
        ...bothSeparators(home).map((p): [string, string] => [p, '/home/you/.agbrte']),
        [userInfo().username, 'you'],
        [hostname(), 'your-machine'],
      ];
      const scrub = (value: unknown): unknown => {
        if (typeof value === 'string') {
          let text = value;
          for (const [from, to] of swaps) if (from !== '') text = text.split(from).join(to);
          return text;
        }
        if (Array.isArray(value)) return value.map(scrub);
        if (value !== null && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrub(v)]),
          );
        }
        return value;
      };

      const serialized = JSON.stringify(scrub({ model: MODEL, calls }));

      /*
       * Read once for secrets before it is written, because this file is
       * published to strangers (§13).
       *
       * Every other place the credential rule is enforced has a person or a
       * process on the other end who is already trusted with something. This one
       * has the open internet, and it is assembled by copying whatever a host
       * said onto a static site. The pairing loop already drops the handshake —
       * an `auth` frame carries no `id` and no `channel`, so it never becomes a
       * call — and this is the check that the drop actually happened, plus the
       * one that catches a *future* channel that starts answering with a value
       * it should not.
       *
       * Cheap, blunt, and deliberately not clever: a literal search for the
       * fixture's own token, and a shape match for the two key formats the
       * providers use. A false positive here costs a re-run. A false negative
       * costs a published key.
       *
       * The scrub above is checked here rather than trusted, and that is the
       * point of doing it in two steps: a substitution that silently missed a
       * spelling — a path that came back with the other separator, a username
       * that appeared inside a longer word — looks exactly like one that worked.
       */
      const token = web.url.split('#t=')[1] ?? '';
      const leaks: string[] = [];
      if (token !== '' && serialized.includes(token)) leaks.push('the session token');
      if (serialized.includes(userInfo().username)) leaks.push('the username that took it');
      if (serialized.includes(hostname())) leaks.push('the machine name that took it');
      for (const [name, shape] of [
        ['an Anthropic key', /sk-ant-[A-Za-z0-9_-]{8,}/u],
        ['an OpenAI-style key', /(?<![A-Za-z0-9])sk-[A-Za-z0-9]{20,}/u],
        ['a bearer header', /[Bb]earer\s+[A-Za-z0-9._-]{16,}/u],
      ] as const) {
        if (shape.test(serialized)) leaks.push(name);
      }
      if (leaks.length > 0) {
        throw new Error(
          `refusing to write a recording that contains ${leaks.join(' and ')}. ` +
            `This file is published; find what answered with it before taking another.`,
        );
      }

      await mkdir(resolve('docs/app'), { recursive: true });
      await writeFile(OUT, serialized, 'utf8');
      const size = serialized.length;
      process.stdout.write(
        `\n  recorded ${calls.length} answers across ` +
          `${new Set(calls.map((c) => c.channel)).size} channels — ${Math.round(size / 1024)} KB\n\n`,
      );
    } finally {
      await web.stop();
    }
  });
});
