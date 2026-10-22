/**
 * Shells taught to mark their commands (`src/main/terminal/integration.ts`), run
 * for real.
 *
 * `marks.test.ts` pins how a stream of marks is read. This is the other half and
 * the one that can only be checked by running the shells: that the scripts make
 * each shell actually *say* where its commands are, with the right status and the
 * exact line — and that the shell stays one shell, so `cd` on one line is still
 * in force on the next. A block-per-command terminal that lost the working
 * directory between blocks would be worse than the terminal it replaced.
 *
 * Every shell found on this machine is run; one that is not here is skipped by
 * name, so a run that tested nothing says so rather than passing.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlockStream, plainText, type Block } from '../src/shared/terminal/marks.js';
import {
  BASH_SCRIPT,
  cmdPrompt,
  integrate,
  shellKind,
} from '../src/main/terminal/integration.js';
import { findExecutable, terminalEnv } from '../src/main/terminal/programs.js';

const made: string[] = [];
afterAll(() => {
  /*
   * Best effort. Windows will not remove a directory a process is standing in,
   * and a shell killed a moment ago can still be — CI failed a run whose every
   * assertion had passed with `EBUSY` here. `Session.close` waits for the exit;
   * this is what is left if that wait ran out.
   */
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    } catch {
      // A temp directory, left for the OS.
    }
  }
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agbrte-integration-'));
  made.push(dir);
  return dir;
}

describe('which shells are taught', () => {
  it('knows a shell by its file name, on either platform', () => {
    expect(shellKind('/bin/bash')).toBe('bash');
    expect(shellKind('/usr/local/bin/zsh')).toBe('zsh');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('powershell');
    expect(shellKind('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe('powershell');
    expect(shellKind('C:\\WINDOWS\\system32\\cmd.exe')).toBe('cmd');
    expect(shellKind('/bin/sh')).toBeNull();
    expect(shellKind('/usr/bin/fish')).toBeNull();
  });

  it('leaves alone a shell it does not know, one given arguments, and one turned off', () => {
    const dir = scratch();
    expect(integrate({ file: '/bin/sh', args: [] }, { env: {}, dir }).shell).toBeNull();
    // Arguments are somebody's decision about how this starts — the Windows
    // relay through `cmd.exe /c` is one — and ours could contradict it.
    expect(integrate({ file: '/bin/bash', args: ['-l'] }, { env: {}, dir }).args).toEqual(['-l']);
    expect(integrate({ file: 'C:\\x\\cmd.exe', args: '/d /s /c "y"' }, { env: {}, dir }).shell).toBeNull();
    const off = integrate({ file: '/bin/bash', args: [] }, { env: { AGBRTE_SHELL_INTEGRATION: '0' }, dir });
    expect(off).toMatchObject({ args: [], shell: null, level: 'none' });
    // And none of those wrote anything.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('writes the bash script once, privately, named by what is in it', () => {
    const dir = scratch();
    const first = integrate({ file: '/bin/bash', args: [] }, { env: {}, dir });
    const second = integrate({ file: '/bin/bash', args: [] }, { env: {}, dir });
    expect(first.args).toEqual(second.args);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(first.args[0]).toBe('--init-file');
    expect(first.level).toBe('full');
    // Never a temp file left behind from the atomic write.
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('keeps the user’s own zsh directory, and hands it back', () => {
    const dir = scratch();
    const mine = integrate({ file: '/bin/zsh', args: [] }, { env: { HOME: '/home/me', ZDOTDIR: '/home/me/.config/zsh' }, dir });
    expect(mine.env['ZDOTDIR']).toMatch(/zsh-[0-9a-f]{12}$/u);
    expect(mine.env['AGBRTE_USER_ZDOTDIR']).toBe('/home/me/.config/zsh');
    const plain = integrate({ file: '/bin/zsh', args: [] }, { env: { HOME: '/home/me' }, dir });
    expect(plain.env['AGBRTE_USER_ZDOTDIR']).toBe('/home/me');
    for (const name of ['.zshenv', '.zprofile', '.zshrc']) {
      expect(existsSync(join(String(mine.env['ZDOTDIR']), name))).toBe(true);
    }
  });

  it('wraps cmd’s own prompt rather than replacing it', () => {
    expect(cmdPrompt(undefined)).toBe('$e]133;D$e\\$e]133;A$e\\$P$G$e]133;B$e\\');
    expect(cmdPrompt('[$T] $P$G')).toContain('[$T] $P$G');
  });

  it('does not put a template literal’s interpolation into a shell script', () => {
    // `§{` stands in for `${` in the source; one left behind is a syntax error
    // bash reports on every prompt.
    expect(BASH_SCRIPT).not.toContain('§{');
    expect(BASH_SCRIPT).toContain('${PROMPT_COMMAND:+;$PROMPT_COMMAND}');
  });
});

/* --------------------------------------------------------------------------- */

type Spawn = typeof import('@lydell/node-pty').spawn;
let spawnPty: Spawn | null = null;
try {
  spawnPty = (createRequire(import.meta.url)('@lydell/node-pty') as typeof import('@lydell/node-pty')).spawn;
} catch {
  spawnPty = null;
}

/** A shell running in a real pty, read through the same `BlockStream` the pane uses. */
class Session {
  readonly blocks: Block[] = [];
  readonly stream = new BlockStream();
  raw = '';
  private readonly term: ReturnType<Spawn>;

  constructor(file: string, args: string[] | string, opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    this.term = spawnPty!(file, args, { name: 'xterm-256color', cols: 120, rows: 30, cwd: opts.cwd, env: opts.env });
    this.term.onData((data) => {
      this.raw += data;
      // A cursor-position query is answered, as a terminal would: PSReadLine
      // asks one on start and waits for the reply.
      if (data.includes('\u001b[6n')) this.term.write('\u001b[1;1R');
      this.blocks.push(...this.stream.push(data));
    });
  }

  async until(what: string, ok: () => boolean, ms = 20_000): Promise<void> {
    const start = Date.now();
    while (!ok()) {
      if (Date.now() - start > ms) {
        throw new Error(`timed out waiting for ${what}; the shell said:\n${JSON.stringify(this.raw.slice(-2000))}`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Type one line and wait for the block it makes. */
  async run(line: string): Promise<Block> {
    const before = this.blocks.length;
    this.term.write(`${line}\r`);
    await this.until(`the block for ${JSON.stringify(line)}`, () => this.blocks.length > before);
    return this.blocks[before]!;
  }

  /** The prompt is drawn and waiting for keys. */
  async ready(): Promise<void> {
    await this.until('the first prompt', () => /\u001b\]133;B(\u0007|\u001b\\)/u.test(this.raw));
  }

  /** Kill it, and wait until it has gone, so its working directory is free. */
  async close(): Promise<void> {
    const exited = new Promise<void>((done) => {
      this.term.onExit(() => done());
      setTimeout(done, 5_000);
    });
    try {
      this.term.kill();
    } catch {
      return;
    }
    await exited;
  }
}

/** Git for Windows' bash, never `System32\bash.exe`, which is WSL and another machine. */
function findBash(): string | null {
  if (process.platform !== 'win32') return findExecutable('bash', process.env);
  for (const base of [process.env['ProgramFiles'], process.env['ProgramW6432']]) {
    if (base === undefined) continue;
    const file = join(base, 'Git', 'bin', 'bash.exe');
    if (existsSync(file)) return file;
  }
  return null;
}

function workspace(): { root: string; sub: string } {
  const root = scratch();
  const sub = join(root, 'sub dir');
  mkdirSync(sub);
  return { root, sub };
}

const bash = spawnPty === null ? null : findBash();
/**
 * Whether this bash has `PS0`, which is what reports the exact line (4.4 and
 * later). macOS still ships 3.2 as `/bin/bash`, and CI runs there: a 3.2 bash
 * gets prompts and status but no output mark, so its line is read off the echo.
 */
const bashHasPs0 = ((): boolean => {
  if (bash === null) return false;
  try {
    const [major, minor] = execFileSync(bash, ['-c', 'echo "${BASH_VERSINFO[0]} ${BASH_VERSINFO[1]}"'], {
      encoding: 'utf8',
    })
      .trim()
      .split(' ')
      .map(Number);
    return (major ?? 0) > 4 || ((major ?? 0) === 4 && (minor ?? 0) >= 4);
  } catch {
    return false;
  }
})();
const powershell =
  spawnPty === null
    ? null
    : (findExecutable('pwsh', process.env) ??
      (process.platform === 'win32' ? findExecutable('powershell', process.env) : null));
const cmd = spawnPty === null || process.platform !== 'win32' ? null : findExecutable('cmd', process.env);
const zsh = spawnPty === null ? null : findExecutable('zsh', process.env);

describe.skipIf(bash === null)(`bash, for real (${bash ?? 'not on this machine'})`, () => {
  it('marks every command with its exact line and status, in one shell', async () => {
    const { root } = workspace();
    const home = scratch();
    // The user's own startup must still run, first — and their PROMPT_COMMAND
    // must survive ours.
    writeFileSync(
      join(home, '.bashrc'),
      'FROM_BASHRC=yes\nPROMPT_COMMAND=\'USER_HOOK=$((USER_HOOK+1))\'\nHISTCONTROL=ignorespace\nPS1="mine> "\n',
    );
    const taught = integrate({ file: bash!, args: [] }, { env: {}, dir: scratch() });
    const s = new Session(taught.file, taught.args, {
      cwd: root,
      env: { ...terminalEnv(), ...taught.env, HOME: home },
    });
    try {
      await s.ready();
      expect(s.raw).toContain('mine> ');

      const from = bashHasPs0 ? 'exact' : 'echo';
      expect(await s.run('cd "sub dir"')).toMatchObject({ command: 'cd "sub dir"', commandFrom: from, exitCode: 0 });
      const pwd = await s.run('pwd');
      // The shell is one shell: the `cd` above is still in force.
      expect(plainText(pwd.output)).toMatch(/sub dir$/u);
      expect(await s.run('false')).toMatchObject({ command: 'false', exitCode: 1 });
      expect(await s.run('(exit 42)')).toMatchObject({ exitCode: 42 });
      // A `;` inside the line survives the escaping it travels in.
      expect(await s.run('echo "a;b" \\\\x')).toMatchObject({ command: 'echo "a;b" \\\\x', commandFrom: from });
      expect(plainText((await s.run('echo $FROM_BASHRC')).output)).toBe('yes');
      expect(Number(plainText((await s.run('echo $USER_HOOK')).output))).toBeGreaterThan(1);
      /*
       * A line history did not record (`ignorespace`) has no exact line to
       * report. What must not happen is reporting the *previous* command in its
       * place, which reading `history 1` without checking would do.
       */
      const hidden = await s.run(' echo hidden');
      expect(hidden).toMatchObject({ command: 'echo hidden', commandFrom: 'echo' });
      expect(plainText(hidden.output)).toBe('hidden');
      expect(s.stream.level).toBe(bashHasPs0 ? 'full' : 'prompt');
    } finally {
      await s.close();
    }
  }, 60_000);
});

describe.skipIf(powershell === null)(`PowerShell, for real (${powershell ?? 'not on this machine'})`, () => {
  it('marks every command with its exact line and status, in one shell', async () => {
    const { root } = workspace();
    const taught = integrate({ file: powershell!, args: [] }, { env: {}, dir: scratch() });
    expect(taught.args).toContain('-EncodedCommand');
    const s = new Session(taught.file, taught.args, { cwd: root, env: { ...terminalEnv(), ...taught.env } });
    try {
      await s.ready();
      expect(await s.run("Set-Location 'sub dir'")).toMatchObject({
        command: "Set-Location 'sub dir'",
        commandFrom: 'exact',
        exitCode: 0,
      });
      expect(plainText((await s.run('(Get-Location).Path')).output).trim()).toMatch(/sub dir$/u);
      // A native program's status, which PowerShell keeps in LASTEXITCODE —
      // through whichever native shell this platform has.
      const native = process.platform === 'win32' ? 'cmd /c exit 3' : "sh -c 'exit 3'";
      expect(await s.run(native)).toMatchObject({ exitCode: 3 });
      // A failed cmdlet has no number of its own; failure is still failure.
      expect((await s.run('Get-Item nowhere-at-all')).exitCode).not.toBe(0);
      const both = await s.run("Write-Output 'a;b'");
      expect(both).toMatchObject({ command: "Write-Output 'a;b'", exitCode: 0 });
      // pwsh on Linux and macOS follows output with blank lines.
      expect(plainText(both.output).trim()).toBe('a;b');
    } finally {
      await s.close();
    }
  }, 90_000);
});

describe.skipIf(cmd === null)(`cmd.exe, for real (${cmd ?? 'not on this machine'})`, () => {
  it('finds the blocks from its prompt, and says it cannot know the status', async () => {
    const { root } = workspace();
    const taught = integrate({ file: cmd!, args: [] }, { env: {}, dir: scratch() });
    expect(taught.level).toBe('prompt');
    const s = new Session(taught.file, taught.args, { cwd: root, env: { ...terminalEnv(), ...taught.env } });
    try {
      await s.ready();
      expect(await s.run('cd "sub dir"')).toMatchObject({ command: 'cd "sub dir"', commandFrom: 'echo', exitCode: null });
      // ConPTY repaints as it goes, so the output carries cursor moves around the
      // text; what a person reads is the text.
      expect(plainText((await s.run('cd')).output).trim()).toMatch(/sub dir$/u);
      expect(plainText((await s.run('echo one')).output).trim()).toBe('one');
      expect(s.stream.level).toBe('prompt');
    } finally {
      await s.close();
    }
  }, 60_000);
});

describe.skipIf(zsh === null)(`zsh, for real (${zsh ?? 'not on this machine'})`, () => {
  it('marks every command with its exact line and status, in one shell', async () => {
    const { root } = workspace();
    const home = scratch();
    writeFileSync(join(home, '.zshrc'), 'FROM_ZSHRC=yes\nPS1="mine> "\n');
    const taught = integrate({ file: zsh!, args: [] }, { env: { HOME: home }, dir: scratch() });
    const s = new Session(taught.file, taught.args, { cwd: root, env: { ...terminalEnv(), ...taught.env, HOME: home } });
    try {
      await s.ready();
      expect(await s.run('cd "sub dir"')).toMatchObject({ command: 'cd "sub dir"', commandFrom: 'exact', exitCode: 0 });
      /*
       * Read as a person reads it. zsh follows every output with its end-of-line
       * mark — a `%`, a line of spaces, and a carriage return that rubs them out
       * — and the raw block carries all of it.
       */
      expect(plainText((await s.run('pwd')).output).trim()).toMatch(/sub dir$/u);
      expect(await s.run('false')).toMatchObject({ exitCode: 1 });
      expect(plainText((await s.run('echo $FROM_ZSHRC')).output).trim()).toBe('yes');
    } finally {
      await s.close();
    }
  }, 60_000);
});
