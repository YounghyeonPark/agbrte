/**
 * Making what Agbrte installed findable by the process that looks for it
 * (DESIGN.md §3.12, §6.4, §6.8).
 *
 * "Set up this machine" installs a vendor CLI with `npm --prefix ~/.agbrte/npm`,
 * because that is the only prefix a host can write to without `sudo` on a
 * machine it was lent rather than given. Nothing puts that directory on a PATH:
 * a host starts as `ssh <alias> '<command>'`, a non-interactive non-login shell
 * that sources no profile at all. So `detectCli` would spawn `claude`, get
 * `ENOENT`, and report *not installed on this host* about a binary this program
 * had just put there — the exact sentence the whole feature exists to remove,
 * reappearing one layer down and much harder to explain.
 *
 * **Appended, never prepended.** §6.8 states the rule for a user's own preview
 * command and it holds identically here: if the machine has its own `claude`,
 * that is the one somebody means, and shadowing it would be precisely the "we
 * changed your machine" the private prefix exists to avoid. Ours is the fallback
 * for a machine that had none.
 *
 * The Node directory goes on for a second, less obvious reason. Gemini CLI's
 * shim is a `#!/usr/bin/env node` script, so a machine whose only Node is the
 * private one under `~/.agbrte/node` would install the CLI successfully and then
 * fail to run it — a runtime detected and unrunnable, which is worse than one
 * that was never offered.
 */

import { delimiter } from 'node:path';

/** `~/.agbrte`, from an explicit home so a test can point it anywhere. */
function agbrteRoot(env: NodeJS.ProcessEnv): string | null {
  // `USERPROFILE` for completeness rather than for use: the scripts that create
  // these directories are POSIX-only, so on Windows this finds nothing and
  // correctly adds nothing.
  const home = env['HOME'] ?? env['USERPROFILE'];
  return home === undefined || home === '' ? null : `${home}/.agbrte`;
}

/** The directories a managed install puts executables in, in PATH order. */
export function managedToolDirs(env: NodeJS.ProcessEnv): string[] {
  const root = agbrteRoot(env);
  if (root === null) return [];
  return [`${root}/npm/bin`, `${root}/node/bin`, `${root}/ollama/bin`];
}

/**
 * Append them to `PATH`, in place, skipping anything already there.
 *
 * Mutates rather than returning a copy because the caller is `startSessionHost`
 * and the consumer is `child_process.fork`, which snapshots `process.env` at the
 * moment it runs. Returning a new object would leave the forked agent host —
 * the process that actually spawns the CLI — with the PATH it started with.
 *
 * The key is found case-insensitively: Windows spells it `Path`, and setting
 * `PATH` beside an existing `Path` there produces two variables and no effect.
 */
export function addManagedToolsToPath(env: NodeJS.ProcessEnv): void {
  const dirs = managedToolDirs(env);
  if (dirs.length === 0) return;
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  const already = new Set(current.split(delimiter));
  const missing = dirs.filter((d) => !already.has(d));
  if (missing.length === 0) return;
  env[key] = current === '' ? missing.join(delimiter) : [current, ...missing].join(delimiter);
}
