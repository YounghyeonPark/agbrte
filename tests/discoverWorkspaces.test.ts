/**
 * Looking around a machine before anything of ours is on it (DESIGN.md §6.2).
 *
 * Attaching a remote used to require typing an absolute path from memory. This
 * covers the half that replaces it: what is sent, what comes back, and what each
 * kind of non-answer means.
 *
 * **The live path is not measured here, and this is the note saying so.** The
 * machine this was written on has no `sshd` — `ssh localhost` is refused — so
 * everything below drives an injected `SshRunner`, which is the seam
 * `sshTransport` already exposes for exactly this. What that cannot show is
 * whether a real `find` on a real remote is fast enough and deep enough; what it
 * can show is that the command is built and quoted correctly, that a truncated
 * or timed-out stream still produces an answer, and that "nothing here" and
 * "cannot be asked" never collapse into each other.
 *
 * One test does better than a fake: `discoveryScript` is executed by a **real
 * POSIX shell** against a temporary home directory with a space in its name.
 * That is the only way to know that `find` accepts the expression, that the
 * prunes prune, and that the depth bound is the one intended — the string
 * assertions above it would all still pass if the expression were nonsense.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { noConsoleWindow } from './support/noConsoleWindow.js';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeAlias,
  discoverRemoteWorkspaces,
  discoveryScript,
  parseDiscovery,
  DISCOVERY_MAX_DEPTH,
} from '@main/host/discoverWorkspaces.js';
import type { SshRunner } from '@main/host/sshTransport.js';

/*
 * A budget that reflects what these tests actually do.
 *
 * Every case in this file spawns a real process — a shell, a browser, the built
 * CLI, a detached host — and the 5-second default is a number nobody chose for
 * that. It is the arrangement that fails worst: green on an idle machine, red on
 * a loaded CI runner, and no signal about which. A test that fails because a
 * machine was busy is not reporting anything about the code; only a genuine hang
 * should reach this.
 */
vi.setConfig({ testTimeout: 30_000 });


/** Records what was asked and answers with canned output. */
function fakeRunner(reply: {
  code?: number;
  stdout?: string;
  stderr?: string;
}): SshRunner & { commands: string[]; aliases: string[]; timeouts: Array<number | undefined> } {
  const commands: string[] = [];
  const aliases: string[] = [];
  const timeouts: Array<number | undefined> = [];
  return {
    commands,
    aliases,
    timeouts,
    exec: async (alias, command, opts) => {
      commands.push(command);
      aliases.push(alias);
      timeouts.push(opts?.timeoutMs);
      return { code: reply.code ?? 0, stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' };
    },
    upload: async () => undefined,
    forward: async () => ({ close: () => undefined }),
  };
}

/** A Windows probe that says "not me", so the POSIX path is the one under test. */
const noWindows = fakeRunner({ code: 255, stderr: 'nope' });

const HOME = '/home/a b';

/** What a well-populated machine streams back. */
const answer = [
  '=roots',
  HOME,
  `${HOME}/src`,
  '=marks',
  `${HOME}/work stuff/.devagents`,
  `${HOME}/work stuff/.git`,
  `${HOME}/src/api/.git`,
  '=dirs',
  `${HOME}/Documents`,
  `${HOME}/work stuff`,
  '',
].join('\n');

describe('the command that is sent', () => {
  it('quotes every root, so a home with a space cannot break it', () => {
    const script = discoveryScript();
    // `"$HOME/src"` and not `$HOME/src`: the far side must expand the variable
    // and must not then split the result on the space in it.
    expect(script).toContain('"$HOME"');
    expect(script).toContain('"$HOME/src"');
    expect(script).toContain(`'/srv'`);
    // Every `for r in …` list is made of quoted tokens and nothing else.
    for (const line of script.split('\n').filter((l) => l.startsWith('for r in '))) {
      const tokens = line.slice('for r in '.length).split(';')[0]!.trim().split(' ');
      for (const token of tokens) {
        expect(token, `unquoted root ${token}`).toMatch(/^(".*"|'.*')$/);
      }
    }
  });

  it('is bounded four ways at once', () => {
    const script = discoveryScript();
    expect(script).toContain(`-maxdepth ${DISCOVERY_MAX_DEPTH}`);
    // The prunes that make it cheap. `.*` is the one that matters most: it takes
    // every hidden directory out in a single rule.
    expect(script).toContain(`-name 'node_modules'`);
    expect(script).toContain(`-name '.*'`);
    expect(script).toMatch(/head -n \d+/);
    expect(script).toContain('timeout');
  });

  it('asks for both workspace names', () => {
    // The marker walk is the only place discovery can see a workspace at all, so
    // dropping the old name here would make a machine full of `.devagents`
    // folders answer "nothing found" (§5.1).
    const script = discoveryScript();
    expect(script).toContain('-name .agbrte');
    expect(script).toContain('-name .devagents');
  });

  it('does not depend on anything the user typed', async () => {
    // The alias is an argv element of `ssh`, never part of the command. Two
    // different machines are asked with a byte-identical script, which is the
    // strongest form of "nothing typed reaches a shell".
    const a = fakeRunner({ stdout: answer });
    const b = fakeRunner({ stdout: answer });
    await discoverRemoteWorkspaces('build-01', { runner: a, windowsRunner: noWindows });
    await discoverRemoteWorkspaces('user@10.0.0.9', { runner: b, windowsRunner: noWindows });
    expect(a.commands[0]).toBe(b.commands[0]);
    expect(a.commands[0]).toBe(discoveryScript());
    expect(a.aliases).toEqual(['build-01']);
  });

  it('carries a timeout, because a slow machine must not be a hang', async () => {
    const runner = fakeRunner({ stdout: answer });
    await discoverRemoteWorkspaces('build-01', { runner, timeoutMs: 4_000 });
    expect(runner.timeouts[0]).toBe(4_000);
  });
});

describe('reading what came back', () => {
  it('keeps a path with a space whole', () => {
    const { candidates } = parseDiscovery(answer);
    expect(candidates.map((c) => c.path)).toContain('/home/a b/work stuff');
  });

  it('ranks a used workspace above a repository above a folder', () => {
    const { candidates } = parseDiscovery(answer);
    expect(candidates).toEqual([
      { path: '/home/a b/work stuff', kind: 'workspace' },
      { path: '/home/a b/src/api', kind: 'git' },
      { path: '/home/a b/Documents', kind: 'folder' },
    ]);
    // `work stuff` was reported three times — as a `.devagents`, as a `.git` and
    // as a plain folder — and appears once, under the strongest claim. A demotion
    // here would hide the only row that is *known* to hold sessions.
    expect(candidates.filter((c) => c.path === '/home/a b/work stuff')).toHaveLength(1);
  });

  it('reads both workspace names, because the old one is read forever', () => {
    const { candidates } = parseDiscovery(
      [
        '=roots',
        HOME,
        '=marks',
        `${HOME}/old one/.devagents`,
        `${HOME}/new one/.agbrte`,
        '=dirs',
        '',
      ].join('\n'),
    );
    expect(candidates.every((c) => c.kind === 'workspace')).toBe(true);
    expect(candidates.map((c) => c.path).sort()).toEqual([
      '/home/a b/new one',
      '/home/a b/old one',
    ]);
  });

  it('reports the roots, so an empty list means something', () => {
    const { roots, candidates } = parseDiscovery(['=roots', '/home/x', '=marks', '=dirs'].join('\n'));
    expect(roots).toEqual(['/home/x']);
    expect(candidates).toEqual([]);
  });

  it('ignores anything that is not one of its own lines', () => {
    // A Windows shell echoes the script back and exits 0. Nothing here should
    // become a candidate out of it.
    const { roots, candidates } = parseDiscovery(
      ["'printf' is not recognized as an internal or external command", 'for r in ...'].join('\n'),
    );
    expect(roots).toEqual([]);
    expect(candidates).toEqual([]);
  });

  it('notices a root whose walk was cut short', () => {
    const { partial } = parseDiscovery(['=roots', '/srv', '=marks', '?/srv'].join('\n'));
    expect(partial).toBe(true);
  });

  it('caps the list and says that it did', () => {
    const lines = ['=roots', '/home/x', '=marks'];
    for (let i = 0; i < 12; i += 1) lines.push(`/home/x/repo${i}/.git`);
    const { candidates, truncated } = parseDiscovery(lines.join('\n'), { cap: 5 });
    expect(candidates).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it('does not claim there are more when the extras were duplicates', () => {
    // The roots overlap, so the same repository arrives twice. Counting before
    // deduplication would put "there are more than these" under a complete list.
    const lines = ['=roots', '/home/x', '/home/x/src', '=marks'];
    for (let i = 0; i < 3; i += 1) {
      lines.push(`/home/x/src/repo${i}/.git`, `/home/x/src/repo${i}/.git`);
    }
    const { candidates, truncated } = parseDiscovery(lines.join('\n'), { cap: 3 });
    expect(candidates).toHaveLength(3);
    expect(truncated).toBe(false);
  });
});

describe('what each kind of non-answer means', () => {
  it('an empty machine is an answer, not a failure', async () => {
    const runner = fakeRunner({ stdout: ['=roots', '/home/nobody', '=marks', '=dirs'].join('\n') });
    const result = await discoverRemoteWorkspaces('empty-box', {
      runner,
      windowsRunner: noWindows,
    });
    expect(result.candidates).toEqual([]);
    // The three fields that let a UI say "nothing under these" rather than
    // showing a blank panel that reads as broken.
    expect(result.roots).toEqual(['/home/nobody']);
    expect(result.unavailable).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('a slow machine gives a short list marked as short', async () => {
    // Killed from this side after streaming two roots and one marker. What
    // arrived is real, so it is kept.
    const runner = fakeRunner({
      code: 124,
      stdout: ['=roots', '/home/x', '=marks', '/home/x/api/.git'].join('\n'),
    });
    const result = await discoverRemoteWorkspaces('slow-box', { runner, windowsRunner: noWindows });
    expect(result.candidates).toEqual([{ path: '/home/x/api', kind: 'git' }]);
    expect(result.partial).toBe(true);
    expect(result.unavailable).toBeUndefined();
  });

  it('a machine that said nothing at all before the timeout says so', async () => {
    const runner = fakeRunner({ code: 124, stdout: '' });
    const result = await discoverRemoteWorkspaces('wedged', {
      runner,
      windowsRunner: noWindows,
      timeoutMs: 9_000,
    });
    expect(result.unavailable).toContain('9s');
    expect(result.partial).toBe(true);
  });

  it('names Windows rather than reporting an empty machine', async () => {
    /*
     * The failure this exists to prevent: a Windows remote hands the script to
     * `cmd.exe`, which prints it back and **exits 0**. Parsed naively that is a
     * machine with no projects on it, stated confidently — which is worse than
     * the missing feature, because the user has no reason to doubt it.
     */
    const runner = fakeRunner({ code: 0, stdout: `'printf' is not recognized` });
    const windows = fakeRunner({
      code: 0,
      stdout: [
        'home=C:\\Users\\dev',
        'arch=AMD64',
        'platform=Windows_NT',
        'node=',
        'bundle=',
      ].join('\n'),
    });
    const result = await discoverRemoteWorkspaces('winbox', { runner, windowsRunner: windows });
    expect(result.unavailable).toContain('Windows');
    // And it points at what still works, because attaching a Windows remote does.
    expect(result.unavailable).toContain('type the workspace path');
    expect(result.candidates).toEqual([]);
  });

  it('a machine that could not be reached rejects with the usual diagnosis', async () => {
    const runner = fakeRunner({ code: 255, stderr: 'Permission denied (publickey).' });
    await expect(
      discoverRemoteWorkspaces('locked', { runner, windowsRunner: noWindows }),
    ).rejects.toThrow(/refused the credentials/i);
  });

  it('a shell that is neither POSIX nor PowerShell says which problem it is', async () => {
    const runner = fakeRunner({ code: 0, stdout: 'welcome to the appliance CLI' });
    const result = await discoverRemoteWorkspaces('appliance', {
      runner,
      windowsRunner: noWindows,
    });
    expect(result.unavailable).toContain('did not run a POSIX script');
  });
});

describe('an alias is the one thing the user types', () => {
  it('refuses a name ssh would read as an option', () => {
    // `ssh -oProxyCommand=… host` runs a command on *this* machine. There is no
    // legitimate destination beginning with a hyphen.
    expect(() => assertSafeAlias('-oProxyCommand=calc')).toThrow(/option, not a destination/);
  });

  it('refuses whitespace, and allows the names people actually have', () => {
    expect(() => assertSafeAlias('two words')).toThrow(/whitespace/);
    expect(() => assertSafeAlias('')).toThrow(/no machine/);
    for (const good of ['build-01', 'user@10.0.0.9', 'jump.example.com']) {
      expect(() => assertSafeAlias(good)).not.toThrow();
    }
  });

  it('is checked before anything is spawned', async () => {
    const runner = fakeRunner({ stdout: answer });
    await expect(
      discoverRemoteWorkspaces('-oProxyCommand=calc', { runner, windowsRunner: noWindows }),
    ).rejects.toThrow();
    expect(runner.commands).toHaveLength(0);
  });
});

/**
 * The script, run by a real shell against a real directory tree.
 *
 * Every assertion above is about a *string*. This is the one that knows whether
 * `find` accepts the expression at all — a misplaced parenthesis in a `-prune`
 * clause is a syntax error at run time and passes every text assertion ever
 * written about it.
 *
 * Skipped loudly, not silently, where there is no POSIX shell: a criterion that
 * quietly stops being checked is worse than one that was never claimed.
 */
const sh = ((): string | null => {
  for (const candidate of ['sh', '/bin/sh']) {
    try {
      const probe = spawnSync(candidate, ['-c', 'printf ok'], {
        encoding: 'utf8',
        ...noConsoleWindow,
      });
      if (probe.status === 0 && probe.stdout.includes('ok')) return candidate;
    } catch {
      // Next candidate.
    }
  }
  return null;
})();

describe.skipIf(sh === null)('the script, under a real shell', () => {
  it('finds what it should and walks past what it should not', async () => {
    // A space in the home directory, because that is the case a quoting mistake
    // breaks and nothing else would notice.
    const home = await mkdtemp(join(tmpdir(), 'agbrte home '));
    // Both workspace names, because §5.1 reads the old one forever: a machine
    // whose sessions predate the rename must still be offered its folders.
    await mkdir(join(home, 'used', '.devagents'), { recursive: true });
    await mkdir(join(home, 'used new', '.agbrte'), { recursive: true });
    await mkdir(join(home, 'plain repo', '.git'), { recursive: true });
    await mkdir(join(home, 'src', 'deep', 'api', '.git'), { recursive: true });
    await mkdir(join(home, 'Documents'), { recursive: true });
    // Expensive and never a workspace: must not be descended into.
    await mkdir(join(home, 'node_modules', 'left-pad', '.git'), { recursive: true });
    await mkdir(join(home, '.cache', 'thing', '.git'), { recursive: true });
    // A linked worktree, where `.git` is a file rather than a directory.
    await mkdir(join(home, 'worktree'), { recursive: true });
    await writeFile(join(home, 'worktree', '.git'), 'gitdir: /elsewhere\n');

    /*
     * MSYS (Git for Windows) is a POSIX shell over a Windows filesystem, so the
     * home it is given has to be in the form its own `find` prints back —
     * otherwise the paths in the output would not match the paths asserted on.
     */
    const posixHome =
      process.platform === 'win32'
        ? execFileSync(sh!, ['-c', 'pwd'], { cwd: home, encoding: 'utf8', ...noConsoleWindow }).trim()
        : home;

    const stdout = execFileSync(sh!, ['-c', discoveryScript()], {
      encoding: 'utf8',
      env: { ...process.env, HOME: posixHome },
      maxBuffer: 4 * 1024 * 1024,
      ...noConsoleWindow,
    });

    const { roots, candidates, truncated } = parseDiscovery(stdout);
    expect(roots).toContain(posixHome);
    expect(roots).toContain(`${posixHome}/src`);

    const byPath = new Map(candidates.map((c) => [c.path, c.kind]));
    expect(byPath.get(`${posixHome}/used`)).toBe('workspace');
    expect(byPath.get(`${posixHome}/used new`)).toBe('workspace');
    expect(byPath.get(`${posixHome}/plain repo`)).toBe('git');
    // Two levels below a root: reached through `~/src`, which is why the
    // conventional project parents are roots of their own.
    expect(byPath.get(`${posixHome}/src/deep/api`)).toBe('git');
    // A worktree's `.git` is a file. Matching only directories would lose it.
    expect(byPath.get(`${posixHome}/worktree`)).toBe('git');
    expect(byPath.get(`${posixHome}/Documents`)).toBe('folder');

    // The two that make an unbounded `find` a hang.
    expect(byPath.has(`${posixHome}/node_modules/left-pad`)).toBe(false);
    expect(byPath.has(`${posixHome}/.cache/thing`)).toBe(false);
    // …and nothing hidden is offered as a plain folder either.
    expect([...byPath.keys()].some((p) => p.includes('/.'))).toBe(false);
    expect(truncated).toBe(false);
  });
});

if (sh === null) {
  // eslint-disable-next-line no-console
  console.warn(
    'discoverWorkspaces: no POSIX shell on PATH, so the script was checked as text only.',
  );
}
