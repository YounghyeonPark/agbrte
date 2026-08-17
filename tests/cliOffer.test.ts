/**
 * What a host offers, proved against real processes (DESIGN.md §3.12, §6.4, §8).
 *
 * Everything else about this path is tested over in-memory channels, which is
 * faster and covers more. None of it can tell you whether a *detected* CLI is a
 * runtime the owner will actually admit, because that question spans three
 * processes — this one, the session host it spawns, and the agent host that host
 * forks — and the disagreement it exists to catch lived precisely in the gap
 * between the second and the third:
 *
 *   - the **agent host** detected `claude`, registered `cli:claude-code`, and
 *     reported it in its `ready` handshake;
 *   - the **session host** put that id in the `welcome` every client reads, and
 *     built the `RuntimeRegistry` that `admit()` consults from a hardcoded list
 *     beside the fork that did not contain it;
 *   - so a picker offered the runtime, faithfully, and `addAgent` refused it with
 *     `runtime "cli:claude-code" is not registered` — from the same process that
 *     had just advertised it.
 *
 * Both halves were individually correct and separately tested. The only way to
 * see it is to start a real host and ask it for the thing it says it has.
 *
 * The host is started by running the built bundle, so this suite needs
 * `npm run build` first and says so loudly rather than passing on nothing.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { until } from './support/until.js';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import { Fleet, type FleetRuntime } from '@main/fleet.js';
import type { HostConnection } from '@main/host/hostConnection.js';
import type { InstanceId, SessionId } from '@shared/types/index.js';

const HOST_BUNDLE = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');

/**
 * The CLI this suite is about, on this machine.
 *
 * Located rather than assumed: a machine without Claude Code installed can still
 * run the negative half, and the positive half says why it was skipped instead
 * of failing on somebody else's laptop.
 */
const CLAUDE = process.platform === 'win32' ? 'claude.exe' : 'claude';

const RUNTIMES: FleetRuntime[] = [
  { id: 'agbrte-harness', label: 'Agbrte harness', version: '0.0.1', model: 'required' },
  { id: 'echo', label: 'Echo (no model)', version: '0.0.1', model: 'none' },
  {
    id: 'cli:claude-code',
    label: 'Claude Code (installed CLI)',
    version: '0.0.1',
    model: 'optional',
  },
];

let roots: string[] = [];
let open: HostConnection[] = [];
let originalPath: string;

/** Where `claude` is on this machine, or `null` if it is not installed. */
async function findClaude(): Promise<string | null> {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      await access(join(dir, CLAUDE));
      return dir;
    } catch {
      // Not here. Ordinary.
    }
  }
  return null;
}

async function built(): Promise<boolean> {
  try {
    await access(HOST_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

/**
 * A workspace and a host for it, started with whatever PATH is set right now.
 *
 * The PATH is what this suite manipulates, because it is the real mechanism: a
 * host started from a login shell and one started from a launcher genuinely see
 * different tools, which is why §3.12 detects per machine and why two
 * generations of host on one workspace can disagree.
 */
async function startHost(root: string): Promise<HostConnection> {
  const connection = await connectOrSpawnHost({
    workspaceRoot: root,
    hostEntry: HOST_BUNDLE,
    // Node, not Electron: this suite runs under Vitest.
    execPath: process.execPath,
    startupTimeoutMs: 30_000,
  });
  open.push(connection);
  return connection;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-clioffer-'));
  roots.push(root);
  return root;
}

/** Ask a host to stop, so a suite does not leave processes behind. */
async function stopHost(connection: HostConnection): Promise<void> {
  try {
    await connection.requestShutdown();
  } catch {
    // Already gone.
  }
  connection.disconnect();
}

beforeEach(() => {
  roots = [];
  open = [];
  originalPath = process.env['PATH'] ?? '';
});

afterEach(async () => {
  process.env['PATH'] = originalPath;
  for (const connection of open) await stopHost(connection);
  // Retried, because Windows will not remove a directory a departing host still
  // holds a handle on and the host is asked to stop rather than killed.
  for (const root of roots) {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** Everything except the directory holding `claude`. */
function pathWithout(claudeDir: string): string {
  return originalPath
    .split(delimiter)
    .filter((d) => d !== '' && resolve(d) !== resolve(claudeDir))
    .join(delimiter);
}

describe('a host with the CLI installed', () => {
  it('admits the runtime it advertises', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);
    const claudeDir = await findClaude();
    if (claudeDir === null) return; // not installed here; the negative half still runs

    const root = await makeRoot();
    const connection = await startHost(root);
    const identity = await connection.ready;

    // What a picker would offer, straight from the handshake.
    expect(identity.runtimes).toContain('cli:claude-code');

    // And what happens when somebody picks it. This threw
    // `AdmissionRefused: agent refused: runtime "cli:claude-code" is not
    // registered` — the exact sentence from the bug report — against the very
    // handshake asserted one line above.
    const session = await connection.createSession({ title: 't', goal: 'g' });
    const agent = await connection.addAgent(session.sessionId, {
      role: 'worker',
      runtimeId: 'cli:claude-code',
    });
    expect(agent.spec.runtimeId).toBe('cli:claude-code');
  }, 60_000);
});

describe('a host without it on PATH', () => {
  it('does not offer it, and says why rather than going quiet', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);
    const claudeDir = await findClaude();
    if (claudeDir === null) return;

    // A real host process, started from an environment that genuinely cannot see
    // the binary — the same thing a launcher-started host experiences.
    process.env['PATH'] = pathWithout(claudeDir);
    const root = await makeRoot();
    const identity = await (await startHost(root)).ready;

    expect(identity.runtimes).not.toContain('cli:claude-code');

    /*
     * The half that did not exist, and cost a long session.
     *
     * Absence alone is what shipped: the runtime was missing from every list and
     * no line anywhere said the host had looked. That is indistinguishable from
     * a client that forgot to ask, and it is what a person stares at while
     * knowing perfectly well the tool is installed.
     */
    const note = identity.runtimeNotes?.find((n) => n.id === 'cli:claude-code');
    expect(note, 'the host says nothing about a CLI it could not find').toBeDefined();
    expect(note?.label).toContain('Claude Code');
    // Names the binary, so the remedy is legible without reading our source.
    expect(note?.reason).toContain('claude');
  }, 60_000);
});

describe('the app, when the host is replaced by a different machine-state', () => {
  /**
   * The staleness this whole change is about, end to end.
   *
   * A host is a detached process that outlives the app (§6.4). Stop it, start
   * another from an environment that can see a tool the first could not, and the
   * app is talking to a genuinely different set of capabilities under the same
   * `instanceId` — which is per *workspace* (§5.2), so the fleet is right to keep
   * the entry and was wrong to keep everything on it.
   */
  it('follows the host in front of it, not the one it first met', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);
    const claudeDir = await findClaude();
    if (claudeDir === null) return;

    const root = await makeRoot();

    // Generation one: started blind to `claude`.
    const blindPath = pathWithout(claudeDir);
    let path = blindPath;

    const fleet = new Fleet({
      runtimes: RUNTIMES,
      maxBackoffMs: 50,
      connect: async ({ workspaceRoot }) => {
        // Set at dial time, so each generation is spawned with the PATH in force
        // when it starts — including the one the reconnect loop starts.
        process.env['PATH'] = path;
        const connection = await connectOrSpawnHost({
          workspaceRoot,
          hostEntry: HOST_BUNDLE,
          execPath: process.execPath,
          startupTimeoutMs: 30_000,
        });
        open.push(connection);
        return connection;
      },
    });

    const attached = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });
    expect(attached.available).not.toContain('cli:claude-code');
    const firstPid = attached.pid;

    /*
     * Kill generation one rather than asking it to stop.
     *
     * Both really happen and they are **different events to the fleet**, which
     * is the distinction `reconnect` is built on. A polite `shutdown` sends
     * `push.closing` — the host saying it is going on purpose — and the app
     * correctly forgets it, so there is no stale entry to be stale. The case
     * this test is about is the other one: a host that dies (OOM, a reboot, a
     * `kill` from another terminal, a crash) and is replaced by the reconnect
     * loop, which keeps the entry precisely because the sessions are still
     * there. That is the path where a frozen `available` survives.
     */
    // Set *before* the kill, not after: the reconnect loop's first attempt has
    // zero backoff, so it can dial — and spawn generation two — inside the same
    // tick the socket dies. Assigning afterwards is a race that reproduces the
    // old behaviour by accident and would have made this test lie.
    path = originalPath;
    process.kill(attached.pid, 'SIGKILL');
    await until(() => fleet.hosts()[0]?.link === 'reconnecting', 15_000);
    await until(() => fleet.hosts()[0]?.link === 'connected', 60_000);

    const now = fleet.hosts()[0];
    expect(now?.pid, 'a new process should be answering').not.toBe(firstPid);
    expect(
      now?.available,
      'the app is still describing a process that has exited',
    ).toContain('cli:claude-code');

    // And the runtime list a picker reads follows without anyone asking twice.
    expect(fleet.runtimesOn(now?.instanceId as InstanceId).map((r) => r.id)).toContain(
      'cli:claude-code',
    );

    // The end of the round trip: the thing the picker now offers is one the
    // owner will actually admit.
    const session = await fleet.createSession(now?.instanceId as InstanceId, {
      title: 't',
      goal: 'g',
    });
    const agent = await fleet.addAgent(session.sessionId as SessionId, {
      role: 'worker',
      runtimeId: 'cli:claude-code',
    });
    expect(agent.spec.runtimeId).toBe('cli:claude-code');

    await fleet.detachAll();
  }, 120_000);
});
