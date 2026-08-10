/**
 * Running the dev server ourselves (DESIGN.md §6.8, §3.12).
 *
 * > **Preview servers are started by us, not by the agent** — an agent's
 * > background processes are killed shortly after its run returns (§3.12), so an
 * > agent-started dev server would vanish under you.
 *
 * The constraint is somebody else's: a CLI harness reaps what its run started,
 * shortly after the run returns. An agent that helpfully backgrounds `npm run
 * dev` produces a server that exists for as long as it takes you to switch
 * windows, and the failure looks like the port dying on its own.
 *
 * So this process is **not** the agent's child. It belongs to the host, which
 * already outlives the app on purpose (§6.4), and so a preview survives the turn
 * that motivated it, the app closing, and the laptop lid.
 *
 * ## It is the user's command, never the model's
 *
 * Stated here because getting it wrong would be quiet and bad. §3.12's reaping
 * is a real containment property: whatever an agent starts, ends. An API that
 * starts a persistent process would **launder** that guarantee if a model could
 * reach it — "run this in the background" becomes possible again by asking us
 * nicely. So this is a protocol command and an IPC method, and deliberately not
 * a tool: nothing in the tool registry can call it, and the gate is
 * `requireWrite`, which is about the human client's role.
 *
 * ## Killing the process group, not the process
 *
 * `npm run dev` is npm, which spawns node, which holds the port. Killing npm
 * leaves node running and the port bound, and the next start fails with
 * `EADDRINUSE` for a server the user believes they stopped. The child gets its
 * own process group (`detached`) and the whole group is signalled, which is the
 * only way to reach the grandchild that is actually listening.
 *
 * ## The log is the answer to "nothing is listening"
 *
 * §6.8 reports an unreachable forward rather than refusing it, because a server
 * still compiling looks the same as one that will never answer. That is only
 * humane if the difference is *findable*, and the difference is in the output: a
 * dev server that died on a syntax error said so and nobody was reading. Kept as
 * a bounded ring, because a dev server left running for a day will happily
 * produce a gigabyte of request logs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { delimiter, dirname } from 'node:path';

/** How many lines of output are kept per server. */
export const LOG_LINES = 200;

export interface PreviewServer {
  id: string;
  sessionId: string;
  command: string;
  cwd: string;
  pid: number | null;
  startedAt: string;
  /** Set once it has exited; `null` while running. */
  exit: { code: number | null; signal: string | null } | null;
}

export interface PreviewServerLog {
  id: string;
  lines: string[];
  /** Lines dropped off the front, so a truncated log says it is truncated. */
  dropped: number;
}

export class PreviewServerRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PreviewServerRefused';
  }
}

interface Running {
  record: PreviewServer;
  child: ChildProcess;
  lines: string[];
  dropped: number;
  /** Held so a line split across two chunks is not published as two lines. */
  partial: string;
}

export type ServerSpawner = (command: string, cwd: string, env: NodeJS.ProcessEnv) => ChildProcess;

/**
 * The runtime this host is running on, made findable by the command.
 *
 * A remote machine reached by §6.2 often has **no system Node at all** — the
 * bootstrap unpacks a private one under `~/.agbrte/node` precisely so that
 * attaching a host does not mean changing the machine. Which means the very
 * first thing a user types here, `npm run dev`, fails with
 *
 *     /bin/sh: 1: node: not found
 *
 * on a machine that is demonstrably running Node right now. Found by running
 * it against a real host, and found *through the log* — which is the argument
 * for keeping the log, arriving as its own first example.
 *
 * **Appended, never prepended.** If the machine has its own Node, that is the
 * one the user's command should get: shadowing it would be exactly the "we
 * changed your machine" that the private runtime exists to avoid. Ours is the
 * fallback for a machine that has none.
 */
function withOwnRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const ours = dirname(process.execPath);
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const current = env[key] ?? '';
  if (current.split(delimiter).includes(ours)) return env;
  return { ...env, [key]: current === '' ? ours : `${current}${delimiter}${ours}` };
}

const defaultSpawn: ServerSpawner = (command, cwd, env) =>
  spawn(command, {
    cwd,
    env,
    // A dev server command is a shell command — `npm run dev`, `cargo watch -x
    // run`, something with a pipe in it. Refusing a shell would mean refusing
    // most of what people would type, and this is the user's own command on
    // their own machine, run at their own request.
    shell: true,
    /**
     * Its own process group, so the whole tree can be signalled — **on POSIX
     * only**, and the exception is not a nicety.
     *
     * On Windows `detached` creates a new *console*, and a child in a new
     * console writes its output there instead of into the pipe: measured, and
     * total. The same command captures `42
` without the flag and `""` with it,
     * so every preview log would have been empty and a dev server that died on a
     * syntax error would have died silently — which is the one thing §6.8's
     * "report, do not refuse" rule depends on not happening.
     *
     * It also buys nothing there. `taskkill /T` walks the tree by pid rather
     * than by group, and a child on Windows already outlives its parent without
     * a job object. So the flag exists for a POSIX reason and is paid for only
     * where the reason applies.
     */
    ...(process.platform === 'win32' ? {} : { detached: true }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

export class PreviewServers {
  private readonly running = new Map<string, Running>();
  private counter = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly spawnFn: ServerSpawner = defaultSpawn,
  ) {}

  /**
   * Start one, and keep it.
   *
   * Returns as soon as it is spawned rather than when it is serving — there is
   * no general way to know when a dev server is ready, and inventing one per
   * framework is a maintenance sink. §6.8's reachability probe answers that
   * question from the outside, which works the same for every server.
   */
  start(sessionId: string, command: string, cwd?: string): PreviewServer {
    const trimmed = command.trim();
    if (trimmed === '') throw new PreviewServerRefused('no command to run');

    const already = [...this.running.values()].find(
      (r) => r.record.sessionId === sessionId && r.record.command === trimmed && r.record.exit === null,
    );
    // Starting the same command twice in one session is a second server fighting
    // the first for the port, and the error it produces (`EADDRINUSE`) points at
    // neither.
    if (already !== undefined) return already.record;

    this.counter += 1;
    const id = `preview-${this.counter}`;
    const where = cwd ?? this.workspaceRoot;
    const child = this.spawnFn(trimmed, where, withOwnRuntime(process.env));

    const record: PreviewServer = {
      id,
      sessionId,
      command: trimmed,
      cwd: where,
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
      exit: null,
    };
    const entry: Running = { record, child, lines: [], dropped: 0, partial: '' };
    this.running.set(id, entry);

    const take = (chunk: Buffer | string): void => this.absorb(entry, String(chunk));
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    child.on('error', (err) => {
      // A command that cannot start at all — a typo, a missing binary. It is
      // output as far as the user is concerned, and the alternative is a server
      // that silently never existed.
      this.absorb(entry, `${err.message}\n`);
      record.exit = { code: null, signal: null };
    });
    child.on('exit', (code, signal) => {
      // Kept rather than deleted. A dev server that exited two seconds ago is
      // exactly when its last twenty lines matter most, and removing the record
      // would take them with it.
      this.absorb(entry, `${entry.partial}\n`);
      entry.partial = '';
      record.exit = { code, signal };
    });

    return record;
  }

  private absorb(entry: Running, chunk: string): void {
    const combined = entry.partial + chunk;
    const parts = combined.split('\n');
    entry.partial = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim() === '') continue;
      entry.lines.push(line.replace(/\r$/, ''));
    }
    // Bounded: a dev server left up for a day produces a great deal of nothing
    // in particular, and the interesting part is always the end.
    while (entry.lines.length > LOG_LINES) {
      entry.lines.shift();
      entry.dropped += 1;
    }
  }

  list(sessionId?: string): PreviewServer[] {
    return [...this.running.values()]
      .map((r) => r.record)
      .filter((r) => sessionId === undefined || r.sessionId === sessionId);
  }

  log(id: string): PreviewServerLog | null {
    const entry = this.running.get(id);
    if (entry === undefined) return null;
    // The held partial is included: a dev server that prints a prompt without a
    // trailing newline — which is most of them, while starting — would otherwise
    // show nothing at the moment there is most to see.
    const tail = entry.partial.trim() === '' ? [] : [entry.partial];
    return { id, lines: [...entry.lines, ...tail], dropped: entry.dropped };
  }

  /**
   * Stop one, killing the whole group.
   *
   * `SIGTERM` to the group first, because a dev server asked politely gets to
   * flush and remove its socket. Nothing here waits for it: a caller that needs
   * "it is really gone" should watch the port, which is the same check §6.8
   * already uses and does not depend on this process being the one that noticed.
   */
  stop(id: string): boolean {
    const entry = this.running.get(id);
    if (entry === undefined) return false;
    killGroup(entry.child);
    return true;
  }

  /** Everything this session started. Called when it ends. */
  stopSession(sessionId: string): number {
    let stopped = 0;
    for (const entry of this.running.values()) {
      if (entry.record.sessionId !== sessionId || entry.record.exit !== null) continue;
      killGroup(entry.child);
      stopped += 1;
    }
    return stopped;
  }

  /** Everything, for host shutdown. */
  stopAll(): void {
    for (const entry of this.running.values()) {
      if (entry.record.exit === null) killGroup(entry.child);
    }
  }

  /** Drop the record of something that has exited. */
  forget(id: string): boolean {
    const entry = this.running.get(id);
    if (entry === undefined || entry.record.exit === null) return false;
    this.running.delete(id);
    return true;
  }
}

/**
 * Kill the whole tree, by whichever mechanism the platform has.
 *
 * On POSIX `-pid` signals the process group, which is the only way to reach the
 * `node` that `npm` spawned — the one actually holding the port.
 *
 * **Windows needed a different answer, and finding that out was the point of
 * writing the test first.** `detached` there creates a new *console*, not a
 * process group, and `child.kill()` reaches only the `cmd.exe` that `shell: true`
 * started. The grandchild survives, keeps the port, and the next start fails
 * with `EADDRINUSE` for a server the user believes they stopped — asserted by
 * watching a grandchild keep writing a file after its parent was killed. So
 * Windows gets `taskkill /T`, which is what walks the tree there.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (process.platform === 'win32') {
    // `/T` is the tree and `/F` is the force. Without `/T` this is `child.kill()`
    // with extra steps; without `/F` a busy dev server can decline. Fire and
    // forget: its failure means the process was already gone, which is the
    // outcome wanted.
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.on('error', () => {
      try {
        child.kill();
      } catch {
        /* it is gone */
      }
    });
    return;
  }

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // No group, or already gone. The direct kill is the remaining thing worth
    // trying, and its own failure means it is dead.
    try {
      child.kill();
    } catch {
      /* it is gone */
    }
  }
}
