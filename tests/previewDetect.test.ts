/**
 * The host offering the ports it can see (DESIGN.md §6.8), and the version bump
 * that exposed a stranding bug (§17.16).
 *
 * `preview.ports` is the first command added since negotiation was built, so it
 * is the first real exercise of it — and bumping the protocol to ship it found
 * `connectRemote` refusing any version difference before the handshake could
 * speak. That is the failure negotiation exists to prevent, sitting one layer
 * above negotiation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRemoteHost } from '@main/host/connectRemote.js';
import { RemoteBootstrapFailed, type SshRunner } from '@main/host/sshTransport.js';
import { COMMAND_SINCE, SESSION_PROTOCOL_VERSION } from '@shared/host/sessionProtocol.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { PreviewServers } from '@main/preview/servers.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { InstanceId, LineageId, SessionId } from '@shared/types/index.js';

const roots: string[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A runner whose remote reports whatever protocol the test wants. */
function runnerReporting(protocol: number): SshRunner {
  return {
    exec: (_alias, command) => {
      if (/uname/.test(command)) {
        return Promise.resolve({
          code: 0,
          stdout: 'home=/h\narch=x86_64\nplatform=Linux\nnode=/usr/bin/node\nbundle=v1\n',
          stderr: '',
        });
      }
      if (/host\.json/.test(command)) {
        return Promise.resolve({
          code: 0,
          stdout: JSON.stringify({ pid: 42, socket: '/tmp/x.sock', protocol, instanceId: 'i' }),
          stderr: '',
        });
      }
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    },
    upload: () => Promise.resolve(),
    // Nothing is listening, so the attempt fails *after* any version check —
    // which is what lets this distinguish the two refusals.
    forward: () => Promise.reject(new RemoteBootstrapFailed('ssh forward never became usable')),
  };
}

describe('a version difference is not a reason to refuse', () => {
  it('reaches a host older than this app', async () => {
    /**
     * Reproduced against a real host before it was written: a v2 host that had
     * been running since the previous day, and an app at v3, produced
     *
     *   REFUSED: the host on build-01 speaks session protocol v2,
     *            this app speaks v3: stop it there, or update this app
     *
     * "Stop it there" for a host holding a live agent means losing the work, and
     * §17.16 exists precisely because a bump must not require killing the thing
     * it upgrades. The check called itself "the same rule the handshake
     * enforces" and was not: the handshake refuses a client older than the
     * host's minimum, this refused any difference in either direction.
     *
     * So what is asserted is *which* failure comes back. The forward fails in
     * this harness, so getting that error rather than a protocol one means the
     * version check let it through.
     */
    const older = connectRemoteHost({
      alias: 'build-01',
      workspaceRoot: '/w',
      bundles: { host: 'x', agent: 'y' },
      bundleVersion: 'v1',
      runner: runnerReporting(SESSION_PROTOCOL_VERSION - 1),
    });
    await expect(older).rejects.toThrow(/forward never became usable/);
    await expect(older).rejects.not.toThrow(/protocol/);
  });

  it('reaches a host newer than this app, and lets it decide', async () => {
    // The other direction, which the old check also refused. Whether a newer
    // host will serve an older client is the host's call — the same reason roles
    // are granted rather than claimed — and it makes that call in the handshake.
    const newer = connectRemoteHost({
      alias: 'build-01',
      workspaceRoot: '/w',
      bundles: { host: 'x', agent: 'y' },
      bundleVersion: 'v1',
      runner: runnerReporting(SESSION_PROTOCOL_VERSION + 1),
    });
    await expect(newer).rejects.toThrow(/forward never became usable/);
  });
});

describe('an older host costs one command, not the connection', () => {
  it('declares when preview.ports arrived', () => {
    expect(COMMAND_SINCE['preview.ports']).toBe(3);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(3);
  });

  it('names the command and the version rather than failing obscurely', async () => {
    // Against a real client with an identity that reports v2 — which is what a
    // host deployed before this command reports. Verified against the actual v2
    // host still running remotely: "this host speaks session protocol v2 and
    // `preview.ports` needs v3 — upgrade the host to use it".
    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const client = new HostConnection({ channel: main, client: 'test' });

    host.onMessage((command) => {
      if (command.t === 'hello') {
        host.post({
          t: 'welcome',
          id: command.id,
          role: 'read-write',
          identity: {
            instanceId: 'i' as InstanceId,
            lineageId: 'l' as LineageId,
            workspaceRoot: '/w',
            runtimes: [],
            pid: 1,
            protocol: 2,
            minProtocol: 1,
          },
        } as SessionMessage);
      }
    });

    await client.ready;
    expect(client.supports('preview.ports')).toBe(false);
    await expect(client.previewPorts()).rejects.toThrow(/needs v3/);
    // And the connection is still good for everything else, which is the point.
    expect(client.supports('session.list')).toBe(true);
    client.disconnect();
  });
});

describe('the host answers about its own machine', () => {
  it('answers about the machine it is actually on', async () => {
    /**
     * This asserted `[]` on anything but Linux, and failed the moment Windows
     * and macOS got enumerators — which is the assertion working. The claim now
     * is the one that matters for "each OS controls itself": a host reports the
     * ports of the machine it runs on, whichever machine that is, and CI runs
     * this on all three.
     *
     * `[]` remains the answer where it genuinely cannot look — a platform with
     * no enumerator, or a tool that is missing. Empty is right for a picker:
     * asking what is available is a question a UI asks on open, and an error
     * banner is not an answer to it. The *other* kind of "cannot tell" — a host
     * too old to have the command — comes from `supports`, above.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-detect-'));
    roots.push(root);
    const identity = await openWorkspace(root);
    const manager = new SessionManager({
      registry: new RuntimeRegistry(),
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    managers.push(manager);

    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: [],
      },
      lingerMs: 0,
    });
    server.accept(host);

    const client = new HostConnection({ channel: main, client: 'test' });
    await client.ready;
    expect(client.supports('preview.ports')).toBe(true);

    // A real listener, so "it answered" is not the same as "it answered empty".
    const listener = createServer(() => undefined);
    await new Promise<void>((r) => listener.listen(0, '127.0.0.1', r));
    const address = listener.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    try {
      const ports = await client.previewPorts();
      expect(ports.some((p) => p.port === port), `${process.platform} could not see its own listener`).toBe(
        true,
      );
    } finally {
      listener.close();
    }

    client.disconnect();
    server.stop('done');
  }, 30_000);
});

describe('starting a process is a person’s request, not a model’s', () => {
  it('refuses a read-only client', async () => {
    /**
     * §3.12's reaping — whatever an agent starts, ends — is a real containment
     * property, and an API that starts a *persistent* process launders it if the
     * wrong caller can reach it. Two guards, and this is the one a test can
     * assert: the role. The other is structural — `preview.start` is a protocol
     * command and an IPC method, and is deliberately absent from the tool
     * registry, so a model cannot ask for it at all.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-detect-'));
    roots.push(root);
    const identity = await openWorkspace(root);
    const manager = new SessionManager({
      registry: new RuntimeRegistry(),
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    managers.push(manager);

    const servers = new PreviewServers(root);
    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      servers,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: [],
      },
      // What a workspace policy pinning a phone to read-only produces.
      grantRole: () => ({ role: 'read-only', actor: { id: 'phone', via: 'asserted' } }),
      lingerMs: 0,
    });
    server.accept(host);

    const client = new HostConnection({ channel: main, client: 'agbrte-app@phone-1' });
    await client.ready;

    await expect(
      client.startPreviewServer('s1' as SessionId, 'node -e "process.exit(0)"'),
    ).rejects.toThrow(/read-only|start a preview server/i);
    // And nothing was spawned. The refusal is the point, not the message.
    expect(servers.list()).toHaveLength(0);

    // Reading what is running stays allowed: it is a read, like the transcript.
    await expect(client.previewServers()).resolves.toEqual([]);

    servers.stopAll();
    client.disconnect();
    server.stop('done');
  }, 30_000);

  it('says so when the host does not run processes at all', async () => {
    // A host constructed without a supervisor — a test, or an embedding that
    // does not want to run commands. Saying so beats an optional-chain that
    // reports success for a server nobody started.
    const root = await mkdtemp(join(tmpdir(), 'agbrte-detect-'));
    roots.push(root);
    const identity = await openWorkspace(root);
    const manager = new SessionManager({
      registry: new RuntimeRegistry(),
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    managers.push(manager);

    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: [],
      },
      lingerMs: 0,
    });
    server.accept(host);

    const client = new HostConnection({ channel: main, client: 'test' });
    await client.ready;
    await expect(
      client.startPreviewServer('s1' as SessionId, 'node -e "0"'),
    ).rejects.toThrow(/does not run preview servers/);

    client.disconnect();
    server.stop('done');
  }, 30_000);
});
