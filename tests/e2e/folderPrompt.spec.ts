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

test('asks for a folder when the one it was given belongs to the system', async () => {
  test.setTimeout(120_000);

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

  const home = await mkdtemp(join(tmpdir(), 'agbrte-prompt-home-'));
  const answer = join(await mkdtemp(join(tmpdir(), 'agbrte-prompt-')), 'my-project');

  const term = pty.spawn(
    process.execPath,
    [resolve('dist/cli/agbrte.js'), 'web', '.', '--port', '7923', '--token', 'prompt'],
    {
      name: 'xterm-color',
      cols: 100,
      rows: 30,
      // The folder somebody's terminal opened in, not one they chose.
      cwd: REFUSED,
      env: { ...process.env, AGBRTE_HOME: home, AGBRTE_HOST_LINGER_MS: '3000' },
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
      setTimeout(() => term.write(`${answer}\r`), 200);
    }
  });

  try {
    await expect
      .poll(() => out, { timeout: 90_000, message: 'the CLI never served a link' })
      .toContain('7923');

    // It said why before it asked. A prompt with no reason above it is a
    // question somebody cannot answer well.
    expect(out).toContain('belongs to the operating system');
    expect(asked).toBe(true);
    // And it is working in what was typed, not in what it was given.
    expect(out).toContain(answer);
    expect(out).not.toContain(`agbrte web  ${REFUSED}`);
  } finally {
    term.kill();
  }
});
