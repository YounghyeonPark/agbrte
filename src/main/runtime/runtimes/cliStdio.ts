/**
 * `agent-cli-stdio` — driving an agent CLI the user already installed (§3.12).
 *
 * The third adapter shape, and the one that shares nothing with the other two.
 * The SDK adapter holds a long-lived query and streams turns into it; the
 * harness runs our own loop over HTTP. This one has **no loop it can hold onto
 * at all**: headless agent CLIs are one-shot. `claude -p "…"` runs a turn and
 * exits, and continuing means starting a new process with `--resume <id>`.
 *
 * So a turn here is a *process*, and the session is a string the last process
 * printed. Everything below follows from that.
 *
 * ## The gate costs a process
 *
 * Headless mode has no per-call approval callback — that is a library feature.
 * This adapter therefore declares whatever fidelity its manifest declares
 * (`precomputed-allowlist` at best), and §13's rule is that a runtime must never
 * claim a gate it does not have. What it can do is §3.12's deny-ask-resume:
 *
 *   1. compile our `ToolPolicy` into the CLI's allowlist before spawn;
 *   2. run under the CLI's **deny-by-default** baseline, never the
 *      abort-on-unallowed one — denial lets the agent adapt, aborting loses the
 *      turn;
 *   3. when a call is refused, ask the user, add the rule, and re-spawn with
 *      `--resume` so the work already done is kept.
 *
 * The tool did not run, and the user decided before it could. That is a real
 * gate. It is just one that costs a process and cannot express "allow once".
 *
 * ## One `stopped`, at the end of the whole turn
 *
 * A run that ends in a denial is not the end of the turn — the turn continues in
 * the next process. So the manifest reports the end of a *run* as `end`, this
 * adapter decides whether another run follows, and exactly one `stopped` reaches
 * the pump. Forwarding each run's stop would have ended the session's turn at
 * the first denied tool call, which is the failure this whole flow exists to
 * avoid.
 *
 * ## Verification status
 *
 * Exercised end to end against a real subprocess speaking the protocol, over
 * real pipes (`tests/fixtures/fakeCli.mjs`) — spawn, chunked NDJSON, exit codes,
 * and a full deny → ask → grant → resume across two processes. What that cannot
 * prove is the *flag names*, which are the vendor's to change. Every manifest
 * carries `verified`, and a conformance run against an installed build is what
 * flips it.
 */

import { spawn } from 'node:child_process';
import {
  compilePolicy,
  LineSplitter,
  parseLine,
  type CliAgentManifest,
  type CliRecord,
} from '../cli/manifest.js';
import type {
  AgentHandle,
  AgentRuntime,
  AgentSpec,
  PermissionDecision,
  RuntimeCapabilities,
  RuntimeContext,
  RuntimeEvent,
  StopReason,
  UserTurn,
} from '@shared/types/index.js';

export const ADAPTER_VERSION = '0.0.1';

/** How many denials may be granted and resumed within one turn. */
const DEFAULT_MAX_GRANTS = 3;

/** Enough stderr to explain a failure, not enough to hold a runaway log. */
const STDERR_CAP = 8_192;

// ------------------------------------------------------------------ spawning

export interface CliExit {
  code: number | null;
  signal: string | null;
  stderr: string;
  /**
   * The OS's own word for why the process never started — `ENOENT`, `EACCES`.
   *
   * Kept apart from `stderr` because it is the difference between *this tool is
   * not installed* and *this tool ran and complained*, which are different
   * problems with different remedies. Both used to arrive here as prose in the
   * same field, so detection could only report "it did not work".
   */
  errorCode?: string;
}

export interface CliRun {
  /** Raw stdout, at whatever boundaries the pipe happens to produce. */
  stdout: AsyncIterable<string>;
  exit: Promise<CliExit>;
  kill(): void;
}

export interface SpawnOptions {
  cwd: string;
  stdin?: string;
}

export type SpawnCli = (argv: string[], opts: SpawnOptions) => CliRun;

/**
 * The real subprocess.
 *
 * Note what is *not* here: no shell. Arguments reach the binary as an argv
 * array, so a workspace path with a space, or a policy pattern containing `&&`,
 * is data rather than syntax.
 */
export const nodeSpawn: SpawnCli = (argv, opts) => {
  const [bin, ...rest] = argv;
  if (bin === undefined) throw new Error('cannot spawn an empty argv');

  const child = spawn(bin, rest, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stderr = '';
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < STDERR_CAP) stderr += chunk;
  });

  const exit = new Promise<CliExit>((resolve) => {
    let settled = false;
    const done = (e: CliExit): void => {
      if (settled) return;
      settled = true;
      resolve(e);
    };
    // A missing binary raises `error` and may never produce `close`, so both
    // paths must settle — otherwise a typo'd manifest hangs the turn forever
    // instead of failing it.
    child.on('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code;
      done({
        code: null,
        signal: null,
        stderr: stderr || String(err),
        ...(code === undefined ? {} : { errorCode: code }),
      });
    });
    child.on('close', (code, signal) => done({ code, signal, stderr }));
  });

  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();

  return { stdout: child.stdout, exit, kill: () => void child.kill() };
};

// ------------------------------------------------------------------ detection

export interface DetectedCli {
  binary: string;
  version: string;
}

/**
 * The outcome of looking for one CLI — found, or not found *and why*.
 *
 * `detectCli` used to return `DetectedCli | null`, and `null` is where a long
 * afternoon went. A host that could not find `claude` said nothing to anybody:
 * the runtime was absent from the handshake, absent from the picker, and absent
 * from every log — indistinguishable from a client that had forgotten to ask.
 * The information existed for a few microseconds inside a `catch` and was
 * dropped on the floor.
 *
 * So the negative case carries a sentence. It costs one string per manifest,
 * computed once when the agent host comes up, and it is the difference between
 * "not installed on this machine" and "something is wrong with this app".
 */
export type CliDetection =
  | { found: true; binary: string; version: string }
  | { found: false; binary: string; reason: string };

/**
 * Find the CLI and read its version.
 *
 * Never throws: a CLI the user has not installed is an ordinary state of the
 * world, and the caller's job is to not offer it — not to fail starting up.
 *
 * The three ways this fails are kept apart, because they send a person to three
 * different places. A **spawn error** means the binary is not on this host's
 * PATH — the usual case, and the one whose remedy is "install it, or start the
 * host from a shell that can see it". A **non-zero exit** means it is installed
 * and unhappy, so its own stderr is the useful thing to repeat. An **unmatched
 * version pattern** is neither: the tool answered, so it is still offered with
 * `version: 'unknown'` rather than being discarded over a changed banner — but
 * it is worth saying, because a vendor who reformats `--version` is a vendor who
 * may have changed the flags this manifest is built on.
 */
export async function detectCli(
  manifest: CliAgentManifest,
  spawnFn: SpawnCli = nodeSpawn,
  cwd: string = process.cwd(),
): Promise<CliDetection> {
  const binary = manifest.detect.binary;
  let out = '';
  try {
    const run = spawnFn([binary, ...manifest.detect.versionArgs], { cwd });
    for await (const chunk of run.stdout) out += chunk;
    const exit = await run.exit;

    // `code: null` with no signal is how `nodeSpawn` reports a process that
    // never started. Checked before the exit code, because "exited with null"
    // would be a confusing way to say "not installed".
    if (exit.code === null && exit.signal === null) {
      return {
        found: false,
        binary,
        reason:
          `\`${binary}\` could not be started on this host` +
          `${exit.errorCode === undefined ? '' : ` (${exit.errorCode})`}` +
          ` — it is probably not installed, or not on the PATH this host was started with`,
      };
    }
    if (exit.code !== 0) {
      return {
        found: false,
        binary,
        reason:
          `\`${binary} ${manifest.detect.versionArgs.join(' ')}\` exited ${exit.code ?? `on ${exit.signal ?? 'a signal'}`}` +
          `${firstLine(exit.stderr) === '' ? '' : `: ${firstLine(exit.stderr)}`}`,
      };
    }
  } catch (err) {
    // A `spawnFn` that throws synchronously rather than settling `exit` — a
    // test double, or an argv this platform will not take.
    return {
      found: false,
      binary,
      reason: `\`${binary}\` could not be started on this host: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const match = manifest.detect.versionPattern.exec(out);
  // A binary that answers but not with a version is still a binary. Recorded as
  // unknown rather than discarded, so the transcript says which is which.
  return { found: true, binary, version: match?.[1] ?? 'unknown' };
}

/** Enough of a tool's complaint to act on, on one line of a picker. */
function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim().length > 0) ?? '';
  return line.trim().slice(0, 200);
}

// -------------------------------------------------------------------- runtime

export interface CliStdioOptions {
  manifest: CliAgentManifest;
  /** Overridden in tests; defaults to a real subprocess. */
  spawnFn?: SpawnCli;
  /** From `detectCli`, recorded on every event this runtime produces (§5.1). */
  toolVersion?: string;
  maxGrants?: number;
}

export class CliStdioRuntime implements AgentRuntime {
  readonly id: string;
  readonly version = ADAPTER_VERSION;
  readonly toolVersion?: string;

  private readonly manifest: CliAgentManifest;
  private readonly spawnFn: SpawnCli;
  private readonly maxGrants: number;

  constructor(opts: CliStdioOptions) {
    this.manifest = opts.manifest;
    this.id = runtimeIdFor(opts.manifest);
    this.spawnFn = opts.spawnFn ?? nodeSpawn;
    this.maxGrants = opts.maxGrants ?? DEFAULT_MAX_GRANTS;
    if (opts.toolVersion !== undefined) this.toolVersion = opts.toolVersion;
  }

  async capabilities(_spec: AgentSpec): Promise<RuntimeCapabilities> {
    return {
      ...this.manifest.capabilities,
      permissionFidelity: this.manifest.permissionFidelity,
      // A manifest cannot claim native resume without supplying the flag that
      // performs one. Enforced rather than trusted: the contract suite checks
      // that a runtime declaring `nativeResume` produces a token, and this is
      // where a manifest edit would otherwise make that claim false.
      nativeResume:
        this.manifest.invoke.resumeArgs !== undefined && this.manifest.capabilities.nativeResume,
    };
  }

  async start(spec: AgentSpec, ctx: RuntimeContext): Promise<AgentHandle> {
    return new CliStdioHandle(spec, ctx, this.manifest, this.spawnFn, null, this.maxGrants);
  }

  async resume(spec: AgentSpec, token: string | null, ctx: RuntimeContext): Promise<AgentHandle> {
    return new CliStdioHandle(spec, ctx, this.manifest, this.spawnFn, token, this.maxGrants);
  }
}

/** Namespaced, so two installed CLIs are two runtimes rather than a collision. */
export function runtimeIdFor(manifest: CliAgentManifest): string {
  return `cli:${manifest.cliId}`;
}

/**
 * The CLI behind a runtime id, or `null` for a runtime that is not one.
 *
 * The inverse of `runtimeIdFor`, and here rather than at the caller so the id
 * format stays owned by one module. Its caller is `SessionManager`, deciding
 * what a seat authenticates with: an installed CLI signs itself in, and that is
 * a fact about *this* runtime family rather than about any particular manifest.
 */
export function cliIdOf(runtimeId: string): string | null {
  const cliId = runtimeId.startsWith('cli:') ? runtimeId.slice('cli:'.length) : '';
  return cliId === '' ? null : cliId;
}

// --------------------------------------------------------------------- handle

interface Denial {
  tool: string;
  args: unknown;
  toolUseId?: string;
}

interface RunOutcome {
  stop: StopReason;
  denials: Denial[];
}

class CliStdioHandle implements AgentHandle {
  private readonly queue: RuntimeEvent[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  private stream: AsyncIterable<RuntimeEvent> | null = null;

  private sessionId: string | null;
  /** Allowlist terms granted mid-turn, carried into every later spawn. */
  private readonly granted: string[] = [];
  private current: CliRun | null = null;
  private interrupted = false;

  /** The compiled policy, fixed before the first spawn — that is the fidelity. */
  private readonly baseAllow: string[];
  private readonly baseDeny: string[];

  constructor(
    private readonly spec: AgentSpec,
    private readonly ctx: RuntimeContext,
    private readonly manifest: CliAgentManifest,
    private readonly spawnFn: SpawnCli,
    resumeIn: string | null,
    private readonly maxGrants: number,
  ) {
    this.sessionId = resumeIn;

    ctx.abortSignal.addEventListener('abort', () => void this.interrupt(), { once: true });

    const compiled = compilePolicy(spec.toolPolicy, manifest.toolNames);
    for (const loss of compiled.losses) {
      // §3.5's rule, applied to policy instead of schemas: a degradation nobody
      // is told about becomes "this CLI just ignores my rules".
      ctx.reportProgress({
        kind: 'phase',
        detail: `policy rule ${loss.effect}: ${loss.rule.tool} — ${loss.reason}`,
        at: new Date().toISOString(),
      });
    }
    this.baseAllow = compiled.allow;
    this.baseDeny = compiled.deny;
  }

  async send(turn: UserTurn): Promise<void> {
    let prompt = promptText(turn);
    let grants = 0;
    let stop: StopReason = { kind: 'transport' };

    for (;;) {
      const outcome = await this.runOnce(prompt);
      stop = outcome.stop;

      if (this.interrupted) return; // `interrupt()` already stopped and closed.

      const resumable = this.manifest.invoke.resumeArgs !== undefined && this.sessionId !== null;

      if (outcome.denials.length === 0) break;

      if (!resumable) {
        // Nothing dishonest happened — the calls were refused and stayed
        // refused — but the user should know why approving is not on offer.
        this.report(
          `${outcome.denials.length} tool call(s) were denied and ${this.manifest.cliId} ` +
            `cannot resume, so they cannot be granted without restarting the turn`,
        );
        break;
      }
      if (grants >= this.maxGrants) {
        // A bounded number of repairs, for the same reason the text-protocol
        // codec caps its own: an agent that keeps finding new tools to be denied
        // would otherwise spawn processes until something else gives out.
        this.report(`stopped asking after ${this.maxGrants} grant rounds in one turn`);
        break;
      }

      const terms = await this.grantsFor(outcome.denials);
      if (terms.length === 0) break; // Everything was refused; the stop stands.

      this.granted.push(...terms);
      grants += 1;
      prompt = resumeInstruction(terms);
      continue;
    }

    // Exactly one, for the whole turn, however many processes it took.
    this.emit({ type: 'stopped', stop });
    this.close();
  }

  private async runOnce(rawPrompt: string): Promise<RunOutcome> {
    const prompt = this.compose(rawPrompt);
    const argv = this.argv(prompt);
    const read = this.manifest.parse.reader();
    const splitter = new LineSplitter();
    const denials: Denial[] = [];
    // A holder rather than a `let`: the assignment happens inside `consume`, and
    // a captured `let` initialized to `null` narrows to `never` at the read.
    //
    // `hint` is the weaker of the two (see `CliRecord`): something the run said
    // about itself that only matters if it never reaches an `end`.
    const seen: { stop: StopReason | null; hint: StopReason | null } = { stop: null, hint: null };

    const consume = (line: string): void => {
      // Reported *before* parsing: the banner lines `parseLine` rightly skips
      // are exactly what a person watching raw wants to see. The owner keeps
      // them — a handle is one turn, and the tail has to outlive the turn.
      this.ctx.reportRaw?.(line);
      const record = parseLine(line);
      // A CLI writes more than its protocol to stdout — update banners,
      // deprecation notices. Skipping them is not tolerance for sloppiness; it
      // is the difference between a notice and a lost turn.
      if (record === null) return;
      for (const out of read(record)) this.apply(out, denials, seen);
    };

    let run: CliRun;
    try {
      run = this.spawnFn(argv, {
        cwd: this.spec.workspacePath,
        ...(this.manifest.invoke.promptMode === 'stdin' ? { stdin: prompt } : {}),
      });
    } catch (err) {
      // Still worth a raw line: the terminal view's job is to answer "why is
      // nothing appearing", and a spawn that failed is the strongest answer.
      this.ctx.reportRaw?.(String(err));
      return { stop: { kind: 'misconfigured', detail: String(err) }, denials };
    }
    this.current = run;

    try {
      for await (const chunk of run.stdout) {
        for (const line of splitter.push(chunk)) consume(line);
      }
      for (const line of splitter.flush()) consume(line);
    } finally {
      this.current = null;
    }

    const exit = await run.exit;
    // Stderr reaches the tail at run end rather than live, because `CliRun`
    // only surfaces it there — a real cost, and a small one: these CLIs stream
    // their protocol on stdout, and stderr is the epitaph, not the narration.
    for (const line of exit.stderr.split('\n')) {
      if (line.trim() !== '') this.ctx.reportRaw?.(line);
    }
    if (seen.stop === null && exit.stderr.length > 0) this.report(exit.stderr.trim().slice(0, 400));

    /*
     * Three tiers, weakest last.
     *
     * The hint sits between the protocol and the exit code because it is better
     * than a guess and worse than a statement. A CLI killed while retrying a
     * rejected credential prints no `result`, and `stopFromExit` can only see a
     * non-zero exit — which is `transport`, which is retryable, which sends the
     * session to `awaiting_input` with nothing to act on. The run already said
     * what was wrong ten times; this is what stops us throwing that away.
     */
    return {
      stop: seen.stop ?? seen.hint ?? stopFromExit(exit, this.manifest.detect.binary),
      denials,
    };
  }

  private apply(
    record: CliRecord,
    denials: Denial[],
    seen: { stop: StopReason | null; hint: StopReason | null },
  ): void {
    switch (record.kind) {
      case 'event':
        this.emit(record.event);
        return;
      case 'session':
        // A cache, never truth (§5.4) — the event log is what a session is.
        this.sessionId = record.sessionId;
        return;
      case 'end':
        seen.stop = record.stop;
        return;
      case 'stop_hint':
        // Last one wins, and it never ends the run. A tenth retry that succeeds
        // is a successful turn, and the `end` record that follows overrides this.
        seen.hint = record.stop;
        return;
      case 'denied':
        denials.push({
          tool: record.tool,
          args: record.args,
          ...(record.toolUseId !== undefined ? { toolUseId: record.toolUseId } : {}),
        });
        return;
    }
  }

  /** Ask about each denied call and turn the approvals into allowlist terms. */
  private async grantsFor(denials: Denial[]): Promise<string[]> {
    const terms: string[] = [];
    for (const denial of denials) {
      const decision = await this.ctx.requestPermission({
        agentId: this.spec.agentId,
        tool: denial.tool,
        args: denial.args,
        ...(denial.toolUseId !== undefined ? { toolUseId: denial.toolUseId } : {}),
      });
      if (decision.result !== 'allow') continue;
      terms.push(this.termFor(denial, decision));
    }
    return terms;
  }

  /**
   * The narrowest allowlist term that expresses an approval.
   *
   * `allow once` has no allowlist equivalent — a rule granted before spawn lasts
   * as long as the process. The closest honest thing is the *exact* argument as
   * the pattern, which matches that call and nothing else, so approving
   * `git status` does not also approve `git push`. Where no string argument can
   * be identified the grant widens to the whole tool, and says so.
   */
  private termFor(denial: Denial, decision: Extract<PermissionDecision, { result: 'allow' }>): string {
    const name = this.manifest.toolNames[denial.tool.toLowerCase()] ?? denial.tool;

    if (decision.scope === 'pattern') return `${name}(${decision.match})`;
    if (decision.scope === 'session') return name;

    const exact = designatedArg(denial.args);
    if (exact === null) {
      this.report(
        `approved ${denial.tool} for the rest of this run: "once" cannot be expressed in an ` +
          `allowlist and this call has no single argument to pin it to`,
      );
      return name;
    }
    return `${name}(${exact})`;
  }

  private argv(prompt: string): string[] {
    const inv = this.manifest.invoke;
    const argv = [this.manifest.detect.binary, ...inv.baseArgs];

    /**
     * Deterministic mode is chosen by the auth mode, not configured.
     *
     * §3.12 offers it as a user choice, and for Claude Code it is also what
     * skips OAuth and keychain reads. Under `vendor-cli-session` the login it
     * declines to read is the entire reason we are invoking the user's own CLI,
     * so the two settings cannot both be honored. Deriving it here means they
     * cannot be configured into contradicting each other.
     */
    if (inv.deterministicArgs && this.spec.auth.kind !== 'vendor-cli-session') {
      argv.push(...inv.deterministicArgs);
    }
    /**
     * Only when the user actually named one.
     *
     * The CLI's own default is a real answer — it is the vendor's tuned choice
     * for their own harness — so an unset model means "yours", not "ours".
     */
    if (inv.modelArgs && this.spec.model !== undefined) {
      argv.push(...inv.modelArgs(this.spec.model.modelId));
    }
    if (inv.permissionModeArgs) argv.push(...inv.permissionModeArgs);
    if (inv.workspaceArgs) argv.push(...inv.workspaceArgs(this.spec.workspacePath));

    const allow = [...this.baseAllow, ...this.granted];
    if (inv.allowArgs && allow.length > 0) argv.push(...inv.allowArgs(allow));
    if (inv.denyArgs && this.baseDeny.length > 0) argv.push(...inv.denyArgs(this.baseDeny));

    if (inv.resumeArgs && this.sessionId !== null) argv.push(...inv.resumeArgs(this.sessionId));

    if (inv.promptMode === 'argv') argv.push(prompt);

    return argv;
  }

  /**
   * The system prompt goes into the turn, not into a flag.
   *
   * The flag that carries one differs per CLI and per version, and a wrong flag
   * on these tools is accepted and ignored rather than rejected — so the failure
   * mode is instructions that silently never arrived.
   */
  private compose(prompt: string): string {
    return this.spec.systemPrompt !== undefined
      ? `${this.spec.systemPrompt}\n\n${prompt}`
      : prompt;
  }

  async interrupt(): Promise<void> {
    if (this.closed) return;
    this.interrupted = true;
    this.current?.kill();
    // Killing *is* the interrupt here: headless CLIs expose no other channel.
    // Reported as `end_turn` because the session should wait for the person who
    // asked for the interruption, which is what `awaiting_input` means (§4.1).
    this.emit({ type: 'stopped', stop: { kind: 'end_turn' } });
    this.close();
  }

  async stop(_reason: string): Promise<void> {
    this.current?.kill();
    this.close();
  }

  /** The CLI's own session id. A cache, never truth (§5.4). */
  resumeToken(): string | null {
    return this.sessionId;
  }

  get events(): AsyncIterable<RuntimeEvent> {
    this.stream ??= {
      [Symbol.asyncIterator]: async function* (this: CliStdioHandle) {
        while (true) {
          while (this.queue.length > 0) yield this.queue.shift() as RuntimeEvent;
          if (this.closed) return;
          await new Promise<void>((r) => {
            this.waiter = r;
          });
        }
      }.bind(this),
    };
    return this.stream;
  }

  private report(detail: string): void {
    this.ctx.reportProgress({ kind: 'phase', detail, at: new Date().toISOString() });
  }

  private emit(ev: RuntimeEvent): void {
    this.queue.push(ev);
    this.wake();
  }

  private close(): void {
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
}

// --------------------------------------------------------------------- pieces

/**
 * What a process exit means when no protocol record explained it.
 *
 * A clean exit with no result is a **truncation**, not a success: the turn
 * stopped somewhere in the middle and reporting it as finished is the worst
 * available outcome, because it looks like the work was done.
 */
export function stopFromExit(exit: CliExit, binary: string): StopReason {
  if (/ENOENT|not found|not recognized|No such file/i.test(exit.stderr)) {
    // Retrying cannot install a CLI, and `transport` is retryable — so an
    // uninstalled binary mapped there would burn the attempt budget on a typo.
    return { kind: 'misconfigured', detail: `${binary} is not installed or not on PATH` };
  }
  // Everything else — a non-zero exit, a signal, a clean exit that never printed
  // a result — is retryable, because the alternative is calling a truncated turn
  // a finished one.
  return { kind: 'transport' };
}

/**
 * The argument an approval should be pinned to.
 *
 * Ordered, not "first string found": tools carry incidental strings — a
 * description, a label — and pinning a grant to one of those would produce a
 * rule that matches nothing while looking specific.
 */
const DESIGNATED_ARGS = ['command', 'file_path', 'path', 'url', 'pattern', 'query'] as const;

export function designatedArg(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of DESIGNATED_ARGS) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

export function promptText(turn: UserTurn): string {
  return turn.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join('\n');
}

/**
 * What the resuming process is told.
 *
 * Not the original turn. The session already contains it, and re-sending would
 * ask for everything to be done a second time — the opposite of §15's "resumes
 * without losing the turn".
 */
export function resumeInstruction(granted: string[]): string {
  return (
    `Permission has been granted for: ${granted.join(', ')}. ` +
    `Continue from where you stopped and do not repeat work you have already completed.`
  );
}
