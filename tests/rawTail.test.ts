/**
 * The raw side of a CLI seat, and who owns it (DESIGN.md §3.12, §7).
 *
 * The terminal toggle shipped and did nothing, for two independent reasons that
 * each produce the same symptom — an empty pane, or no toggle at all.
 *
 *  1. **The tail lived on the handle.** `SessionManager.runTurn` releases the
 *     handle when the turn ends, so everything the CLI had printed was thrown
 *     away at exactly the moment somebody opened the pane to read it. Between
 *     turns `rawLog` answered `null`, which is indistinguishable from a seat
 *     with no raw side.
 *  2. **It never crossed the agent-host boundary.** Agent loops run in a
 *     separate process (§8), so the handle the manager holds is a
 *     `HostBackedHandle` proxying that process — no pipes, no stdout, and no
 *     `rawTail` at all. In the shipped topology the answer was therefore `null`
 *     *always*, mid-turn included, for every runtime.
 *
 * Both are properties of ownership rather than of the adapter, so both tests
 * below drive the real owner: a real `SessionManager` over a real
 * `CliStdioRuntime`, and the real control protocol over a real channel pair.
 * A test that handed a context to the adapter directly would pass in both the
 * broken and the fixed world, which is how this shipped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { CliStdioRuntime, type CliRun, type SpawnCli } from '@main/runtime/runtimes/cliStdio.js';
import { CLAUDE_CODE_MANIFEST } from '@main/runtime/cli/manifests.js';
import { RawTailBuffer } from '@main/rawTail.js';
import { AgentHostServer } from '../src/host/server.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostBackedRuntime, HostClient } from '@main/host/hostRuntime.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { HostCommand, HostMessage } from '@shared/host/protocol.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { AgentId, InstanceId, SessionId } from '@shared/types/index.js';

/** A stand-in agent CLI speaking the real `stream-json` shape, over real pipes. */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fakeCli.mjs');

let root: string;
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-raw-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A spawn whose runs are supplied by the test — one array of lines per run. */
function scriptedSpawn(runs: string[][], stderr = ''): SpawnCli {
  let i = 0;
  return (): CliRun => {
    const lines = runs[Math.min(i, runs.length - 1)] ?? [];
    i += 1;
    return {
      stdout: (async function* () {
        for (const line of lines) yield `${line}\n`;
      })(),
      exit: Promise.resolve({ code: 0, signal: null, stderr }),
      kill: () => undefined,
    };
  };
}

/** One complete run of the protocol, plus the noise a real CLI mixes into it. */
function run(text: string): string[] {
  return [
    'npm notice a new version of claude is available',
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }),
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  ];
}

const TEXT = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function cliManager(runs: string[][], stderr = ''): SessionManager {
  const registry = new RuntimeRegistry();
  registry.register(
    new CliStdioRuntime({ manifest: CLAUDE_CODE_MANIFEST, spawnFn: scriptedSpawn(runs, stderr) }),
    { label: 'Claude Code', model: 'optional' },
  );
  return new SessionManager({ registry, workspaceRoot: root, instanceId });
}

async function seat(
  sm: SessionManager,
  runtimeId = 'cli:claude-code',
): Promise<{ sessionId: SessionId; agentId: AgentId }> {
  const session = await sm.createSession({ title: 's', goal: 'g' });
  const agent = await sm.addAgent(session.sessionId, { role: 'worker', runtimeId });
  return { sessionId: session.sessionId, agentId: agent.agentId };
}

describe('the tail belongs to the session, not to the turn', () => {
  it('is still readable after the turn that printed it has finished', async () => {
    // The regression. `runTurn` deletes the handle at the end of every turn, so
    // a tail owned by the handle answers `null` here — and the pane a person
    // opens *after* something happened is empty, which is what "the toggle does
    // not work" looks like from the outside.
    const sm = cliManager([run('hello')]);
    const { sessionId, agentId } = await seat(sm);

    await sm.send(sessionId, agentId, TEXT('go'));
    expect(sm.get(sessionId).state).not.toBe('working'); // the turn really ended

    const tail = sm.rawLog(sessionId, agentId);
    expect(tail).not.toBeNull();
    // The banner too: what `parseLine` skips is exactly what someone watching
    // raw output wants to see, and it is the one line the transcript cannot show.
    expect(tail?.lines).toContain('npm notice a new version of claude is available');
    expect(tail?.lines.join('\n')).toContain('"session_id":"s1"');
    expect(tail?.dropped).toBe(0);
  });

  it('keeps what earlier turns printed instead of starting over', async () => {
    // Each turn opens a fresh handle. A per-handle tail therefore also silently
    // reset the pane on every send, so a session's raw history was never longer
    // than its last turn.
    const sm = cliManager([run('first'), run('second')]);
    const { sessionId, agentId } = await seat(sm);

    await sm.send(sessionId, agentId, TEXT('one'));
    await sm.send(sessionId, agentId, TEXT('two'));

    const joined = sm.rawLog(sessionId, agentId)?.lines.join('\n') ?? '';
    expect(joined).toContain('"text":"first"');
    expect(joined).toContain('"text":"second"');
  });

  it('keeps stderr, which is where a failing run explains itself', async () => {
    const sm = cliManager([run('hi')], 'warning: model fell back to sonnet\n');
    const { sessionId, agentId } = await seat(sm);

    await sm.send(sessionId, agentId, TEXT('go'));
    expect(sm.rawLog(sessionId, agentId)?.lines).toContain(
      'warning: model fell back to sonnet',
    );
  });

  it('answers null for a seat with no raw side at all', async () => {
    // Not a failure, and the reason the control is hidden rather than shown over
    // an empty pane: the harness and `echo` have no process to watch.
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
    const sm = new SessionManager({ registry, workspaceRoot: root, instanceId });
    const { sessionId, agentId } = await seat(sm, 'echo');

    await sm.send(sessionId, agentId, TEXT('go'));
    expect(sm.rawLog(sessionId, agentId)).toBeNull();
  });

  it('survives two turns of a real subprocess over real pipes', async () => {
    /**
     * The same claim without a scripted spawn anywhere in it: real argv, real
     * pipes with real chunk boundaries, a real exit, and a second real process
     * for the second turn — which is the part that was lost, since each turn
     * opens a fresh handle and the old tail went with the old one.
     *
     * `noise` mode, because the lines a person opens this pane for are exactly
     * the ones the transcript cannot show: an npm banner and a deprecation
     * warning are invisible to `parseLine` and visible in a terminal.
     */
    const manifest = {
      ...CLAUDE_CODE_MANIFEST,
      detect: { ...CLAUDE_CODE_MANIFEST.detect, binary: process.execPath },
      invoke: {
        ...CLAUDE_CODE_MANIFEST.invoke,
        baseArgs: [FIXTURE, '--mode', 'noise', ...CLAUDE_CODE_MANIFEST.invoke.baseArgs],
      },
    };
    const registry = new RuntimeRegistry();
    // No `spawnFn`: the real `nodeSpawn`.
    registry.register(new CliStdioRuntime({ manifest }), { label: 'fake', model: 'optional' });
    const sm = new SessionManager({ registry, workspaceRoot: root, instanceId });
    const { sessionId, agentId } = await seat(sm);

    await sm.send(sessionId, agentId, TEXT('go'));
    const first = sm.rawLog(sessionId, agentId);
    expect(first?.lines).toContain('npm notice New major version available');

    await sm.send(sessionId, agentId, TEXT('again'));
    const second = sm.rawLog(sessionId, agentId);
    expect(second?.lines.length).toBeGreaterThan(first?.lines.length ?? 0);
  });

  it('refuses a seat that does not exist rather than answering null', async () => {
    // `null` means "no raw side". Letting it also mean "no such agent" would
    // hide a caller's bug behind a missing button.
    const sm = cliManager([run('hi')]);
    const { sessionId } = await seat(sm);
    expect(() => sm.rawLog(sessionId, 'agent_nobody' as AgentId)).toThrow();
  });
});

describe('and it survives the process that printed it', () => {
  /**
   * The half that made the two panes unequal.
   *
   * The chat comes back from the log on every reopen; the raw pane came back
   * blank, because the ring died with the process that filled it. Nothing about
   * that was visible while a session stayed open, which is why it lasted: it is
   * a property of restarts, and only of the pane nobody had a test reopening.
   */
  it('comes back after the session is reopened from disk', async () => {
    const first = cliManager([run('hello')]);
    const { sessionId, agentId } = await seat(first);
    await first.send(sessionId, agentId, TEXT('go'));

    const printed = first.rawLog(sessionId, agentId);
    expect(printed?.lines).toContain('npm notice a new version of claude is available');
    // The mirror is coalesced, so give the beat a chance to land. Nothing waits
    // on it in production either — see `mirrorRaw`.
    await new Promise((r) => setTimeout(r, 400));
    first.dispose();

    // A different manager over the same workspace: a restarted host, a second
    // window, the app reopened tomorrow.
    const second = cliManager([run('hello')]);
    await second.resumeSession(sessionId);

    const restored = second.rawLog(sessionId, agentId);
    expect(restored?.lines).toEqual(printed?.lines);
    expect(restored?.dropped).toBe(printed?.dropped);
    second.dispose();
  });

  /**
   * And the next run continues the pane rather than replacing it.
   *
   * A restored tail is the *opening* of this run's window: what the seat prints
   * next goes underneath, the way it would have if nothing had restarted.
   */
  it('keeps the earlier run above what this one prints', async () => {
    const first = cliManager([run('before')]);
    const { sessionId, agentId } = await seat(first);
    await first.send(sessionId, agentId, TEXT('go'));
    await new Promise((r) => setTimeout(r, 400));
    first.dispose();

    const second = cliManager([run('after')]);
    await second.resumeSession(sessionId);
    await second.send(sessionId, agentId, TEXT('again'));

    const tail = second.rawLog(sessionId, agentId);
    const text = tail?.lines.join('\n') ?? '';
    expect(text).toContain('"text":"before"');
    expect(text).toContain('"text":"after"');
    expect(text.indexOf('"text":"before"')).toBeLessThan(text.indexOf('"text":"after"'));
    second.dispose();
  });

  /**
   * A seat that never printed still has no raw side after a reopen.
   *
   * `rawLog` answering `null` is what hides the pane's toggle, and a restore
   * that invented an empty tail for every agent would offer a pane that can
   * only ever be blank — which is the thing the lazy ring was written to avoid.
   */
  it('does not invent a raw side for a seat that never printed', async () => {
    const first = cliManager([run('hi')]);
    // Admitted and never sent to, so the seat exists in the log with nothing
    // behind it — the state the lazy ring reports as "no raw side".
    const { sessionId, agentId } = await seat(first);
    first.dispose();

    const second = cliManager([run('hi')]);
    await second.resumeSession(sessionId);
    expect(second.rawLog(sessionId, agentId)).toBeNull();
    second.dispose();
  });
});

describe('across the agent-host process boundary', () => {
  /**
   * The failure the first bug hid behind.
   *
   * Agent loops run in their own process (§8), so the handle `SessionManager`
   * holds is a proxy with no pipes behind it. `rawTail()` on a handle could
   * therefore never have worked in the shipped app, however the tail was
   * scoped — the lines have to be *pushed* to the owner, the way `progress`
   * and `token` already are.
   */
  it('carries a reported line from the host process to the owner', async () => {
    const registry = new RuntimeRegistry();
    registry.register(
      new CliStdioRuntime({
        manifest: CLAUDE_CODE_MANIFEST,
        spawnFn: scriptedSpawn([run('hello')]),
      }),
      { label: 'Claude Code', model: 'optional' },
    );

    const pair = memoryChannelPair<HostCommand, HostMessage>();
    new AgentHostServer(pair.host, registry);
    const client = new HostClient({ channel: pair.main });
    const hosted = new HostBackedRuntime(client, 'cli:claude-code', '0.0.1');

    // The owner's registry holds the *proxy*, exactly as `hostMain` builds it.
    const proxied = new RuntimeRegistry();
    proxied.register(hosted, { label: 'Claude Code', model: 'optional' });
    const sm = new SessionManager({ registry: proxied, workspaceRoot: root, instanceId });

    const { sessionId, agentId } = await seat(sm);
    await sm.send(sessionId, agentId, TEXT('go'));

    const tail = sm.rawLog(sessionId, agentId);
    expect(tail).not.toBeNull();
    expect(tail?.lines).toContain('npm notice a new version of claude is available');
  });
});

describe('over the session protocol', () => {
  it('answers agent.rawLog to a client on the other side of a host', async () => {
    const manager = cliManager([run('hello')]);
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId,
        lineageId: lineageId as never,
        workspaceRoot: root,
        runtimes: ['cli:claude-code'],
      },
    });
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const connection = new HostConnection({ channel: pair.main });
    await connection.ready;

    const { sessionId, agentId } = await seat(manager);
    await manager.send(sessionId, agentId, TEXT('go'));

    const tail = await connection.rawLog(sessionId, agentId);
    expect(tail?.lines).toContain('npm notice a new version of claude is available');
    connection.disconnect();
  });
});

describe('what a tail is allowed to cost', () => {
  /**
   * Bounds matter more here than they did on the handle.
   *
   * A handle's tail died with the turn; this one lives as long as the session,
   * which can be a week (§7). A line cap alone is not a memory bound when one
   * CLI line can carry a megabyte of tool output, so the ring bounds lines,
   * total characters, and the length of any single line.
   */
  it('drops the oldest lines and says how many', () => {
    const ring = new RawTailBuffer(3);
    for (const line of ['a', 'b', 'c', 'd', 'e']) ring.push(line);

    expect(ring.tail()).toEqual({ lines: ['c', 'd', 'e'], dropped: 2 });
  });

  it('bounds total size, not just line count', () => {
    // 2,000 short lines and 2,000 half-megabyte lines are the same to a line
    // cap, and one of them is a gigabyte.
    const ring = new RawTailBuffer(1_000, 50, 1_000);
    for (let i = 0; i < 100; i += 1) ring.push('x'.repeat(20));

    const tail = ring.tail();
    expect(tail.lines.join('').length).toBeLessThanOrEqual(50);
    expect(tail.dropped).toBeGreaterThan(0);
  });

  it('clamps one enormous line rather than dropping it', () => {
    // A 4 MB tool result still has a first line worth seeing, and omitting it
    // would read as "the CLI never said that".
    const ring = new RawTailBuffer(10, 1_000_000, 8);
    ring.push('0123456789abcdef');

    expect(ring.tail().lines[0]).toBe('01234567…');
  });

  it('keeps the newest line even when it alone exceeds the budget', () => {
    // Evicting to empty would answer "nothing printed yet" to a seat that just
    // printed the only thing anybody cares about.
    const ring = new RawTailBuffer(10, 4, 100);
    ring.push('short');
    ring.push('a much longer line than the budget');

    expect(ring.tail().lines).toEqual(['a much longer line than the budget']);
  });
});
