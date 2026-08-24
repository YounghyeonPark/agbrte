/**
 * A terminal the **person** drives, in the workspace (DESIGN.md §6.4, §8).
 *
 * ## What this is not
 *
 * It is not an agent seat. Nothing *this file* does produces a `AgbrteEvent`,
 * writes to the event log, or passes through §13's permission gate — because
 * §13 gates *what a model asks for*, and this is a person typing on their own
 * machine. Putting a human keystroke in front of the gate would make the gate
 * mean two different things, and the one it exists for is the one that would get
 * weaker.
 *
 * That stays true when the program in the terminal is itself an agent CLI. A
 * person running `claude` in this pane is running it the way they would in any
 * terminal on the machine: it is their credential, their keyboard, and the
 * app is not mediating the turn — so there is nothing for §13 to gate and
 * nothing for the log to record. What the app *does* mediate is a CLI seat, and
 * that goes through `CliStdioRuntime` and is fully recorded.
 *
 * **One program is deliberately the other way round, and the distinction is
 * worth being exact about.** `{kind:'agbrte'}` starts our own CLI, which is a
 * *client of this host* (§8.1): the turns somebody sends from it are queued by
 * the same owner and appended to the same log as the ones the window sends, and
 * they get there by connecting to the socket like any other client — not through
 * this file. So the claim above is unchanged as a statement about the terminal
 * machinery, and false as a statement about the session, and only the first was
 * ever the property. Anything above this layer that says "nothing here enters
 * the transcript" has to say it per program; `Shell.tsx` does.
 *
 * The rest is a *view*: it belongs to whoever is looking at it and dies with
 * them. `preview.start` is the neighbouring case and makes the opposite trade
 * deliberately, outliving its client because a dev server should.
 *
 * ## What runs in it
 *
 * A shell, one of the agent CLIs this host detected — started **the way a person
 * would start it**, with no arguments at all — or Agbrte's own CLI attached to
 * the session the pane is showing. `programs.ts` holds those decisions and the
 * reasoning behind them; what matters here is the shape they leave: `open` takes
 * a selector over a closed set, never a program name, so this file still has no
 * parameter through which a client could name a binary.
 *
 * ## Why the host owns it rather than main
 *
 * The host is the process that owns the workspace, so `cwd` is the workspace by
 * construction rather than by agreement, and a host on a build box gives you
 * that machine's shell rather than a shell here that has to pretend. The same
 * argument §6.8 makes for preview servers, arriving at the same place.
 *
 * That also keeps main free. §8's rule is that a blocked main process freezes
 * every window; a PTY draining `yes` at full speed is exactly the sort of thing
 * that should be draining somewhere else.
 *
 * ## Output is coalesced here, and bounded here
 *
 * A PTY emits many small chunks — every keystroke echoes — and each one crossing
 * the socket as its own JSON frame would put a terminal's idle chatter in front
 * of the event pushes §6.7 already worries about starving. So chunks are held
 * for one frame's worth of time and sent as one message.
 *
 * The buffer is capped, and when it overflows the **oldest** bytes go with a
 * marker rather than the newest. A terminal is a window onto the end of a
 * stream; dropping the tail would freeze the screen at the moment it stopped
 * being readable, which is the opposite of what somebody watching a build wants.
 * Saying so in-band matters too — silently swallowing 200 KB of a compiler error
 * produces a screen that looks complete and is not.
 *
 * ## The native module, and why it costs the build nothing
 *
 * `@lydell/node-pty` ships **Node-API** prebuilds (verified: the binary exports
 * `node_api_module_get_api_version_v1` and contains no `NODE_MODULE_VERSION`,
 * `v8::` or `Nan` symbols), which is what makes it ABI-stable across both Node
 * and Electron. The same `conpty.node` loads and spawns a working PTY under
 * plain `node` v24.18 *and* under `electron.exe` v43.2.0 with
 * `ELECTRON_RUN_AS_NODE=1` — which is precisely how this process is started.
 * There is no `electron-rebuild` step and no `node-gyp`: `npm run build` is
 * untouched, because esbuild never sees this module (it is loaded through
 * `createRequire` at first use, not imported).
 *
 * Loaded lazily and failing softly for the same reason. A remote host is two
 * bundled `.js` files uploaded to `~/.agbrte` with no `node_modules` beside
 * them (`uploadHostBundle`), so the require there would throw — and a host that
 * cannot open a terminal must still serve every session on it.
 */

import { createRequire } from 'node:module';
import { TERM_NAME, TerminalPrograms, terminalEnv } from './programs.js';
import type { ShellProgram } from '@shared/types/index.js';

/** What one open terminal looks like to whoever is holding it. */
export interface ShellHandle {
  /** Opaque, minted here. Never a pid, never a file descriptor (§7). */
  shellId: string;
  /**
   * The file that was started, as resolved on this machine.
   *
   * The answer to "what is running", which is what a person checks when a pane
   * is doing something they did not expect — and it is the host's answer, not an
   * echo of anything a client sent.
   *
   * Usually the file that was started, verbatim. Where the host had to put a
   * wrapper in front of the real program — the Windows shell relay in
   * `programs.ts` — it names the program instead of the wrapper, because
   * `cmd.exe` is a true answer to a question nobody asked.
   */
  program: string;
  /**
   * What to call it above the terminal, e.g. `Claude Code (installed CLI)`.
   *
   * Separate from `program` because the two say different things and the pane
   * needs both: `claude.exe` is where it came from, `Claude Code (installed
   * CLI)` is what somebody chose. A label derived in the renderer from the path
   * would be the renderer guessing at what the host started.
   */
  label: string;
  /** Where it started, which is the workspace. */
  cwd: string;
  cols: number;
  rows: number;
}

/** How a terminal ended, so a pane can say so instead of going quiet. */
export interface ShellExit {
  shellId: string;
  exitCode: number;
  signal?: number;
}

/**
 * The slice of `node-pty` used here.
 *
 * Declared rather than imported wholesale so this module has one narrow seam a
 * test can drive, and so nothing outside it depends on the shape of a package
 * that is loaded at runtime.
 */
export interface Pty {
  readonly pid: number;
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

/**
 * `args` is an argv, or — for the one program that needs it — a verbatim Win32
 * command line, which is a shape `node-pty` accepts natively. `programs.ts`
 * decides which and records why; nothing here has to know.
 */
export type PtySpawner = (
  program: string,
  args: string[] | string,
  opts: PtySpawnOptions,
) => Pty;

export class ShellUnavailable extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ShellUnavailable';
  }
}

/** How long output is held before it is sent, in ms. About one frame. */
export const COALESCE_MS = 16;

/**
 * How many bytes of un-sent output one terminal may hold.
 *
 * Reached only when the far side is slower than the program is loud — `cat` on
 * something large, a test runner in colour. Past it the oldest bytes go.
 */
export const MAX_PENDING_BYTES = 256 * 1024;

/**
 * Said in-band when the cap above is hit, so a gap is never silent.
 *
 * Assembled from escapes rather than written out, because it is going *to a
 * terminal*: the yellow is how a person tells our sentence from the program's
 * own output, and a literal control byte in a source file is invisible to
 * review and mangled by the first tool that normalises line endings.
 */
const ESC = '\u001b';
export const TRUNCATION_MARKER = `\r\n${ESC}[33m…[output truncated]…${ESC}[0m\r\n`;

/**
 * A sensible default size before the pane has measured itself.
 *
 * The pane fits and resizes immediately, so these only decide how the first few
 * milliseconds of a shell's banner wraps — but a `0`-column PTY makes some
 * programs divide by zero, so they are never zero.
 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

interface Running<Owner> {
  handle: ShellHandle;
  pty: Pty;
  /** Whose pane this is. The host uses it to sweep on disconnect. */
  owner: Owner;
  pending: string;
  timer: NodeJS.Timeout | null;
  exited: boolean;
}

/**
 * Load `node-pty` the first time somebody asks for a terminal.
 *
 * `createRequire` rather than an `import`: esbuild bundles this file, and a
 * static import of a package with a `.node` binary inside it would either be
 * inlined (impossible) or left as a load-time dependency of a host that must
 * start on machines where it is absent.
 */
let cached: PtySpawner | undefined;
/**
 * Why the load failed last time, kept for the message and **not** as an answer.
 *
 * Two things are wanted here and they pull apart. A second attempt must not
 * report a generic sentence when the first reported a real one — the second
 * attempt is the one somebody makes after reading the message. But it must also
 * not report the *old* one: the reason they made it is that they changed
 * something, and on a remote that something is this module arriving after the
 * host had already started and concluded it was absent.
 *
 * So the load is retried and this is overwritten. What is remembered is the
 * wording, never the verdict.
 */
let loadFailure: string | undefined;

/**
 * Whether this machine can open a terminal at all (§7).
 *
 * Asked per handshake rather than once at startup, because the answer changes
 * under a running host: a remote is given this module while its host is already
 * serving, and a value captured at start would say "no terminal here" until
 * somebody restarted it. The load is cached on success, so a host that has one
 * pays for the check once.
 *
 * Asked at all so a host can *say* it on its handshake instead of a
 * client inferring it. The inference it replaces was `targetKind === 'local'`,
 * which was true of the world it was written in — a remote host was two `.js`
 * files with no `node_modules` — and became a lie the moment the pty module was
 * deployed with them. It was also wrong the other way: an arm64 build that ships
 * without the prebuild is a *local* host that cannot open one.
 *
 * A load rather than a file check, because "the module is on disk" and "the
 * module runs here" are different claims and only the second one matters. The
 * result is cached by `loadSpawner` either way, so this costs the first terminal
 * nothing.
 */
export function shellsAvailable(): boolean {
  try {
    loadSpawner();
    return true;
  } catch {
    return false;
  }
}

function loadSpawner(): PtySpawner {
  if (cached !== undefined) return cached;

  try {
    const require = createRequire(import.meta.url);
    const pty = require('@lydell/node-pty') as {
      // `string` as well as `string[]`: the library's own signature, and the
      // one program that has to go through `cmd.exe` needs it (see
      // `comspecCommandLine`).
      spawn: (file: string, args: string[] | string, options: Record<string, unknown>) => Pty;
    };
    cached = (program, args, opts) =>
      pty.spawn(program, args, {
        // Somebody measured. This used to claim `xterm-color` — eight colours —
        // on the grounds that overclaiming is how a TUI draws wrongly, which is
        // the right instinct and was the wrong number: xterm.js implements the
        // 256-colour palette and 24-bit SGR, and a real `claude` in this pane
        // emits `38;2;r;g;b` and renders correctly. Underclaiming has its own
        // cost, and it is the one that shows: a full-screen TUI told it has
        // eight colours draws a duller, flatter version of itself.
        name: TERM_NAME,
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd,
        env: opts.env,
        // Windows only, ignored elsewhere: hide the helper console window that
        // ConPTY would otherwise flash on screen.
        windowsHide: true,
      });
    return cached;
  } catch (err) {
    loadFailure =
      'this host cannot open a terminal — the pty module is not installed beside its bundle ' +
      `(${err instanceof Error ? err.message : String(err)})`;
    throw new ShellUnavailable(loadFailure);
  }
}

/**
 * Every terminal this host has open.
 *
 * Transport-free on purpose, like `PreviewServers` beside it: it takes a sink
 * and a spawner, so the batching and the bounding — where the bugs are — can be
 * driven by a test with no socket, no PTY, and no clock of its own.
 */
export class Shells<Owner extends object = object> {
  private readonly running = new Map<string, Running<Owner>>();
  private counter = 0;

  constructor(
    private readonly workspaceRoot: string,
    private readonly opts: {
      /** Where coalesced output goes. Called once per flush, never per chunk. */
      onData: (shellId: string, data: string, owner: Owner) => void;
      onExit: (exit: ShellExit, owner: Owner) => void;
      /** Injectable so a test needs no native module and no real shell. */
      spawn?: PtySpawner;
      env?: NodeJS.ProcessEnv;
      /**
       * The closed set of programs this host will start.
       *
       * Absent means *a shell and nothing else*: every `{kind:'cli'}` is refused
       * by name. That is the honest default for a host with no agent host behind
       * it, and it is a refusal rather than a quiet fall back to the shell —
       * a pane labelled "Claude Code" showing a PowerShell prompt is a lie in
       * the one place the label carries weight.
       */
      programs?: TerminalPrograms;
      /** Injectable so a test drives time rather than sleeping through it. */
      setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
      clearTimer?: (h: NodeJS.Timeout) => void;
    },
  ) {}

  /**
   * Open one, in the workspace.
   *
   * The **caller does not choose `cwd`, and chooses the program only from a
   * closed set**. That is the narrowing §7 asks for, kept intact while the pane
   * gained a second thing it can run: `program` is a selector over what this
   * host detected for itself (`TerminalPrograms`), not a name, a path or an
   * argv, so there is still no string a client can send that becomes a command
   * line. An id this host did not detect is refused by name.
   */
  open(
    owner: Owner,
    opts?: { program?: ShellProgram; cols?: number; rows?: number; sessionId?: string },
  ): ShellHandle {
    // Resolved before the spawner is loaded: a refusal for an undetected CLI
    // should say so on a machine with no pty module either, and loading first
    // would answer the wrong question first.
    const chosen = (
      this.opts.programs ??
      new TerminalPrograms(this.opts.env === undefined ? {} : { env: this.opts.env })
    ).resolve(opts?.program, {
      // The workspace is ours and the session id is the caller's, which is why
      // they arrive here from different directions and are separated again on
      // the way out (see `ProgramContext`).
      workspaceRoot: this.workspaceRoot,
      ...(opts?.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    });
    const spawner = this.opts.spawn ?? loadSpawner();
    /*
     * This machine's environment, then whatever *that program* needs.
     *
     * The overlay is one key today (`ELECTRON_RUN_AS_NODE`, for our own CLI)
     * and it is composed here rather than inside `terminalEnv` because the two
     * are answering different questions: `terminalEnv` describes the terminal,
     * which is the same for everything a person can start in it, and this
     * describes one program's requirements. Folding the second into the first
     * would put a per-program exception in the function whose whole value is
     * that it has none.
     */
    const env = { ...terminalEnv(this.opts.env ?? process.env), ...chosen.env };
    const cols = clamp(opts?.cols ?? DEFAULT_COLS);
    const rows = clamp(opts?.rows ?? DEFAULT_ROWS);

    this.counter += 1;
    const shellId = `shell-${this.counter}`;
    const handle: ShellHandle = {
      shellId,
      // What is running, which for a wrapped program is not the file that was
      // started — see `ResolvedProgram.display`.
      program: chosen.display ?? chosen.file,
      label: chosen.label,
      cwd: this.workspaceRoot,
      cols,
      rows,
    };

    const pty = spawner(chosen.file, chosen.args, {
      cwd: this.workspaceRoot,
      cols,
      rows,
      env,
    });
    const entry: Running<Owner> = { handle, pty, owner, pending: '', timer: null, exited: false };
    this.running.set(shellId, entry);

    pty.onData((data) => this.absorb(entry, data));
    pty.onExit(({ exitCode, signal }) => {
      /*
       * Only for a program that ended on its own.
       *
       * `destroy` kills the pty, so this fires for a terminal somebody has
       * already closed — and announcing that is telling the closer a thing they
       * did. Worse, it would arrive at a pane that has already unmounted, which
       * is the shape of message that later grows a "why is this listener still
       * here" workaround. `exited` is set before the kill for exactly this.
       */
      if (entry.exited) return;
      // Flushed first: the last thing a failing command prints is the reason it
      // failed, and losing it to the exit that it caused is the one gap nobody
      // can work around.
      this.flush(entry);
      entry.exited = true;
      this.running.delete(shellId);
      this.opts.onExit(
        { shellId, exitCode, ...(signal !== undefined ? { signal } : {}) },
        entry.owner,
      );
    });

    return handle;
  }

  /** Keystrokes. Written straight through — a keypress that waits is a keypress. */
  write(owner: Owner, shellId: string, data: string): boolean {
    const entry = this.owned(owner, shellId);
    if (entry === null) return false;
    entry.pty.write(data);
    return true;
  }

  resize(owner: Owner, shellId: string, cols: number, rows: number): boolean {
    const entry = this.owned(owner, shellId);
    if (entry === null) return false;
    entry.handle.cols = clamp(cols);
    entry.handle.rows = clamp(rows);
    entry.pty.resize(entry.handle.cols, entry.handle.rows);
    return true;
  }

  /** Close one. The pane going away is the ordinary reason. */
  close(owner: Owner, shellId: string): boolean {
    const entry = this.owned(owner, shellId);
    if (entry === null) return false;
    this.destroy(entry);
    return true;
  }

  /**
   * Everything one client had open, for a connection that went away.
   *
   * A shell whose only reader has gone is a program waiting on a prompt nobody
   * will ever answer, printing into a buffer nobody will ever read. Unlike a
   * preview server — which is started on purpose to outlive the person who
   * started it — that is pure leak, so it goes.
   */
  closeOwned(owner: Owner): number {
    let closed = 0;
    for (const entry of [...this.running.values()]) {
      if (entry.owner !== owner) continue;
      this.destroy(entry);
      closed += 1;
    }
    return closed;
  }

  /** Everything, for host shutdown. */
  closeAll(): void {
    for (const entry of [...this.running.values()]) this.destroy(entry);
  }

  /** Test and diagnostic view. */
  get openCount(): number {
    return this.running.size;
  }

  private owned(owner: Owner, shellId: string): Running<Owner> | null {
    const entry = this.running.get(shellId);
    // Ownership is checked rather than assumed: one host serves several clients,
    // and a shell id is a short string anybody could guess. A client must not be
    // able to type into a terminal on somebody else's screen.
    if (entry === undefined || entry.owner !== owner || entry.exited) return null;
    return entry;
  }

  private destroy(entry: Running<Owner>): void {
    this.running.delete(entry.handle.shellId);
    if (entry.timer !== null) {
      (this.opts.clearTimer ?? clearTimeout)(entry.timer);
      entry.timer = null;
    }
    if (entry.exited) return;
    entry.exited = true;
    try {
      entry.pty.kill();
    } catch {
      // Already gone. The outcome wanted either way.
    }
  }

  private absorb(entry: Running<Owner>, chunk: string): void {
    entry.pending += chunk;

    if (entry.pending.length > MAX_PENDING_BYTES) {
      // The oldest goes, and says so. See the note at the top of the file for
      // why this end rather than the other one.
      entry.pending =
        TRUNCATION_MARKER + entry.pending.slice(entry.pending.length - MAX_PENDING_BYTES);
    }

    if (entry.timer !== null) return;
    entry.timer = (this.opts.setTimer ?? setTimeout)(() => this.flush(entry), COALESCE_MS);
    // Never a reason for the process to stay up.
    entry.timer.unref?.();
  }

  private flush(entry: Running<Owner>): void {
    if (entry.timer !== null) {
      (this.opts.clearTimer ?? clearTimeout)(entry.timer);
      entry.timer = null;
    }
    if (entry.pending === '') return;
    const data = entry.pending;
    entry.pending = '';
    this.opts.onData(entry.handle.shellId, data, entry.owner);
  }
}

/**
 * A size a PTY will accept.
 *
 * Zero columns makes some programs divide by zero and some hang; an absurd
 * number is a renderer that measured a hidden element. Both arrive from a
 * `fit()` on a pane that is mid-layout, which is a normal thing to happen.
 */
function clamp(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_COLS;
  return Math.max(1, Math.min(1000, Math.floor(n)));
}
