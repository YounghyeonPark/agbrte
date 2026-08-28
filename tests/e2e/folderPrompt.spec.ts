/**
 * The question `agbrte` asks when the folder it was given is not a workspace.
 *
 * ## Why this needs a real terminal
 *
 * The whole behaviour is conditional on `process.stdin.isTTY`, because a prompt
 * in a script or a CI job is a hang and a hang is worse than the refusal it
 * replaced. A test that spawns the CLI with piped stdio therefore exercises the
 * *other* branch by construction — it can prove the refusal and can never prove
 * the question. Only a pty makes stdin a terminal, which is the one condition
 * under test, and a pty is the reason this suite exists at all.
 *
 * ## The path this rescues
 *
 * The connect screen offers `npx agbrte web .` as the first thing on it, so the
 * folder is whatever the terminal opened in — and on Windows the elevated
 * PowerShell shortcut opens in `C:\WINDOWS\system32`. Somebody pasted the line
 * there and got an errno. Refusing was the first fix and was still a dead end:
 * they are already in a terminal, already running the program, and the only
 * missing fact is a path. So it asks.
 */

import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * A directory the rule refuses, per platform.
 *
 * Named rather than computed, because the point of the test is the folder people
 * actually land in. On Windows that is the system directory; elsewhere `/usr` is
 * the nearest thing nobody keeps a project in.
 */
const REFUSED = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr';

/**
 * Drives the CLI under a pty from a folder it must refuse, answers the question,
 * and reports what the terminal showed.
 *
 * Shared by both refusals because the *question* is the behaviour under test and
 * it must not depend on which rule declined the folder — a difference there is
 * exactly the bug this file grew to cover, where a system directory got a clean
 * sentence and a prompt while `$HOME` got a wrapped prefix and no way forward.
 */
async function askedFrom(
  cwd: string,
  env: Record<string, string>,
  port: string,
): Promise<{ out: string; asked: boolean; answer: string }> {
  const require = createRequire(import.meta.url);
  // Loaded the way `shell.ts` loads it — through `createRequire`, because it
  // carries a `.node` binary and a static import would make this file's whole
  // module graph depend on it being present.
  const pty = require('@lydell/node-pty') as {
    spawn: (
      file: string,
      args: string[],
      opts: Record<string, unknown>,
    ) => {
      onData: (cb: (d: string) => void) => void;
      write: (s: string) => void;
      kill: () => void;
    };
  };

  const answer = join(await mkdtemp(join(tmpdir(), 'agbrte-prompt-')), 'my-project');

  const term = pty.spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', '.', '--port', port, '--token', 'prompt'],
    {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      // The folder somebody's terminal opened in, not one they chose.
      cwd,
      env: { ...process.env, ...env, AGBRTE_HOST_LINGER_MS: '3000' },
    },
  );

  let out = '';
  let asked = false;
  term.onData((d) => {
    out += d;
    // Answered on sight rather than after a fixed wait: the prompt is the
    // signal, and a sleep long enough to be safe here is a slow test everywhere.
    if (!asked && /Folder to work in \[/u.test(out)) {
      asked = true;
      setTimeout(() => term.write(`${answer}`), 200);
    }
  });

  try {
    await expect
      .poll(() => out, { timeout: 90_000, message: 'the CLI never served a link' })
      .toContain(port);
    return { out, asked, answer };
  } finally {
    term.kill();
  }
}

test('asks for a folder when the one it was given belongs to the system', async () => {
  test.setTimeout(120_000);
  const home = await mkdtemp(join(tmpdir(), 'agbrte-prompt-home-'));
  const { out, asked, answer } = await askedFrom(REFUSED, { AGBRTE_HOME: home }, '7923');

  // It said why before it asked. A prompt with no reason above it is a question
  // somebody cannot answer well.
  expect(out).toContain('belongs to the operating system');
  expect(asked).toBe(true);
  // And it is working in what was typed, not in what it was given.
  expect(out).toContain(answer);
  expect(out).not.toContain(`agbrte web  ${REFUSED}`);
});

/**
 * The other refusal, which for a while was treated worse than this one.
 *
 * `$HOME` is declined by `assertNotInstallRoot`, because `~/.agbrte` is the
 * machine's install area: a workspace rooted there writes its host record over
 * the machine's own, and that record carries the bearer token which is the whole
 * of the control channel's authentication (§6.2). The CLI's pre-check originally
 * ran only the system-directory rule, so this case still arrived wrapped in
 * `no session host for …` with no question — and home is far likelier than a
 * system directory to be what somebody tries.
 *
 * Reproduced by pointing `AGBRTE_HOME` at the candidate's own `.agbrte` rather
 * than by using the real `$HOME`. It is the same collision — the rule is about
 * the two directories being one, not about the path being a home — and it keeps
 * this test out of the developer's actual installation.
 */
test('asks for a folder when the one it was given is the install directory', async () => {
  test.setTimeout(120_000);
  const collides = await mkdtemp(join(tmpdir(), 'agbrte-installroot-'));
  const { out, asked, answer } = await askedFrom(
    collides,
    { AGBRTE_HOME: join(collides, '.agbrte') },
    '7924',
  );

  expect(out).toContain("this machine's Agbrte install directory");
  // The prefix that made this case unreadable, asserted absent by name.
  expect(out).not.toContain('no session host for');
  expect(asked).toBe(true);
  expect(out).toContain(answer);
});
