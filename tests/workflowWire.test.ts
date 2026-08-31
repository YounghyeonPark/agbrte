/**
 * What `workflow.list` puts on the wire, and what it deliberately does not
 * (DESIGN.md §4.4, §5.4b, §6.4).
 *
 * Two claims made in comments elsewhere, pinned here because both are the kind
 * that stay true by accident until somebody adds a field.
 *
 * **The absolute path does not travel.** The host reads
 * `<workspace>/.agbrte/templates/x.workflow.json` and knows where that is; a
 * client may be a phone on a tailnet, where that string names nothing. §5.4b
 * spends a whole codec on stopping a path travelling by accident, and the
 * boundary is the honest place to drop this one.
 *
 * **A host too old to answer is not a workspace with no workflows.** `supports()`
 * says which, and the fleet returns `null` rather than `[]` so the difference
 * survives to the screen — the same distinction §3.3 spends four capability
 * states on. Rendering the second as the first tells somebody they have none
 * when the truth is that nothing could say.
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
import { WORKFLOW_SUFFIX } from '@main/store/workflows.js';

const DOC = {
  id: 'review',
  name: 'review and fix',
  goal: 'find what is broken on this branch',
  nodes: [
    {
      id: 'scan',
      title: 'scan',
      scope: 'list every changed file',
      outOfScope: ['do not edit anything'],
      acceptance: ['every file named'],
      contract: { summaryMaxTokens: 800, artifacts: [] },
      tokenCeiling: 10_000,
    },
  ],
};

let root = '';
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-wfwire-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  await writeFile(
    join(root, '.agbrte', 'templates', `review${WORKFLOW_SUFFIX}`),
    JSON.stringify(DOC),
    'utf8',
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function connect(protocol?: number): Promise<HostConnection> {
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [] }), { label: 'Echo', model: 'none' });
  const server = new SessionHostServer({
    manager: new SessionManager({ registry, workspaceRoot: root, instanceId }),
    identity: { instanceId, lineageId: lineageId as never, workspaceRoot: root, runtimes: ['echo'] },
  });
  const pair = memoryChannelPair<SessionCommand, SessionMessage>();
  server.accept(pair.host);
  const connection = new HostConnection({ channel: pair.main });
  // The identity a client reads comes from `welcome`, so a command asked before
  // the handshake sees protocol 1 and is refused for the wrong reason.
  await connection.ready;
  if (protocol !== undefined) {
    // Pretend the far side is older than the command, which is the state a
    // client meets against a host nobody has restarted since the release.
    (connection as unknown as { identity?: { protocol: number } }).identity = { protocol };
  }
  return connection;
}

describe('workflow.list over the session protocol', () => {
  it('answers with the documents, parsed and validated', async () => {
    const found = await (await connect()).workflows();
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('review');
    expect(found[0]?.workflow?.name).toBe('review and fix');
    expect(found[0]?.problems).toEqual([]);
  });

  it('keeps the host absolute path off the wire', async () => {
    const found = await (await connect()).workflows();
    // Asserted on the serialised frame rather than on the field, because the
    // claim is that the path is *absent* — checking `summary.path` would pass
    // against a shape that carries it under any other name.
    const wire = JSON.stringify(found);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain('templates');
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(['id', 'problems', 'workflow']);
  });

  it('carries a broken document as a row with its reason', async () => {
    await writeFile(
      join(root, '.agbrte', 'templates', `broken${WORKFLOW_SUFFIX}`),
      '{ not json',
      'utf8',
    );
    const found = await (await connect()).workflows();
    // Both come back. The reason to look at a list of workflows is often that
    // one of them is wrong, so a bad file must not take the good one with it.
    expect(found.map((f) => f.id).sort()).toEqual(['broken', 'review']);
    expect(found.find((f) => f.id === 'broken')?.problems[0]?.message).toContain('not valid JSON');
  });
});

describe('a host that predates the command', () => {
  /*
   * Pinned to what the *command* needs, not to one below the current protocol.
   *
   * The first version of this said `SESSION_PROTOCOL_VERSION - 1`, which meant
   * "a host one release behind" and was true only until the next bump — adding
   * `workflow.save` at v26 made v25 a host that *does* have `workflow.list`, and
   * the test failed for a reason that had nothing to do with what it asserts.
   * `COMMAND_SINCE` is the record of when a command appeared, so a host older
   * than *that* is the state being described.
   */
  const tooOldFor = (command: string): number => (COMMAND_SINCE[command] ?? 1) - 1;

  it('refuses a read by name rather than answering an empty list', async () => {
    await expect((await connect(tooOldFor('workflow.list'))).workflows()).rejects.toThrow(
      /workflow\.list/,
    );
  });

  it('refuses a write by name too', async () => {
    // A write has more to lose from a silent no-op than a read: somebody who
    // saved and was told nothing believes their edit is on disk.
    await expect(
      (await connect(tooOldFor('workflow.save'))).saveWorkflow('review', DOC as never),
    ).rejects.toThrow(/workflow\.save/);
  });

  it('registers both in COMMAND_SINCE at the versions that added them', () => {
    // `supports()` is derived from this table — an entry missing here makes the
    // refusals above silent, which is the failure the table exists to prevent.
    expect(COMMAND_SINCE['workflow.list']).toBe(25);
    expect(COMMAND_SINCE['workflow.save']).toBe(26);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(26);
  });
});

describe('writing over the wire', () => {
  it('saves, and a listing then finds it', async () => {
    const connection = await connect();
    const edited = { ...DOC, goal: 'find what is broken and fix what is safe' };
    expect((await connection.saveWorkflow('review', edited as never)).problems).toEqual([]);
    const found = await connection.workflows();
    expect(found[0]?.workflow?.goal).toBe('find what is broken and fix what is safe');
  });

  it('refuses a document the reader would refuse, and changes nothing', async () => {
    const connection = await connect();
    const bad = { ...DOC, nodes: [{ ...DOC.nodes[0], outOfScope: [] }] };
    const said = await connection.saveWorkflow('review', bad as never);
    expect(said.problems[0]?.message).toContain('outOfScope is required');
    // The file on disk is untouched: a document that will be refused on read is
    // not a saved workflow, it is a trap set for later.
    expect((await connection.workflows())[0]?.workflow?.goal).toBe(DOC.goal);
  });
});
