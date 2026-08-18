/**
 * Setting a machine up, checked two ways (DESIGN.md §6.2, §6.4, §3.8).
 *
 * ## What is checked here, and what is not
 *
 * There is no `sshd` reachable from this machine — `ssh localhost` is refused —
 * and there is no `docker` on it either, so nothing here runs against a real
 * remote. Saying that plainly is the point: a suite that implies otherwise is
 * worse than one that admits a gap.
 *
 * What *is* real, and is the half that catches the bugs a review does not:
 *
 *  - **The scripts are executed by a real POSIX shell**, against a temporary
 *    home directory with a space in its name, with stub `npm`, `curl`, `df`,
 *    `setsid` and `ollama` on PATH. That is what proves the quoting holds, that
 *    the `@@step` markers actually print in order, that a failing step exits
 *    non-zero with its own words on stderr, and that the disk and checksum
 *    refusals fire rather than being unreachable branches. None of those survive
 *    a text assertion.
 *  - **Command construction and classification** run against an injected runner,
 *    which is where the Windows refusal, the architecture refusal and the
 *    "no user input reaches a shell" property are asserted.
 *
 * What remains unmeasured: whether a real remote answers in a useful time,
 * whether the real Ollama tarball's layout is what `find` expects, and whether
 * npm's global prefix behaves the same on a machine that is not this one.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authFollowUp,
  cliInstallScript,
  CLI_PACKAGES,
  managedCliBin,
  ollamaAsset,
  ollamaInstallScript,
  RouteRefused,
  runSetup,
  SetupFailed,
  StepReader,
  type ProvisionRunner,
} from '@main/host/provision.js';
import { managedToolDirs, addManagedToolsToPath } from '../src/host/managedTools.js';
import type { RemoteProbe } from '@main/host/sshTransport.js';

function probe(over: Partial<RemoteProbe> = {}): RemoteProbe {
  return {
    reachable: true,
    arch: 'x86_64',
    platform: 'Linux',
    nodePath: '/home/ci/.agbrte/node/bin/node',
    bundleVersion: null,
    home: '/home/ci',
    detail: '',
    ...over,
  };
}

/** Records what would have been run, and replies with canned output. */
function fakeRunner(
  replies: Array<{ match: RegExp; code?: number; stdout?: string; stderr?: string }> = [],
): ProvisionRunner & { commands: string[] } {
  const commands: string[] = [];
  return {
    commands,
    exec: async (_alias, command) => {
      commands.push(command);
      const reply = replies.find((r) => r.match.test(command));
      return { code: reply?.code ?? 0, stdout: reply?.stdout ?? '', stderr: reply?.stderr ?? '' };
    },
  };
}

describe('refusing a route rather than half-running it', () => {
  it('says so by name when the machine is not POSIX, before anything is sent', async () => {
    // A Windows remote answers ssh perfectly well and reports an empty platform
    // through the POSIX probe (§6.2). Sending it `sh` would produce a script
    // echoed back with exit 0, which is the failure that cost an operating
    // system's worth of debugging the first time.
    const runner = fakeRunner();
    await expect(
      runSetup(runner, 'winbox', probe({ platform: 'MINGW64_NT' }), { kind: 'cli', cli: 'claude-code' }, () => undefined),
    ).rejects.toThrow(RouteRefused);
    expect(runner.commands).toHaveLength(0);
  });

  it('names the machine and the alternative that does work', async () => {
    await runSetup(fakeRunner(), 'winbox', probe({ platform: '' }), { kind: 'ollama' }, () => undefined).catch(
      (err: unknown) => {
        const message = (err as Error).message;
        expect(message).toContain('winbox');
        expect(message).toContain('Linux or macOS');
        // The route that still works on that machine, because a refusal with no
        // way forward is the screen this whole feature exists to remove.
        expect(message).toContain('API endpoint');
      },
    );
  });

  it('refuses an architecture Ollama does not publish, rather than 404ing inside curl', async () => {
    await expect(
      runSetup(fakeRunner(), 'pi', probe({ arch: 'riscv64' }), { kind: 'ollama' }, () => undefined),
    ).rejects.toThrow(/publishes no build for Linux\/riscv64/);
  });

  it('refuses to route a credential through a shell at all', async () => {
    // A caller that sent the endpoint plan here would be the bug: the key must
    // travel on the session channel, not in an argv.
    await expect(
      runSetup(
        fakeRunner(),
        'box',
        probe(),
        { kind: 'endpoint', endpoint: { id: 'x', provider: 'p', baseUrl: 'https://a/v1', apiKey: 'sk-secret' } },
        () => undefined,
      ),
    ).rejects.toThrow(RouteRefused);
  });
});

describe('the scripts as text', () => {
  it('puts nothing free-form into a shell', () => {
    // The whole "no user input reaches a shell" claim, asserted rather than
    // remembered: a plan can only name one of two CLIs, and both are constants.
    const script = cliInstallScript('/home/ci', '/usr/bin/npm', 'claude-code');
    expect(script).toContain(`'@anthropic-ai/claude-code'`);
    for (const cli of ['claude-code', 'gemini-cli'] as const) {
      expect(CLI_PACKAGES[cli].pkg).toMatch(/^@[a-z0-9-]+\/[a-z0-9-]+$/);
    }
  });

  it('never lets the far side`s $HOME reach the shell unquoted', () => {
    /*
     * The path comes from `echo "home=$HOME"` on the other machine, so it is a
     * value from over there — and this caught the one place it was interpolated
     * into a double-quoted `echo`, where `$(…)` would have been substituted.
     * Every occurrence of it must sit inside single quotes, or behind a shell
     * variable that is expanded rather than re-evaluated.
     */
    const scripts = [
      cliInstallScript('/home/a b', '/usr/bin/npm', 'claude-code'),
      cliInstallScript('/home/a b', '/usr/bin/npm', 'gemini-cli'),
      ollamaInstallScript('/home/a b', 'ollama-darwin.tgz'),
    ];
    for (const script of scripts) {
      expect(script).toContain("'/home/a b");
      for (const at of [...script.matchAll(/\/home\/a b/g)]) {
        expect(script[at.index - 1]).toBe("'");
      }
    }
  });

  it('never installs system-wide and never asks for root', () => {
    const cli = cliInstallScript('/home/ci', '/usr/bin/npm', 'claude-code');
    const ollama = ollamaInstallScript('/home/ci', 'ollama-linux-amd64.tar.zst');
    for (const script of [cli, ollama]) {
      expect(script).not.toMatch(/\bsudo\b/);
      expect(script).not.toMatch(/\/usr\/local/);
    }
    expect(cli).toContain('--prefix');
  });

  it('binds Ollama to loopback rather than trusting its default', () => {
    // The failure this prevents is a model server answering on every interface
    // of somebody's build box, with us as the one who put it there.
    const script = ollamaInstallScript('/home/ci', 'ollama-darwin.tgz');
    expect(script).toContain('OLLAMA_HOST=127.0.0.1:11434');
    expect(script).not.toContain('0.0.0.0');
  });

  it('detaches the server the way the host detaches itself', () => {
    const script = ollamaInstallScript('/home/ci', 'ollama-darwin.tgz');
    expect(script).toContain('nohup setsid');
    // The subshell's fds are redirected, or `ssh` never returns.
    expect(script).toContain('>/dev/null 2>&1');
  });

  it('fetches every installer over https', () => {
    const script = ollamaInstallScript('/home/ci', 'ollama-linux-arm64.tar.zst');
    const urls = script.match(/https?:\/\/[^\s'"]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    // `http://127.0.0.1` is the readiness probe on the machine itself, which is
    // not an installer and has no network to protect.
    for (const url of urls) {
      expect(url.startsWith('https://') || url.startsWith('http://127.0.0.1')).toBe(true);
    }
  });

  it('maps a platform to the asset that exists, and refuses the rest', () => {
    expect(ollamaAsset('Linux', 'x86_64')).toBe('ollama-linux-amd64.tar.zst');
    expect(ollamaAsset('Linux', 'aarch64')).toBe('ollama-linux-arm64.tar.zst');
    expect(ollamaAsset('Darwin', 'arm64')).toBe('ollama-darwin.tgz');
    expect(ollamaAsset('Linux', 'riscv64')).toBeNull();
    expect(ollamaAsset('MINGW64_NT', 'x86_64')).toBeNull();
  });
});

describe('the follow-up nobody can skip', () => {
  it('names the command and the machine rather than implying the job is done', () => {
    const text = authFollowUp('claude-code', 'build-01');
    expect(text).toContain('build-01');
    // Checked against an installed 2.1.233 rather than guessed: both are real
    // subcommands, and both need a terminal on that machine.
    expect(text).toContain('claude auth login');
    expect(text).toContain('claude setup-token');
    // The reason the app cannot do it, said rather than left as a mystery.
    expect(text).toContain('local-only');
  });
});

describe('reading steps out of a stream', () => {
  it('keeps a torn line for the next chunk', () => {
    const seen: string[] = [];
    const reader = new StepReader((s) => seen.push(s));
    reader.push('@@step downloa');
    expect(seen).toEqual([]);
    reader.push('ding\n@@step unpacking\n');
    expect(seen).toEqual(['downloading', 'unpacking']);
  });

  it('flushes a final line with no newline', () => {
    const seen: string[] = [];
    const reader = new StepReader((s) => seen.push(s));
    reader.push('@@step starting');
    reader.end();
    expect(seen).toEqual(['starting']);
  });

  it('remembers which step failed, not merely that one did', () => {
    const reader = new StepReader(() => undefined);
    reader.push('@@step downloading\n@@fail downloading\n');
    expect(reader.failure).toBe('downloading');
  });
});

describe('what a freshly installed CLI needs to be found', () => {
  it('appends the managed prefixes and never shadows the machine`s own', () => {
    const env = { HOME: '/home/ci', PATH: '/usr/bin:/bin' } as NodeJS.ProcessEnv;
    addManagedToolsToPath(env);
    const parts = (env['PATH'] ?? '').split(/[:;]/);
    // Appended: a machine with its own `claude` keeps it.
    expect(parts[0]).toBe('/usr/bin');
    expect(parts).toContain('/home/ci/.agbrte/npm/bin');
    expect(parts).toContain('/home/ci/.agbrte/node/bin');
  });

  it('is idempotent, so a restarted host does not grow its PATH', () => {
    const env = { HOME: '/home/ci', PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    addManagedToolsToPath(env);
    const once = env['PATH'];
    addManagedToolsToPath(env);
    expect(env['PATH']).toBe(once);
  });

  it('adds nothing when there is no home to add from', () => {
    expect(managedToolDirs({} as NodeJS.ProcessEnv)).toEqual([]);
  });
});

// ---------------------------------------------------------------- real shell

/**
 * Skipped loudly, not silently, where there is no POSIX shell.
 *
 * Everything above is a claim about a string. These are the assertions that the
 * string is a *program*: a misplaced quote, an `if` without its `fi`, or a
 * marker printed after the thing it announces are all invisible to a text
 * comparison and fatal at run time.
 */
const sh = ((): string | null => {
  for (const candidate of ['sh', '/bin/sh']) {
    try {
      const probeRun = spawnSync(candidate, ['-c', 'printf ok'], { encoding: 'utf8' });
      if (probeRun.status !== 0 || !probeRun.stdout.includes('ok')) continue;
      /*
       * Resolved to an absolute path, which is not tidiness.
       *
       * These tests hand the child a PATH containing only the stub directory
       * and the POSIX bin directories — that is the whole point, since the
       * machine this runs on has a real `ollama` installed and `command -v
       * ollama` finding it skips the branch under test. But Node resolves the
       * *executable* against the child's PATH too, so a bare `sh` with a POSIX
       * PATH on Windows cannot be found, and every one of these came back with
       * status `-1` and no output. Naming the binary separates "where the shell
       * is" from "what the shell can see", which are two different questions
       * that one variable was answering.
       */
      if (process.platform !== 'win32') return candidate;
      const abs = spawnSync(candidate, ['-c', 'cygpath -w "$(command -v sh)"'], {
        encoding: 'utf8',
      });
      return abs.status === 0 && abs.stdout.trim() !== '' ? abs.stdout.trim() : candidate;
    } catch {
      // Next candidate.
    }
  }
  return null;
})();

/** The path a POSIX shell on this platform calls a directory. */
function posixPath(dir: string): string {
  return process.platform === 'win32'
    ? execFileSync(sh!, ['-c', 'pwd'], { cwd: dir, encoding: 'utf8' }).trim()
    : dir;
}

/** A throwaway `$HOME` with a space in it, plus a directory of stub tools. */
async function sandbox(): Promise<{ home: string; bin: string; posixHome: string }> {
  const home = await mkdtemp(join(tmpdir(), 'agbrte home '));
  const bin = join(home, 'stub bin');
  await mkdir(bin, { recursive: true });
  return { home, bin, posixHome: posixPath(home) };
}

async function stub(bin: string, name: string, body: string): Promise<void> {
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
}

/**
 * The PATH these scripts are given, and why it is not the developer's.
 *
 * Two bugs, both found by running this rather than reading it. This machine has
 * a real `ollama` on its PATH, so `command -v ollama` succeeded and the whole
 * download branch was skipped — every assertion about downloading, verifying and
 * unpacking passed straight over the code it was about. And `{...process.env,
 * PATH}` on Windows produces an environment holding both `Path` and `PATH`,
 * where the child gets whichever the OS picks; the stub directory was never
 * consulted at all.
 *
 * So the environment is built rather than inherited: the stub directory, then
 * the two POSIX bin directories every tool these scripts use lives in on both
 * MSYS and Linux. Anything the machine happens to have installed elsewhere is
 * invisible, which is the only way a test about *a machine with nothing on it*
 * can mean what it says.
 */
function runScript(
  script: string,
  bin: string,
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string } {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Dropped case-insensitively: `Path` beside `PATH` is one variable to
    // Windows and two to Node, and the wrong one wins.
    if (value !== undefined && key.toUpperCase() !== 'PATH') clean[key] = value;
  }
  const result = spawnSync(sh!, ['-c', script], {
    encoding: 'utf8',
    env: { ...clean, ...env, PATH: `${bin}:/usr/bin:/bin` },
    maxBuffer: 8 * 1024 * 1024,
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

describe.skipIf(sh === null)('the CLI script, under a real shell', () => {
  it('installs, verifies, and leaves ~/.agbrte to its owner', async () => {
    const { home, bin, posixHome } = await sandbox();
    // A stub npm that does what npm does: put a shim in `<prefix>/bin`. It also
    // records its argv, so the prefix and the package name are checked as the
    // shell actually delivered them rather than as this file assembled them.
    await stub(
      bin,
      'npm',
      `printf '%s\\n' "$@" > "$RECORD"\n` +
        `mkdir -p "${posixHome}/.agbrte/npm/bin"\n` +
        `printf '#!/bin/sh\\necho 9.9.9\\n' > "${posixHome}/.agbrte/npm/bin/claude"\n` +
        `chmod 755 "${posixHome}/.agbrte/npm/bin/claude"\n`,
    );
    const record = join(home, 'argv.txt');

    const seen: string[] = [];
    const script = cliInstallScript(posixHome, `${posixHome}/stub bin/npm`, 'claude-code');
    const posixBin = `${posixHome}/stub bin`;
    const out = runScript(script, posixBin, {
      RECORD: `${posixHome}/argv.txt`,
      HOME: posixHome,
    });

    const reader = new StepReader((s) => seen.push(s));
    reader.push(out.stdout);
    reader.end();

    expect(out.code).toBe(0);
    // The order matters: a marker printed after the work it announces is a
    // progress panel that is always one step behind.
    expect(seen).toEqual([
      'checking there is room',
      'preparing ~/.agbrte',
      'installing @anthropic-ai/claude-code',
      'checking it runs',
    ]);
    // The verify step really ran the binary, which is what stops "installed" and
    // "runnable" being reported as one thing.
    expect(out.stdout).toContain('9.9.9');

    const argv = await readFile(record, 'utf8');
    expect(argv).toContain('--prefix');
    expect(argv).toContain(`${posixHome}/.agbrte/npm`);
    expect(argv).toContain('@anthropic-ai/claude-code');
    // The shim landed where the host's PATH will look for it.
    expect(managedCliBin(posixHome)).toBe(`${posixHome}/.agbrte/npm/bin`);
    await stat(join(home, '.agbrte', 'npm', 'bin', 'claude'));
  });

  it('fails at the step that failed, with the tool`s own words', async () => {
    const { home, bin, posixHome } = await sandbox();
    await stub(bin, 'npm', `echo "npm ERR! code E403" >&2; exit 1`);

    const runner: ProvisionRunner = {
      exec: async (_alias, command, opts) => {
        const out = runScript(command, `${posixHome}/stub bin`, { HOME: posixHome });
        opts?.onData?.(out.stdout);
        return { code: out.code, stdout: out.stdout, stderr: out.stderr };
      },
    };

    await expect(
      runSetup(
        runner,
        'box',
        probe({ home: posixHome, nodePath: `${posixHome}/stub bin/node` }),
        { kind: 'cli', cli: 'claude-code' },
        () => undefined,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      const failure = err as SetupFailed;
      expect(failure.step).toBe('installing @anthropic-ai/claude-code');
      // Verbatim, because "the install failed" sends nobody anywhere.
      expect(failure.detail).toContain('npm ERR! code E403');
      return true;
    });
    void home;
  });

  it('refuses on a full disk before it writes anything', async () => {
    const { home, bin, posixHome } = await sandbox();
    // `df` reporting almost nothing free. The refusal has to happen here rather
    // than inside `tar`, which would complain about an unexpected end of file —
    // a sentence about the wrong thing entirely.
    await stub(bin, 'df', `echo "Filesystem 1024-blocks Used Available Capacity"; echo "/dev/x 100 99 8 99% /"`);
    await stub(bin, 'npm', `echo "npm should never have run" >&2; exit 1`);

    const script = cliInstallScript(posixHome, `${posixHome}/stub bin/npm`, 'claude-code');
    const out = runScript(script, `${posixHome}/stub bin`, { HOME: posixHome });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not enough free space');
    expect(out.stderr).not.toContain('npm should never have run');
    const reader = new StepReader(() => undefined);
    reader.push(out.stdout);
    reader.end();
    expect(reader.failure).toBe('checking there is room');
    void home;
    void bin;
  });
});

describe.skipIf(sh === null)('the Ollama script, under a real shell', () => {
  it('does nothing at all when one is already serving', async () => {
    const { bin, posixHome } = await sandbox();
    // Answers the version probe, so the whole download is skipped. The failure
    // this guards is a gigabyte fetched to arrive at a no-op.
    await stub(bin, 'curl', `exit 0`);

    const out = runScript(ollamaInstallScript(posixHome, 'ollama-darwin.tgz'), `${posixHome}/stub bin`, {
      HOME: posixHome,
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toContain('it is already serving');
    expect(out.stdout).not.toContain('downloading');
  });

  it('refuses a download that does not match the published checksum', async () => {
    const { bin, posixHome } = await sandbox();
    /*
     * The one check standing between a user and a gigabyte of unverified binary
     * running as them. Also the check that catches a truncated download, which
     * is what a disk filling up produces.
     */
    await stub(
      bin,
      'curl',
      `for a in "$@"; do case "$a" in -o) next=out;; *) if [ "$next" = out ]; then dest="$a"; next=; fi;; esac; done\n` +
        `case "$dest" in *sha256sum.txt) printf '%s  ./ollama-darwin.tgz\\n' 0000000000000000000000000000000000000000000000000000000000000000 > "$dest";; ` +
        `*) if [ -n "$dest" ]; then printf 'not a real tarball' > "$dest"; else exit 1; fi;; esac`,
    );

    const out = runScript(ollamaInstallScript(posixHome, 'ollama-darwin.tgz'), `${posixHome}/stub bin`, {
      HOME: posixHome,
    });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain('does not match the checksum');
    const reader = new StepReader(() => undefined);
    reader.push(out.stdout);
    reader.end();
    expect(reader.failure).toBe('checking the download');
    // Nothing was unpacked and nothing was started.
    expect(out.stdout).not.toContain('unpacking');
    expect(out.stdout).not.toContain('starting the server');
  });

  it('downloads, verifies, unpacks, detaches and waits for the API to answer', async () => {
    const { home, bin, posixHome } = await sandbox();
    const stage = join(home, 'stage');
    await mkdir(join(stage, 'bin'), { recursive: true });
    // A fake `ollama` that behaves the way the real one does for this script's
    // purposes: `serve` runs forever and signals readiness by existing.
    await writeFile(
      join(stage, 'bin', 'ollama'),
      `#!/bin/sh\ntouch "$OLLAMA_READY"\nwhile true; do sleep 1; done\n`,
      'utf8',
    );
    await chmod(join(stage, 'bin', 'ollama'), 0o755);
    const tarball = join(home, 'ollama-darwin.tgz');
    execFileSync(sh!, ['-c', `cd "${posixPath(stage)}" && tar -czf "${posixPath(home)}/ollama-darwin.tgz" bin`]);
    const digest = execFileSync(sh!, ['-c', `sha256sum "${posixPath(home)}/ollama-darwin.tgz"`], {
      encoding: 'utf8',
    })
      .trim()
      .split(/\s+/)[0]!;

    await stub(
      bin,
      'curl',
      `dest=\n` +
        `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; dest="$1"; fi; last="$1"; shift; done\n` +
        `case "$dest" in\n` +
        `  *sha256sum.txt) printf '%s  ./ollama-darwin.tgz\\n' "${digest}" > "$dest"; exit 0;;\n` +
        `  *ollama-darwin.tgz) cp "${posixPath(home)}/ollama-darwin.tgz" "$dest"; exit 0;;\n` +
        `esac\n` +
        // The readiness probe: fails until the fake server has started.
        `if [ -f "$OLLAMA_READY" ]; then exit 0; fi; exit 7`,
    );
    // MSYS has no `setsid`; the real one puts the child in its own session and
    // this stands in for it so the launch line is exercised as written.
    await stub(bin, 'setsid', `exec "$@"`);

    const ready = `${posixPath(home)}/ready`;
    const seen: string[] = [];
    const out = runScript(ollamaInstallScript(posixHome, 'ollama-darwin.tgz'), `${posixHome}/stub bin`, {
      HOME: posixHome,
      OLLAMA_READY: ready,
    });

    const reader = new StepReader((s) => seen.push(s));
    reader.push(out.stdout);
    reader.end();

    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(seen).toContain('downloading Ollama v0.32.14 (about a gigabyte)');
    expect(seen).toContain('checking the download');
    expect(seen).toContain('unpacking');
    expect(seen).toContain('starting the server');
    expect(seen).toContain('waiting for it to answer');
    // Unpacked where the host's PATH and the next run's probe both look.
    await stat(join(home, '.agbrte', 'ollama', 'bin', 'ollama'));
    void tarball;
  }, 60_000);
});

const hasZstd = spawnSync('zstd', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(sh === null || hasZstd)('a machine that cannot read the archive', () => {
  it('says which package to install rather than failing inside tar', async () => {
    const { home, bin, posixHome } = await sandbox();
    // A file that is not an archive at all — the point is that the refusal comes
    // *before* tar is asked to read it, so what is in it does not matter.
    await writeFile(join(home, 'arch'), 'not an archive', 'utf8');
    await stub(
      bin,
      'curl',
      `dest=
` +
        `while [ $# -gt 0 ]; do if [ "$1" = -o ]; then shift; dest="$1"; fi; shift; done
` +
        `case "$dest" in
` +
        `  *sha256sum.txt) printf '%s  ./ollama-linux-amd64.tar.zst\n' "$(sha256sum "$WORK/arch" | awk '{print $1}')" > "$dest"; exit 0;;
` +
        `  *tar.zst) cp "$WORK/arch" "$dest"; exit 0;;
` +
        `esac
` +
        `exit 7`,
    );

    const out = runScript(
      ollamaInstallScript(posixHome, 'ollama-linux-amd64.tar.zst'),
      `${posixHome}/stub bin`,
      { HOME: posixHome, WORK: posixHome },
    );

    expect(out.code).toBe(1);
    // Named, with the fix in it. GNU tar's `--zstd` shells out to `zstd`, so
    // without it the failure arrives from inside tar as a complaint about a
    // filter — which reads as a corrupt download and sends nobody anywhere.
    expect(out.stderr).toContain('no zstd binary');
    expect(out.stderr).toContain('Install zstd');
  });
});

if (sh === null) {
  // eslint-disable-next-line no-console
  console.warn('provision: no POSIX shell on PATH, so the scripts were checked as text only.');
}
