/**
 * The terminal client (DESIGN.md §6.4, §10).
 *
 * Two claims, and they are the ones that make a CLI worth having rather than a
 * second half-product:
 *
 *  1. **It is a client.** `once` is driven here against a real `SessionHostServer`
 *     over an in-memory channel — the same server the app connects to — so a
 *     session it creates is a session, logged and attributed, not a private copy.
 *  2. **It answers without a human.** An interactive client that merely tolerates
 *     a pipe still stops at the first permission prompt and waits forever, which
 *     in cron is a hang rather than a failure. Denying is the behaviour under
 *     test, and so is the exit code that reports it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { noConsoleWindow } from './support/noConsoleWindow.js';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { exitCodeFor, once } from '../src/cli/once.js';
import { KNOWN_COMMANDS, parse } from '../src/cli/args.js';
import { preview } from '../src/cli/format.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId } from '@shared/types/index.js';

/*
 * A budget that reflects what these tests actually do.
 *
 * Every case in this file spawns a real process — a shell, a browser, the built
 * CLI, a detached host — and the 5-second default is a number nobody chose for
 * that. It is the arrangement that fails worst: green on an idle machine, red on
 * a loaded CI runner, and no signal about which. A test that fails because a
 * machine was busy is not reporting anything about the code; only a genuine hang
 * should reach this.
 */
vi.setConfig({ testTimeout: 30_000 });



let root: string;
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-cli-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const QUIET: EchoStep[] = [
  { kind: 'text', text: 'done' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

const ASKS: EchoStep[] = [
  { kind: 'tool', tool: 'shell', args: { cmd: 'rm -rf /' } },
  { kind: 'text', text: 'finished' },
  { kind: 'stop', stop: { kind: 'end_turn' } },
];

function rig(script: EchoStep[] = QUIET): { connect(): HostConnection; manager: SessionManager } {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script }), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
  const server = new SessionHostServer({
    manager,
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
    grantRole: () => ({
      role: 'read-write',
      actor: { id: 'uid:1000', via: 'peer-credential', label: 'ci@box' },
    }),
  });
  return {
    manager,
    connect() {
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      return new HostConnection({ channel: pair.main, client: 'agbrte-cli@box' });
    },
  };
}

describe('parsing a command line', () => {
  it('treats a bare path as attach', () => {
    // `agbrte /srv/api` is the common case; requiring `attach` would make it long.
    const parsed = parse(['/srv/api']);
    expect(parsed.command).toBe('attach');
    expect(parsed.path).toContain('api');
  });

  it('recognises every subcommand the CLI dispatches on', () => {
    /**
     * A new subcommand has to be registered in two places — the `KNOWN` set here
     * and the switch in `agbrte.ts` — and missing this one fails *silently*:
     * the verb is taken for a path, so `agbrte interrupt .` opened an
     * interactive session on a folder named `interrupt`. Found on a real
     * server, which is a slow way to notice.
     */
    for (const verb of ['attach', 'run', 'ls', 'serve', 'stop', 'web', 'interrupt']) {
      expect(parse([verb]).command).toBe(verb);
    }
  });

  it('tells a path from a prompt by asking the filesystem', () => {
    // Not by shape: a prompt can look like a path ("src/main is broken") and a
    // path can contain spaces. `root` exists, so it is the workspace.
    expect(parse(['run', root, 'fix the parser']).rest).toEqual(['fix the parser']);
    expect(parse(['run', 'fix the parser']).rest).toEqual(['fix the parser']);
    expect(parse(['run', 'fix the parser']).path).toBe(process.cwd());
  });

  it('keeps a multi-word prompt together', () => {
    // Shells split unquoted prompts. Counting words to find the path was the
    // first attempt, and it ate "add" as the workspace.
    expect(parse(['run', 'add', 'a', 'test']).rest.join(' ')).toBe('add a test');
    expect(parse(['run', 'add', 'a', 'test']).path).toBe(process.cwd());
  });

  it('takes an explicit path even where nothing exists yet', () => {
    // `.` and a leading slash are how someone says "this is a path" about a
    // directory that is about to exist.
    expect(parse(['run', '.', 'go']).rest).toEqual(['go']);
    expect(parse(['run', '/srv/not-yet', 'go']).rest).toEqual(['go']);
  });

  it('separates value flags from boolean ones', () => {
    const parsed = parse(['run', '--runtime', 'echo', '--yes', 'go']);
    expect(parsed.value('--runtime')).toBe('echo');
    expect(parsed.flags.has('--yes')).toBe(true);
    // The flag's value must not be mistaken for the prompt.
    expect(parsed.rest).toEqual(['go']);
  });
});

describe('a scripted run', () => {
  it('creates a real session on the host, attributed', async () => {
    const r = rig();
    const connection = r.connect();
    const code = await once(connection, { prompt: 'hello', autoApprove: false, verbose: false });
    expect(code).toBe(0);

    // The claim that matters: this is the host's session, not the CLI's.
    const [session] = await connection.list();
    expect(session).toBeDefined();
    const events = await connection.events(session!.sessionId);
    const turn = events.find((e) => e.type === 'user.turn');
    expect(turn?.actor?.id).toBe('uid:1000');
  });

  it('denies a permission request instead of waiting for nobody', async () => {
    const r = rig(ASKS);
    const connection = r.connect();
    const code = await once(connection, { prompt: 'go', autoApprove: false, verbose: false });

    // Waiting would be a job that never ends. Denying feeds a reason back to the
    // agent, which can adapt — and reports the shortfall as a non-zero exit.
    expect(code).toBe(1);
    const [session] = await connection.list();
    const events = await connection.events(session!.sessionId);
    const decided = events.find((e) => e.type === 'permission.decided');
    expect(decided).toMatchObject({ decision: { result: 'deny' } });
  });

  it('allows everything under --yes', async () => {
    const r = rig(ASKS);
    const connection = r.connect();
    const code = await once(connection, { prompt: 'go', autoApprove: true, verbose: false });
    expect(code).toBe(0);
  });

  it('refuses a runtime the host does not have, naming the ones it does', async () => {
    const r = rig();
    const connection = r.connect();
    const code = await once(connection, {
      prompt: 'go',
      runtimeId: 'not-a-runtime',
      autoApprove: false,
      verbose: false,
    });
    // An error, not a prompt: there is nobody to ask.
    expect(code).toBe(1);
    expect(await connection.list()).toHaveLength(0);
  });

  it('continues an existing session rather than starting another', async () => {
    const r = rig();
    const connection = r.connect();
    await once(connection, { prompt: 'first', autoApprove: false, verbose: false });
    const [session] = await connection.list();

    await once(connection, {
      prompt: 'second',
      sessionId: session!.sessionId,
      autoApprove: false,
      verbose: false,
    });

    // One session, two turns — the point of `--session` in a script that runs
    // repeatedly against the same task.
    expect(await connection.list()).toHaveLength(1);
    const turns = (await connection.events(session!.sessionId)).filter((e) => e.type === 'user.turn');
    expect(turns).toHaveLength(2);
  });
});

describe('what a stop means to a script', () => {
  it('reports an unreachable model as a failure, not a clean pass', () => {
    // The bug this exists for. The first version listed failing kinds and
    // defaulted the rest to 0, so a run against a model that was down exited 0
    // and a cron job logged a clean pass.
    expect(exitCodeFor({ kind: 'unavailable' })).toBe(2);
    expect(exitCodeFor({ kind: 'transport' })).toBe(2);
  });

  it('separates "try later" from "this will not fix itself"', () => {
    // A retry loop needs these apart. Both are `pause` to the supervisor, which
    // is why the split lives here.
    expect(exitCodeFor({ kind: 'quota_exhausted', scope: 'daily' })).toBe(2);
    expect(exitCodeFor({ kind: 'limit_reached', limit: 'turns' })).toBe(1);
    expect(exitCodeFor({ kind: 'auth' })).toBe(1);
    expect(exitCodeFor({ kind: 'misconfigured', detail: 'no such model' })).toBe(1);
  });

  it('treats a finished turn as success', () => {
    expect(exitCodeFor({ kind: 'end_turn' })).toBe(0);
  });
});

describe('terminal output', () => {
  it('shortens a value to one line', () => {
    // Tool arguments are routinely a whole file, and printing that in a prompt
    // buries the question under the thing it is asking about.
    expect(preview('x'.repeat(500), 40)).toHaveLength(40);
    expect(preview({ a: 1 })).toBe('{"a":1}');
  });

  it('flattens newlines so one event stays one line', () => {
    expect(preview('a\n\n  b')).toBe('a b');
  });
});

describe('asking what is here must not make something be here', () => {
  /**
   * Found on a server, not in a test. I ran `agbrte ls` in a home directory to
   * see what was running, and it made a workspace store there and started a
   * host — because every verb went through `open`, and opening a workspace
   * creates one. For a command whose whole job is to report, that is a side effect
   * nobody asked for, landing in whatever directory the user was standing in.
   *
   * Driven as a subprocess against the built CLI rather than by calling a
   * predicate, because the bug was never in the predicate. It was in which
   * commands run before it — the same shape as the `interrupt` verb that
   * dispatched as a folder name because it was in one list and not the other.
   */
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'agbrte-ls-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const cli = (args: string[]): Promise<{ code: number; out: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [join(process.cwd(), 'dist/cli/agbrte.js'), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        ...noConsoleWindow,
      });
      let out = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (out += b.toString()));
      child.on('close', (code) => resolve({ code: code ?? -1, out }));
    });

  it('reports an empty directory without creating a workspace in it', async () => {
    const { code, out } = await cli(['ls', dir]);

    expect(code).toBe(0);
    expect(out).toMatch(/no agbrte workspace/i);
    // The whole point. A `.agbrte` here would be a directory the user did
    // not ask for, in a directory they may not have meant to be in.
    expect(existsSync(join(dir, '.agbrte'))).toBe(false);
  });

  it('guards only ls, because every other verb is "do something here"', async () => {
    /**
     * The opposite failure, and the more likely one to be introduced later:
     * a guard that stops `run` from creating the workspace it is about to work
     * in. `run`, `attach` and `serve` are all instructions rather than
     * questions, and creating the workspace is the right first step for each.
     *
     * Checked by the side effect rather than the exit code — this `run` has no
     * model to reach and is expected to fail, and what matters is that it got
     * far enough to make the workspace.
     */
    await cli(['run', dir, 'hello']);
    expect(existsSync(join(dir, '.agbrte'))).toBe(true);
  });

  it('still lists a real workspace', async () => {
    // The guard must not turn `ls` into a command that never works. A workspace
    // that exists is listed as before.
    await openWorkspace(dir);
    const { code, out } = await cli(['ls', dir]);

    expect(code).toBe(0);
    expect(out).not.toMatch(/no agbrte workspace/i);
  });
});

/**
 * Every command the entry point implements is one the parser knows.
 *
 * `case 'update':` was written in `agbrte.ts` while `update` was missing from
 * the parser's vocabulary, and nothing failed. An unrecognised first argument is
 * treated as a *path*, so `agbrte update .` attached to a directory named
 * `update`, printed a host pid and exited 0 — a switch arm that could never be
 * reached, wearing the appearance of a working feature.
 *
 * The cases are read out of the source rather than listed here, because a
 * hand-kept list would be a third vocabulary that can drift too. What this
 * asserts is that two lists which already exist agree with each other.
 */
describe('the parser and the entry point agree on what a command is', () => {
  it('knows every case the CLI implements', async () => {
    const source = await readFile(new URL('../src/cli/agbrte.ts', import.meta.url), 'utf8');
    const cases = [...source.matchAll(/^\s+case '([a-z-]+)':/gm)].map((m) => m[1]!);

    // A guard on the guard: if the entry point's shape changes so that no cases
    // are found, this must fail rather than pass having checked nothing.
    expect(cases.length, 'found no command cases to check').toBeGreaterThan(4);

    for (const command of cases) {
      expect(
        KNOWN_COMMANDS.has(command),
        `\`${command}\` is implemented but the parser reads it as a path`,
      ).toBe(true);
      // And it parses as itself rather than falling back to `attach`.
      expect(parse([command, '.']).command).toBe(command);
    }
  });
});
