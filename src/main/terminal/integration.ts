/**
 * Teaching a shell to say where its commands are (DESIGN.md §17 Q23, step 1).
 *
 * `marks.ts` reads `OSC 133` and `OSC 633` out of a terminal's output. Shells do
 * not write those on their own; this is the part that makes them. When the pane
 * opens the user's shell — not a CLI, not our own client — the host starts it
 * with a small startup script that wraps the prompt in marks, reports each
 * command line exactly where the shell can, and then gets out of the way.
 *
 * ## The user's own setup comes first, always
 *
 * Every script reads the user's startup files before it adds anything —
 * `~/.bashrc`, the zsh files under the user's own `ZDOTDIR`, the PowerShell
 * profile (which PowerShell loads itself before `-EncodedCommand` runs) — and
 * wraps whatever prompt they produced rather than replacing it. A terminal whose
 * prompt changed because of a feature the person did not ask for has stopped
 * being their terminal. The marks themselves draw nothing: an `OSC` a terminal
 * does not use is not displayed.
 *
 * ## Four shells, three levels
 *
 *   - **bash** (4.4 and later): prompt marks from `PROMPT_COMMAND` and `PS1`, the
 *     start of output from `PS0`, the exit status from `$?`, and the command line
 *     from history — *only* when history recorded it. A line history skipped
 *     (`HISTCONTROL=ignorespace`, a repeat under `ignoredups`, history off) is
 *     left to the echo rather than reported as the previous command, which is
 *     what reading `history 1` blindly would do. Older bash has no `PS0`, so it
 *     gets prompts and status but no output mark: blocks are still found.
 *   - **zsh**: `precmd` and `preexec`, which hand over the line exactly.
 *   - **PowerShell** (Windows PowerShell 5.1 and `pwsh`): the `prompt` function,
 *     wrapped; and `PSConsoleHostReadLine`, wrapped, for the exact line and the
 *     start of output where PSReadLine is loaded.
 *   - **cmd.exe**: only its `PROMPT` can be taught, so only prompts are marked.
 *     Blocks are found; the command comes from the echo and the status is
 *     unknown — `marks.ts` says `null` rather than guessing.
 *
 * Anything else — `sh`, `fish`, a shell started with arguments — is opened
 * exactly as before, unmarked, and the pane says it has no blocks.
 *
 * ## Where the scripts are written, and why not /tmp
 *
 * A startup script is code the shell runs as the user. Written to a shared
 * `/tmp`, another account on the same machine could replace it between the
 * write and the read and run its own code in this person's shell. So they go in
 * the machine directory (§5.1) — `~/.agbrte/shell`, private, honouring
 * `AGBRTE_HOME` — named by their own content, so one host writes each version
 * once and two starting at the same moment cannot interleave a half-written file.
 *
 * `AGBRTE_SHELL_INTEGRATION=0` turns all of it off, for a shell this breaks.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { machineRoot } from '../../host/machine.js';
import type { IntegrationLevel } from '@shared/terminal/marks.js';

export type ShellKind = 'bash' | 'zsh' | 'powershell' | 'cmd';

/**
 * Which shell a file is, by its name; `null` for one this cannot teach.
 *
 * Split on both separators rather than with `path.basename`, which on Linux
 * and macOS does not treat a backslash as one — so `C:\...\pwsh.exe` was a
 * file called all of that, and CI on those machines said so.
 */
export function shellKind(file: string): ShellKind | null {
  const name = (file.split(/[\\/]/u).pop() ?? '').toLowerCase().replace(/\.exe$/u, '');
  if (name === 'bash') return 'bash';
  if (name === 'zsh') return 'zsh';
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  return null;
}

/** A shell, ready to start with the marks taught. */
export interface Integrated {
  file: string;
  args: string[] | string;
  env: NodeJS.ProcessEnv;
  /** Which shell was taught, or `null` when this one was started as it was. */
  shell: ShellKind | null;
  /** What it was taught to say. Older shells can say less, and `marks.ts` notices. */
  level: IntegrationLevel;
}

/*
 * The scripts. Written with `§{` where the shell needs `${`, because a template
 * literal would read `${` as its own interpolation; `script()` puts it back.
 * Everything else is exactly what the shell receives.
 */
const script = (text: string): string => text.replace(/§\{/gu, '${');

export const BASH_SCRIPT = script(String.raw`# Agbrte shell integration for bash (DESIGN.md §17 Q23). Written by the Agbrte host on start.
# The user's own startup first: started with --init-file, bash reads this instead of ~/.bashrc.
if [ -z "§{__AGBRTE_INTEGRATED-}" ]; then
  __AGBRTE_INTEGRATED=1
  if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

  __agbrte_started=
  __agbrte_hist=
  __agbrte_histnum() {
    local line
    line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
    line=§{line#"§{line%%[![:space:]]*}"}
    printf '%s' "§{line%%[!0-9]*}"
  }
  __agbrte_precmd() {
    local code=$?
    if [ -n "$__agbrte_started" ]; then printf '\033]133;D;%s\007' "$code"; fi
    __agbrte_started=1
    __agbrte_hist=$(__agbrte_histnum)
    printf '\033]133;A\007'
    return $code
  }
  __agbrte_ps1() {
    case "$PS1" in
      *'133;B'*) ;;
      *) PS1="$PS1"'\[\033]133;B\007\]' ;;
    esac
  }
  __agbrte_preexec() {
    local line num
    line=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
    line=§{line#"§{line%%[![:space:]]*}"}
    num=§{line%%[!0-9]*}
    # Only a line history just recorded. Anything else is the previous command,
    # and reporting it would name the wrong thing as having run.
    if [ -n "$num" ] && [ "$num" != "$__agbrte_hist" ]; then
      line=§{line#"$num"}
      line=§{line#\*}
      line=§{line#"§{line%%[![:space:]]*}"}
      line=§{line//\\/\\\\}
      line=§{line//;/\\x3b}
      line=§{line//$'\n'/\\x0a}
      printf '\033]633;E;%s\007' "$line"
    fi
    printf '\033]133;C\007'
  }
  PS0="§{PS0-}"'$(__agbrte_preexec)'
  PROMPT_COMMAND="__agbrte_precmd§{PROMPT_COMMAND:+;$PROMPT_COMMAND};__agbrte_ps1"
fi
`);

/** zsh reads these from `ZDOTDIR`; each hands over to the user's own first. */
export const ZSH_FILES: Readonly<Record<string, string>> = {
  '.zshenv': script(String.raw`# Agbrte shell integration for zsh. Written by the Agbrte host on start.
__agbrte_zdotdir=$ZDOTDIR
ZDOTDIR=§{AGBRTE_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshenv ]] && . $ZDOTDIR/.zshenv
AGBRTE_USER_ZDOTDIR=$ZDOTDIR
# Back to ours for the files zsh reads next; .zshrc restores the user's.
ZDOTDIR=$__agbrte_zdotdir
`),
  '.zprofile': script(String.raw`__agbrte_zdotdir=$ZDOTDIR
ZDOTDIR=§{AGBRTE_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zprofile ]] && . $ZDOTDIR/.zprofile
ZDOTDIR=$__agbrte_zdotdir
`),
  '.zshrc': script(String.raw`ZDOTDIR=§{AGBRTE_USER_ZDOTDIR:-$HOME}
[[ -r $ZDOTDIR/.zshrc ]] && . $ZDOTDIR/.zshrc

__agbrte_started=
__agbrte_precmd() {
  local code=$?
  [[ -n $__agbrte_started ]] && printf '\033]133;D;%s\007' $code
  __agbrte_started=1
  printf '\033]133;A\007'
  return $code
}
__agbrte_preexec() {
  local line=$1
  line=§{line//\\/\\\\}
  line=§{line//;/\\x3b}
  line=§{line//$'\n'/\\x0a}
  printf '\033]633;E;%s\007\033]133;C\007' "$line"
}
__agbrte_ps1() {
  [[ $PS1 == *'133;B'* ]] || PS1="$PS1"$'%{\e]133;B\a%}'
}
# First, so it reads the status before anything else can change it; the prompt
# check last, after every theme has had its turn at PS1.
precmd_functions=(__agbrte_precmd $precmd_functions __agbrte_ps1)
preexec_functions=($preexec_functions __agbrte_preexec)
`),
};

/*
 * No backticks in here: PowerShell's escape character is the template literal's
 * delimiter, so control characters are spelled `[char]27` and `[char]7`.
 */
export const POWERSHELL_SCRIPT = String.raw`# Agbrte shell integration for PowerShell. Sent by the Agbrte host on start; the profile has already run.
if ($null -eq $global:__agbrteOriginalPrompt) {
  $global:__agbrteOriginalPrompt = $function:prompt
  $global:__agbrteStarted = $false
  function global:prompt {
    $ok = $?
    $code = if ($ok) { 0 } elseif ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 }
    $e = [char]27; $b = [char]7
    $out = ''
    if ($global:__agbrteStarted) { $out += "$e]133;D;$code$b" }
    $global:__agbrteStarted = $true
    $out += "$e]133;A$b"
    $out += [string](& $global:__agbrteOriginalPrompt)
    $out += "$e]133;B$b"
    $out
  }
  # PSReadLine's own function, wrapped rather than re-implemented. This called
  # [PSConsoleReadLine]::ReadLine directly, which PSReadLine 2.3 (pwsh 7.4)
  # answers with an empty line at once, for ever: the prompt looped without
  # waiting for a key. Its function knows its own signature.
  $global:__agbrteReadLine = $function:PSConsoleHostReadLine
  if ($null -ne $global:__agbrteReadLine) {
    function global:PSConsoleHostReadLine {
      $line = [string](& $global:__agbrteReadLine)
      $e = [char]27; $b = [char]7
      $safe = $line.Replace('\', '\\').Replace(';', '\x3b').Replace([string][char]10, '\x0a').Replace([string][char]13, '\x0d')
      [Console]::Write("$e]633;E;$safe$b$e]133;C$b")
      $line
    }
  }
}
`;

/**
 * cmd.exe's prompt, marked. `$e` is ESC in a `PROMPT`, and `$e\` is the string
 * terminator — the only one cmd can write, which is why `marks.ts` accepts it.
 */
export function cmdPrompt(existing: string | undefined): string {
  const base = existing !== undefined && existing.trim() !== '' ? existing : '$P$G';
  return `$e]133;D$e\\$e]133;A$e\\${base}$e]133;B$e\\`;
}

/** Where the scripts go: the machine directory, never a shared temp directory. */
export function integrationDir(): string {
  return join(machineRoot(), 'shell');
}

/** Write `content` under a name derived from it, once, atomically. */
function writeOnce(dir: string, stem: string, content: string): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const path = join(dir, `${stem}-${hash}`);
  if (!existsSync(path)) {
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    try {
      renameSync(temp, path);
    } catch (err) {
      // Two hosts starting together both found it missing. On Windows the
      // second rename onto a file the first just put there can be refused
      // while a shell has it open — and the file it was refused for is this
      // one, byte for byte, because the name is its hash.
      rmSync(temp, { force: true });
      if (!existsSync(path)) throw err;
    }
  }
  return path;
}

/**
 * Start `program` with the marks taught, or exactly as it was when this shell
 * cannot be taught, was given arguments, or integration is turned off.
 */
export function integrate(
  program: { file: string; args: string[] | string; env?: NodeJS.ProcessEnv },
  opts: { env: NodeJS.ProcessEnv; dir?: string },
): Integrated {
  const untouched: Integrated = {
    file: program.file,
    args: program.args,
    env: { ...(program.env ?? {}) },
    shell: null,
    level: 'none',
  };
  // Arguments mean somebody chose how this shell starts — through `cmd.exe` for
  // a shim, or by naming flags — and adding ours could contradict them.
  if (typeof program.args === 'string' || program.args.length > 0) return untouched;
  if (opts.env['AGBRTE_SHELL_INTEGRATION'] === '0') return untouched;
  const kind = shellKind(program.file);
  if (kind === null) return untouched;

  const dir = opts.dir ?? integrationDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const env = { ...(program.env ?? {}) };

  switch (kind) {
    case 'bash': {
      const path = writeOnce(dir, 'bash', BASH_SCRIPT);
      return { file: program.file, args: ['--init-file', path, '-i'], env, shell: kind, level: 'full' };
    }
    case 'zsh': {
      // A directory, because zsh finds its files by name in `ZDOTDIR`.
      const hash = createHash('sha256').update(JSON.stringify(ZSH_FILES)).digest('hex').slice(0, 12);
      const zdotdir = join(dir, `zsh-${hash}`);
      if (!existsSync(join(zdotdir, '.zshrc'))) {
        mkdirSync(zdotdir, { recursive: true, mode: 0o700 });
        for (const [name, content] of Object.entries(ZSH_FILES)) {
          const temp = join(zdotdir, `${name}.${process.pid}.tmp`);
          writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
          renameSync(temp, join(zdotdir, name));
        }
      }
      const user = opts.env['ZDOTDIR'];
      return {
        file: program.file,
        args: [],
        env: {
          ...env,
          ZDOTDIR: zdotdir,
          AGBRTE_USER_ZDOTDIR: user !== undefined && user !== '' ? user : (opts.env['HOME'] ?? ''),
        },
        shell: kind,
        level: 'full',
      };
    }
    case 'powershell': {
      /*
       * Sent as the command rather than written as a `.ps1` and dot-sourced.
       * Windows ships PowerShell with the execution policy `Restricted`, which
       * refuses to run a script *file* — and a refused integration is a terminal
       * that opens with a red error in it. A command is allowed.
       */
      const encoded = Buffer.from(POWERSHELL_SCRIPT, 'utf16le').toString('base64');
      return {
        file: program.file,
        args: ['-NoLogo', '-NoExit', '-EncodedCommand', encoded],
        env,
        shell: kind,
        level: 'full',
      };
    }
    case 'cmd':
      return {
        file: program.file,
        args: [],
        env: { ...env, PROMPT: cmdPrompt(opts.env['PROMPT']) },
        shell: kind,
        level: 'prompt',
      };
  }
}
