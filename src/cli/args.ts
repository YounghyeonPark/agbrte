/**
 * The command line, parsed.
 *
 * Its own module so a test can import it without importing the entry point —
 * which runs a command and exits, taking the test runner with it. A guard on
 * `process.argv[1]` was the first attempt and is exactly the kind of thing that
 * works until the runner's argv is not what you assumed.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface Parsed {
  command: string;
  path: string;
  rest: string[];
  flags: Set<string>;
  value(name: string): string | undefined;
}

/**
 * Every verb the CLI answers to.
 *
 * Exported, and that is the point. It used to be a `new Set([...])` inside
 * `parse`, and adding `update` meant writing a `case 'update'` in the entry
 * point that could never be reached: an unlisted first argument is treated as a
 * **path**, so `agbrte update .` attached to a directory called `update` and
 * reported success. Nothing failed — the switch arm was simply unreachable,
 * which is this project's most reliable bug in miniature.
 *
 * A test now reads the entry point's `case` labels and requires them to be in
 * here, so the two vocabularies cannot drift again.
 */
export const KNOWN_COMMANDS = new Set([
  'attach',
  'run',
  'ls',
  'serve',
  'stop',
  'update',
  'web',
  'interrupt',
  'group',
  'ungroup',
]);

/** Flags that consume the next argument; everything else is a boolean. */
const VALUE_FLAGS = new Set([
  '--runtime',
  '--model',
  '--session',
  '--title',
  '--port',
  '--bind',
  '--endpoint',
  '--token',
  '--name',
]);

/**
 * Commands whose first argument may not be a path.
 *
 * `run` takes a prompt and `group` takes session ids, so for these the first
 * argument is a workspace only if it *looks* like one. Everything else takes a
 * path or nothing, and treating a lone session id as a directory would resolve
 * it against the cwd and open a workspace nobody asked for.
 */
const TAKES_ARGUMENTS = new Set(['run', 'group', 'ungroup']);

export function parse(argv: string[]): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith('-')) {
      positional.push(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next !== undefined) {
        values.set(arg, next);
        i += 1;
      }
    } else {
      flags.add(arg);
    }
  }

  const KNOWN = KNOWN_COMMANDS;
  // `agbrte /srv/api` and `agbrte attach /srv/api` both work: a first argument that
  // is not a command is a path. Requiring the verb would make the common case
  // the long one.
  const command = positional[0] !== undefined && KNOWN.has(positional[0]) ? positional[0] : 'attach';
  const after = command === positional[0] ? positional.slice(1) : positional;

  // `agbrte run "prompt"` with no path means the current directory, so `run` has
  // to tell a path from a prompt. Two signals, both deliberate:
  //
  //  - it exists on disk, or
  //  - it is written as a path — `.`, `./x`, `/x`, `~`, `C:\x`
  //
  // Counting words was the first attempt and was wrong: shells split unquoted
  // arguments, so `agbrte run add a test` arrived as three of them and "add"
  // became the workspace. Everything else is prompt, because for `run` a prompt
  // is the argument that must always work unquoted.
  const first = after[0];
  const looksLikePath =
    first !== undefined &&
    (!TAKES_ARGUMENTS.has(command) ||
      first === '.' ||
      /^(\.\.?[/\\]|[/\\]|~|[A-Za-z]:[/\\])/.test(first) ||
      existsSync(resolve(first)));

  return {
    command,
    path: resolve(looksLikePath ? (after[0] as string) : process.cwd()),
    rest: looksLikePath ? after.slice(1) : after,
    flags,
    value: (name) => values.get(name),
  };
}
