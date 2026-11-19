/**
 * `agbrte` on the PATH of the app's own terminal (DESIGN.md §17 Q24, step 4).
 *
 * A terminal that plays media needs something to ask it to — `agbrte show
 * clip.mp4` — and inside the app there was no `agbrte` to type. The desktop app
 * does not install one: the CLI is a script inside its bundle, run by the
 * bundle's own runtime. So a shell the host starts gets a directory at the
 * front of its PATH holding two launchers, one for POSIX shells and Git Bash,
 * one for cmd.exe and PowerShell, each running *this host's* CLI with *this
 * host's* runtime — the version that matches the terminal drawing its output.
 * A machine with Agbrte installed some other way gets the same, and the host's
 * copy wins because it is first; the alternative is a stale global install
 * answering inside the window of a newer app.
 *
 * ## Why a `.cmd` makes the packaged app's runtime usable here at all
 *
 * `programs.ts` measured that `electron.exe`, started directly in a
 * pseudoconsole by the detached host, writes nothing — a GUI-subsystem binary
 * finds its console through its parent, and the host has none. A launcher typed
 * at a shell has a parent with a console: `cmd.exe` running the `.cmd`, or the
 * shell itself. That is the same middleman `programs.ts` puts in front of the
 * CLI pane, arrived at without having to add it. What it does not fix is
 * input — Electron's stdin is still not the console — so a command that reads
 * the keyboard (`agbrte attach`) is not for this launcher. `show`, `play`, `ls`
 * and `run` only write.
 *
 * ## Where, and named how
 *
 * In the machine directory beside the shell integration's scripts, for the same
 * reason they are there: a launcher on the PATH is code the shell runs as the
 * user, and a shared temp directory is somewhere another account could swap it.
 * Named by its content, which is the two paths it names, so an upgraded app
 * writes a new one rather than editing a file a running shell may be reading.
 *
 * ## Why PowerShell does not hand its arguments to the batch file
 *
 * A batch file's arguments are a command line that cmd.exe parses, and cmd
 * reads `&`, `|`, `<`, `>`, `^` and `%` in it as cmd syntax. PowerShell builds
 * that line itself when it runs a `.cmd`, and Windows PowerShell 5.1 quotes an
 * argument only when it holds a space. Measured on this machine (5.1.26100):
 * `agbrte show 'a b' 'c&d'` reached the CLI as `a b` and `c`, and then cmd ran
 * `d` as a command of its own. A file named `x&calc.png`, tab-completed in
 * PowerShell, would have started the calculator. `%PATH%` in an argument was
 * expanded and a `^` was dropped, which is the same parse corrupting data
 * rather than running it. The split happens while cmd reads the line that
 * starts the batch file, before the batch file's first line runs, so nothing
 * written inside the `.cmd` can undo it; `%*` is not the hole, only where it
 * shows.
 *
 * So in PowerShell `agbrte` is a function (`POWERSHELL_SCRIPT` in
 * integration.ts) that puts its arguments in {@link LAUNCHER_ARGV_ENV} as JSON
 * and runs the batch file with none, and the CLI reads them back
 * ({@link launcherArgv}). The batch file stays the way in because it is what
 * gives Electron a console parent, as above, and it is the reason the arguments
 * cannot simply be passed to `electron.exe` from PowerShell: PowerShell does not
 * wait for a GUI-subsystem program. The function finds the batch file by
 * {@link LAUNCHER_ENV}, which only a PowerShell this host taught is given, and
 * which the script removes before the user's first command. A `.ps1` launcher
 * would have been the other way, and Windows' default execution policy refuses
 * to run one.
 *
 * cmd.exe keeps `%*`. There the line was typed at cmd and is parsed by cmd
 * whatever the launcher does: `agbrte show a&b` runs `b` in any cmd.exe, and
 * quoting it is cmd's own rule rather than a hole of ours.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export interface CliLauncher {
  /** The runtime that runs the CLI: the host's own `process.execPath`. */
  execPath: string;
  /** The CLI bundle beside the host's (`findAgbrteCli`). */
  entry: string;
  /** Whether that runtime is Electron, which runs a script only when told to. */
  electron: boolean;
}

/**
 * The batch launcher's path, given to a PowerShell this host taught so its
 * `agbrte` function can find it. The integration script reads it and unsets it.
 */
export const LAUNCHER_ENV = 'AGBRTE_LAUNCHER';

/** The arguments PowerShell's `agbrte` function passes, as a JSON array of strings. */
export const LAUNCHER_ARGV_ENV = 'AGBRTE_ARGV';

/**
 * The CLI's arguments: its own, or, when it was given none, the ones
 * PowerShell's function left in the environment. `null` when that variable is
 * there and is not an array of strings, which the caller reports rather than
 * running with no arguments, because a mangled `agbrte show x` must not quietly
 * become a bare `agbrte` that opens a session.
 *
 * The variable is removed from `env` either way, so nothing the CLI starts
 * inherits it, and a later `agbrte` started some other way cannot pick up
 * these arguments. Arguments on the command line win over it, so a variable
 * left behind by a PowerShell that died mid-call cannot replace what somebody
 * typed.
 */
export function launcherArgv(argv: readonly string[], env: NodeJS.ProcessEnv): string[] | null {
  const json = env[LAUNCHER_ARGV_ENV];
  delete env[LAUNCHER_ARGV_ENV];
  if (json === undefined || argv.length > 0) return [...argv];
  try {
    const parsed: unknown = JSON.parse(json);
    if (Array.isArray(parsed) && parsed.every((a): a is string => typeof a === 'string')) return parsed;
  } catch {
    // Reported below, by the caller.
  }
  return null;
}

/** POSIX `sh`: single quotes hold everything but a single quote. */
const shQuote = (s: string): string => `'${s.replace(/'/gu, `'\\''`)}'`;

/** A POSIX shell's launcher. Forward slashes, which Git Bash reads in a Windows path and backslashes it may not. */
export function shLauncher(cli: CliLauncher): string {
  const run = `${shQuote(cli.execPath.replace(/\\/gu, '/'))} ${shQuote(cli.entry.replace(/\\/gu, '/'))}`;
  return [
    '#!/bin/sh',
    '# The Agbrte CLI as the host that started this shell runs it (written by the host; see cliOnPath.ts).',
    `${cli.electron ? 'ELECTRON_RUN_AS_NODE=1 ' : ''}exec ${run} "$@"`,
    '',
  ].join('\n');
}

/**
 * cmd.exe's launcher, which PowerShell runs too, but through its function and
 * with no arguments (see the module comment). `%` doubled, because in a batch
 * file it begins a variable; a Windows path cannot hold `"`. CRLF, which is
 * what cmd expects of a batch file.
 */
export function cmdLauncher(cli: CliLauncher): string {
  const q = (s: string): string => `"${s.replace(/%/gu, '%%')}"`;
  return [
    '@echo off',
    'rem The Agbrte CLI as the host that started this shell runs it (written by the host; see cliOnPath.ts).',
    // Off whatever the registry says: with delayed expansion on, a `!` in
    // either path would be read as a variable.
    'setlocal DisableDelayedExpansion',
    ...(cli.electron ? ['set ELECTRON_RUN_AS_NODE=1'] : []),
    `${q(cli.execPath)} ${q(cli.entry)} %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
}

/** Write the launchers under `dir` once, and return the directory to put on the PATH. */
export function writeLaunchers(dir: string, cli: CliLauncher, platform: NodeJS.Platform = process.platform): string {
  const files: Record<string, string> = { agbrte: shLauncher(cli) };
  if (platform === 'win32') files['agbrte.cmd'] = cmdLauncher(cli);
  const hash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const bin = join(dir, `bin-${hash}`);
  if (Object.keys(files).every((name) => existsSync(join(bin, name)))) return bin;
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  for (const [name, content] of Object.entries(files)) {
    const path = join(bin, name);
    if (existsSync(path)) continue;
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o700 });
    try {
      renameSync(temp, path);
    } catch (err) {
      // Two hosts writing the same content at once; see `writeOnce` in integration.ts.
      rmSync(temp, { force: true });
      if (!existsSync(path)) throw err;
    }
  }
  return bin;
}

/**
 * `env` with `bin` first on its PATH. Windows spells the key `Path` and treats
 * it case-insensitively, so the key that is there is the one changed — adding a
 * second `PATH` beside a `Path` leaves which one a child sees to chance.
 */
export function withOnPath(env: NodeJS.ProcessEnv, bin: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key];
  return { ...env, [key]: current === undefined || current === '' ? bin : `${bin}${delimiter}${current}` };
}
