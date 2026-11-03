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
 * cmd.exe's launcher, which PowerShell finds too (`PATHEXT`). `%` doubled,
 * because in a batch file it begins a variable; a Windows path cannot hold `"`.
 * CRLF, which is what cmd expects of a batch file.
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
