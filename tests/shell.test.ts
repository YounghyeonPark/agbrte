/**
 * The user's own terminal in the workspace (DESIGN.md §7, §8).
 *
 * Three halves, tested differently on purpose.
 *
 * **Program selection** is where the security property now lives, so it is
 * tested as a property rather than as a happy path: the assertions are about
 * what a client *cannot* say and about a refusal repeating the sentence the
 * picker already showed. The pane gained the ability to run an installed agent
 * CLI, which is the first real chance to reopen the hole §7 closed, and the
 * closure is `TerminalPrograms.resolve` and nothing else.
 *
 * The **supervisor** is driven against a fake PTY, because what is worth
 * asserting there is coalescing, the byte cap, ownership and lifetime — none of
 * which are properties of a real pseudoterminal, and all of which are properties
 * that would be hidden by one. Driving a real shell to overflow a 256 KiB buffer
 * is a slow way to test a `slice`.
 *
 * The **native module** is exercised for real once, and the assertion is the
 * only one that matters about it: that the *same prebuilt binary* loads under
 * the runtime the session host actually runs on. `@lydell/node-pty` ships
 * Node-API prebuilds, which is what makes that true without `electron-rebuild`
 * — and "it works under my `node`" would not have proved it, because the host is
 * started as `electron.exe` with `ELECTRON_RUN_AS_NODE=1`.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DEFAULT_COLS,
  MAX_PENDING_BYTES,
  Shells,
  shellsAvailable,
  TRUNCATION_MARKER,
  type Pty,
  type PtySpawner,
} from '@main/terminal/shell.js';
import {
  AGBRTE_CLI_LABEL,
  ProgramRefused,
  TERM_NAME,
  TerminalPrograms,
  agbrteCliCandidates,
  comspecCommandLine,
  defaultShell,
  findAgbrteCli,
  findExecutable,
  terminalEnv,
  type ResolvedProgram,
} from '@main/terminal/programs.js';
import { CLAUDE_CODE_MANIFEST } from '@main/runtime/cli/manifests.js';


/** A pty that does exactly what it is told, and records what it was told. */
class FakePty implements Pty {
  readonly pid = 4242;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  private data: ((d: string) => void) | null = null;
  private exit: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(cb: (d: string) => void): void {
    this.data = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exit = cb;
  }
  write(d: string): void {
    this.written.push(d);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }

  /** Test drivers. */
  emit(d: string): void {
    this.data?.(d);
  }
  end(exitCode: number): void {
    this.exit?.({ exitCode });
  }
}

interface Owner {
  name: string;
}

/**
 * A host that found Claude Code and did not find Gemini CLI.
 *
 * Both halves are load-bearing: the found one proves a pane can open a detected
 * CLI, and the missing one is the only way to check that a refusal repeats the
 * host's *own* detection sentence rather than inventing a second one.
 */
const DETECTED = ['echo', 'cli:claude-code'];
const GEMINI_NOTE = '`gemini` could not be started on this host (ENOENT) — it is probably not installed';
const NOTES = [{ id: 'cli:gemini-cli', reason: GEMINI_NOTE }];

/** Nothing exists on disk in a unit test, so the PATH walk is stubbed out. */
const FOUND: Readonly<Record<string, string>> = {
  '/bin/fakesh': '/bin/fakesh',
  claude: '/opt/tools/claude',
};

/** Our own CLI bundle, named rather than looked for — no `dist` tree in a unit test. */
const CLI_ENTRY = '/opt/agbrte/dist/cli/agbrte.js';
/** A session the pane could be showing. Shape-checked by `resolve`, so a real one. */
const SESSION_ID = '019fd625-1a2b-7c3d-8e4f-506172839405';

function programs(): TerminalPrograms {
  return new TerminalPrograms({
    runtimeIds: DETECTED,
    notes: NOTES,
    env: { AGBRTE_SHELL: '/bin/fakesh' },
    lookup: (name) => FOUND[name] ?? null,
    cliEntry: CLI_ENTRY,
  });
}

function harness(): {
  shells: Shells<Owner>;
  ptys: FakePty[];
  spawns: Array<{
    program: string;
    args: string[] | string;
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }>;
  chunks: Array<{ shellId: string; data: string; owner: Owner }>;
  exits: Array<{ shellId: string; exitCode: number }>;
  /** Run whatever the coalescer scheduled, without waiting for it. */
  tick(): void;
} {
  const ptys: FakePty[] = [];
  const spawns: Array<{
    program: string;
    args: string[] | string;
    cwd: string;
    cols: number;
    rows: number;
    env: NodeJS.ProcessEnv;
  }> = [];
  const chunks: Array<{ shellId: string; data: string; owner: Owner }> = [];
  const exits: Array<{ shellId: string; exitCode: number }> = [];
  const scheduled: Array<() => void> = [];

  const spawn: PtySpawner = (program, args, opts) => {
    spawns.push({
      program,
      args,
      cwd: opts.cwd,
      cols: opts.cols,
      rows: opts.rows,
      env: opts.env,
    });
    const pty = new FakePty();
    ptys.push(pty);
    return pty;
  };

  const shells = new Shells<Owner>('/work/space', {
    onData: (shellId, data, owner) => chunks.push({ shellId, data, owner }),
    onExit: (exit, _owner) => exits.push({ shellId: exit.shellId, exitCode: exit.exitCode }),
    spawn,
    env: { AGBRTE_SHELL: '/bin/fakesh', ELECTRON_RUN_AS_NODE: '1' },
    programs: programs(),
    // Time is driven rather than waited on: the property under test is "one
    // message per window", and a real 16 ms timer would make that a race.
    setTimer: (fn) => {
      scheduled.push(fn);
      return 0 as unknown as NodeJS.Timeout;
    },
    clearTimer: () => undefined,
  });

  return {
    shells,
    ptys,
    spawns,
    chunks,
    exits,
    tick: () => {
      for (const fn of scheduled.splice(0)) fn();
    },
  };
}

/*
 * The directories these two tests plant an executable in, removed afterwards.
 *
 * Made with `mkdtempSync` inside the test because the file it plants has to
 * exist before the call under test looks for it; a list plus one hook is what
 * keeps that from leaving a folder per run under the system temp directory.
 */
const planted: string[] = [];
afterAll(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

describe('what a terminal is allowed to start', () => {
  it('opens the shell when nobody chose, and the caller cannot name one', () => {
    const h = harness();
    const handle = h.shells.open({ name: 'window' }, { cols: 120, rows: 40 });

    // The narrowing §7 asks for: `cwd` and the file are the host's, and there is
    // no parameter through which a client could name either.
    expect(h.spawns[0]?.cwd).toBe('/work/space');
    expect(h.spawns[0]?.program).toBe('/bin/fakesh');
    expect(handle.cwd).toBe('/work/space');
    expect(handle.label).toBe('Your shell');
    // And nothing that crosses the boundary is a handle: no pid, no descriptor.
    expect(Object.keys(handle).sort()).toEqual([
      'cols',
      'cwd',
      'label',
      'program',
      'rows',
      'shellId',
    ]);
  });

  it('opens an installed CLI interactively — none of the argv a turn composes', () => {
    const h = harness();
    const handle = h.shells.open(
      { name: 'window' },
      { program: { kind: 'cli', cliId: 'claude-code' } },
    );

    // The point of the whole feature: this is the vendor's own interface, so it
    // is started the way a person starts it. `-p --output-format stream-json` is
    // a *headless* run, it belongs to `CliStdioRuntime`, and composing it here
    // would put a stream of NDJSON in front of somebody expecting a TUI.
    expect(h.spawns[0]?.program).toBe('/opt/tools/claude');
    expect(h.spawns[0]?.args).toEqual([]);
    // Asserted against the manifest rather than against a literal, so this stays
    // true when the vendor's flags change: whatever the headless argv becomes,
    // none of it is here.
    expect(CLAUDE_CODE_MANIFEST.invoke.baseArgs.length).toBeGreaterThan(0);
    for (const flag of CLAUDE_CODE_MANIFEST.invoke.baseArgs) {
      expect(h.spawns[0]?.args).not.toContain(flag);
    }

    // Labelled with what is running, which is the pane's whole claim.
    expect(handle.label).toBe(CLAUDE_CODE_MANIFEST.label);
    expect(handle.program).toBe('/opt/tools/claude');
    expect(handle.cwd).toBe('/work/space');
  });

  it('opens our own CLI against the session the pane is showing', () => {
    const h = harness();
    const handle = h.shells.open(
      { name: 'window' },
      { program: { kind: 'agbrte' }, sessionId: SESSION_ID },
    );

    // The runtime this host is already running, never a `node` from the PATH:
    // the desktop app is installed on machines that have no Node at all, and on
    // the ones that do it would be a different version chosen by accident.
    expect(h.spawns[0]?.program).toBe(process.execPath);
    // `attach --session`, which is the whole point: it joins the session the
    // window is looking at rather than making a second one beside it.
    expect(h.spawns[0]?.args).toEqual([
      CLI_ENTRY,
      'attach',
      '/work/space',
      '--session',
      SESSION_ID,
    ]);
    // Still the host's workspace, still the host's decision.
    expect(h.spawns[0]?.cwd).toBe('/work/space');
    expect(handle.label).toBe(AGBRTE_CLI_LABEL);
  });

  it('refuses to open our CLI on a session id it was not given, or was given badly', () => {
    const h = harness();

    // Without one there is no session to attach to, and the alternative — let
    // the CLI ask which — is a second session list inside a window that is
    // already showing one, with "make a new one" as an option.
    expect(() => h.shells.open({ name: 'window' }, { program: { kind: 'agbrte' } })).toThrow(
      ProgramRefused,
    );

    /*
     * The one client-supplied string in this file that reaches an argv, so it is
     * admitted only in the shape a session id has. Neither of these could do
     * anything on its own — arguments are passed as data, not as a command line
     * — but "a client cannot put arbitrary text in our argv" is a property worth
     * having by construction rather than by the spawner being careful.
     */
    for (const bad of ['--yes', '../../etc/passwd', 'not-a-uuid', '']) {
      expect(() =>
        h.shells.open({ name: 'window' }, { program: { kind: 'agbrte' }, sessionId: bad }),
      ).toThrow(/is not a session id/);
    }
    expect(h.spawns).toEqual([]);
  });

  it('refuses when there is no Agbrte CLI beside the host, and says where it looked', () => {
    // A remote host is two bundled `.js` files in `~/.agbrte` with nothing else
    // beside them, which is exactly this: the pane's other programs still work
    // and this one honestly cannot.
    const bare = new Shells<Owner>('/work/space', {
      onData: () => undefined,
      onExit: () => undefined,
      spawn: () => new FakePty(),
      programs: new TerminalPrograms({
        env: { AGBRTE_SHELL: '/bin/fakesh' },
        lookup: (name) => FOUND[name] ?? null,
      }),
    });

    let refused: unknown;
    try {
      bare.open({ name: 'window' }, { program: { kind: 'agbrte' }, sessionId: SESSION_ID });
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(ProgramRefused);
    // Named in full, because "could not start the CLI" sends somebody to look at
    // the CLI when the fault is a layout.
    expect((refused as Error).message).toContain(join('cli', 'agbrte.js'));
  });

  it('gives our own CLI the switch that lets this runtime run a script, and nothing else', () => {
    /*
     * The composition, tested deterministically rather than against whatever
     * runtime the suite happens to be on.
     *
     * `terminalEnv` deletes `ELECTRON_RUN_AS_NODE` for everything a person can
     * start — an Electron tool that inherits it comes up as headless Node with
     * no window — and our own CLI is the one program that needs it back,
     * because in a packaged app the only interpreter present is `electron.exe`.
     * Both halves have to be true at once, which is why the switch lives on the
     * resolved program rather than on the terminal.
     */
    class OneProgram extends TerminalPrograms {
      override resolve(): ResolvedProgram {
        return {
          file: '/bin/wrapper',
          args: [],
          label: 'Fixed',
          env: { ELECTRON_RUN_AS_NODE: '1' },
          display: '/opt/agbrte/runtime /opt/agbrte/dist/cli/agbrte.js',
        };
      }
    }
    const spawns: NodeJS.ProcessEnv[] = [];
    const started: string[] = [];
    const shells = new Shells<Owner>('/work/space', {
      onData: () => undefined,
      onExit: () => undefined,
      spawn: (program, _args, opts) => {
        started.push(program);
        spawns.push(opts.env);
        return new FakePty();
      },
      env: { AGBRTE_SHELL: '/bin/fakesh', ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' },
      programs: new OneProgram(),
    });

    const handle = shells.open({ name: 'window' });
    expect(spawns[0]?.['ELECTRON_RUN_AS_NODE']).toBe('1');
    // The rest of the terminal's environment is untouched by the overlay.
    expect(spawns[0]?.['TERM']).toBe(TERM_NAME);
    expect(spawns[0]?.['PATH']).toBe('/usr/bin');

    // The wrapper is what starts, and is not what the pane says is running:
    // "Agbrte CLI … C:\WINDOWS\system32\cmd.exe" is a true sentence that sends
    // somebody looking for a bug in the wrong process.
    expect(started[0]).toBe('/bin/wrapper');
    expect(handle.program).toBe('/opt/agbrte/runtime /opt/agbrte/dist/cli/agbrte.js');
  });

  it('refuses a CLI this host did not detect, in the words the picker used', () => {
    const h = harness();

    let refused: unknown;
    try {
      h.shells.open({ name: 'window' }, { program: { kind: 'cli', cliId: 'gemini-cli' } });
    } catch (err) {
      refused = err;
    }

    expect(refused).toBeInstanceOf(ProgramRefused);
    // The host's own detection sentence, repeated rather than paraphrased. A
    // second explanation written at the pane would drift from the one already on
    // screen beside the runtime picker, and the person reading it has just been
    // told something different about the same machine.
    expect((refused as Error).message).toContain(GEMINI_NOTE);
    expect((refused as Error).message).toContain('Gemini CLI');
    // Refused, not quietly downgraded: a pane labelled "Gemini CLI" showing a
    // shell prompt is a lie in the one place the label carries weight.
    expect(h.spawns).toEqual([]);
    expect(h.shells.openCount).toBe(0);
  });

  it('refuses an id no manifest knows, and says what it does know', () => {
    const h = harness();
    expect(() =>
      h.shells.open({ name: 'window' }, { program: { kind: 'cli', cliId: '../../../bin/sh' } }),
    ).toThrow(/is not a CLI this app knows about/);
    // A path is not a special case that needed special handling — it is simply
    // not one of two literals, which is what makes the closed set a closed set.
    expect(h.spawns).toEqual([]);
  });

  it('offers exactly the CLIs the host advertised as runtimes', () => {
    // The list and the picker's list are one list. A CLI in `available` can be
    // opened; one that is only in `runtimeNotes` cannot; nothing else exists.
    expect(programs().available).toEqual(['claude-code']);
  });

  it('gives the program an environment that is this machine, minus our own switches', () => {
    const h = harness();
    h.shells.open({ name: 'window' });

    const env = h.spawns[0]?.env ?? {};
    // The session host runs as `electron.exe` with this set and everything it
    // spawns inherits it — so an Electron-based tool started from this pane
    // would come up as headless Node with no window and no explanation.
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    // Set, because Windows sets it for nobody and a full-screen TUI reads it to
    // decide what it may draw.
    expect(env['TERM']).toBe(TERM_NAME);
    // Not scrubbed: a terminal whose environment does not match the machine is a
    // terminal that cannot be used to debug the machine.
    expect(env['AGBRTE_SHELL']).toBe('/bin/fakesh');
  });

  it('names the shell the user asked for, then the platform’s, then a fallback', () => {
    expect(defaultShell({ AGBRTE_SHELL: '/bin/zsh', SHELL: '/bin/bash' })).toBe('/bin/zsh');
    // Blank is not a choice — an empty variable is an unset one with a value.
    expect(defaultShell({ AGBRTE_SHELL: '  ', SHELL: '/bin/bash', COMSPEC: 'cmd.exe' })).toBe(
      process.platform === 'win32' ? 'cmd.exe' : '/bin/bash',
    );
    // A detached host can inherit a surprisingly empty environment, and a
    // terminal that refuses to open over an unset variable is worse than one on
    // `sh`.
    expect(defaultShell({})).toBe(process.platform === 'win32' ? 'cmd.exe' : '/bin/sh');
  });

  it('says which file it could not find rather than failing inside the pty', () => {
    const h = harness();
    // A host that detected Claude Code and then lost it — an uninstall between
    // startup and now, or a PATH the pty walks differently from the detector,
    // which is not hypothetical (see below).
    const lost = new Shells<Owner>('/work/space', {
      onData: () => undefined,
      onExit: () => undefined,
      spawn: () => new FakePty(),
      programs: new TerminalPrograms({
        runtimeIds: DETECTED,
        env: { AGBRTE_SHELL: '/bin/fakesh' },
        lookup: () => null,
      }),
    });

    expect(() => lost.open({ name: 'window' }, { program: { kind: 'cli', cliId: 'claude-code' } }))
      .toThrow(/`claude` could not be found on the PATH/);
    expect(h.spawns).toEqual([]);
  });
});

describe('finding a program on this machine', () => {
  /**
   * The measurement this resolver exists for.
   *
   * `@lydell/node-pty` on Windows walks `PATH` testing `dir\name` **verbatim**,
   * with no `PATHEXT` expansion — so `pty.spawn('claude', …)` on a machine with
   * `claude.exe` on the PATH throws `File not found:` (with an empty name, which
   * is the empty candidate it ended on). `detectCli` spawns through Node, which
   * *does* expand `PATHEXT`, and reports the CLI present. The two disagreed, and
   * the failure had the worst possible shape: the picker offered Claude Code,
   * the pane refused it, and nothing named the reason.
   *
   * So the extension search is ours, and this is the test that keeps it.
   */
  it('expands PATHEXT on Windows, so a bare name finds the .exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-path-'));
    planted.push(dir);
    const name = process.platform === 'win32' ? 'probe.exe' : 'probe';
    const file = join(dir, name);
    writeFileSync(file, '');
    if (process.platform !== 'win32') chmodSync(file, 0o755);

    const env: NodeJS.ProcessEnv = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
    expect(findExecutable('probe', env)).toBe(file);
    // An absolute answer is checked rather than trusted, so a stale `COMSPEC`
    // fails with a sentence naming it instead of inside the pty.
    expect(findExecutable(file, env)).toBe(file);
    expect(findExecutable('definitely-not-here', env)).toBeNull();
  });

  it('does not look in the current directory', () => {
    // Windows' own `CreateProcess` searches the working directory first, and the
    // working directory here is a *repository* — a place an agent can write. A
    // checkout that shipped a `claude.exe` beside its README would otherwise be
    // run by this pane on the strength of its filename.
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-cwd-'));
    planted.push(dir);
    const name = process.platform === 'win32' ? 'planted.exe' : 'planted';
    const file = join(dir, name);
    writeFileSync(file, '');
    if (process.platform !== 'win32') chmodSync(file, 0o755);

    const previous = process.cwd();
    try {
      process.chdir(dir);
      expect(findExecutable('planted', { PATH: '', PATHEXT: '.EXE' })).toBeNull();
    } finally {
      process.chdir(previous);
    }
  });

  it('leaves the rest of the environment alone', () => {
    const env = terminalEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin', HOME: '/home/me' });
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/me');
    expect(env['TERM']).toBe(TERM_NAME);
  });
});

describe('finding our own CLI beside the host', () => {
  /**
   * Every layout this app actually ships in, asserted as a list.
   *
   * The PATH is deliberately not among them: `agbrte` on a PATH is whatever a
   * stale global install or a workspace put there, and running *that* under our
   * own label inside our own window is precisely the hole §7 closes for the
   * other programs in this pane.
   */
  it('knows the shipped layouts, and none of them is the PATH', () => {
    const dist = agbrteCliCandidates(resolve('/app', 'dist', 'main'), {});
    // The `dist` tree, an `npm i -g` package, a server install, and a packaged
    // app — all four are this one relative path.
    expect(dist[0]).toBe(resolve('/app', 'dist', 'cli', 'agbrte.js'));
    // `agbrte serve` runs the host *inside* the CLI bundle, so the CLI is the
    // file this code is already in.
    expect(dist).toContain(resolve('/app', 'dist', 'main', 'agbrte.js'));

    const override = agbrteCliCandidates('/anywhere', { AGBRTE_CLI_ENTRY: '/opt/custom/agbrte.js' });
    expect(override).toEqual([resolve('/opt/custom/agbrte.js')]);
  });

  it('crosses back into app.asar from an unpacked host bundle', () => {
    /*
     * The packaged split, in one assertion.
     *
     * `dist/main/agbrteHost.js` is `asarUnpack`ed because a process cannot be
     * given a path inside an archive; `dist/cli` is not, because nothing forks
     * it. A host started from the unpacked copy therefore has no `../cli`
     * beside it, and the file it wants is one directory name away.
     */
    const here = resolve('/app', 'resources', 'app.asar.unpacked', 'dist', 'main');
    expect(agbrteCliCandidates(here, {})).toContain(
      resolve('/app', 'resources', 'app.asar', 'dist', 'cli', 'agbrte.js'),
    );
  });

  it('answers null rather than guessing when nothing is there', () => {
    expect(findAgbrteCli('/nowhere', {}, () => false)).toBeNull();
    expect(
      findAgbrteCli(resolve('/app/dist/main'), {}, (p) => p.endsWith(join('cli', 'agbrte.js'))),
    ).toBe(resolve('/app', 'dist', 'cli', 'agbrte.js'));
  });
});

describe('starting a GUI-subsystem runtime in a Windows pty', () => {
  /**
   * The measurement this wrapper exists for, restated where it is enforced.
   *
   * `electron.exe` is GUI-subsystem. Started directly inside a ConPTY it runs,
   * exits 0, reports `process.stdout.isTTY === true` — and delivers **zero
   * bytes** to the pty's reader, in every spawn shape `@lydell/node-pty` offers.
   * A console-subsystem process in between fixes it, because that is what
   * Electron's stream reattach finds.
   *
   * The quoting is the second half and is the part that would have shipped
   * broken: `node-pty` joins an argv the `CommandLineToArgvW` way, `cmd.exe`
   * does not read it that way, and `%LOCALAPPDATA%` contains the user's name —
   * so "a path with a space" is the common case, not the corner one.
   */
  it('wraps a command line that survives a space and an ampersand', () => {
    const wrapped = comspecCommandLine(
      'C:\\Program Files\\Agbrte\\Agbrte.exe',
      ['C:\\Program Files\\Agbrte\\resources\\app.asar\\dist\\cli\\agbrte.js', 'attach', 'C:\\q & a'],
      { COMSPEC: 'C:\\WINDOWS\\system32\\cmd.exe' },
    );

    expect(wrapped.file).toBe('C:\\WINDOWS\\system32\\cmd.exe');
    // `/s` plus the doubled outer quote is the documented escape: cmd strips
    // exactly the first and last character and takes the rest verbatim. The
    // `type CON |` is the second measurement — Electron cannot read a Windows
    // console and can read a pipe, so the console is put on the end of one.
    expect(wrapped.args).toBe(
      '/d /s /c "type CON | "C:\\Program Files\\Agbrte\\Agbrte.exe" ' +
        '"C:\\Program Files\\Agbrte\\resources\\app.asar\\dist\\cli\\agbrte.js" ' +
        '"attach" "C:\\q & a""',
    );
    // The `&` is inside a quoted argument, which is what stops a workspace
    // called `q & a` from being read as two commands.
    expect(wrapped.args).toContain('"C:\\q & a"');
  });

  it('refuses a quote rather than sanitising one', () => {
    // Unreachable in practice — a Windows path cannot contain `"` — and the
    // honest answer if it ever is reached, because the alternative is running
    // something other than what was asked for.
    expect(() => comspecCommandLine('C:\\a"b.exe', [], {})).toThrow(ProgramRefused);
  });
});

describe('the user’s terminal', () => {
  it('coalesces a burst into one message rather than one per chunk', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    h.shells.open(owner);

    // What a shell echoing a typed line actually looks like: many tiny writes.
    for (const ch of 'echo hello\r\n') h.ptys[0]!.emit(ch);
    expect(h.chunks).toHaveLength(0); // nothing sent before the window closes

    h.tick();

    expect(h.chunks).toHaveLength(1);
    expect(h.chunks[0]?.data).toBe('echo hello\r\n');
  });

  it('drops the oldest bytes when a program is louder than the reader, and says so', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    h.shells.open(owner);

    // Never flushed, so it all piles up — the shape of a slow client rather than
    // a slow program.
    h.ptys[0]!.emit('a'.repeat(MAX_PENDING_BYTES));
    h.ptys[0]!.emit(`b`.repeat(1_000));
    h.tick();

    const data = h.chunks[0]?.data ?? '';
    // The *end* survives, because a terminal is a window onto the end of a
    // stream — and the gap is announced rather than silent.
    expect(data.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(data.endsWith('b'.repeat(1_000))).toBe(true);
    expect(data.length).toBeLessThanOrEqual(MAX_PENDING_BYTES + TRUNCATION_MARKER.length);
  });

  it('refuses to let one client touch another’s terminal', () => {
    const h = harness();
    const mine: Owner = { name: 'my window' };
    const theirs: Owner = { name: 'their phone' };

    const handle = h.shells.open(mine);

    // A shell id is a short guessable string, so ownership is checked rather
    // than assumed — one host serves several clients.
    expect(h.shells.write(theirs, handle.shellId, 'rm -rf /\r')).toBe(false);
    expect(h.shells.resize(theirs, handle.shellId, 10, 10)).toBe(false);
    expect(h.shells.close(theirs, handle.shellId)).toBe(false);
    expect(h.ptys[0]?.written).toEqual([]);
    expect(h.ptys[0]?.killed).toBe(false);

    expect(h.shells.write(mine, handle.shellId, 'ls\r')).toBe(true);
    expect(h.ptys[0]?.written).toEqual(['ls\r']);
  });

  it('routes output only to the client that opened it', () => {
    const h = harness();
    const mine: Owner = { name: 'my window' };
    const theirs: Owner = { name: 'their phone' };

    const a = h.shells.open(mine);
    const b = h.shells.open(theirs);
    h.ptys[0]!.emit('mine\r\n');
    h.ptys[1]!.emit('theirs\r\n');
    h.tick();

    expect(h.chunks).toEqual([
      { shellId: a.shellId, data: 'mine\r\n', owner: mine },
      { shellId: b.shellId, data: 'theirs\r\n', owner: theirs },
    ]);
  });

  it('kills a departing client’s terminals and leaves everyone else’s alone', () => {
    const h = harness();
    const leaving: Owner = { name: 'closing window' };
    const staying: Owner = { name: 'other window' };

    h.shells.open(leaving);
    h.shells.open(leaving);
    h.shells.open(staying);

    // The one place a shell differs from a session or a preview server: it is a
    // view, and a view with no reader is a program blocked on a prompt nobody
    // will answer.
    expect(h.shells.closeOwned(leaving)).toBe(2);
    expect(h.ptys.map((p) => p.killed)).toEqual([true, true, false]);
    expect(h.shells.openCount).toBe(1);
  });

  it('kills everything when the host stops', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    h.shells.open(owner);
    h.shells.open(owner);

    h.shells.closeAll();

    expect(h.ptys.every((p) => p.killed)).toBe(true);
    expect(h.shells.openCount).toBe(0);
  });

  it('does not announce an exit for a terminal somebody closed on purpose', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    const handle = h.shells.open(owner);

    h.shells.close(owner, handle.shellId);
    // The real pty answers a kill with an exit, and forwarding it would tell the
    // closer a thing they did — arriving at a pane that has already unmounted.
    h.ptys[0]!.end(0);

    expect(h.exits).toEqual([]);
  });

  it('flushes what a dying program printed before announcing that it died', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    const handle = h.shells.open(owner);

    h.ptys[0]!.emit('error: no such file\r\n');
    h.ptys[0]!.end(1);

    // The last thing a failing command prints is why it failed, and losing it to
    // the exit it caused is the one gap nobody can work around.
    expect(h.chunks.map((c) => c.data)).toEqual(['error: no such file\r\n']);
    expect(h.exits).toEqual([{ shellId: handle.shellId, exitCode: 1 }]);
    expect(h.shells.openCount).toBe(0);
  });

  it('clamps a size a mid-layout pane produced rather than passing it on', () => {
    const h = harness();
    const owner: Owner = { name: 'window' };
    const handle = h.shells.open(owner, { cols: 0, rows: 0 });

    // Zero columns makes some programs divide by zero, and a hidden pane
    // measuring itself is an ordinary thing to happen. It matters more than it
    // did: a full-screen TUI lays its frame out once, at the size it was given.
    expect(h.spawns[0]?.cols).toBe(1);
    h.shells.resize(owner, handle.shellId, Number.NaN, 999_999);
    expect(h.ptys[0]?.sizes).toEqual([[DEFAULT_COLS, 1000]]);
  });
});

describe('whether this machine can open a terminal at all', () => {
  /**
   * The question a host answers on its handshake, so no client has to guess.
   *
   * What it replaces was `targetKind === 'local'`, which described the world it
   * was written in — a remote host was two bundled `.js` files with no
   * `node_modules` beside them — and was wrong in both directions afterwards: a
   * remote with the pty module deployed can open a terminal, and a cross-built
   * arm64 artifact ships without the prebuild, so a *local* host may not.
   */
  it('answers for this process rather than for its platform', () => {
    const { createRequire } = require('node:module') as typeof import('node:module');
    let loadable = true;
    try {
      createRequire(import.meta.url).resolve('@lydell/node-pty');
    } catch {
      loadable = false;
    }

    // Not hardcoded to `true`: the point is that the answer tracks the module,
    // which is exactly what a machine with no prebuild needs it to do.
    expect(shellsAvailable()).toBe(loadable);
  });
});

describe('the prebuilt pty binary', () => {
  /**
   * The claim this whole dependency choice rests on.
   *
   * `node-pty` proper is built against V8 and needs `electron-rebuild` for
   * Electron — a real cost to a repo whose `electron-builder.yml` says in so
   * many words that it has no native runtime dependencies and therefore no
   * rebuild matrix. `@lydell/node-pty@1.2.0-beta` is Node-API, which is ABI
   * stable across both runtimes, so the same file loads in each.
   *
   * Asserted against the binary rather than against the README: a future bump
   * back to a NAN build would pass every other test in this file and fail only
   * in a packaged app on somebody's machine.
   */
  it('is Node-API, which is why no rebuild step exists', async () => {
    const { readFile } = await import('node:fs/promises');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);

    let binary: string;
    try {
      binary = require.resolve(
        `@lydell/node-pty-${process.platform}-${process.arch}/prebuilds/` +
          `${process.platform}-${process.arch}/${process.platform === 'win32' ? 'conpty' : 'pty'}.node`,
      );
    } catch {
      // A platform with no prebuild is a platform where the terminal is
      // honestly unavailable, which the host reports as `ShellUnavailable`.
      return;
    }

    const symbols = (await readFile(binary)).toString('latin1');
    expect(symbols).toContain('node_api_module_get_api_version_v1');
    // The two markers of a V8/NAN build, which is the one that would need
    // `electron-rebuild` and would break the packaging story.
    expect(symbols).not.toContain('NODE_MODULE_VERSION');
    expect(symbols).not.toContain('Nan::');
  });

  it('opens a real pty in this process and echoes what is typed', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);

    let pty: typeof import('@lydell/node-pty');
    try {
      pty = require('@lydell/node-pty') as typeof import('@lydell/node-pty');
    } catch {
      return; // unsupported platform; see above
    }

    // Through the resolver, which is how the host starts everything now — and
    // on Windows that is not decoration: `pty.spawn` does not expand `PATHEXT`,
    // so a name that is not already a file is a `File not found:` with nothing
    // after the colon.
    const program = findExecutable(defaultShell(), process.env);
    expect(program).not.toBeNull();
    const args = process.platform === 'win32' ? ['/c', 'echo pty-is-real'] : ['-c', 'echo pty-is-real'];
    const term = pty.spawn(program!, args, {
      name: TERM_NAME,
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: terminalEnv(),
    });

    const seen = await new Promise<string>((done) => {
      let out = '';
      term.onData((d) => {
        out += d;
      });
      term.onExit(() => done(out));
      // Not a race the test can lose quietly: a hang here is a broken binary.
      setTimeout(() => done(out), 15_000);
    });

    expect(seen).toContain('pty-is-real');
  }, 20_000);
});
