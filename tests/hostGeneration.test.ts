/**
 * A host is a process, and processes get replaced (DESIGN.md §6.4, §8, §3.12).
 *
 * The `instanceId` belongs to the **workspace**, not to the process serving it
 * (§5.2). That is deliberate and load-bearing: it is what lets a client dial the
 * same host after a laptop lid closes, and what lets `updateHost` restart a host
 * without every open session pointing at a stranger.
 *
 * It also means the *second* process answering on an identity can be a genuinely
 * different machine-state from the first: a different bundle, a different
 * endpoints file, a different set of CLIs on PATH. `Fleet.reconnect` kept the
 * entry — right — and then took only the pid from the new handshake, so
 * everything else went on describing a process that had exited. The failure that
 * surfaced is the worst-shaped one available: a picker offering a runtime,
 * confidently, that the owner would refuse the instant it was chosen.
 *
 * The other half of this file is the same disagreement from the other end. A
 * host that cannot find a CLI must not offer it — and must **say so**, because
 * an absent row and a broken client look identical from a window.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { until } from './support/until.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet, type FleetRuntime } from '@main/fleet.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { HostIdentity, SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';

/** What this "app" knows how to label, mirroring `HOST_RUNTIMES` in main.ts. */
const RUNTIMES: FleetRuntime[] = [
  { id: 'echo', label: 'Echo', version: '0.0.1', model: 'none' },
  { id: 'cli:claude-code', label: 'Claude Code (installed CLI)', version: '0.0.1', model: 'optional' },
];

let roots: string[] = [];

beforeEach(() => {
  roots = [];
});

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A fleet whose host can be *replaced* rather than merely reconnected.
 *
 * The generation counter is the whole point: `nextIdentity` decides what the
 * host answering after the cut says about itself, so the test can put a machine
 * with a different toolchain on the other end of the same identity — which is
 * exactly what happens when a host exits and a new one starts from a shell with
 * a different PATH.
 */
async function rig() {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-generation-'));
  roots.push(root);
  const workspace = await openWorkspace(root);

  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
  const manager = new SessionManager({
    registry,
    workspaceRoot: root,
    instanceId: workspace.instanceId,
  });

  /** What the *next* host to start will report. Mutated between generations. */
  let next: Omit<HostIdentity, 'protocol' | 'pid'> = {
    instanceId: workspace.instanceId,
    lineageId: workspace.lineageId,
    workspaceRoot: root,
    runtimes: ['echo'],
    endpoints: [],
  };

  let reachable = true;
  let live: { host: { close(): void } } | null = null;

  const fleet = new Fleet({
    runtimes: RUNTIMES,
    maxBackoffMs: 1,
    connect: async () => {
      if (!reachable) throw new Error('link is down');
      // A fresh server per connect: this is a *new process* answering on the
      // same workspace identity, not the same server reconnected.
      const server = new SessionHostServer({ manager, identity: next });
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      live = pair as never;
      return new HostConnection({ channel: pair.main });
    },
  });

  return {
    root,
    fleet,
    instanceId: workspace.instanceId,
    /** Retire this generation and decide what the next one will be. */
    replaceWith(identity: Partial<Omit<HostIdentity, 'protocol' | 'pid'>>): void {
      next = { ...next, ...identity };
      reachable = false;
      live?.host.close();
    },
    restore(): void {
      reachable = true;
    },
  };
}

describe('a host that is replaced by a different one', () => {
  it('offers what the host in front of it has, not what the last one had', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    // Generation one has the CLI installed, so the picker is right to offer it.
    expect(r.fleet.hosts()[0]?.available).toEqual(['echo']);

    r.replaceWith({ runtimes: ['echo', 'cli:claude-code'] });
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');

    // Generation two found `claude`. Without re-reading the handshake this stays
    // `['echo']` forever and the runtime is unreachable from a window that has
    // been open since before it was installed.
    expect(r.fleet.hosts()[0]?.available).toEqual(['echo', 'cli:claude-code']);
    expect(r.fleet.runtimesOn(r.instanceId).map((x) => x.id)).toEqual([
      'echo',
      'cli:claude-code',
    ]);
  });

  it('stops offering what the new host does not have', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });
    r.replaceWith({ runtimes: ['echo', 'cli:claude-code'] });
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.available.length === 2);

    // And back the other way, which is the direction that produced the bug
    // report: the app attached while the CLI was there, the host was replaced by
    // one started without it on PATH, and `addAgent` failed with
    // `runtime "cli:claude-code" is not registered` under a picker still
    // offering it.
    r.replaceWith({ runtimes: ['echo'] });
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');

    expect(r.fleet.hosts()[0]?.available).toEqual(['echo']);
  });

  it('re-reads the endpoints, the bundle, and the reason nothing can run', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    r.replaceWith({
      runtimes: [],
      unavailableReason: 'agent host failed to start',
      bundleVersion: '9.9.9',
      endpoints: [
        {
          id: 'local',
          label: 'Local',
          provider: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:11434/v1',
          authenticated: false,
        },
      ],
    });
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');

    const host = r.fleet.hosts()[0];
    expect(host?.available).toEqual([]);
    expect(host?.unavailableReason).toBe('agent host failed to start');
    expect(host?.bundleVersion).toBe('9.9.9');
    expect(host?.endpoints.map((e) => e.id)).toEqual(['local']);
  });

  it('drops a claim the new handshake no longer makes', async () => {
    const r = await rig();
    r.replaceWith({ bundleVersion: '1.0.0', movedFrom: '/somewhere/else' });
    r.restore();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });
    expect(r.fleet.hosts()[0]?.bundleVersion).toBe('1.0.0');
    expect(r.fleet.hosts()[0]?.movedFrom).toBe('/somewhere/else');

    // A move is news exactly once (§5.3) and an unstamped bundle means *cannot
    // be determined* (§6.3). Keeping the old values would re-announce a move
    // that already happened and put a version on a host that carries none —
    // both claims with nothing behind them, which is worse than no claim.
    r.replaceWith({});
    // `replaceWith` merges, so the two have to be removed explicitly — the same
    // thing a host that no longer reports them does on the wire.
    r.replaceWith({ bundleVersion: undefined, movedFrom: undefined } as never);
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => r.fleet.hosts()[0]?.link === 'connected');

    expect(r.fleet.hosts()[0]?.bundleVersion).toBeUndefined();
    expect(r.fleet.hosts()[0]?.movedFrom).toBeUndefined();
  });

  it('tells clients, so a picker follows without being asked', async () => {
    const r = await rig();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    // The renderer re-fetches `hosts.runtimes` on every hosts push, so a push
    // carrying the new `available` is the whole of the client-side fix. Without
    // one the window keeps a list nothing will ever correct.
    const pushed: string[][] = [];
    r.fleet.on('host', (h: unknown) => pushed.push((h as { available: string[] }).available));

    r.replaceWith({ runtimes: ['echo', 'cli:claude-code'] });
    await until(() => r.fleet.hosts()[0]?.link === 'reconnecting');
    r.restore();
    await until(() => pushed.some((a) => a.includes('cli:claude-code')));
  });

  it('carries what the host could not find, so the gap is explained', async () => {
    const r = await rig();
    r.replaceWith({
      runtimeNotes: [
        {
          id: 'cli:claude-code',
          label: 'Claude Code (installed CLI)',
          reason: '`claude` could not be started on this host (ENOENT)',
        },
      ],
    });
    r.restore();
    await r.fleet.attach({ target: { kind: 'local' }, workspaceRoot: r.root });

    const [host] = r.fleet.hosts();
    expect(host?.available).toEqual(['echo']);
    expect(host?.runtimeNotes).toEqual([
      {
        id: 'cli:claude-code',
        label: 'Claude Code (installed CLI)',
        reason: '`claude` could not be started on this host (ENOENT)',
      },
    ]);
  });
});
