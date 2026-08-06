/**
 * Terminal output, shared by the CLI's commands.
 *
 * Colour is **off unless stdout is a TTY**, which matters more here than usual:
 * `gilmok ls | grep working` and `gilmok ls > sessions.txt` are the reason a list
 * command exists at all, and escape codes baked into that output turn a plain
 * grep into one that needs a regex nobody wants to write. `NO_COLOR` is honoured
 * for the same reason it exists.
 */

const enabled =
  process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';

const wrap =
  (code: string) =>
  (s: string): string =>
    enabled ? `\x1b[${code}m${s}\x1b[0m` : s;

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  ok: wrap('32'),
  fail: wrap('31'),
  warn: wrap('33'),
  accent: wrap('36'),
};

/**
 * Shorten a value for one line of terminal.
 *
 * Tool arguments are the thing being summarised, and they are routinely a whole
 * file's contents — printing that in a permission prompt buries the question
 * being asked under the thing it is asking about.
 */
export function preview(value: unknown, max = 120): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
