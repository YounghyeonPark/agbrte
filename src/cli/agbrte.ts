/**
 * Agbrte at a terminal (DESIGN.md §6.4, §8, §10).
 *
 * ## This is a client, not a second implementation
 *
 * Every command below talks to the same session host the window talks to, over
 * the same socket, using the same `HostConnection`. Nothing about sessions, the
 * log, the permission gate, or the turn queue is reimplemented here — a terminal
 * and a window are two clients of one owner, and if that were not already true
 * this file would be a fork of the product rather than a view onto it.
 *
 * That is why `agbrte attach` and the app can be open on the same workspace at the
 * same time and see one session rather than two copies. It is also why a turn
 * sent from a terminal is answerable from the window, and why closing either one
 * stops nothing.
 *
 * `src/cli/run.ts` is the exception and deliberately so: it builds its own
 * `SessionManager` in-process to exercise adapters without a host in the way.
 * That makes it the wrong tool for ordinary use — two of them on one workspace
 * would both own the log — which is why it is `npm run agbrte:direct` and not a
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

import { loadReport } from '@main/conformance.js';
import { LEGACY_WORKSPACE_DIR, WORKSPACE_DIR } from '@main/store/layout.js';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import { hostHolding } from '../host/legacyHost.js';
import { connect } from '@shared/host/socketChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { newControlToken } from '@shared/host/loopback.js';
import type { SessionId } from '@shared/types/index.js';
import { parse } from './args.js';
import { attach } from './attach.js';
import { once } from './once.js';
import { c } from './format.js';

declare const __AGBRTE_VERSION__: string | undefined;
/** Injected by the build; falls back when run straight from source via tsx. */
const AGBRTE_VERSION = typeof __AGBRTE_VERSION__ === 'string' ? __AGBRTE_VERSION__ : 'dev';

const USAGE = `agbrte — an agent workbench, at a terminal

  agbrte [attach] [path]        open the workspace and drive it interactively
  agbrte run [path] "<prompt>"  one turn, no prompts, an exit code
  agbrte ls [path]              list sessions, one per line
  agbrte group --name <n> <id>… put sessions in a group, so they can reach
                                each other; ids may come from stdin
  agbrte ungroup <id>…          take sessions back out of theirs
  agbrte serve [path]           run the host in the foreground (no client)
  agbrte web [path]             serve the app in a browser — a phone, over your VPN
  agbrte interrupt [path]       stop whatever is running here
  agbrte stop [path]            ask the host to exit; refuses while work is running
  agbrte update [path]          restart the host onto this build's bundle
  agbrte --version

Path defaults to the current directory. A host is started if none is running,
and is left running when you leave — that is the point of it.

Options for attach:
  --session <id>              open this session rather than asking which. Never
                              creates one — an id that is not here is an error.
                              This is how the app's terminal pane runs \`agbrte\`
                              against the session you are already looking at.
  --yes                       allow every permission request

Options for web:
  --port <n>                  default 7717
  --bind <addr>               default 127.0.0.1. Use your tailnet address to
                              reach it from a phone. The address decides who can
                              reach this at all, so name it deliberately.
  --token <value>             the bearer the printed link carries. A fresh one
                              is minted per run; pin one to keep a bookmark
                              working across restarts.

Options for run:
  --yes                       allow every permission request (else each is denied)
  --runtime <id>              which harness; defaults to the host's first
  --model <id>                for runtimes that need one
  --endpoint <id>             which of the host's models; see the ls output
  --session <id>              continue an existing session
  --verbose                   every event to stderr, not just the agent's text

  agbrte /srv/api                       attach to a workspace elsewhere
  agbrte ls | grep working              sessions currently mid-turn
  agbrte ls | grep worker | agbrte group --name "the team"
                                        a group from a pipeline; the members can
                                        then read each other with peer_history
  agbrte run . "summarise the README"   scriptable; 0 done, 1 failed, 2 stopped short
`;

/**
 * A session id, wherever it appears in a line.
 *
 * UUIDv7, matched loosely on purpose: `agbrte ls` prints `state id title`, and
 * requiring a bare id would make every pipeline start with `awk`. Anchoring it
 * to a word boundary is what keeps a title that happens to contain a hex run
 * from being read as an address.
 */
const SESSION_ID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

/**
 * Session ids from stdin, for the pipeline half of `group`.
 *
 * Reads only when there is something to read: a terminal with no pipe attached
 * would otherwise block on a command the user typed by hand, which is the hang
 * `once.ts` spends a paragraph avoiding elsewhere. `isTTY` answers exactly that
 * question, so the check is the condition rather than a timeout.
 */
async function idsFromStdin(): Promise<string[]> {
  if (process.stdin.isTTY === true) return [];
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const global = new RegExp(SESSION_ID.source, 'g');
  return Buffer.concat(chunks).toString('utf8').match(global) ?? [];
}

/**
 * Where the session host bundle is, relative to this one.
 *
 * Two layouts exist and both are legitimate. `npm i -g` installs the package
 * tree, so the host is a sibling directory away. The app's own remote bootstrap
 * drops both bundles flat into `~/.agbrte`, because it copies two files and has no
 * package to lay out. Rather than declare one of them wrong, look for both.
 *
 * `AGBRTE_HOST_ENTRY` wins over either, for a deployment that resembles neither.
 */
function findHostEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const override = process.env['AGBRTE_HOST_ENTRY'];
  if (override !== undefined) return resolve(override);

  const candidates = [
    resolve(here, '../main/agbrteHost.js'), // npm package / dist tree
    resolve(here, 'agbrteHost.js'), // flat beside us
    resolve(here, '../agbrteHost.js'), // one up, as the remote bootstrap lays it out
  ];
  const found = candidates.find((p) => existsSync(p));
  if (found !== undefined) return found;

  // Named in full: "the host did not start" sends someone to look at the host,
  // and the actual fault is a path.
  throw new Error(
    ['cannot find the session host bundle. Looked in:', ...candidates.map((p) => `  ${p}`),
      'Set AGBRTE_HOST_ENTRY to point at agbrteHost.js.'].join('\n'),
  );
}

/**
 * Connect, naming ourselves so the workspace's access policy can see us.
 *
 * The label carries the machine because that is what a rule wants to match on:
 * "the laptop watches, the desk machine drives" is a sentence about devices.
 */
/**
 * Whether this directory is already a workspace, without making it one.
 *
 * Both names, because §5.1 reads the old one forever — `ls` in a folder holding
 * a `.devagents/` must report its sessions rather than say there is nothing here.
 */
function hasWorkspace(path: string): boolean {
  return existsSync(join(path, WORKSPACE_DIR)) || existsSync(join(path, LEGACY_WORKSPACE_DIR));
}

/**
 * Retire a host from before one-host-per-machine (§17 Q16, §8).
 *
 * The failure Q16 was written about, arriving for real: `agbrte stop` speaks the
 * *new* protocol, and the host it exists to retire was started by the old one.
 * Since v21 the two do not even share a socket — this build computes
 * `agbrte-<machineId>` and that one listens on `agbrte-<instanceId>` — so
 * `connectOrSpawnHost` cannot reach it, and would in any case refuse to open a
 * workspace an older host is holding rather than become a second writer.
 *
 * So `stop` looks in the workspace, where that host left its record, and dials
 * it directly. It answers, because a v20 host serves any client at or above
 * `MIN_CLIENT_PROTOCOL: 1` and this one is; and its `welcome` is read through
 * `HostConnection`'s normalisation, which is the client's end of the range rule.
 *
 * Returns `null` when nothing older is there, which is the ordinary case and
 * means "carry on through the normal path".
 */
async function stopLegacyHost(path: string): Promise<number | null> {
  const record = await hostHolding(path);
  if (record === null) return null;

  // A loopback host's control channel needs its bearer token, which this record
  // carries and which nothing may print (§6.2). Only the socket case is handled
  // here: a local host from before v21 listens on a pipe or a unix socket, and a
  // loopback one is reached through a transport that has its own path.
  if (record.port !== undefined) {
    process.stderr.write(
      `an older host (pid ${record.pid}) is serving ${path} on a loopback control port. ` +
        `Stop it from the app that started it, or end pid ${record.pid}.\n`,
    );
    return 1;
  }

  const channel = await connect<SessionCommand, SessionMessage>(record.socket, 5_000).catch(
    () => null,
  );
  if (channel === null) {
    // It stopped between the probe and the dial, which is the outcome asked for.
    process.stdout.write('host stopped\n');
    return 0;
  }

  const connection = new HostConnection({ channel, client: 'agbrte-cli' });
  try {
    await connection.ready;
    const result = await connection.requestShutdown();
    if (result.stopped) {
      process.stdout.write(`host stopped (pid ${record.pid}, started before v21)\n`);
      return 0;
    }
    process.stderr.write(`host still running: ${result.reason ?? 'work in flight'}\n`);
    return 1;
  } finally {
    connection.disconnect();
  }
}

async function open(path: string): Promise<HostConnection> {
  const connection = await connectOrSpawnHost({
    workspaceRoot: path,
    // Both explicit because the defaults are the *app's*. `hostEntry` defaults
    // relative to the main bundle, which is a different directory from this
    // one; and `execPath` left unset means "we are Electron", which sets
    // ELECTRON_RUN_AS_NODE on a child that is plain Node.
    hostEntry: findHostEntry(),
    execPath: process.execPath,
    client: `agbrte-cli@${process.env['HOSTNAME'] ?? process.env['COMPUTERNAME'] ?? 'terminal'}`,
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
    process.stdout.write(`${AGBRTE_VERSION}\n`);
    return 0;
  }

  const { command, path, rest, flags, value } = parse(argv);

  if (command === 'serve') {
    // Deferred so the common paths do not pay to load the whole host.
    const { startSessionHost } = await import('../host/hostMain.js');
    // `lingerMs: 0` disables idle exit: a foreground `agbrte serve` is someone
    // deliberately keeping a host up, and exiting under them because nothing
    // attached for a while would be the opposite of what they asked for.
    const host = await startSessionHost({ workspaceRoot: path, lingerMs: 0 });
    process.stdout.write(`${c.dim(`agbrte host  ${path}`)}\n${c.dim(`socket     ${host.socket}`)}\n`);
    process.stdout.write(c.dim('Ctrl-C to stop. Sessions stop with it — use `agbrte attach` to leave one running.\n'));
    await new Promise<void>((done) => {
      const stop = (): void => {
        void host.stop().then(done);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return 0;
  }

  if (command === 'web') {
    const { serveWeb } = await import('../web/server.js');
    const { Fleet } = await import('@main/fleet.js');
    const { PUBLIC_HOST_ENV, isPublicHost } = await import('@shared/publicHost.js');
    const here = dirname(fileURLToPath(import.meta.url));

    /*
     * `--public` is a deployment, not a convenience flag.
     *
     * Everything else in this program assumes the person on the socket owns the
     * machine, and that assumption is what makes a token sufficient: somebody
     * who can start a session on their own computer could have opened a terminal
     * instead. On a demo the driver is a stranger and that argument is gone, so
     * the capabilities resting on it are withdrawn — `bash`, the vendor CLIs,
     * MCP attach, the terminal panel, capture, preview, attaching folders.
     *
     * Set into the environment **here**, before anything is spawned, because
     * that is the only way it reaches the two processes that enforce it: the
     * session host is spawned with a copy of this environment and forks the
     * agent host with a copy of its own. Reading a flag in this process alone
     * would gate the web server and leave the agent holding a shell.
     */
    const isPublic = flags.has('--public');
    if (isPublic) process.env[PUBLIC_HOST_ENV] = '1';

    // A fleet of exactly one: this is served *by* a workspace, so it shows that
    // workspace. Attaching another machine is a thing you do where the
    // filesystem is, and `hosts.add` says so rather than offering a path field.
    const fleet = new Fleet({
      runtimes: [
        { id: 'echo', label: 'Echo', version: '0.0.1', model: 'none' },
        { id: 'agbrte-harness', label: 'Agbrte harness', version: '0.0.1', model: 'required' },
        // Same list as the desktop app: the host detects these and reports
        // them only where the binary answered (§3.12).
        //
        // Absent on a public host, where `buildHostRegistry` does not register
        // them at all — a vendor CLI brings its own tools and its own idea of
        // where it may go, and nothing here is in a position to confine a
        // subprocess. Advertising one the host will refuse would put a runtime
        // in the picker whose every session fails at admission, which is a worse
        // way to say no than not offering it.
        ...(isPublic
          ? []
          : [
              { id: 'cli:claude-code', label: 'Claude Code (installed CLI)', version: '0.0.1', model: 'optional' as const },
              { id: 'cli:gemini-cli', label: 'Gemini CLI (installed)', version: '0.0.1', model: 'optional' as const },
            ]),
      ],
      connect: async () =>
        connectOrSpawnHost({
          workspaceRoot: path,
          hostEntry: findHostEntry(),
          execPath: process.execPath,
          client: `agbrte-web@${process.env['HOSTNAME'] ?? 'server'}`,
          // A public host has to be one this command started, or the environment
          // above reached nothing. `connectOrSpawn` explains why at length.
          ...(isPublic ? { mustSpawn: true } : {}),
        }),
    });
    await fleet.attach({ target: { kind: 'local' }, workspaceRoot: path });

    const bind = value('--bind') ?? '127.0.0.1';
    const server = await serveWeb({
      api: {
        fleet,
        runtimes: [],
        // The web client serves the same matrix the desktop app does. The report
        // sits beside the installed app rather than inside any workspace: it
        // describes the build, not the folder being worked in.
        loadConformance: () => loadReport(join(resolve(here, '..', '..'), 'conformance')),
        // The browser's About page describes this server, which is the honest
        // subject: the tab is looking at whatever this process runs. No
        // `runtime` block — Electron versions belong to the desktop app.
        about: {
          name: 'Agbrte',
          version: AGBRTE_VERSION,
          description:
            'Agent Bridge Terminal — durable, bridge-owned agent sessions you attach to from any device.',
          license: 'Apache-2.0',
          homepage: 'https://github.com/YounghyeonPark/agbrte',
        },
      },
      rendererDir: resolve(here, '../renderer'),
      port: Number(value('--port') ?? 7717),
      host: bind,
      /*
       * Fresh per run unless the caller pins one.
       *
       * A new token every restart is the safe default and the wrong one for a
       * phone: the bookmark stops working and the person is back at the
       * terminal. `--token` is how somebody says "this address, this bearer,
       * every time" — and passing it is a decision they make in the open rather
       * than a default this chose for them.
       */
      token: value('--token') ?? newControlToken(),
    });

    process.stdout.write(`${c.dim(`agbrte web  ${path}`)}\n${server.url}\n`);

    /*
     * Printed from `isPublicHost()` rather than from the flag that set it.
     *
     * They should be the same thing and the whole design depends on them being
     * the same thing — the flag writes the variable, and the variable is what
     * the spawned processes read. Reporting the flag would say "public" whenever
     * somebody typed it; reporting the variable says it only when the thing the
     * host will actually read is set. If those ever diverge, this line is where
     * it shows, and it shows before a stranger connects rather than after.
     */
    if (isPublicHost()) {
      process.stdout.write(
        c.dim(
          'Public host: no shell, no vendor CLIs, no MCP attach, no terminal, no capture. ' +
            'Agents hold only tools confined to this folder.\n',
        ),
      );
    }

    if (bind === '127.0.0.1' || bind === 'localhost') {
      process.stdout.write(
        c.dim('Loopback only. Pass --bind <your tailnet address> to reach it from a phone.\n'),
      );
    } else {
      // Said plainly every time, because it is true every time. The token in
      // the link decides who is admitted; the address still decides who can
      // knock, and that is the half a credential cannot do anything about.
      process.stdout.write(
        c.warn(
          `Reachable by anything that can address ${bind}. The link above carries the token ` +
            `that admits a client — treat it as the credential it is.\n`,
        ),
      );
    }

    await new Promise<void>((done) => {
      const stop = (): void => void server.close().then(done);
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
    return 0;
  }

  /**
   * Asking what is here must not make something be here.
   *
   * Found by running `agbrte ls` on a server's home directory to see what was
   * running: it made a workspace store in the home directory and started a host
   * there, because every verb went through `open` and opening a workspace
   * creates one. For a command
   * whose entire job is to report, that is a side effect nobody asked for — and
   * it lands in whatever directory the user happened to be standing in.
   *
   * Only `ls` is guarded. `run`, `attach` and `serve` are all "do something
   * here", and creating the workspace is the right first step for each of them.
   */
  if (command === 'ls' && !hasWorkspace(path)) {
    process.stdout.write(
      `${c.dim(`no agbrte workspace at ${path}`)}
` +
        c.dim(`start one with:  agbrte run ${path} "..."
`),
    );
    return 0;
  }

  /*
   * Retiring an older host is the one thing that must work before opening.
   *
   * `open` refuses a workspace an older host is holding, which is right for
   * every other verb and is exactly backwards for this one — §17 Q16's rule is
   * that a bump must never leave the tool that would politely shut a host down
   * unable to reach it.
   */
  if (command === 'stop') {
    const handled = await stopLegacyHost(path);
    if (handled !== null) return handled;
  }

  const connection = await open(path);

  try {
    switch (command) {
      case 'group': {
        /*
         * Put sessions in a group, from a terminal (§17 Q22).
         *
         * The protocol had `session.group` and `HostConnection` had
         * `groupSessions`, and between a person and them there was only the app
         * — so a group could be made only where there is a window. That is the
         * wrong half of the product to require one for: dividing work across
         * sessions is what you do on a build box over ssh, and both of the
         * things a group is *for*, `message_peer` and `peer_history`, are
         * reachable only from inside one.
         *
         * Ids come from the arguments, or from stdin when there are none, so
         * `agbrte ls | grep worker | agbrte group --name "the team"` is one
         * line. The pattern matches an id anywhere in the input, which is what
         * lets a whole `ls` row be piped in without cutting a column out of it.
         */
        const ids = rest.some((a) => SESSION_ID.test(a))
          ? rest.filter((a) => SESSION_ID.test(a))
          : await idsFromStdin();
        if (ids.length === 0) {
          process.stderr.write(
            `${c.fail('name at least one session')} — ids come from arguments or from stdin:\n` +
              c.dim(`  agbrte group --name "the team" <id> <id>\n`) +
              c.dim(`  agbrte ls | grep worker | agbrte group --name "the team"\n`),
          );
          return 1;
        }

        const name = value('--name');
        if (name === undefined || name.trim() === '') {
          // The manager refuses an unnamed group and says why. Saying it here
          // saves a round trip and names the flag rather than the concept.
          process.stderr.write(
            `${c.fail('a group needs a name')} — it is what a person finds it by: ` +
              `${c.dim('--name "the team"')}\n`,
          );
          return 1;
        }

        const grouped = await connection.groupSessions(ids as SessionId[], name);
        for (const g of grouped) process.stdout.write(`${g.sessionId}  ${g.title}\n`);
        process.stderr.write(c.dim(`${grouped.length} sessions in "${name}"\n`));
        return 0;
      }

      case 'ungroup': {
        const ids = rest.some((a) => SESSION_ID.test(a))
          ? rest.filter((a) => SESSION_ID.test(a))
          : await idsFromStdin();
        if (ids.length === 0) {
          process.stderr.write(`${c.fail('name at least one session to take out of its group')}\n`);
          return 1;
        }
        for (const id of ids) {
          const left = await connection.ungroupSession(id as SessionId);
          process.stdout.write(`${left.sessionId}  ${left.title}\n`);
        }
        return 0;
      }

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
          // The group, where there is one. Without it a terminal cannot see
          // which sessions are a team, and `agbrte group` would be a command
          // whose result is invisible from the shell that ran it.
          const team = s.group === undefined ? '' : c.dim(`  [${s.group.name}]`);
          process.stdout.write(`${s.state.padEnd(20)} ${s.sessionId}  ${s.title}${team}\n`);
        }
        for (const d of onDisk.filter((d) => !loaded.has(d.sessionId as never))) {
          process.stdout.write(`${'on disk'.padEnd(20)} ${d.sessionId}  ${d.title}\n`);
        }
        if (sessions.length === 0 && onDisk.length === 0) {
          process.stderr.write(c.dim('no sessions in this workspace yet\n'));
        }
        return 0;
      }

      case 'interrupt': {
        /**
         * Stop a turn from outside the interactive client (§8, §10).
         *
         * `attach` has always had Ctrl-C, which is no help when the thing you
         * need to stop is on a headless server and its agent has already gone
         * away. Without this, a session left `working` by a dead turn holds the
         * host busy for good: `stop` refuses on its behalf, and upgrading the
         * host means killing the process.
         *
         * Interrupts every working session by default, because that is the
         * situation this exists for — "something in here is stuck and I want the
         * host back". A single session can be named when the workspace has other
         * work that should carry on.
         */
        const target = value('--session');
        const sessions = await connection.list();
        const working = sessions.filter((x) =>
          target !== undefined ? x.sessionId === target : x.state === 'working',
        );

        if (working.length === 0) {
          process.stdout.write(
            target !== undefined ? `no session ${target} here\n` : 'nothing is running here\n',
          );
          // Not an error: "there was nothing to stop" is a successful outcome
          // for anyone scripting a stop-then-upgrade.
          return 0;
        }

        for (const session of working) {
          await connection.interrupt(session.sessionId);
          process.stdout.write(`interrupted ${session.sessionId}  ${session.title}\n`);
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

      /*
       * Restart the host so a newer bundle takes effect (§6.3).
       *
       * A running host keeps executing the bundle it started with. Attaching
       * already deploys a newer one when the version differs — what it will not
       * do is interrupt a host to make the new code run, because that decision
       * belongs to a person, and on a remote machine it may be somebody's
       * overnight work.
       *
       * So this is `stop` with the intent named. The next attach — this command's
       * own, or the app's, or the next `agbrte run` — starts a host from the
       * deployed bundle. Sessions are durable in the event log (§5.4) and resume
       * from it, so what this costs is the turn in flight, not the work.
       *
       * Deliberately not "download an update": the bundle a host runs comes from
       * whichever client attached to it, not from a release server. Updating the
       * *app* is `Restart to update` in its window; this updates the far side.
       */
      case 'update': {
        const result = await connection.requestShutdown();
        if (!result.stopped) {
          process.stderr.write(
            `host still running: ${result.reason ?? 'work in flight'}\n` +
              'Nothing was changed. Stop the work, or wait, and try again.\n',
          );
          return 1;
        }
        process.stdout.write('host stopped; the next attach deploys this build and starts it\n');
        return 0;
      }

      case 'run': {
        const prompt = rest.join(' ').trim();
        if (prompt === '') {
          process.stderr.write('agbrte run needs a prompt\n');
          return 1;
        }
        return await once(connection, {
          prompt,
          title: value('--title'),
          sessionId: value('--session'),
          runtimeId: value('--runtime'),
          model: value('--model'),
          endpointId: value('--endpoint'),
          autoApprove: flags.has('--yes'),
          verbose: flags.has('--verbose'),
        });
      }

      default:
        return await attach(connection, {
          path,
          autoApprove: flags.has('--yes'),
          // Absent means "ask which one", which is right at a real terminal and
          // wrong inside the app's pane — that pane is already showing a
          // session, so it names it. See `AttachOptions.sessionId`.
          ...(value('--session') !== undefined ? { sessionId: value('--session') as string } : {}),
        });
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
