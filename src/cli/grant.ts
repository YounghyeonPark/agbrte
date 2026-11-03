/**
 * `agbrte grant [folder]` — ask the window to let the agent reach a folder
 * (DESIGN.md §17 Q24 step 6).
 *
 * The agent works in the session's workspace; `cd` moves the shell and nothing
 * else. To give it another folder from the terminal one is standing in, this
 * asks — it does not grant. It writes the pane's keyed request (`mediaOffers.ts`,
 * the channel `agbrte show` streams through), the host takes it out of the
 * output and sends it to the window that owns the pane, and the window asks the
 * person. The owner chose a shell command as well as the palette; what keeps it
 * from being a way for the agent to widen its own reach is that last step —
 * the agent can run this, through its shell tool, and cannot press the button.
 *
 * Only in a tab of the app, only to the terminal itself: the request carries
 * the pane's key, and written into a pipe it would put the key somewhere other
 * than the terminal it unlocks (`show.ts` says the same of streaming).
 */

import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { grantSequence, PANE_KEY_ENV } from '@main/terminal/mediaOffers.js';

export const GRANT_USAGE = `usage: agbrte grant [folder]

Ask the Agbrte window to let the agent read and write a folder besides the
session's workspace — this one if none is named. The window asks you first.
Only in a tab of the Agbrte app; elsewhere use the palette (Ctrl+Shift+P).
`;

export interface GrantIo {
  env: NodeJS.ProcessEnv;
  out: { write(text: string): unknown };
  err: { write(text: string): unknown };
  tty?: boolean | undefined;
  cwd?: string;
}

export async function grant(
  argv: string[],
  io: GrantIo = { env: process.env, out: process.stdout, err: process.stderr, tty: process.stdout.isTTY },
): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h') || argv.length > 1) {
    (argv.length > 1 ? io.err : io.out).write(GRANT_USAGE);
    return argv.length > 1 ? 2 : 0;
  }
  const key = io.env[PANE_KEY_ENV];
  if (key === undefined || key === '' || io.tty !== true) {
    io.err.write(
      'agbrte grant asks the Agbrte window, so it works only in a tab of the app, writing to the ' +
        'terminal itself. Elsewhere, grant a folder from the palette: Ctrl+Shift+P.\n',
    );
    return 1;
  }
  const folder = resolve(io.cwd ?? process.cwd(), argv[0] ?? '.');
  try {
    if (!(await stat(folder)).isDirectory()) {
      io.err.write(`agbrte grant: ${folder} is a file, not a folder\n`);
      return 1;
    }
  } catch {
    io.err.write(`agbrte grant: ${folder} does not exist\n`);
    return 1;
  }
  // The line after it is where the host's answer — "asking the window…" — sits.
  io.out.write(`${grantSequence(key, folder)}\n`);
  return 0;
}
