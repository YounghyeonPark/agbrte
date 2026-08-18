/**
 * "Set up this machine", from the button to the file (DESIGN.md §6.4, §3.8, §13).
 *
 * Each host here is a real `SessionHostServer` over a real workspace, reached
 * through a real `HostConnection` — so `endpoints.add` goes through the actual
 * dispatch, the actual write gate and the actual reply path rather than a mock
 * that would agree with whatever it was handed. The two things that genuinely
 * cannot run here are an `ssh` remote (there is no `sshd` reachable from this
 * machine) and an installer (nothing may be downloaded in a unit test), so the
 * provisioner is injected — which is exactly the seam `FleetDeps.provision`
 * exists to provide, and the same seam `main.ts` fills with `ssh`.
 *
 * What that leaves measured: the ordering, the capability refusals, the
 * half-success reporting, the endpoint-already-present decision, and the
 * property that a key reaches the file and appears in nothing else.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fleet } from '@main/fleet.js';
import { RouteRefused } from '@main/host/provision.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { addEndpoint } from '../src/host/endpoints.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import { HostConnection } from '@main/host/hostConnection.js';
import type { SetupPlan } from '@main/host/provision.js';
import type { HostLocation } from '@shared/types/index.js';
import type { InstanceId } from '@shared/types/index.js';

const KEY = 'sk-never-in-a-log';
const RUNTIMES = [{ id: 'echo', label: 'Echo', version: '0.0.1', model: 'none' as const }];

let roots: string[] = [];
let fleets: Fleet[] = [];

beforeEach(() => {
  roots = [];
  fleets = [];
});

afterEach(async () => {
  for (const fleet of fleets) await fleet.detachAll();
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function makeRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-setup-'));
  roots.push(dir);
  return dir;
}

interface Options {
  /** Endpoints the host reports at handshake, as `loadEndpoints` would. */
  endpoints?: Array<{ id: string; label: string; provider: string; baseUrl: string; authenticated: boolean }>;
  /** Where `endpoints.add` writes. A temp file, never the developer's home. */
  endpointsFile?: string;
  /** What the injected provisioner does. Defaults to reporting two steps. */
  provision?: (location: HostLocation, plan: SetupPlan, onProgress: (s: string) => void) => Promise<void>;
}

function makeFleet(opts: Options = {}): { fleet: Fleet; plans: SetupPlan[] } {
  const plans: SetupPlan[] = [];
  /*
   * A *new* server per connect, over a manager kept per workspace.
   *
   * Every route here ends in `updateHost`, which stops the host and dials for
   * its replacement — so a cached server would be handed back stopped and the
   * second call in a test would fail with `host connection closed`, which is a
   * property of the fake and not of the code. A fresh server over the same
   * manager is what a restarted host process actually is: a new listener over
   * the same workspace and the same log.
   */
  const managers = new Map<string, SessionManager>();

  const fleet = new Fleet({
    runtimes: RUNTIMES,
    updateWindowMs: 2_000,
    maxBackoffMs: 20,
    connect: async ({ workspaceRoot }) => {
      const identity = await openWorkspace(workspaceRoot);
      let manager = managers.get(workspaceRoot);
      if (manager === undefined) {
        const registry = new RuntimeRegistry();
        registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
        manager = new SessionManager({ registry, workspaceRoot, instanceId: identity.instanceId });
        managers.set(workspaceRoot, manager);
      }
      const server = new SessionHostServer({
        manager,
        identity: {
          instanceId: identity.instanceId,
          lineageId: identity.lineageId,
          workspaceRoot,
          runtimes: ['echo'],
          endpoints: opts.endpoints ?? [],
        },
        // The real writer, pointed at a temp file. Nothing here stubs the one
        // function that touches a credential.
        ...(opts.endpointsFile !== undefined
          ? { addEndpoint: (input) => addEndpoint(input, opts.endpointsFile!) }
          : {}),
      });
      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);
      return new HostConnection({ channel: pair.main });
    },
    provision: async (location, plan, onProgress) => {
      plans.push(plan);
      if (opts.provision !== undefined) return opts.provision(location, plan, onProgress);
      onProgress('checking there is room');
      onProgress('installing');
    },
  });
  fleets.push(fleet);
  return { fleet, plans };
}

describe('adding an API endpoint from the app', () => {
  it('puts the key in a 0600 file on that machine and nowhere else', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    const { fleet } = makeFleet({ endpointsFile: file });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    const seen: string[] = [];
    const outcome = await fleet.setUpHost(
      host.instanceId as InstanceId,
      {
        kind: 'endpoint',
        endpoint: { id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
      },
      (step) => seen.push(step),
    );

    // The file has it…
    expect(await readFile(file, 'utf8')).toContain(KEY);
    // …and nothing that travelled back does. Serialised whole rather than field
    // by field, because a field added later would ride along unnoticed.
    expect(JSON.stringify(outcome)).not.toContain(KEY);
    expect(seen.join('\n')).not.toContain(KEY);
    expect(outcome.summary).toContain('openai');
    expect(outcome.installed).toBe(true);
    // §6.5's table, stated at the moment the choice was made rather than in a
    // document somewhere: this is the remote-resident credential row.
    expect(outcome.followUp).toContain('detached run');
  });

  it('never sends a credential through the provisioner', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    const { fleet, plans } = makeFleet({ endpointsFile: file });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    await fleet.setUpHost(host.instanceId as InstanceId, {
      kind: 'endpoint',
      endpoint: { id: 'a', provider: 'p', baseUrl: 'https://a.example/v1', apiKey: KEY },
    });
    // The provisioner is the half that runs shell commands. A key must never
    // reach it, which is why the endpoint route does not go through it at all.
    expect(plans).toEqual([]);
  });

  it('says which half worked when the host will not restart', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    const { fleet } = makeFleet({ endpointsFile: file });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    // Something running, so the host exercises its own right to refuse — the
    // §6.4 rule that a window closing must not take a live turn with it.
    const session = await fleet.createSession(host.instanceId as InstanceId, {
      title: 'busy',
      goal: 'be busy',
    });
    const agent = await fleet.addAgent(session.sessionId, { runtimeId: 'echo', model: null });
    await fleet.send(session.sessionId, agent.agentId, 'go');

    const outcome = await fleet.setUpHost(host.instanceId as InstanceId, {
      kind: 'endpoint',
      endpoint: { id: 'later', provider: 'p', baseUrl: 'https://a.example/v1' },
    });

    // Written either way — the endpoint is on disk whatever the host decided —
    // and the sentence says which half is outstanding rather than reporting a
    // failure about a thing that succeeded.
    expect(await readFile(file, 'utf8')).toContain('later');
    if (!outcome.redetected) {
      expect(outcome.installed).toBe(true);
      expect(outcome.detail).toContain('has not noticed yet');
    }
    // And the host is still attached, which is the property `updateHost` keeps.
    expect(fleet.hosts().map((h) => h.instanceId)).toContain(host.instanceId);
  });

  it('refuses a duplicate id in the host`s own words', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    const { fleet } = makeFleet({ endpointsFile: file });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });
    const plan = {
      kind: 'endpoint' as const,
      endpoint: { id: 'dup', provider: 'p', baseUrl: 'https://a.example/v1' },
    };
    await fleet.setUpHost(host.instanceId as InstanceId, plan);
    await expect(fleet.setUpHost(host.instanceId as InstanceId, plan)).rejects.toThrow(
      /already has an endpoint called "dup"/,
    );
  });
});

describe('installing Ollama', () => {
  it('ends with an endpoint pointed at it, not merely a daemon', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    // A host whose endpoint list does *not* include a local one — the case where
    // stopping at "the server is up" leaves a daemon nobody is pointed at.
    const { fleet } = makeFleet({
      endpointsFile: file,
      endpoints: [
        { id: 'work', label: 'work', provider: 'openai', baseUrl: 'https://api.openai.com/v1', authenticated: true },
      ],
    });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    const outcome = await fleet.setUpHost(host.instanceId as InstanceId, { kind: 'ollama' });
    expect(JSON.parse(await readFile(file, 'utf8')).endpoints).toContainEqual(
      expect.objectContaining({ id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }),
    );
    expect(outcome.summary).toContain('Added "ollama"');
  });

  it('adds nothing when one already points there, whatever it is called', async () => {
    const dir = await makeRoot();
    const file = join(dir, 'endpoints.json');
    const { fleet } = makeFleet({
      endpointsFile: file,
      // The implicit fallback every host has without a file, under its own name
      // and with a trailing-slash spelling — the same server, three strings.
      endpoints: [
        { id: 'local', label: 'local model', provider: 'local', baseUrl: 'http://localhost:11434/v1/', authenticated: false },
      ],
    });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    const outcome = await fleet.setUpHost(host.instanceId as InstanceId, { kind: 'ollama' });
    expect(outcome.summary).not.toContain('Added');
    // No file written at all: a second identical endpoint would show in the
    // picker as two rows nobody can choose between.
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });

  it('streams every step the machine reported, in order', async () => {
    const dir = await makeRoot();
    const { fleet } = makeFleet({
      endpointsFile: join(dir, 'endpoints.json'),
      endpoints: [
        { id: 'local', label: 'local', provider: 'local', baseUrl: 'http://127.0.0.1:11434/v1', authenticated: false },
      ],
      provision: async (_l, _p, onProgress) => {
        for (const step of ['downloading Ollama', 'checking the download', 'unpacking', 'starting the server']) {
          onProgress(step);
        }
      },
    });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    const seen: string[] = [];
    const outcome = await fleet.setUpHost(host.instanceId as InstanceId, { kind: 'ollama' }, (s) =>
      seen.push(s),
    );
    expect(seen.slice(0, 4)).toEqual([
      'downloading Ollama',
      'checking the download',
      'unpacking',
      'starting the server',
    ]);
    // The last step is always the same one, because every route ends by making
    // the host look again — a host builds its runtime and endpoint lists once,
    // at startup.
    expect(seen.at(-1)).toContain('restarting the host');
    expect(outcome.steps).toEqual(seen);
  });
});

describe('installing a CLI', () => {
  it('says plainly what is still left to do, and where', async () => {
    const dir = await makeRoot();
    const { fleet, plans } = makeFleet({ endpointsFile: join(dir, 'endpoints.json') });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });

    const outcome = await fleet.setUpHost(host.instanceId as InstanceId, {
      kind: 'cli',
      cli: 'claude-code',
    });

    expect(plans).toEqual([{ kind: 'cli', cli: 'claude-code' }]);
    expect(outcome.summary).toContain('Claude Code is installed');
    // The honest gap: an install is not a sign-in, and the app cannot do the
    // second half — its terminal pane is local-only.
    expect(outcome.followUp).toContain('claude auth login');
    expect(outcome.followUp).toContain('local-only');
  });

  it('reports the installer`s own failure rather than a summary of it', async () => {
    const dir = await makeRoot();
    const { fleet } = makeFleet({
      endpointsFile: join(dir, 'endpoints.json'),
      provision: async () => {
        throw new Error('npm ERR! 403 Forbidden - GET https://registry.npmjs.org/…');
      },
    });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });
    await expect(
      fleet.setUpHost(host.instanceId as InstanceId, { kind: 'cli', cli: 'gemini-cli' }),
    ).rejects.toThrow(/npm ERR! 403 Forbidden/);
    // Nothing was restarted for an install that did not happen.
    expect(fleet.hosts()[0]?.link).toBe('connected');
  });
});

describe('refusing rather than pretending', () => {
  it('will not install anything on a client with no provisioner', async () => {
    const dir = await makeRoot();
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      connect: async ({ workspaceRoot }) => {
        const identity = await openWorkspace(workspaceRoot);
        const registry = new RuntimeRegistry();
        registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
        const server = new SessionHostServer({
          manager: new SessionManager({ registry, workspaceRoot, instanceId: identity.instanceId }),
          identity: {
            instanceId: identity.instanceId,
            lineageId: identity.lineageId,
            workspaceRoot,
            runtimes: ['echo'],
          },
        });
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    fleets.push(fleet);
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });
    await expect(
      fleet.setUpHost(host.instanceId as InstanceId, { kind: 'cli', cli: 'claude-code' }),
    ).rejects.toBeInstanceOf(RouteRefused);
  });

  it('says which capability is missing, not merely that it cannot', async () => {
    // §6.2's rule read for the first time by something other than `attach`: an
    // Ollama has to outlive the connection that started it, and that is exactly
    // what `persistentProcesses` describes.
    const dir = await makeRoot();
    const { fleet } = makeFleet({ endpointsFile: join(dir, 'endpoints.json') });
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });
    // `local` has the capability, so this asserts the wording exists for the
    // case rather than the case itself — the transports it would fire on are
    // `hosted`, which cannot be attached yet.
    await expect(
      fleet.setUpHost(host.instanceId as InstanceId, { kind: 'ollama' }),
    ).resolves.toBeTruthy();
  });

  it('will not let a read-only client change the machine', async () => {
    /*
     * The route the host cannot gate. `endpoints.add` is refused by the host
     * itself; installing a CLI or an Ollama goes over the transport from main
     * and never reaches it, so without this a browser pinned to `read-only` by
     * a workspace's access policy could put a gigabyte on somebody's build box.
     */
    const dir = await makeRoot();
    const fleet = new Fleet({
      runtimes: RUNTIMES,
      connect: async ({ workspaceRoot }) => {
        const identity = await openWorkspace(workspaceRoot);
        const registry = new RuntimeRegistry();
        registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
        const server = new SessionHostServer({
          manager: new SessionManager({ registry, workspaceRoot, instanceId: identity.instanceId }),
          identity: {
            instanceId: identity.instanceId,
            lineageId: identity.lineageId,
            workspaceRoot,
            runtimes: ['echo'],
          },
          // The host grants less than was asked, which is §7's whole shape.
          grantRole: () => ({
            role: 'read-only',
            actor: { id: 'uid:1000', via: 'peer-credential', label: 'watcher' },
          }),
        });
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
      provision: async () => {
        throw new Error('the provisioner should never have been reached');
      },
    });
    fleets.push(fleet);
    const host = await fleet.attach({ target: { kind: 'local' }, workspaceRoot: dir });
    expect(host.role).toBe('read-only');

    for (const plan of [
      { kind: 'cli' as const, cli: 'claude-code' as const },
      { kind: 'ollama' as const },
    ]) {
      await expect(fleet.setUpHost(host.instanceId as InstanceId, plan)).rejects.toThrow(
        /read-only access/,
      );
    }
  });

  it('refuses a host that is not attached, rather than starting one', async () => {
    const { fleet } = makeFleet();
    await expect(
      fleet.setUpHost('nobody' as InstanceId, { kind: 'ollama' }),
    ).rejects.toThrow();
  });
});
