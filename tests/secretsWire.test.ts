/**
 * What `secrets.*` puts on the wire, and the one thing it must never
 * (DESIGN.md §13, §7, §17 Q20).
 *
 * **A value never travels back.** `secrets.list` answers with names, and there
 * is deliberately no command that reads a value — a name is what somebody needs
 * to know what is stored and to remove it, and a value's only caller is the
 * spawn on the machine holding it. This file is where that stops being a
 * convention and becomes a test: the assertion is on the serialised frame, so a
 * shape that carried a value under some other name would fail it.
 *
 * **Storing one is a write, and writes are gated.** §7's `read-only` role exists
 * so a phone pinned by an access policy can watch a build box without driving
 * it. A client that could store a credential there could make that box talk to
 * an account nobody on it owns — the same argument `endpoints.add` makes, and
 * the reason these two commands sit behind the same gate.
 *
 * **Listing is not gated**, which is the deliberate half of that: knowing a
 * machine holds `SEARCH_API_KEY` says nothing about what it is, and a watcher
 * who cannot see the names cannot tell a missing key from a broken server.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import {
  COMMAND_SINCE,
  SESSION_PROTOCOL_VERSION,
  type SessionCommand,
  type SessionMessage,
} from '@shared/host/sessionProtocol.js';
import { openWorkspace } from '@main/store/identity.js';
import type { AccessRole, InstanceId } from '@shared/types/index.js';
import { deleteSecret, readSecretNames, resolveSecrets, setSecret } from '../src/host/secrets.js';

const VALUE = 'sk-live-do-not-echo-me';

let root = '';
let machine = '';
let secrets = '';
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-secwire-'));
  machine = await mkdtemp(join(tmpdir(), 'agbrte-secmachine-'));
  secrets = join(machine, 'secrets.json');
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(machine, { recursive: true, force: true });
});

async function connect(opts: { protocol?: number; role?: AccessRole } = {}): Promise<HostConnection> {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
  const server = new SessionHostServer({
    manager: new SessionManager({ registry, workspaceRoot: root, instanceId }),
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
    /*
     * The same three callbacks `hostMain` supplies, pointed at a temporary
     * machine directory — which is what keeps a test run off the developer's
     * own `~/.agbrte/secrets.json`.
     */
    secrets: {
      list: () => readSecretNames(secrets),
      set: (name, value) => setSecret(name, value, secrets),
      delete: (name) => deleteSecret(name, secrets),
    },
  });
  const pair = memoryChannelPair<SessionCommand, SessionMessage>();
  server.accept(pair.host);
  const connection = new HostConnection({
    channel: pair.main,
    ...(opts.role !== undefined ? { role: opts.role } : {}),
  });
  // The identity a client reads comes from `welcome`, so a command asked before
  // the handshake sees protocol 1 and is refused for the wrong reason.
  await connection.ready;
  if (opts.protocol !== undefined) {
    // Pretend the far side is older than the command, which is the state a
    // client meets against a host nobody has restarted since the release.
    (connection as unknown as { identity?: { protocol: number } }).identity = {
      protocol: opts.protocol,
    };
  }
  return connection;
}

describe('storing and listing over the session protocol', () => {
  it('stores one and answers with the name', async () => {
    const connection = await connect();
    expect(await connection.setSecret('SEARCH_API_KEY', VALUE)).toEqual({
      name: 'SEARCH_API_KEY',
    });
    expect(await connection.secretNames()).toEqual(['SEARCH_API_KEY']);
    // It really landed on the machine: the spawn path can resolve it, which is
    // the only reader that ever should.
    expect(await resolveSecrets(['SEARCH_API_KEY'], secrets)).toEqual({
      SEARCH_API_KEY: VALUE,
    });
  });

  it('never sends the value back, in either direction', async () => {
    const connection = await connect();
    const stored = await connection.setSecret('SEARCH_API_KEY', VALUE);
    const names = await connection.secretNames();
    /*
     * On the serialised replies rather than on their fields, because the claim
     * is that the value is *absent* — a check on `names[0].value` would pass
     * against a shape carrying it under any other name. This is the assertion a
     * refactor must not be able to delete quietly.
     */
    expect(JSON.stringify(stored)).not.toContain(VALUE);
    expect(JSON.stringify(names)).not.toContain(VALUE);
  });

  it('keeps the value out of a refusal, which is where it would leak', async () => {
    const connection = await connect();
    // `reply()` turns a thrown error into its `message`, so a writer that
    // interpolated the value into one would put a credential on the wire
    // through the error path while the success path stayed clean.
    await expect(connection.setSecret('has space', VALUE)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(VALUE) }) as never,
    );
  });

  it('forgets one', async () => {
    const connection = await connect();
    await connection.setSecret('A', '1');
    await connection.setSecret('B', '2');
    await connection.deleteSecret('A');
    expect(await connection.secretNames()).toEqual(['B']);
  });
});

describe('who may store one', () => {
  it('refuses a read-only client, and lets it read the names', async () => {
    const watching = await connect({ role: 'read-only' });
    // A phone pinned by an access policy can watch a build box; it cannot make
    // that box talk to an account nobody on it owns (§7, §13).
    await expect(watching.setSecret('SEARCH_API_KEY', VALUE)).rejects.toThrow(/read-only/);
    await expect(watching.deleteSecret('SEARCH_API_KEY')).rejects.toThrow(/read-only/);
    /*
     * The read is deliberately not gated. Knowing a machine holds
     * `SEARCH_API_KEY` says nothing about what it is, and a watcher who cannot
     * see the names cannot tell a missing key from a broken server.
     */
    await expect(watching.secretNames()).resolves.toEqual([]);
  });
});

describe('a host that predates the commands', () => {
  /*
   * Pinned to what each *command* needs rather than to one below the current
   * protocol, for the reason `workflowWire` records: `SESSION_PROTOCOL_VERSION
   * - 1` means "a host one release behind" and stops describing this state at
   * the next bump.
   */
  const tooOldFor = (command: string): number => (COMMAND_SINCE[command] ?? 1) - 1;

  it('refuses each by name rather than doing nothing', async () => {
    // A write that quietly no-ops leaves somebody believing a key is stored,
    // and they find out when a server fails to start — the worst place.
    await expect((await connect({ protocol: tooOldFor('secrets.set') })).setSecret('A', '1'))
      .rejects.toThrow(/secrets\.set/);
    await expect((await connect({ protocol: tooOldFor('secrets.delete') })).deleteSecret('A'))
      .rejects.toThrow(/secrets\.delete/);
    await expect((await connect({ protocol: tooOldFor('secrets.list') })).secretNames())
      .rejects.toThrow(/secrets\.list/);
  });

  it('registers all three in COMMAND_SINCE at the version that added them', () => {
    // `supports()` is derived from this table — an entry missing here makes the
    // refusals above silent, which is the failure the table exists to prevent.
    expect(COMMAND_SINCE['secrets.list']).toBe(33);
    expect(COMMAND_SINCE['secrets.set']).toBe(33);
    expect(COMMAND_SINCE['secrets.delete']).toBe(33);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(33);
  });
});

describe('a host with nowhere to keep them', () => {
  it('lists nothing and says so by name on a write', async () => {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
    // Constructed without the callbacks, which is the honest state for a server
    // started with no machine directory to write into — said by name rather
    // than by silently succeeding, exactly as `addEndpoint` does.
    const server = new SessionHostServer({
      manager: new SessionManager({ registry, workspaceRoot: root, instanceId }),
      identity: {
        instanceId,
        lineageId: lineageId as never,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
    });
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const connection = new HostConnection({ channel: pair.main });
    await connection.ready;

    expect(await connection.secretNames()).toEqual([]);
    await expect(connection.setSecret('A', '1')).rejects.toThrow(/cannot keep secrets/);
  });
});
