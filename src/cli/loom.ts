/**
 * Loom at a terminal (DESIGN.md §6.4, §8, §10).
 *
 * ## This is a client, not a second implementation
 *
 * Every command below talks to the same session host the window talks to, over
 * the same socket, using the same `HostConnection`. Nothing about sessions, the
 * log, the permission gate, or the turn queue is reimplemented here — a terminal
 * and a window are two clients of one owner, and if that were not already true
 * this file would be a fork of the product rather than a view onto it.
 *
 * That is why `loom attach` and the app can be open on the same workspace at the
 * same time and see one session rather than two copies. It is also why a turn
 * sent from a terminal is answerable from the window, and why closing either one
 * stops nothing.
 *
 * `src/cli/run.ts` is the exception and deliberately so: it builds its own
 * `SessionManager` in-process to exercise adapters without a host in the way.
 * That makes it the wrong tool for ordinary use — two of them on one workspace
 * would both own the log — which is why it is `npm run loom:direct` and not a
 * subcommand here.
 *
 * ## No TUI
 *
 * Line-based readline, no alternate screen, no cursor addressing. The first
 * place this runs is an ssh session on a server with no display, quite possibly
 * inside tmux, possibly with a `TERM` nobody has tested. A full-screen interface
 * is nicer on a good day and unusable on a bad one, and the bad one is exactly
 * when someone is on a server at a terminal.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import type { HostConnection } from '@main/host/hostConnection.js';
import { parse } from './args.js';
import { attach } from './attach.js';
import { once } from './once.js';
import { c } from './format.js';

declare const __LOOM_VERSION__: string | undefined;
/** Injected by the build; falls back when run straight from source via tsx. */
const LOOM_VERSION = typeof __LOOM_VERSION__ === 'string' ? __LOOM_VERSION__ : 'dev';

const USAGE = `loom — an agent workbench, at a terminal

  loom [attach] [path]        open the workspace and drive it interactively
  loom run [path] "<prompt>"  one turn, no prompts, an exit code
  loom ls [path]              list sessions, one per line
  loom serve [path]           run the host in the foreground (no client)
  loom stop [path]            ask the host to exit; refuses while work is running
  loom --version

Path defaults to the current directory. A host is started if none is running,
and is left running when you leave — that is the point of it.

Options for run:
  --yes                       allow every permission request (else each is denied)
  --runtime <id>              which harness; defaults to the host's first
  --model <id>                for runtimes that need one
  --session <id>              continue an existing session
  --verbose                   every event to stderr, not just the agent's text

  loom /srv/api                       attach to a workspace elsewhere
  loom ls | grep working              sessions currently mid-turn
  loom run . "summarise the README"   scriptable; 0 done, 1 failed, 2 stopped short
`;

/**
 * Where the session host bundle is, relative to this one.
 *
 * Two layouts exist and both are legitimate. `npm i -g` installs the package
 * tree, so the host is a sibling directory away. The app's own remote bootstrap
 * drops both bundles flat into `~/.loom`, because it copies two files and has no
 * package to lay out. Rather than declare one of them wrong, look for both.
 *
 * `LOOM_HOST_ENTRY` wins over either, for a deployment that resembles neither.
 */
function findHostEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.env['LOOM_HOST_ENTRY'];
  if (override !== undefined) return resolve(override);

  const candidates = [
    resolve(here, '../main/loomHost.js'), // npm package / dist tree
    resolve(here, 'loomHost.js'), // flat beside us
    resolve(here, '../loomHost.js'), // one up, as the remote bootstrap lays it out
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found !== undefined) return found;

  // Named in full: "the host did not start" sends someone to look at the host,
  // and the actual fault is a path.
  throw new Error(
    ['cannot find the session host bundle. Looked in:', ...candidates.map((p) => `  ${p}`),
      'Set LOOM_HOST_ENTRY to point at loomHost.js.'].join('\n'),
  );
}

/**
 * Connect, naming ourselves so the workspace's access policy can see us.
 *
 * The label carries the machine because that is what a rule wants to match on:
 * "the laptop watches, the desk machine drives" is a sentence about devices.
 */
async function open(path: string): Promise<HostConnection> {
  const connection = await connectOrSpawnHost({
    workspaceRoot: path,
    // Both explicit because the defaults are the *app's*. `hostEntry` defaults
    // relative to the main bundle, which is a different directory from this
    // one; and `execPath` left unset means "we are Electron", which sets
    // ELECTRON_RUN_AS_NODE on a child that is plain Node.
    hostEntry: findHostEntry(),
    execPath: process.execPath,
    client: `loom-cli@${process.env['HOSTNAME'] ?? process.env['COMPUTERNAME'] ?? 'terminal'}`,
  });
  await connection.ready;
  return connection;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv.includes('--version') || argv.includes('-v')) {
    // Baked in at build time: the installed CLI has no package.json beside it
    // to read, and resolving one at runtime finds the *workspace's* if the user
    // happens to be standing in a Node project.
    process.stdout.write(`${LOOM_VERSION}\n`);
    return 0;
  }

  const { command, path, rest, flags, value } = parse(argv);

  if (command === 'serve') {
    // Deferred so the common paths do not pay to load the whole host.
    const { startSessionHost } = await import('../host/hostMain.js');
    // `lingerMs: 0` disables idle exit: a foreground `loom serve` is someone
    // deliberately keeping a host up, and exiting under them because nothing
    // attached for a while would be the opposite of what they asked for.
    const host = await startSessionHost({ workspaceRoot: path, lingerMs: 0 });
    process.stdout.write(`${c.dim(`loom host  ${path}`)}\n${c.dim(`socket     ${host.socket}`)}\n`);
    process.stdout.write(c.dim('Ctrl-C to stop. Sessions stop with it — use `loom attach` to leave one running.\n'));
    await new Promise<void>((done) => {
      const stop = (): void => {
        void host.stop().then(done);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return 0;
  }

  const connection = await open(path);

  try {
    switch (command) {
      case 'ls': {
        const sessions = await connection.list();
        const onDisk = await connection.listOnDisk();
        const loaded = new Set(sessions.map((s) => s.sessionId));

        // Fixed-width state first so the column is greppable, which is the point
        // of a list command that is not a table. Ids in full rather than
        // abbreviated: these are UUIDv7, so two sessions made minutes apart share
        // a long time-ordered prefix — the short form looked tidy and printed two
        // different sessions as `019fd625`, which cannot be pasted into
        // `--session`.
        for (const s of sessions) {
          process.stdout.write(`${s.state.padEnd(20)} ${s.sessionId}  ${s.title}\n`);
        }
        for (const d of onDisk.filter((d) => !loaded.has(d.sessionId as never))) {
          process.stdout.write(`${'on disk'.padEnd(20)} ${d.sessionId}  ${d.title}\n`);
        }
        if (sessions.length === 0 && onDisk.length === 0) {
          process.stderr.write(c.dim('no sessions in this workspace yet\n'));
        }
        return 0;
      }

      case 'stop': {
        const result = await connection.requestShutdown();
        if (result.stopped) {
          process.stdout.write('host stopped\n');
          return 0;
        }
        // Refusing is the correct behaviour, so it is not an error message —
        // but it is a non-zero exit, because a script that asked for a stop did
        // not get one.
        process.stderr.write(`host still running: ${result.reason ?? 'work in flight'}\n`);
        return 1;
      }

      case 'run': {
        const prompt = rest.join(' ').trim();
        if (prompt === '') {
          process.stderr.write('loom run needs a prompt\n');
          return 1;
        }
        return await once(connection, {
          prompt,
          title: value('--title'),
          sessionId: value('--session'),
          runtimeId: value('--runtime'),
          model: value('--model'),
          autoApprove: flags.has('--yes'),
          verbose: flags.has('--verbose'),
        });
      }

      default:
        return await attach(connection, { path, autoApprove: flags.has('--yes') });
    }
  } finally {
    connection.disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${c.fail(err instanceof Error ? err.message : String(err))}\n`);
    process.exit(1);
  },
);
