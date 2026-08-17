/**
 * Which program a terminal starts, and where that program actually is
 * (DESIGN.md §7, §3.12).
 *
 * ## The narrowing, restated in one place
 *
 * `Shells` used to answer one question — *the login shell, in the workspace* —
 * and the reason it was safe is that there was nothing to ask for. Now a pane
 * can also open an installed agent CLI, or Agbrte's own, which are two more
 * answers and therefore the first real chances to reopen the hole §7 closed. So
 * the widening is kept to a **selector over a closed set**: a client sends
 * `{kind:'shell'}`, `{kind:'cli', cliId}` or `{kind:'agbrte'}`, and everything
 * else about the spawn — the file, the arguments, the working directory, the
 * environment — is decided here, on the machine that owns the workspace.
 *
 * ## Our own CLI is the third answer, and the one that is *inside* the record
 *
 * `{kind:'agbrte'}` starts `agbrte attach --session <id>` against this host —
 * the same client the window is, over the same socket (§8.1). It exists because
 * a seat with no vendor binary (a harness on a local model) had no interactive
 * interface to offer at all, and a shell prompt is not one.
 *
 * It widens nothing that the other two did not already settle. The entry is
 * found beside *this bundle* rather than on the PATH — a `PATH` lookup for a
 * name like `agbrte` is precisely the hole §7 closed, because a repository is a
 * directory an agent can write to and a `PATH` is a thing a person edits. The
 * runtime is `process.execPath`, which is the binary this host is already
 * running. The only client-supplied string in the spawn is the session id, and
 * it is checked against the UUID shape before it becomes an argv element.
 *
 * The set is not a list maintained beside the runtime picker; it *is* the
 * picker's list. `TerminalPrograms` is built from the same two facts the host
 * already puts on its handshake — the runtime ids it will admit, and the
 * `runtimeNotes` saying what it looked for and could not find — so a CLI the
 * picker offers is a CLI the pane can open, and one the picker explains away is
 * one the pane refuses **with the same sentence**. Two independently computed
 * lists would have been one detection pass cheaper and would have disagreed the
 * first time a machine changed underneath them.
 *
 * ## Interactively, which is the entire point
 *
 * `CliAgentManifest.invoke` describes a *headless* run: `-p`,
 * `--output-format stream-json`, a compiled allowlist, a resume token. None of
 * it appears here. A pane that composed that argv would show a person a stream
 * of NDJSON, which is what the read-only raw pane beside it already shows and
 * shows better. What a person wants from `claude` in a terminal is `claude` —
 * the vendor's own full-screen interface, which is also the only place `/login`
 * exists (a headless seat answers "/login isn't available in this environment").
 *
 * ## Why the path is resolved here rather than left to the spawner
 *
 * Measured, not assumed: `@lydell/node-pty` on Windows resolves a program name
 * by walking `PATH` and testing `dir\name` **verbatim**, with no `PATHEXT`
 * expansion. `pty.spawn('claude', …)` on a machine with `claude.exe` on the PATH
 * therefore throws `File not found:` — with an empty name, because the failing
 * candidate is the empty string it ended on. Meanwhile `detectCli` spawns
 * through Node, which *does* expand `PATHEXT` and reports the CLI present. The
 * two disagreed, and the shape of the disagreement was the worst kind: the
 * picker offered Claude Code, the pane refused it, and the message named
 * nothing.
 *
 * So resolution happens once, here, with the rules the platform actually has,
 * and a failure is a sentence naming what was looked for.
 *
 * **The workspace is deliberately not searched.** Windows' own `CreateProcess`
 * looks in the current directory first; a repository is a directory an agent can
 * write to, so honouring that would let a checkout drop a `claude.exe` beside
 * its README and have the app run it. `PATH` only.
 */

import { accessSync, existsSync, statSync, constants } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_MANIFESTS } from '../runtime/cli/manifests.js';
import { runtimeIdFor } from '../runtime/runtimes/cliStdio.js';
import { isUuid } from '@shared/types/ids.js';
import type { ShellProgram } from '@shared/types/index.js';

/** What the host will actually start, once a selector has been resolved. */
export interface ResolvedProgram {
  /** An absolute path to a real file. Never a name, never a client's string. */
  file: string;
  /**
   * Composed here, never sent. Empty for everything except a wrapper.
   *
   * A **string** means a verbatim Win32 command line, which `node-pty` accepts
   * in place of an argv and which exactly one program needs — see
   * `comspecCommandLine`, where the reason is measured rather than stylistic.
   */
  args: string[] | string;
  /**
   * What a person would call this, for the pane's own label.
   *
   * The manifest's label rather than a prettier one, because it is the string
   * the runtime picker uses for the same tool — a pane that said "Claude" beside
   * a picker that said "Claude Code (installed CLI)" would be two names for one
   * thing in one window.
   */
  label: string;
  /**
   * Changes to the terminal's environment that belong to *this program*.
   *
   * Empty for everything except Agbrte's own CLI, which is a Node script that
   * has to be started by whichever runtime the host is itself running under —
   * `electron.exe` in a packaged app, which runs a script only with
   * `ELECTRON_RUN_AS_NODE` set. `terminalEnv` deletes that switch for exactly
   * the reason this puts it back for one program: inherited, it silently turns
   * any Electron tool a person starts from the pane into headless Node with no
   * window, and *not* inherited, the one program that genuinely needs it does
   * not start at all. Per-program rather than per-terminal is the only shape
   * that gets both right.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * What to *say* is running, when that is not the file that was started.
   *
   * Only a wrapper needs this, and only because the pane's `program` line is
   * documented as the literal answer to "what is actually running" — which a
   * person reads when something is behaving unexpectedly. Started through the
   * Windows shell relay, the literal answer is `C:\WINDOWS\system32\cmd.exe`,
   * which is true, useless, and reads like a bug. The useful answer names the
   * runtime and the bundle, so this carries it and `file` stays exactly what was
   * spawned.
   */
  display?: string;
}

/**
 * What the host knows about the pane that is asking, which the client does not.
 *
 * `sessionId` arrives from the client and `workspaceRoot` does not, and the
 * difference is deliberate: the session id becomes an *argument* to Agbrte's own
 * CLI, so it is the one client-supplied string in this file that reaches an
 * argv. It is checked against the UUID shape before it does, which is what keeps
 * "name a session" from becoming "name anything" — and it is passed as an argv
 * element rather than spliced into a command string, so even a well-formed id is
 * data on the far side.
 */
export interface ProgramContext {
  /** The session the pane is showing. Only Agbrte's own CLI uses it. */
  sessionId?: string;
  /** The host's own workspace. Never a client's path. */
  workspaceRoot?: string;
}

/**
 * A program this host will not start, and why in the words the client saw.
 *
 * Its own class so `sessionServer` can let it through `reply` unchanged: the
 * `name` crosses the wire, and a client that wants to tell "not installed" from
 * "the host is broken" has it without parsing prose.
 */
export class ProgramRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ProgramRefused';
  }
}

/**
 * Which shell to start when nobody named a CLI.
 *
 * `AGBRTE_SHELL` first, because "my shell" is a thing people are particular
 * about and a machine cannot infer it. Then the platform's own answer: `COMSPEC`
 * on Windows and `SHELL` elsewhere, both of which are set by whatever logged the
 * user in. The final fallbacks exist because a detached host started by an app
 * can inherit a surprisingly empty environment, and a terminal that refuses to
 * open because a variable is unset is worse than one that opens on `sh`.
 */
export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env['AGBRTE_SHELL'];
  if (chosen !== undefined && chosen.trim() !== '') return chosen;
  if (process.platform === 'win32') return env['COMSPEC'] ?? 'cmd.exe';
  return env['SHELL'] ?? '/bin/sh';
}

/** Finds a name on the PATH, or answers `null`. Injectable for tests. */
export type Lookup = (name: string, env: NodeJS.ProcessEnv) => string | null;

/** Where this module ended up, which for a bundle is the bundle's own directory. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Every place Agbrte's own CLI bundle can legitimately be, relative to the host.
 *
 * Four layouts, all of them real, and none of them is "wherever the PATH says":
 *
 *  - `AGBRTE_CLI_ENTRY`, for a deployment that resembles none of the others.
 *  - `../cli/agbrte.js` — the `dist` tree, an `npm i -g` package, a server
 *    install (`~/.agbrte/main/agbrteHost.js` beside `~/.agbrte/cli/agbrte.js`),
 *    **and a packaged desktop app**, where it is a path inside `app.asar` and
 *    Electron's asar-aware `fs` answers for it. That last one is measured
 *    rather than assumed — see the note below.
 *  - `agbrte.js` beside us, which is what `agbrte serve` is: that command runs
 *    the host *inside the CLI bundle*, so this module's own file already is the
 *    CLI and the candidate resolves to it.
 *  - the same tree with `app.asar.unpacked` swapped back to `app.asar`, for a
 *    host started from the unpacked copy rather than through the archive.
 *
 * ## The packaged case, verified rather than assumed
 *
 * `dist/cli` is inside `app.asar` while `dist/main/agbrteHost.js` is unpacked
 * (it has to be — a process cannot be given a path inside an archive), so the
 * obvious worry is that the sibling lookup lands in the wrong tree and that a
 * script inside an archive cannot be run at all. Both were checked against a
 * real `electron-builder --dir` output:
 *
 * ```
 * ELECTRON_RUN_AS_NODE=1 Agbrte.exe resources/app.asar/dist/cli/agbrte.js --version
 * 0.0.6
 * ```
 *
 * and `existsSync` on that same path answers `true` in that mode, because
 * `ELECTRON_RUN_AS_NODE` keeps Electron's asar patching. So the packaged app
 * starts its own CLI by the *same* trick it starts its session host with, and
 * the archive is not in the way. `process.versions.electron` is defined there
 * too, which is what `agbrteEnv` below keys off.
 */
export function agbrteCliCandidates(
  here: string = HERE,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const override = env['AGBRTE_CLI_ENTRY'];
  if (override !== undefined && override.trim() !== '') return [resolvePath(override)];

  const trees = [here];
  const unpacked = `app.asar.unpacked${sep}`;
  if (here.includes(unpacked)) trees.push(here.replace(unpacked, `app.asar${sep}`));

  return trees.flatMap((tree) => [
    resolvePath(tree, '../cli/agbrte.js'),
    resolvePath(tree, 'agbrte.js'),
  ]);
}

/** The first candidate that is really there. Injectable so a test needs no tree. */
export function findAgbrteCli(
  here: string = HERE,
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string | null {
  return agbrteCliCandidates(here, env).find((path) => exists(path)) ?? null;
}

/**
 * The switch that lets `electron.exe` run a script, added back for one program.
 *
 * See `ResolvedProgram.env`: `terminalEnv` deletes it for everything, and this
 * is the one thing in the pane that is *ours* and is a Node script rather than a
 * program on the machine.
 */
function agbrteEnv(): NodeJS.ProcessEnv | undefined {
  return process.versions.electron === undefined ? undefined : { ELECTRON_RUN_AS_NODE: '1' };
}

/**
 * Whether this host has to start its own CLI through the Windows shell.
 *
 * ## Two measurements, because nothing about this is guessable
 *
 * `electron.exe` is a **GUI-subsystem** binary, and inside a ConPTY that costs
 * both directions:
 *
 *  - **Nothing comes out.** Started directly in a pty it runs perfectly and says
 *    nothing: the process starts, exits 0, `process.stdout.isTTY` inside it is
 *    `true`, and **zero bytes** reach the pty's reader. Measured on Windows 11
 *    with `@lydell/node-pty` in all four spawn shapes the library offers (ConPTY,
 *    the ConPTY DLL, winpty, `windowsHide` either way) — `bytes=0` for every one,
 *    while a plain `node.exe` in the same harness echoed immediately. Electron
 *    under `ELECTRON_RUN_AS_NODE` reattaches its streams to its *parent's*
 *    console, and a session host is spawned detached with `stdio: 'ignore'`, so
 *    there is no console up the chain to find. A console-subsystem process in
 *    between — `cmd.exe` — is one, and then output flows. It is also why
 *    `code --version` prints in a Windows terminal and this did not: `code.cmd`
 *    is exactly this middleman.
 *  - **Nothing goes in.** With `cmd.exe` in front, output works and stdin is
 *    still dead: `process.stdin.isTTY` is `undefined` inside Electron and the
 *    first read is EOF, so an interactive CLI printed its banner and exited
 *    ("readline was closed") before a key could be pressed. `<CON` does not fix
 *    it. What does, measured the same way, is giving Electron a **pipe** instead
 *    of the console: `echo hi | electron script` reads fine, and `type CON |` is
 *    that pipe with the console on the other end of it.
 *
 * So on Windows under Electron the pane runs `cmd /d /s /c "type CON | …"`, and
 * everywhere else it starts the file directly. A host running under a real
 * `node` — the CLI's own, a server install — needs none of this, because
 * `node.exe` is console-subsystem and talks to a pty like anything else.
 *
 * ## What the relay costs, stated because a person will notice
 *
 * The console stays in line mode, so editing and echo are the console's rather
 * than readline's: a line is sent on Enter, which is exactly what `agbrte
 * attach` is built for (§8.1 — line-based, no TUI, because the first place it
 * runs is an ssh session). `process.stdin.isTTY` is false inside the CLI, so it
 * takes its own non-TTY path: no prompt redraw, no colour. Ctrl-C reaches the
 * console rather than readline's `SIGINT`, so it ends the client instead of
 * interrupting the turn — and because leaving is not stopping (§8.1), the
 * session carries on and the pane can be reopened.
 */
function needsShellRelay(): boolean {
  return process.platform === 'win32' && process.versions.electron !== undefined;
}

/**
 * `cmd /d /s /c "type CON | "prog" "arg" …"`, quoted so a path with a space in
 * it survives.
 *
 * Not the same thing as handing `['/c', file, …]` to the spawner, and the
 * difference is a bug that would only appear on somebody else's machine:
 * `node-pty` joins an argv with the `CommandLineToArgvW` convention, and
 * `cmd.exe` does not parse its command line that way. `cmd /c "C:\Program
 * Files\nodejs\node.exe" "…"` fails with `'C:\Program' is not recognized`, which
 * reads like a broken PATH and is a quoting mismatch — and `%LOCALAPPDATA%`
 * contains the user's name, so "a path with a space" is `C:\Users\Jane Smith\…`,
 * not a corner case.
 *
 * `/s` plus the doubled outer quotes is the documented escape: with `/s`, cmd
 * strips exactly the first and last character and takes the rest verbatim. So
 * `node-pty` is given the whole line as a **string** — a shape it supports for
 * precisely this reason — instead of an argv it would re-quote.
 *
 * Verified rather than reasoned: with a program under `C:\Program Files`, a
 * script under `…\dir with space\`, and an argument holding `q & a`, every one
 * arrives at the child intact and the `&` is data rather than a command
 * separator, because it is inside the inner quotes.
 */
export function comspecCommandLine(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  relayStdin = true,
): { file: string; args: string } {
  for (const part of [file, ...args]) {
    // A double quote is the one character this quoting cannot carry, and a
    // Windows path cannot contain one — so this never fires, and if it ever
    // does, refusing is the only honest answer. Sanitising would silently run
    // something other than what was asked for.
    if (part.includes('"')) {
      throw new ProgramRefused(
        `this host cannot start ${quote(part)} in a terminal: a double quote cannot be passed ` +
          'through the Windows command processor safely',
      );
    }
  }
  const quoted = [file, ...args].map((part) => `"${part}"`).join(' ');
  return {
    file: env['COMSPEC'] ?? 'cmd.exe',
    args: `/d /s /c "${relayStdin ? 'type CON | ' : ''}${quoted}"`,
  };
}

/**
 * Extensions Windows will append to a bare name, in the order it tries them.
 *
 * Each is tried lowercased *first*, then as `PATHEXT` spells it. Not pedantry:
 * `PATHEXT` is conventionally uppercase and files on disk are conventionally
 * not, so matching the declared spelling first resolves `claude` to
 * `…\claude.EXE` — which runs fine, because the filesystem is case-insensitive,
 * and then appears in the pane's label and in every diagnostic as a name that
 * does not exist on disk. Both spellings are tried rather than only the lower
 * one because per-directory case sensitivity is a thing NTFS can be told to do.
 */
function extensions(env: NodeJS.ProcessEnv): string[] {
  if (process.platform !== 'win32') return [''];
  const declared = env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  // The empty one first: a selector that already carries `.exe` must not become
  // `claude.exe.exe`, and an extensionless script on a PATH is still a thing.
  const out = [''];
  for (const raw of declared.split(';')) {
    const ext = raw.trim();
    if (ext === '') continue;
    for (const spelling of [ext.toLowerCase(), ext]) {
      if (!out.includes(spelling)) out.push(spelling);
    }
  }
  return out;
}

function runnable(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    // Not on Windows: `X_OK` is meaningless there and `accessSync` answers yes
    // for every readable file, so the extension list above is the real filter.
    if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a program name lives on this machine.
 *
 * The rules the platform actually has, rather than the ones a spawner claims:
 * `PATHEXT` on Windows, the executable bit elsewhere, and no current-directory
 * search on either (see the header).
 */
export const findExecutable: Lookup = (name, env) => {
  const exts = extensions(env);

  // Already a path — an `AGBRTE_SHELL` of `/bin/zsh`, or a `COMSPEC`. Checked
  // rather than trusted, so a stale variable fails with a sentence naming it.
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    for (const ext of exts) {
      if (runnable(name + ext)) return name + ext;
    }
    return null;
  }

  const path = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir.trim() === '') continue;
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (runnable(candidate)) return candidate;
    }
  }
  return null;
};

/** The emulator we actually are, claimed in one place (see `terminalEnv`). */
export const TERM_NAME = 'xterm-256color';

/**
 * What the pane calls our own CLI, in one place because three layers say it.
 *
 * "Agbrte CLI" and not "Agbrte": the window is Agbrte too, and a pane inside it
 * labelled with the product's bare name says nothing about what is running. The
 * sentence beside it carries the part that matters — that this one *is* in the
 * transcript — because a label is not the place to make a promise.
 */
export const AGBRTE_CLI_LABEL = 'Agbrte CLI';

/**
 * The environment a terminal's program gets.
 *
 * Two changes to this host's own, and both are about *this host* rather than
 * about the program:
 *
 *  - `ELECTRON_RUN_AS_NODE` is deleted. The session host is started as
 *    `electron.exe` with that set, and it is inherited by everything it spawns —
 *    so an Electron-based tool launched from this pane would silently come up as
 *    plain Node with no window. `scripts/launch.mjs` and the e2e harness both
 *    already delete it for the same reason; a terminal is the third place a
 *    person can reach one.
 *  - `TERM` is set, because a full-screen TUI reads it to decide what it may
 *    draw and Windows sets it for nobody. `xterm-256color` is what the far end
 *    genuinely is — xterm.js implements the 256-colour palette *and* 24-bit SGR,
 *    which is measurable rather than hopeful: a real `claude` in this pane emits
 *    `38;2;r;g;b` and it renders.
 *
 * Nothing else is scrubbed. A terminal whose environment does not match the rest
 * of the machine is a terminal that cannot be used to debug the machine, which
 * is most of what people open one for.
 */
export function terminalEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env['ELECTRON_RUN_AS_NODE'];
  env['TERM'] = TERM_NAME;
  return env;
}

export interface TerminalProgramsOptions {
  /**
   * Runtime ids this host will admit — `HostIdentity.runtimes`, verbatim.
   *
   * The picker's list and this list are the same list, which is the property
   * that stops the pane offering a CLI the host would refuse, or refusing one it
   * offers.
   */
  runtimeIds?: readonly string[];
  /** `HostIdentity.runtimeNotes`, verbatim, so a refusal repeats what was shown. */
  notes?: readonly { id: string; reason: string }[];
  env?: NodeJS.ProcessEnv;
  /** Injectable so a test needs no binaries on disk. */
  lookup?: Lookup;
  /**
   * Where Agbrte's own CLI bundle is, when it is not where it usually is.
   *
   * Present so a test can name one without a `dist` tree, and so an embedding
   * that lays its files out differently has an answer that is not an
   * environment variable. Absent means `findAgbrteCli` decides, which is what
   * every shipped layout does.
   */
  cliEntry?: string;
}

/**
 * The closed set of programs one host will start in a terminal.
 *
 * Constructed with no ids — the default — this is a host that offers a shell and
 * refuses every CLI by name. That is the honest answer for the embeddings that
 * build a `SessionHostServer` without an agent host behind it (`agbrte serve`, a
 * test), and it is a refusal rather than a silent fallback to the shell: opening
 * a pane that says "Claude Code" onto a PowerShell prompt would be a lie told in
 * the one place the label is load-bearing.
 */
export class TerminalPrograms {
  private readonly detected: ReadonlySet<string>;
  private readonly refusals: ReadonlyMap<string, string>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly lookup: Lookup;
  private readonly cliEntry: string | undefined;

  constructor(opts: TerminalProgramsOptions = {}) {
    const ids = new Set(opts.runtimeIds ?? []);
    this.detected = new Set(
      CLI_MANIFESTS.filter((m) => ids.has(runtimeIdFor(m))).map((m) => m.cliId),
    );

    const refusals = new Map<string, string>();
    for (const note of opts.notes ?? []) {
      const manifest = CLI_MANIFESTS.find((m) => runtimeIdFor(m) === note.id);
      if (manifest !== undefined) refusals.set(manifest.cliId, note.reason);
    }
    this.refusals = refusals;

    this.env = opts.env ?? process.env;
    this.lookup = opts.lookup ?? findExecutable;
    this.cliEntry = opts.cliEntry;
  }

  /** The CLIs this host would open a pane on. For diagnostics and for tests. */
  get available(): string[] {
    return [...this.detected];
  }

  /**
   * Turn a selector into something spawnable, or refuse and say why.
   *
   * The whole of the client's influence over the spawn passes through this
   * function, and it is a `switch` over three literals for exactly that reason:
   * an unrecognised shape falls through to a refusal rather than to a default,
   * because a selector this host does not understand is a client that believes
   * something untrue about it.
   *
   * `context` is the host's own knowledge and is never merged with the client's:
   * the workspace comes from `Shells`, and the session id — the only part of it
   * that did come off a socket — is admitted only in the UUID shape a session id
   * has, and only as an argv element.
   */
  resolve(program: ShellProgram | undefined, context: ProgramContext = {}): ResolvedProgram {
    const chosen: ShellProgram = program ?? { kind: 'shell' };

    switch (chosen.kind) {
      case 'shell': {
        const name = defaultShell(this.env);
        return { ...this.locate(name, shellMissing(name)), label: 'Your shell' };
      }

      case 'cli': {
        const manifest = CLI_MANIFESTS.find((m) => m.cliId === chosen.cliId);
        if (manifest === undefined) {
          throw new ProgramRefused(
            `${quote(chosen.cliId)} is not a CLI this app knows about — it knows ` +
              `${CLI_MANIFESTS.map((m) => `“${m.cliId}”`).join(' and ')}`,
          );
        }
        if (!this.detected.has(manifest.cliId)) {
          // The picker's own sentence where there is one. A second explanation
          // written here would drift from the one already on screen, and the
          // person reading it has just been told something different.
          const note = this.refusals.get(manifest.cliId);
          throw new ProgramRefused(
            note !== undefined
              ? `${manifest.label} is not available on this host — ${note}`
              : `${manifest.label} was not detected on this host, so there is nothing to open a ` +
                'terminal on. Install it on the machine that owns this workspace and restart the host.',
          );
        }

        const binary = manifest.detect.binary;
        return {
          // No `invoke.baseArgs`: that is the headless argv a turn composes, and
          // this is the interface a person drives. See the header.
          ...this.locate(binary, cliMissing(manifest.label, binary)),
          label: manifest.label,
        };
      }

      /**
       * Our own client, pointed at the session the pane is showing.
       *
       * Three decisions, each of which had an easier wrong answer:
       *
       *  - **`process.execPath`, not a `node` from the PATH.** This host is
       *    already running the bundle's runtime — `electron.exe` in a packaged
       *    app, a private Node on a server — and that is the one interpreter
       *    known to be able to run our own bundle. Reaching for `node` on the
       *    PATH would fail on every machine that has no Node installed, which
       *    is every machine the desktop app is installed on, and would silently
       *    pick a different version on the ones that do.
       *  - **The entry is found beside this bundle, never looked up by name.**
       *    See `agbrteCliCandidates`. A `PATH` search for `agbrte` would run
       *    whatever a workspace, or a stale global install, happened to put
       *    there — under our own label, inside our own window.
       *  - **The session id is required and shape-checked.** The pane's whole
       *    point is attaching to *this* session; without an id the CLI would
       *    ask the person to pick one, which is a second session list inside a
       *    window that is already showing one, and with an unchecked id it
       *    would be the first client-supplied string in this file to reach an
       *    argv. `--session` is honoured by `agbrte attach` and refuses an id
       *    this host does not have, so a well-formed lie is answered by the CLI
       *    naming it rather than by anything being run.
       */
      case 'agbrte': {
        const entry = this.cliEntry ?? findAgbrteCli(HERE, this.env);
        if (entry === null) {
          throw new ProgramRefused(
            'this host has no Agbrte CLI bundle beside it, so it cannot open one on this ' +
              `session. Looked for: ${agbrteCliCandidates(HERE, this.env).join(', ')}`,
          );
        }
        const sessionId = context.sessionId;
        if (sessionId === undefined || !isUuid(sessionId)) {
          throw new ProgramRefused(
            'the Agbrte CLI opens on a session and this pane named ' +
              `${sessionId === undefined ? 'none' : quote(sessionId)}, which is not a session id`,
          );
        }

        const env = agbrteEnv();
        // `attach` with a path, so the CLI does not depend on inheriting a
        // `cwd` — it gets one from `Shells`, and saying it out loud means a
        // future change there cannot quietly point this at another workspace.
        const argv = [entry, 'attach', context.workspaceRoot ?? process.cwd(), '--session', sessionId];

        return {
          // On Windows under Electron this is `cmd.exe` with the whole thing as
          // one command line, because a GUI-subsystem binary in a pseudoconsole
          // can neither write to it nor read from it. See `needsShellRelay`.
          ...(needsShellRelay()
            ? {
                ...comspecCommandLine(process.execPath, argv, this.env),
                // `cmd.exe` is what starts, and is not what a person wants to
                // read above a pane that says "Agbrte CLI".
                display: `${process.execPath} ${entry}`,
              }
            : { file: process.execPath, args: argv }),
          label: AGBRTE_CLI_LABEL,
          ...(env === undefined ? {} : { env }),
        };
      }

      default: {
        // A selector off the wire that is none of them. Narrowed to `never`, so
        // a new member of `ShellProgram` is a compile error here rather than a
        // shape that silently opens a shell — and this is also the sentence an
        // *older* host gives a newer client that asks for a kind it predates,
        // which is why it lists what it does have rather than only refusing.
        const unknown: never = chosen;
        throw new ProgramRefused(
          `${quote((unknown as { kind?: unknown }).kind)} is not a kind of program this host ` +
            'can start — the choices are its own shell, the CLIs it detected, and Agbrte’s own',
        );
      }
    }
  }

  /**
   * A real file, or a refusal that names what was looked for.
   *
   * `.cmd` and `.bat` are wrapped rather than refused, because that is how npm
   * installs a CLI on Windows — `gemini` is `gemini.cmd` on most machines that
   * have it — and `CreateProcess`, which is what a pty ends up calling, cannot
   * start either directly. The wrapper is composed here from `COMSPEC`; the
   * shim's path is an argv element rather than a piece of a command string, so a
   * directory with a space or an ampersand in it stays data.
   */
  private locate(
    name: string,
    refusal: (env: NodeJS.ProcessEnv) => string,
  ): { file: string; args: string[] } {
    const found = this.lookup(name, this.env);
    if (found === null) throw new ProgramRefused(refusal(this.env));
    return throughComspec(found, this.env) ?? { file: found, args: [] };
  }
}

/** A shim `CreateProcess` cannot start, and the argv that runs it anyway. */
export function throughComspec(
  file: string,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[] } | null {
  if (process.platform !== 'win32') return null;
  if (!/\.(cmd|bat)$/i.test(file)) return null;
  return { file: env['COMSPEC'] ?? 'cmd.exe', args: ['/c', file] };
}

/**
 * Something a client sent, put into a sentence a person will read.
 *
 * Bounded and stringified, because every refusal above quotes back the id it was
 * given and that id came off a socket. A hostile client cannot inject anything
 * through it — the message is rendered as text, and the message is all it
 * becomes — but a megabyte of it would still travel to every open pane and sit
 * in the host's logs, and a refusal is not a place that needs more than a name.
 */
function quote(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”`;
}

function shellMissing(name: string) {
  return (env: NodeJS.ProcessEnv): string =>
    `this host cannot find a shell to start: \`${name}\` is not on its PATH` +
    `${env['AGBRTE_SHELL'] === undefined ? '' : ' (it came from AGBRTE_SHELL)'}`;
}

function cliMissing(label: string, binary: string) {
  return (): string =>
    `${label} was detected on this host, but \`${binary}\` could not be found on the PATH the ` +
    'host was started with — a terminal starts a program by path, so it has to resolve to a real file';
}
