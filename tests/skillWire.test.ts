/**
 * What `skill.list` puts on the wire, and what it deliberately does not
 * (DESIGN.md §17 Q21, §17 Q12, §5.4b, §6.4).
 *
 * The same three claims `workflowWire` pins, because this is the same shape and
 * the shape is the thing that keeps being got wrong.
 *
 * **The absolute path does not travel.** The host reads
 * `<workspace>/.agbrte/templates/x.skill.md` and knows where that is; a client
 * may be a phone on a tailnet, where that string names nothing.
 *
 * **A host too old to answer is not a workspace with no skills.** `supports()`
 * says which, and the fleet returns `null` rather than `[]` so the difference
 * survives to the screen (§3.3). Rendering the second as the first tells
 * somebody they have none when the truth is that nothing could say.
 *
 * And one that is this file's own: **the wire carries the whole body.** A
 * summary carrying only ids would make the client fetch each one to create a
 * session with it, and a two-call create is a create that can half happen.
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
import { SKILL_SUFFIX } from '@main/store/skills.js';

const DOC = `---
description: How commit messages are written in this repository
---

They say why, and they record what broke.
`;

let root = '';
let instanceId: InstanceId;
let lineageId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-skillwire-'));
  const identity = await openWorkspace(root);
  instanceId = identity.instanceId;
  lineageId = identity.lineageId;
  await mkdir(join(root, '.agbrte', 'templates'), { recursive: true });
  await writeFile(join(root, '.agbrte', 'templates', `commits${SKILL_SUFFIX}`), DOC, 'utf8');
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

describe('skill.list over the session protocol', () => {
  it('answers with the documents, checked and ready to create with', async () => {
    const found = await (await connect()).skills();
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe('commits');
    expect(found[0]?.problems).toEqual([]);
    /*
     * The whole body, not a pointer to it.
     *
     * `createSession` takes `SkillConfig`s, so a client that received only ids
     * would have to fetch each one before creating — and a create split across
     * two calls is a create that can half happen. It is also what makes the log
     * the record: what a session was given is what travelled, not what a file
     * said at the time and may not say tomorrow.
     */
    expect(found[0]?.skill).toEqual({
      id: 'commits',
      description: 'How commit messages are written in this repository',
      instructions: 'They say why, and they record what broke.\n',
    });
  });

  it('keeps the host absolute path off the wire', async () => {
    const found = await (await connect()).skills();
    // Asserted on the serialised frame rather than on a field, because the claim
    // is that the path is *absent* — checking `summary.path` would pass against
    // a shape that carries it under any other name.
    const wire = JSON.stringify(found);
    expect(wire).not.toContain(root);
    expect(wire).not.toContain('templates');
    expect(Object.keys(found[0] ?? {}).sort()).toEqual(['id', 'problems', 'skill']);
  });

  it('carries an unusable document as a row with its reason', async () => {
    await writeFile(join(root, '.agbrte', 'templates', `bare${SKILL_SUFFIX}`), 'no header\n', 'utf8');
    const found = await (await connect()).skills();
    // Both come back. The reason to look at the list is often that one of them
    // is wrong, so a bad file must not take the good one with it.
    expect(found.map((f) => f.id).sort()).toEqual(['bare', 'commits']);
    const bad = found.find((f) => f.id === 'bare');
    expect(bad?.skill).toBeUndefined();
    expect(bad?.problems[0]).toContain('no frontmatter');
  });
});

describe('a host that predates the command', () => {
  /*
   * Pinned to what the *command* needs rather than to one below the current
   * protocol, for the reason `workflowWire` records: `SESSION_PROTOCOL_VERSION
   * - 1` means "a host one release behind" and stops describing this state at
   * the next bump. `COMMAND_SINCE` is the record of when a command appeared.
   */
  const tooOldFor = (command: string): number => (COMMAND_SINCE[command] ?? 1) - 1;

  it('refuses the read by name rather than answering an empty list', async () => {
    await expect((await connect(tooOldFor('skill.list'))).skills()).rejects.toThrow(/skill\.list/);
  });

  it('registers it in COMMAND_SINCE at the version that added it', () => {
    // `supports()` is derived from this table — an entry missing here makes the
    // refusal above silent, which is the failure the table exists to prevent.
    expect(COMMAND_SINCE['skill.list']).toBe(32);
    expect(SESSION_PROTOCOL_VERSION).toBeGreaterThanOrEqual(32);
  });
});

describe('what a session is given', () => {
  it('creates with the skill the workspace holds, and the session says so', async () => {
    const connection = await connect();
    const found = await connection.skills();
    const skill = found[0]?.skill;
    expect(skill).toBeDefined();

    /*
     * The end of the trip: a file in a tracked directory becomes a tool on a
     * session, without anybody retyping it.
     *
     * The session reports `{id, description}` and not the body — the body is in
     * the log, and §17 Q21's whole design is that the model pays for it only
     * when the work calls for it.
     */
    const session = await connection.createSession({
      title: 'a seat',
      goal: 'a seat',
      skills: [skill as never],
    });
    expect(session.skills).toEqual([
      { id: 'commits', description: 'How commit messages are written in this repository' },
    ]);
  });
});
