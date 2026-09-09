/**
 * What `mcp.project` puts on the wire (DESIGN.md §17 Q20, §5.4b, §3.3, §8).
 *
 * The claim worth an end-to-end test is the **join**. A declaration says which
 * names a server wants; only the machine can say which of them it holds. Those
 * are two facts owned by two places, and the host is the one process with both
 * — so `missing` is computed there rather than by a client holding a second
 * copy of the rule.
 *
 * Beside it, the two properties every read on this wire has: the absolute path
 * does not travel, and a host too old to answer is refused by name rather than
 * answering an empty list.
 *
 * And one that belongs to this command in particular: **`command` and `args` do
 * travel.** Whoever approves a declaration is approving what will run on their
 * machine, and an id alone is not something anybody can agree to.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
import type { InstanceId } from '@shared/types/index.js';
import { PROJECT_SERVER_SUFFIX } from '@main/store/projectServers.js';
import {
  deleteSecret,
  readSecretNames,
  resolveSecrets,
  setSecret,
} from '../src/host/secrets.js';

const DECLARED = {
  command: 'npx',
  args: ['-y', '@some/mcp-search'],
  envFrom: { API_KEY: 'SEARCH_API_KEY' },
};

let root = '';
let machine = '';
let secrets = '';
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-mcpwire-'));
  machine = await mkdtemp(join(tmpdir(), 'agbrte-mcpmachine-'));
  secrets = join(machine, 'secrets.json');
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  await writeFile(
    join(root, '.agbrte', 'templates', `search${PROJECT_SERVER_SUFFIX}`),
    JSON.stringify(DECLARED),
    'utf8',
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(machine, { recursive: true, force: true });
});

async function connect(protocol?: number): Promise<HostConnection> {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
  const server = new SessionHostServer({
    manager: new SessionManager({ registry, workspaceRoot: root, instanceId }),
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
    secrets: {
      list: () => readSecretNames(secrets),
      set: (name, value) => setSecret(name, value, secrets),
      delete: (name) => deleteSecret(name, secrets),
      resolve: (names) => resolveSecrets(names, secrets),
    },
  });
  const pair = memoryChannelPair<SessionCommand, SessionMessage>();
  server.accept(pair.host);
  const connection = new HostConnection({ channel: pair.main });
  await connection.ready;
  if (protocol !== undefined) {
    (connection as unknown as { identity?: { protocol: number } }).identity = { protocol };
  }
  return connection;
}

describe('mcp.project over the session protocol', () => {
  it('says what the workspace declares and what it still needs', async () => {
    const found = await (await connect()).projectServers();
    expect(found).toHaveLength(1);
    expect(found[0]).toEqual({
      id: 'search',
      command: 'npx',
      args: ['-y', '@some/mcp-search'],
      // The machine holds nothing yet, so everything the declaration wants is
      // missing — which is exactly the list a form has to ask for.
      needs: ['SEARCH_API_KEY'],
      missing: ['SEARCH_API_KEY'],
      problems: [],
    });
  });

  it('stops calling it missing once the machine holds it', async () => {
    const connection = await connect();
    await connection.setSecret('SEARCH_API_KEY', 'sk-live-abcdef');
    const found = await connection.projectServers();
    /*
     * The join, which is the reason this command exists rather than a client
     * asking twice: `needs` comes from a file in the workspace and `missing`
     * from `secrets.list` on the machine, and §8 puts those in one host.
     */
    expect(found[0]?.needs).toEqual(['SEARCH_API_KEY']);
    expect(found[0]?.missing).toEqual([]);
  });

  it('goes back to missing when the machine forgets it', async () => {
    const connection = await connect();
    await connection.setSecret('SEARCH_API_KEY', 'sk-live-abcdef');
    await connection.deleteSecret('SEARCH_API_KEY');
    // Derived on every read rather than remembered anywhere — §5.1 refuses a
    // second source of truth, and this one has two sources that both move.
    expect((await connection.projectServers())[0]?.missing).toEqual(['SEARCH_API_KEY']);
  });

  it('keeps the host absolute path off the wire', async () => {
    const found = await (await connect()).projectServers();
    // On the serialised frame rather than a field, because the claim is that
    // the path is *absent* — a check on `summary.path` would pass against a
    // shape carrying it under any other name.
    const wire = JSON.stringify(found);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain('templates');
  });

  it('carries a broken declaration as a row with its reason', async () => {
    await writeFile(
      join(root, '.agbrte', 'templates', `bad${PROJECT_SERVER_SUFFIX}`),
      JSON.stringify({ command: 'npx', env: { API_KEY: 'sk-live-abcdef' } }),
      'utf8',
    );
    const found = await (await connect()).projectServers();
    expect(found.map((f) => f.id).sort()).toEqual(['bad', 'search']);
    const bad = found.find((f) => f.id === 'bad');
    // No command on a row that has no usable declaration, and nothing that was
    // in the refused `env` block anywhere near the wire.
    expect(bad?.command).toBeUndefined();
    expect(bad?.problems[0]).toContain('committed');
    expect(JSON.stringify(found)).not.toContain('sk-live-abcdef');
  });
});

describe('attaching one', () => {
  /*
   * The end of the trip, and the reason the last two versions exist: a file in
   * a repository plus a value on a machine become tools on a session, with the
   * value never leaving the machine in either direction.
   */
  it('resolves the declaration against the machine and attaches it', async () => {
    const connection = await connect();
    await connection.setSecret('SEARCH_API_KEY', 'sk-live-abcdef');
    const session = await connection.createSession({ title: 'work', goal: 'work' });

    /*
     * `npx` is not going to answer MCP here, and that is the *right* failure to
     * see: it means the config was built and handed to `connectMcp`, which
     * reported a process that would not start as `mcp.failed` in the transcript
     * (§3.5) rather than throwing. What matters is which failure — "could not
     * start" is a spawn that happened, and the refusals below are the ones that
     * happen before anything is spawned at all.
     */
    const status = await connection.attachProjectMcp(session.sessionId, 'search');
    expect(status.id).toBe('search');
    expect(status.error ?? '').not.toContain('no usable MCP server');
    expect(status.error ?? '').not.toContain('not stored here');
    // And the value did not come back in the reply, which is the whole point.
    expect(JSON.stringify(status)).not.toContain('sk-live-abcdef');
  });

  it('refuses before attaching when the machine does not hold the secret', async () => {
    const connection = await connect();
    const session = await connection.createSession({ title: 'work', goal: 'work' });
    /*
     * Named, because the name is the list a person has to fill in. "Could not
     * start" would send them to the wrong problem — a missing key is not a
     * broken server, and only one of the two has a remedy they can act on.
     */
    await expect(connection.attachProjectMcp(session.sessionId, 'search')).rejects.toThrow(
      /SEARCH_API_KEY/,
    );
  });

  it('refuses an id the workspace does not declare', async () => {
    const connection = await connect();
    const session = await connection.createSession({ title: 'work', goal: 'work' });
    await expect(connection.attachProjectMcp(session.sessionId, 'nothing')).rejects.toThrow(
      /no usable MCP server/,
    );
  });

  it('refuses a whole create rather than leaving a session half-equipped', async () => {
    const connection = await connect();
    /*
     * Resolved before the session exists. A session created and *then* told it
     * cannot have the server it was asked for is a session somebody has to
     * notice and clean up — and `createSession` already refuses a duplicate
     * server id the same way, for the same reason.
     */
    await expect(
      connection.createSession({ title: 'work', goal: 'work' }, ['search']),
    ).rejects.toThrow(/SEARCH_API_KEY/);
  });
});

describe('a host that predates the commands', () => {
  const tooOldFor = (command: string): number => (COMMAND_SINCE[command] ?? 1) - 1;

  it('refuses the read by name rather than answering an empty list', async () => {
    // §3.3: a workspace declaring none and a host that cannot be asked are
    // different facts, and only one of them has a remedy.
    await expect((await connect(tooOldFor('mcp.project'))).projectServers()).rejects.toThrow(
      /mcp\.project/,
    );
  });

  it('refuses the attach by name too', async () => {
    // A silent failure here leaves somebody believing a session has tools it
    // has not got, and they find out from a model that cannot do the thing they
    // asked for.
    await expect(
      (await connect(tooOldFor('session.attachProject'))).attachProjectMcp(
        'whatever' as never,
        'search',
      ),
    ).rejects.toThrow(/session\.attachProject/);
  });

  it('registers both in COMMAND_SINCE at the versions that added them', () => {
    expect(COMMAND_SINCE['mcp.project']).toBe(34);
    expect(COMMAND_SINCE['session.attachProject']).toBe(35);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(35);
  });
});
