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
import { fileURLToPath } from 'node:url';
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

/*
 * A real MCP server over stdio, from `tests/fixtures`. `npx` would have been
 * shorter and would have made every assertion below a statement about a spawn
 * that failed — and the difference between "the config was built and the
 * process would not start" and "the config was never built" is most of what
 * this file is about.
 *
 * `lookup` echoes `AGBRTE_E2E_TOKEN`, which is how a test can show a value
 * reached the *process* while the log and the wire carry only its name (§13).
 */
const FIXTURE = fileURLToPath(new URL('./fixtures/mcpServer.cjs', import.meta.url));

const DECLARED = {
  command: process.execPath,
  args: [FIXTURE],
  envFrom: { AGBRTE_E2E_TOKEN: 'SEARCH_API_KEY' },
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
      // What will run, because whoever approves this is approving that rather
      // than a name they cannot check.
      command: process.execPath,
      args: [FIXTURE],
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
    expect(status.error).toBeUndefined();
    // The server started and named its tools under this declaration's id.
    expect(status.tools).toContain('mcp__search__lookup');
    // And the value did not come back in the reply, which is the whole point.
    expect(JSON.stringify(status)).not.toContain('sk-live-abcdef');

    /*
     * The log carries the env *name* and not the value (§13) — the asymmetry
     * Q20 named, unchanged by any of this. What is new is only where the value
     * comes from; where it is allowed to appear is exactly where it was.
     *
     * The name is `AGBRTE_E2E_TOKEN`, which is what the *server* asked for,
     * rather than `SEARCH_API_KEY`, which is what the machine calls it. That is
     * `envFrom` doing the one thing it exists for.
     */
    const events = await connection.events(session.sessionId);
    const line = events.find((e) => e.type === 'mcp.attached');
    expect((line as { envKeys?: string[] }).envKeys).toEqual(['AGBRTE_E2E_TOKEN']);
    expect(JSON.stringify(events)).not.toContain('sk-live-abcdef');
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

describe('resuming', () => {
  /*
   * Q20's recorded cost, bought back (§17 Q20, v35).
   *
   * "A resumed session does not silently reconnect: the log deliberately cannot
   * rebuild what it deliberately does not hold." It can now, for a declared
   * server: the file has the command and the machine has the value, so the two
   * halves the log was missing are both still here after a restart.
   *
   * Which servers to bring back is read from `mcp.attached` in the log, and
   * whether one is a declaration is answered by the workspace *now* — no marker
   * was added to the event, because that would be a durable claim about the past
   * answering a question the present can answer.
   */
  it('brings back a declared server the session used to have', async () => {
    const first = await connect();
    await first.setSecret('SEARCH_API_KEY', 'sk-live-abcdef');
    const session = await first.createSession({ title: 'work', goal: 'work' });
    await first.attachProjectMcp(session.sessionId, 'search');

    // A second host over the same workspace and the same machine directory,
    // which is what a restart is from the session's point of view.
    const restarted = await connect();
    const back = await restarted.resumeSession(session.sessionId);
    // Back, and working: the tools are named again, which they could not be if
    // resume had only noticed the server without starting it.
    expect(back.mcp?.map((m) => m.id)).toEqual(['search']);
    expect(back.mcp?.[0]?.tools).toContain('mcp__search__lookup');
  });

  it('says why, when the machine has forgotten the key', async () => {
    const first = await connect();
    await first.setSecret('SEARCH_API_KEY', 'sk-live-abcdef');
    const session = await first.createSession({ title: 'work', goal: 'work' });
    await first.attachProjectMcp(session.sessionId, 'search');
    await first.deleteSecret('SEARCH_API_KEY');

    const back = await (await connect()).resumeSession(session.sessionId);
    /*
     * Recorded rather than silent, and never thrown. A resume that fell over
     * because a key was rotated would take the transcript with it, and "why can
     * it not search any more" has to be answerable where the question is asked.
     */
    expect(back.mcp?.[0]?.error).toContain('SEARCH_API_KEY');
  });

  it('leaves a hand-typed server exactly as it was', async () => {
    const first = await connect();
    const session = await first.createSession({
      title: 'work',
      goal: 'work',
      mcpServers: [
        { id: 'typed', command: process.execPath, args: [FIXTURE], env: { API_KEY: 'sk-live-typed' } },
      ],
    });
    expect(session.mcp?.map((m) => m.id)).toEqual(['typed']);

    const back = await (await connect()).resumeSession(session.sessionId);
    /*
     * Unchanged, and this is the half of Q20 that still holds: the log kept the
     * env *names* and never the values, so there is nothing to rebuild from.
     * The workspace declares no `typed`, so nothing here pretends otherwise.
     */
    expect(back.mcp ?? []).toEqual([]);
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
