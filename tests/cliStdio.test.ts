/**
 * The installed-CLI adapter (DESIGN.md §3.12, §15 Phase 3).
 *
 * > *Done when:* … the user's installed CLI under its own auth. Second
 * > criterion: a coarse-gated CLI agent hits a denied tool, the user grants the
 * > rule, and it resumes without losing the turn.
 *
 * Half of this file drives a **real subprocess** (`fixtures/fakeCli.mjs`) over
 * real pipes. That is deliberate: the two things that actually break a
 * text-protocol adapter are framing and process lifetime, and a mocked spawn
 * assumes both away. The deny-ask-resume test in particular is only meaningful
 * across two genuinely separate processes, since "without losing the turn" is a
 * claim about what survives the first one exiting.
 *
 * The other half uses a scripted spawn, for the cases a fixture cannot produce
 * on demand — a CLI that cannot resume, a turn that keeps finding new tools to
 * be denied, a process that never ends.
 */

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ADAPTER_VERSION,
  CliStdioRuntime,
  cliIdOf,
  detectCli,
  designatedArg,
  runtimeIdFor,
  resumeInstruction,
  stopFromExit,
  type CliRun,
  type SpawnCli,
} from '@main/runtime/runtimes/cliStdio.js';
import { CLAUDE_CODE_MANIFEST, GEMINI_CLI_MANIFEST } from '@main/runtime/cli/manifests.js';
import {
  compilePolicy,
  LineSplitter,
  parseLine,
  type CliAgentManifest,
} from '@main/runtime/cli/manifest.js';
import {
  newAgentId,
  type AgentSpec,
  type PermissionDecision,
  type RuntimeContext,
  type RuntimeEvent,
  type ToolPolicy,
} from '@shared/types/index.js';
import { recorderFor, scenario } from './support/conformance.js';

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeCli.mjs');

const recorder = recorderFor('cli-stdio');

/**
 * Record a scenario the shared contract does not cover.
 *
 * These belong here rather than in the contract suite because they are not
 * things every adapter owes — nothing about `echo` has pipe framing. They are
 * still rows in the matrix, since "this adapter reassembles a split record" is
 * exactly what someone choosing a CLI runtime wants to know, and a matrix that
 * only carried the universal scenarios would have nothing to say about the
 * failure modes specific to a text protocol.
 *
 * Evidence is `real-subprocess` for all of them: every one drives the fixture
 * over real pipes.
 */
function cliScenario(scenarioId: string, body: () => Promise<void>): Promise<void> {
  return scenario(
    recorder,
    {
      runtimeId: 'cli:claude-code',
      scenarioId,
      adapterVersion: ADAPTER_VERSION,
      evidence: 'real-subprocess',
    },
    body,
  );
}
const EMPTY_POLICY: ToolPolicy = { rules: [], defaultAction: 'ask' };

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    agentId: newAgentId(),
    role: 'worker',
    runtimeId: 'cli:claude-code',
    auth: { kind: 'vendor-cli-session', cliId: 'claude-code', quotaGroup: 'default' },
    toolPolicy: EMPTY_POLICY,
    limits: {},
    workspacePath: process.cwd(),
    ...over,
  };
}

interface Ctx extends RuntimeContext {
  asked: Array<{ tool: string; args: unknown }>;
  progress: string[];
}

function context(decide: () => PermissionDecision = () => ({ result: 'allow', scope: 'once' })): Ctx {
  const asked: Array<{ tool: string; args: unknown }> = [];
  const progress: string[] = [];
  return {
    asked,
    progress,
    requestPermission: async (ask) => {
      asked.push({ tool: ask.tool, args: ask.args });
      return decide();
    },
    reportProgress: (p) => progress.push(p.detail ?? ''),
    abortSignal: new AbortController().signal,
  };
}

async function drain(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of events) out.push(ev);
  return out;
}

/** The real manifest, pointed at the fixture instead of an installed `claude`. */
function fixtureManifest(mode: string, over: Partial<CliAgentManifest> = {}): CliAgentManifest {
  return {
    ...CLAUDE_CODE_MANIFEST,
    detect: { ...CLAUDE_CODE_MANIFEST.detect, binary: process.execPath },
    invoke: {
      ...CLAUDE_CODE_MANIFEST.invoke,
      baseArgs: [FIXTURE, '--mode', mode, ...CLAUDE_CODE_MANIFEST.invoke.baseArgs],
    },
    ...over,
  };
}

/**
 * The same manifest with its resume flag removed.
 *
 * Deleted rather than set to `undefined`: `exactOptionalPropertyTypes` treats
 * "absent" and "present and undefined" as different, and the adapter's check is
 * for absence.
 */
function withoutResume(manifest: CliAgentManifest): CliAgentManifest {
  const { resumeArgs, ...invoke } = manifest.invoke;
  void resumeArgs;
  return { ...manifest, invoke };
}

async function runTurn(
  manifest: CliAgentManifest,
  ctx: Ctx = context(),
  over: Partial<AgentSpec> = {},
): Promise<RuntimeEvent[]> {
  const runtime = new CliStdioRuntime({ manifest });
  const handle = await runtime.start(spec(over), ctx);
  const drained = drain(handle.events);
  await handle.send({ content: [{ type: 'text', text: 'do the thing' }] });
  return drained;
}

// ------------------------------------------------- against a real subprocess

describe('driving an actual process', () => {
  it('turns a run into text, usage, and one stop', async () => {
    const events = await runTurn(fixtureManifest('plain'));

    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
  });

  it('reads a record that arrived in pieces', async () =>
    cliScenario('chunked-framing', async () => {
      // The pipe hands over whatever was buffered. Treating a chunk as a line
      // works on every short test and loses the middle of real output.
      const events = await runTurn(fixtureManifest('split'));
      expect(events).toContainEqual({ type: 'text', text: 'chunked across writes' });
    }));

  it('ignores the things a CLI prints that are not its protocol', async () =>
    cliScenario('non-protocol-output', async () => {
      // An npm notice is not a failed turn.
      const events = await runTurn(fixtureManifest('noise'));
      expect(events).toContainEqual({ type: 'text', text: 'hello' });
      expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
    }));

  it('calls a truncated run a transport failure, not a success', async () =>
    cliScenario('truncated-run', async () => {
      const events = await runTurn(fixtureManifest('crash'));
      // It said something and then died. Reporting `end_turn` would mean the
      // session moves on believing the work was finished.
      expect(events).toContainEqual({ type: 'text', text: 'got partway' });
      expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'transport' } });
    }));

  it('does not retry a CLI that is not installed', async () =>
    cliScenario('missing-binary', async () => {
      const events = await runTurn(fixtureManifest('missing'));
      const last = events.at(-1);
      // `transport` is retryable, so mapping this there would spend the whole
      // attempt budget on a binary that will never appear.
      expect(last).toMatchObject({ type: 'stopped', stop: { kind: 'misconfigured' } });
    }));

  it('parks a CLI that is not logged in, with the command that fixes it', async () =>
    cliScenario('unauthenticated-parks', async () => {
      const events = await runTurn(fixtureManifest('no-login'));

      // The trap this exists for: that run's `result` says `subtype: "success"`,
      // so reading the subtype first reported a turn that never reached the
      // model as a clean finish — and "Not logged in · Please run /login"
      // arrived as ordinary assistant text with no route forward.
      const stop = events.at(-1);
      expect(stop).toMatchObject({ type: 'stopped', stop: { kind: 'auth' } });
      // `auth` pauses (§4.1). `end_turn` and `transport` both move on as though
      // the turn had happened, and `misconfigured` would fail a session that a
      // login fixes in ten seconds.
      expect(stop).not.toMatchObject({ stop: { kind: 'end_turn' } });

      // Actionable, and specific enough to type. The category came from the
      // `error` field; nothing matched on the vendor's sentence.
      const detail = (stop as { stop: { detail?: string } }).stop.detail ?? '';
      expect(detail).toContain('claude auth login');
    }));

  it('remembers why a run was failing when it dies before saying so', async () => {
    // Ten `api_retry` records naming a rejected credential, then a process that
    // ends without a `result`. The exit code alone is `transport` — retryable,
    // and retrying an unauthenticated CLI helps nobody.
    const events = await runTurn(fixtureManifest('auth-dies'));
    expect(events.at(-1)).toMatchObject({ type: 'stopped', stop: { kind: 'auth' } });
  });

  it('lets a retry that recovers finish the turn normally', async () => {
    // The other half of the same rule: a hint is not a verdict. Failing
    // attempts followed by one that works is a successful turn, and a run that
    // parked on the first `api_retry` would strand every session that ever hit
    // a transient error.
    const events = await runTurn(fixtureManifest('auth-recovers'));
    expect(events).toContainEqual({ type: 'text', text: 'worked on retry' });
    expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
  });

  it('keeps the session id from the failed run, so the next turn resumes it', async () => {
    // Checked because the whole promise of `awaiting_credentials` is that the
    // work is still there: `claude --resume <id>` on the session an
    // unauthenticated run left behind is what carries it, and that was confirmed
    // against a real `claude` 2.1.233 (the session file is written at init,
    // before the credential is ever used).
    const runtime = new CliStdioRuntime({ manifest: fixtureManifest('no-login') });
    const handle = await runtime.start(spec(), context());
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(handle.resumeToken()).toBe('sess-fake-1');
  });
});

describe('deny, ask, grant, resume', () => {
  it('asks about a call the CLI refused and finishes the turn in a second process', async () =>
    cliScenario('denial-then-grant', async () => {
      const ctx = context();
      const events = await runTurn(fixtureManifest('deny-once'), ctx);

      // The gate was consulted about a call that did not run.
      expect(ctx.asked).toEqual([{ tool: 'Read', args: { file_path: 'a.ts' } }]);
      // A second process really started, carrying the session forward.
      expect(events).toContainEqual({ type: 'text', text: 'resumed' });
      // And the tool succeeded there, which only happens if the grant reached
      // the new process's allowlist.
      expect(events.filter((e) => e.type === 'tool_result').at(-1)).toMatchObject({ ok: true });
      // One turn, one stop — however many processes it took.
      expect(events.filter((e) => e.type === 'stopped')).toHaveLength(1);
      expect(events.at(-1)).toEqual({ type: 'stopped', stop: { kind: 'end_turn' } });
    }));

  it('stops at the denial when the user says no', async () => {
    const ctx = context(() => ({ result: 'deny', reason: 'not that file' }));
    const events = await runTurn(fixtureManifest('deny-once'), ctx);

    expect(ctx.asked).toHaveLength(1);
    expect(events.some((e) => e.type === 'text' && e.text === 'resumed')).toBe(false);
    expect(events.filter((e) => e.type === 'stopped')).toHaveLength(1);
  });

  it('pins an approval to the exact argument rather than the whole tool', async () => {
    // "allow once" has no allowlist equivalent, and the closest honest thing is
    // a rule that matches that call and nothing else. A bare `Read` would hand
    // over every file for the rest of the run.
    const ctx = context();
    await runTurn(fixtureManifest('deny-once'), ctx);
    expect(designatedArg({ file_path: 'a.ts' })).toBe('a.ts');
  });
});

// ---------------------------------------------------------- scripted spawning

/** A spawn whose runs are supplied by the test, for cases a fixture cannot make. */
function scriptedSpawn(runs: string[][], seen: string[][] = []): SpawnCli {
  let i = 0;
  return (argv): CliRun => {
    seen.push(argv);
    const lines = runs[Math.min(i, runs.length - 1)] ?? [];
    i += 1;
    return {
      stdout: (async function* () {
        for (const line of lines) yield `${line}\n`;
      })(),
      exit: Promise.resolve({ code: 0, signal: null, stderr: '' }),
      kill: () => undefined,
    };
  };
}

const DENIED_RUN = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] },
  }),
  JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true, content: 'permission denied' }],
    },
  }),
  JSON.stringify({ type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } }),
];

describe('what the adapter refuses to promise', () => {
  it('does not ask about denials it could never act on', async () => {
    // No `resumeArgs`: granting the rule would mean starting the turn over,
    // which is not a grant, it is a restart. Asking anyway would offer the user
    // a button that cannot do what it says.
    const manifest = withoutResume(CLAUDE_CODE_MANIFEST);
    const ctx = context();
    const runtime = new CliStdioRuntime({ manifest, spawnFn: scriptedSpawn([DENIED_RUN]) });
    const handle = await runtime.start(spec(), ctx);
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(ctx.asked).toEqual([]);
    expect(ctx.progress.join(' ')).toMatch(/cannot resume/);
  });

  it('bounds how many times one turn may be granted and resumed', async () => {
    // An agent that keeps finding new tools to be denied would otherwise spawn
    // processes until something else gave out.
    const seen: string[][] = [];
    const ctx = context();
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([DENIED_RUN], seen),
      maxGrants: 2,
    });
    const handle = await runtime.start(spec(), ctx);
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(seen).toHaveLength(3); // the first run, plus two grants
    expect(ctx.progress.join(' ')).toMatch(/stopped asking after 2/);
  });

  it('will not claim native resume that its manifest cannot perform', async () => {
    const manifest = withoutResume(CLAUDE_CODE_MANIFEST);
    const caps = await new CliStdioRuntime({ manifest }).capabilities(spec());
    // The manifest still says `nativeResume: true`. The adapter does not.
    expect(manifest.capabilities.nativeResume).toBe(true);
    expect(caps.nativeResume).toBe(false);
  });

  it('declares gemini at the fidelity its documentation supports', async () => {
    const caps = await new CliStdioRuntime({ manifest: GEMINI_CLI_MANIFEST }).capabilities(
      spec({ runtimeId: 'cli:gemini-cli' }),
    );
    // No compilable allowlist means the only expressible grant is a blanket
    // one. The registry refuses `all-or-nothing` in a shared workspace (§9), so
    // this declaration is what routes it into isolation.
    expect(caps.permissionFidelity).toBe('all-or-nothing');
    expect(caps.nativeResume).toBe(false);
  });
});

describe('the arguments a run is given', () => {
  it('ends the options before the prompt, so a variadic flag cannot eat it', async () => {
    /*
     * `--allowedTools` and `--disallowedTools` are variadic (`<tools...>`), and
     * they are the last flags emitted — so the prompt that followed one was read
     * as another tool name and the CLI answered `Input must be provided either
     * through stdin or as a prompt argument when using --print`. A turn that did
     * nothing, stopped `transport`, with nothing on screen to say why.
     *
     * It hid because §13 scopes writing to *inside* the workspace and
     * `compilePolicy` refuses to widen that for an allowlist, so the default
     * policy emits no flag at all. The first seat given an unscoped grant lost
     * every turn. Reproduced against the real CLI both ways before the fix.
     */
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(
      spec({ toolPolicy: { rules: [{ tool: 'bash', action: 'allow' }], defaultAction: 'ask' } }),
      context(),
    );
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    const argv = seen[0]!;
    expect(argv).toContain('--allowedTools');
    // Adjacent, not merely present: `--` anywhere earlier would not stop the
    // variadic, and the prompt is the last argument.
    expect(argv.at(-2)).toBe('--');
    expect(argv.at(-1)).toContain('go');
  });

  it('suppresses deterministic mode under vendor-cli-session', async () => {
    // `--bare` skips OAuth and keychain reads, and that login is the entire
    // reason for invoking the user's own CLI.
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(spec(), context());
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(seen[0]).not.toContain('--bare');
  });

  it('uses deterministic mode when the credential is a key', async () => {
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(
      spec({ auth: { kind: 'api-key', endpointId: 'e1' } }),
      context(),
    );
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(seen[0]).toContain('--bare');
  });

  it('never uses the abort-on-unallowed permission baseline', async () => {
    // Denial lets the agent adapt and keep working; aborting loses the turn.
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(spec(), context());
    const drained = drain(handle.events);
    await handle.send({ content: [{ type: 'text', text: 'go' }] });
    await drained;

    expect(seen[0]).toContain('dontAsk');
  });
});

// ------------------------------------------------------------ policy → argv

describe('compiling a policy into an allowlist', () => {
  it('translates our lowercase names into the CLI’s own', () => {
    const compiled = compilePolicy(
      { rules: [{ tool: 'bash', match: 'git diff *', action: 'allow' }], defaultAction: 'ask' },
      CLAUDE_CODE_MANIFEST.toolNames,
    );
    // Emitting `bash` here matches nothing — the same mistake that once made the
    // SDK adapter's deny rules inert.
    expect(compiled.allow).toEqual(['Bash(git diff *)']);
  });

  it('refuses to turn a scoped allow into an unscoped one', () => {
    const rule = { tool: 'write', scope: 'inside' as const, action: 'allow' as const };
    const compiled = compilePolicy({ rules: [rule], defaultAction: 'ask' }, CLAUDE_CODE_MANIFEST.toolNames);

    // §13's table allows writing *inside* the workspace and asks outside it. An
    // allowlist has no such notion, so a bare `Write` would hand over the whole
    // filesystem while the UI kept displaying a rule that says "inside".
    expect(compiled.allow).toEqual([]);
    expect(compiled.losses).toEqual([
      { rule, effect: 'denied', reason: expect.stringContaining('anywhere on the machine') },
    ]);
  });

  it('keeps a scoped deny, and says it now covers more than asked', () => {
    const rule = { tool: 'bash', scope: 'outside' as const, action: 'deny' as const };
    const compiled = compilePolicy({ rules: [rule], defaultAction: 'ask' }, CLAUDE_CODE_MANIFEST.toolNames);

    // Stricter than intended is the safe direction, so it compiles — but a user
    // whose rule was meant to leave the inside case alone needs to know.
    expect(compiled.deny).toEqual(['Bash']);
    expect(compiled.losses[0]).toMatchObject({ effect: 'broadened' });
  });

  it('says nothing about `ask`, which is simply how this branch works', () => {
    const compiled = compilePolicy(
      { rules: [{ tool: 'bash', action: 'ask' }], defaultAction: 'ask' },
      CLAUDE_CODE_MANIFEST.toolNames,
    );
    // `defaultAction` is `ask`, so reporting these would mean reporting nearly
    // every tool on every run — a loss report nobody reads.
    expect(compiled.losses).toEqual([]);
    expect(compiled.allow).toEqual([]);
  });

  it('surfaces losses to the user rather than swallowing them', async () => {
    const ctx = context();
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      spawnFn: scriptedSpawn([[]]),
    });
    await runtime.start(
      spec({ toolPolicy: { rules: [{ tool: 'write', scope: 'inside', action: 'allow' }], defaultAction: 'ask' } }),
      ctx,
    );
    expect(ctx.progress.join(' ')).toMatch(/policy rule denied: write/);
  });
});

// --------------------------------------------------------------- small pieces

describe('framing', () => {
  it('holds a partial line until its newline arrives', () => {
    const s = new LineSplitter();
    expect(s.push('{"a"')).toEqual([]);
    expect(s.push(':1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('returns whatever arrived without a final newline', () => {
    const s = new LineSplitter();
    s.push('{"a":1}');
    expect(s.flush()).toEqual(['{"a":1}']);
  });

  it('tolerates CRLF, which is what a Windows CLI writes', () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\r\n')).toEqual(['{"a":1}']);
  });

  it('skips a line that is not JSON instead of throwing', () => {
    expect(parseLine('npm notice')).toBeNull();
    expect(parseLine('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('small decisions', () => {
  it('pins a grant to the designated argument, not to any string it finds', () => {
    // A description or a label would produce a rule that matches nothing while
    // looking specific.
    expect(designatedArg({ description: 'list files', command: 'ls -la' })).toBe('ls -la');
    expect(designatedArg({ description: 'nothing pinnable' })).toBeNull();
  });

  it('tells the resuming process to continue rather than start over', () => {
    // Re-sending the original turn would ask for everything to be done twice —
    // the opposite of resuming without losing the turn.
    expect(resumeInstruction(['Read(a.ts)'])).toMatch(/do not repeat work/);
  });

  it('reads a missing binary out of stderr', () => {
    expect(stopFromExit({ code: 127, signal: null, stderr: 'ENOENT' }, 'claude')).toEqual({
      kind: 'misconfigured',
      detail: expect.stringContaining('not installed') as unknown as string,
    });
  });
});

describe('naming a model for an installed CLI (§3.12, §17.11)', () => {
  /**
   * `modelArgs` was left out of the manifest on purpose: admission rejected any
   * spec carrying a model whenever `requiresModel` was false, so the flag would
   * have been code that could never run. With `model: 'optional'` the case is
   * reachable, and the flag is worth shipping.
   */
  it('passes the model through when the user named one', async () => {
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      toolVersion: '1.0.0',
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(
      spec({ model: { providerId: 'vendor', modelId: 'some-model' } }),
      context(),
    );
    await handle.send({ content: [{ type: 'text', text: 'hi' }] });
    await drain(handle.events);

    expect(seen[0]).toContain('--model');
    expect(seen[0]).toContain('some-model');
  });

  it('leaves the CLI its own default when the user named none', async () => {
    // The vendor's tuned choice for their own harness is a real answer, so an
    // unset model means "yours" rather than "none".
    const seen: string[][] = [];
    const runtime = new CliStdioRuntime({
      manifest: CLAUDE_CODE_MANIFEST,
      toolVersion: '1.0.0',
      spawnFn: scriptedSpawn([[]], seen),
    });
    const handle = await runtime.start(spec(), context());
    await handle.send({ content: [{ type: 'text', text: 'hi' }] });
    await drain(handle.events);

    expect(seen[0]).not.toContain('--model');
  });
});

/**
 * Detection, and the sentence it produces when it fails (§3.12).
 *
 * `detectCli` used to answer `DetectedCli | null`, and `null` is where a real
 * afternoon went. A host that could not find `claude` said nothing to anybody:
 * the runtime was absent from the handshake, absent from the picker, and absent
 * from every log. Absence is indistinguishable from a client that forgot to ask,
 * so the person staring at the gap looks in the wrong place — and the reason had
 * existed, for a few microseconds, inside a `catch`.
 *
 * The three failures are kept apart here because they send somebody to three
 * different places: *not installed*, *installed and complaining*, and *installed
 * and answering in an unexpected shape*.
 */
describe('finding an installed CLI, and saying why it was not found', () => {
  /** A spawn that never starts a process, as a missing binary really behaves. */
  const missing = (code?: string): SpawnCli => () => ({
    stdout: (async function* () {
      // Nothing: the process does not exist, so it prints nothing.
    })(),
    exit: Promise.resolve({
      code: null,
      signal: null,
      stderr: 'Error: spawn claude ENOENT',
      ...(code === undefined ? {} : { errorCode: code }),
    }),
    kill: () => undefined,
  });

  const answering = (out: string, code = 0): SpawnCli => () => ({
    stdout: (async function* () {
      yield out;
    })(),
    exit: Promise.resolve({ code, signal: null, stderr: code === 0 ? '' : 'not logged in\nrun: claude login' }),
    kill: () => undefined,
  });

  it('reports a version when the tool is there', async () => {
    const found = await detectCli(CLAUDE_CODE_MANIFEST, answering('1.2.3 (Claude Code)'));
    expect(found.found).toBe(true);
    expect(found.found === true && found.version).toBe('1.2.3');
  });

  it('names the binary and the OS code when it could not be started', async () => {
    const found = await detectCli(CLAUDE_CODE_MANIFEST, missing('ENOENT'));
    expect(found.found).toBe(false);
    // The binary, because the remedy is about that name and not about ours.
    expect(found.found === false && found.reason).toContain('claude');
    // The OS's own word, which is what distinguishes "not installed" from
    // "installed and not executable by this user".
    expect(found.found === false && found.reason).toContain('ENOENT');
    expect(found.found === false && found.reason).toContain('PATH');
  });

  it('repeats the tool\u2019s own complaint when it ran and failed', async () => {
    const found = await detectCli(CLAUDE_CODE_MANIFEST, answering('', 1));
    expect(found.found).toBe(false);
    // Its first line, not ours: an installed tool refusing to answer knows more
    // about why than we do, and paraphrasing would lose the actionable half.
    expect(found.found === false && found.reason).toContain('not logged in');
    expect(found.found === false && found.reason).toContain('exited 1');
  });

  it('still offers a tool whose version banner it cannot parse', async () => {
    /*
     * Not a skip. The tool answered, which is the thing being detected; a vendor
     * who reformats `--version` should cost a version string in a label, never a
     * runtime that vanishes from the picker. Recorded as `unknown` so a
     * transcript says which is which (§5.1).
     */
    const found = await detectCli(CLAUDE_CODE_MANIFEST, answering('Claude Code, latest'));
    expect(found.found).toBe(true);
    expect(found.found === true && found.version).toBe('unknown');
  });

  it('does not throw when the spawn itself refuses', async () => {
    const explodes: SpawnCli = () => {
      throw new Error('argv rejected by this platform');
    };
    const found = await detectCli(CLAUDE_CODE_MANIFEST, explodes);
    // A CLI that cannot even be attempted is still an ordinary state of a
    // machine; the host has to come up regardless (§3.12).
    expect(found.found).toBe(false);
    expect(found.found === false && found.reason).toContain('argv rejected');
  });
});

describe('reading a CLI back out of a runtime id', () => {
  /*
   * The inverse of `runtimeIdFor`, and the thing `SessionManager` asks before
   * deciding a seat signs itself in. Worth its own test because a seat that is
   * wrongly judged *not* a CLI gets `auth: none`, which sends `--bare`, which
   * skips OAuth — and the symptom is a logged-in CLI reporting that it is not
   * logged in, three files away from this line.
   */
  it('names the CLI, and says null for anything else', () => {
    expect(cliIdOf(runtimeIdFor(CLAUDE_CODE_MANIFEST))).toBe('claude-code');
    expect(cliIdOf('cli:gemini')).toBe('gemini');
    expect(cliIdOf('agbrte-harness')).toBeNull();
    expect(cliIdOf('echo')).toBeNull();
    // Not a CLI called "": a prefix on its own names nothing, and treating it
    // as one would mint a quota group keyed on an empty string.
    expect(cliIdOf('cli:')).toBeNull();
  });
});
