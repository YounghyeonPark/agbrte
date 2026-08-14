/**
 * Session templates, derived from sessions (DESIGN.md §17 Q12, §13).
 *
 * The recommendation these implement is "derive, never author": every field a
 * template needs is already in a `Session`, so the feature is "save this as a
 * template" rather than a format someone fills in ahead of time and drifts away
 * from.
 *
 * Two things are worth asserting hard. A template is **committed** — it lives
 * beside `memory/` on the tracked side of `.devagents/`'s own `.gitignore` — so
 * a credential reaching one would travel to everyone with the repo. And its
 * `id` becomes a **filename**, from a string a person typed.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteTemplate,
  fromSession,
  listTemplates,
  readTemplate,
  saveTemplate,
  templateId,
  TemplateRefused,
  templatesDir,
  TEMPLATE_SCHEMA_VERSION,
} from '@main/store/templates.js';
import { openWorkspace } from '@main/store/identity.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import type { LineageId, SessionId } from '@shared/types/index.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';

const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(async () => {
  for (const m of managers.splice(0)) m.dispose();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

/** A real session with a real roster, since a template is a projection of one. */
async function realSession(): Promise<{ root: string; manager: SessionManager; sessionId: SessionId }> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-template-'));
  roots.push(root);
  const identity = await openWorkspace(root);
  const registry = new RuntimeRegistry();
  registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
    label: 'Echo',
    model: 'none',
  });
  const manager = new SessionManager({ registry, workspaceRoot: root, instanceId: identity.instanceId });
  managers.push(manager);

  const session = await manager.createSession({ title: 'nightly review', goal: 'review the diff' });
  await manager.addAgent(session.sessionId, { role: 'reviewer', runtimeId: 'echo' });
  return { root, manager, sessionId: session.sessionId as SessionId };
}

describe('a template is a projection of a session', () => {
  it('carries the roster, the goal and the checklist text', async () => {
    const { manager, sessionId } = await realSession();
    const session = await manager.get(sessionId);

    const template = fromSession(session, 'Nightly review');
    expect(template.name).toBe('Nightly review');
    expect(template.id).toBe('nightly-review');
    expect(template.goal).toBe('review the diff');
    expect(template.roles).toHaveLength(1);
    expect(template.roles[0]?.role).toBe('reviewer');
    expect(template.roles[0]?.runtimeId).toBe('echo');
    expect(template.fromSessionId).toBe(sessionId);
  }, 30_000);

  it('drops everything that described that particular run', async () => {
    /**
     * The fields that make a template a lie on any other machine or day: ids,
     * state, usage, resume tokens, artifacts, and `resolvedCapabilities` — a
     * snapshot of the host it ran on.
     */
    const { manager, sessionId } = await realSession();
    const template = fromSession(await manager.get(sessionId), 'Nightly review');
    const text = JSON.stringify(template);

    for (const leaked of ['agentId', 'resolvedCapabilities', 'resumeToken', 'usage', 'lastEventSeq', 'instanceId']) {
      expect(text, `${leaked} survived into the template`).not.toContain(leaked);
    }
    // `fromSessionId` is deliberate and is the only id kept: "where did this come
    // from" is the question a template most often provokes.
    expect(template.fromSessionId).toBe(sessionId);
  }, 30_000);

  it('never captures a grant, because a template is a committed file', async () => {
    /**
     * §17 Q19's whole design is *per session, never a setting*. A standing
     * grant that survived into a template would be exactly the preference
     * somebody turned on months ago and forgot — travelling to colleagues by
     * `git clone`, which is worse. Same for a split grant (§17 Q8).
     */
    const { manager } = await realSession();
    const granted = await manager.createSession(
      {
        title: 'overnight',
        goal: 'g',
        standingGrant: true,
        splitGrant: { count: 2, maxDepth: 2 },
      },
      { id: 'uid:1000', via: 'peer-credential', label: 'Alice' },
    );
    await manager.addAgent(granted.sessionId, { role: 'worker', runtimeId: 'echo' });

    const text = JSON.stringify(fromSession(await manager.get(granted.sessionId), 'Overnight'));
    for (const leaked of ['standingGrant', 'splitGrant', 'grantedBy', 'grantedAt']) {
      expect(text, `${leaked} survived into the template`).not.toContain(leaked);
    }
  }, 30_000);

  it('starts a checklist unfinished', async () => {
    const { manager, sessionId } = await realSession();
    const session = await manager.get(sessionId);
    const withList = {
      ...session,
      checklist: [
        { id: 'a', text: 'run the tests', state: 'done' as const },
        { id: 'b', text: 'write the note', state: 'todo' as const },
      ],
    };

    const template = fromSession(withList, 'Nightly review');
    // Text only: a template of a finished checklist is a checklist that starts
    // finished, which is worse than no checklist.
    expect(template.checklist).toEqual(['run the tests', 'write the note']);
    expect(JSON.stringify(template)).not.toContain('done');
  }, 30_000);

  it('refuses a session with no roster', async () => {
    // A roster is the substance. Without one this is a title and a checklist, and
    // saving it teaches the user the feature does nothing.
    const root = await mkdtemp(join(tmpdir(), 'agbrte-template-'));
    roots.push(root);
    const identity = await openWorkspace(root);
    const manager = new SessionManager({
      registry: new RuntimeRegistry(),
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    managers.push(manager);
    const empty = await manager.createSession({ title: 't', goal: 'g' });

    expect(() => fromSession(await0(empty), 'Empty')).toThrow(TemplateRefused);
  }, 30_000);

  /**
   * This test used to hand `fromSession` a session with `target: {kind:'ssh'}`
   * and check it came back out. It passed for as long as it existed, while the
   * feature did not work at all.
   *
   * No session can be in that state. `session.create` carries a title and a goal
   * and nothing else, and `spawnChild` refuses a target differing from its
   * parent's, so every session on every host records `{kind:'local'}` and always
   * has. The projection read `session.target` and skipped `local`, so the branch
   * under test was unreachable in production and no template could ever carry a
   * target — while the field's own documentation promised a refusal on apply
   * that therefore could never fire. The spread in the old test is what supplied
   * the state reality does not.
   *
   * The lesson is narrow and worth keeping: **a fixture that constructs an
   * impossible input tests the function, not the feature.** Rewritten around
   * where the value actually comes from — the client, the only side that knows
   * how it reaches a host.
   */
  it('records the target it was told, and stays quiet about a local one', async () => {
    const { manager, sessionId } = await realSession();
    const session = await manager.get(sessionId);

    // No origin at all: a v5 client, or a caller with nothing to say.
    expect(fromSession(session, 'No origin').target).toBeUndefined();

    // Local is the default everywhere and says nothing; recording it would make
    // every template claim a locality it does not care about.
    expect(fromSession(session, 'Local', { target: { kind: 'local' } }).target).toBeUndefined();

    const remote = fromSession(session, 'On the box', {
      target: { kind: 'ssh', alias: 'build-01', host: 'build-01' },
    });
    expect(remote.target).toEqual({ kind: 'ssh', alias: 'build-01', host: 'build-01' });

    // And the session's own target is not consulted, which is the fix itself:
    // reading it made the condition one that could never be false.
    expect(session.target).toEqual({ kind: 'local' });
  }, 30_000);
});

describe('a template is committed, so it must carry no secret', () => {
  it('keeps only an endpoint or CLI id from the auth mode', async () => {
    /**
     * §13's rule is that credentials never reach a file that travels. This file
     * is *designed* to travel — it sits beside `memory/` on the tracked side of
     * `.devagents/`'s `.gitignore`, so anyone who clones the repo gets it.
     *
     * `AuthMode` is `{api-key, endpointId}` / `{vendor-cli-session, cliId,
     * quotaGroup}` / `{none}`, which is why this is safe at all. Asserted rather
     * than assumed, because a future field on that type would arrive here for
     * free.
     */
    const { manager, sessionId } = await realSession();
    const session = await manager.get(sessionId);
    const withKey = {
      ...session,
      agents: session.agents.map((a) => ({
        ...a,
        spec: { ...a.spec, auth: { kind: 'api-key' as const, endpointId: 'openrouter-main' } },
      })),
    };

    const template = fromSession(withKey, 'Keyed');
    const text = JSON.stringify(template);
    expect(text).toContain('openrouter-main');
    for (const shape of ['sk-', 'Bearer', 'apiKey', 'token', 'secret', 'password']) {
      expect(text.toLowerCase(), `${shape} reached a committed file`).not.toContain(
        shape.toLowerCase(),
      );
    }
  }, 30_000);

  it('lives beside memory, on the side of .devagents that is tracked', async () => {
    const { root, manager, sessionId } = await realSession();
    await saveTemplate(root, fromSession(await manager.get(sessionId), 'Nightly review'));

    const ignore = await readFile(join(root, '.devagents', '.gitignore'), 'utf8');
    // `sessions/`, `index/`, `run/` and `instance.json` are excluded; templates
    // are not, which is the whole point — a colleague gets them by cloning.
    expect(ignore).not.toContain('templates');
    expect(templatesDir(root)).toBe(join(root, '.devagents', 'templates'));
  }, 30_000);
});

describe('the name becomes a filename', () => {
  it('is built from an allow-list, not by removing the bad parts', () => {
    /**
     * This string reaches `join()`. A deny-list is a promise to have thought of
     * every escape; an allow-list is a promise about what is kept.
     */
    expect(templateId('Nightly Review')).toBe('nightly-review');
    expect(templateId('../../etc/passwd')).toBe('etc-passwd');
    expect(templateId('C:\\Windows\\System32')).toBe('c-windows-system32');
    expect(templateId('review\u0000.json')).toBe('review-json');
    expect(templateId('--rf')).toBe('rf');
    expect(templateId('  spaced  out  ')).toBe('spaced-out');
    expect(templateId('a'.repeat(200))).toHaveLength(60);
  });

  it('refuses a name with nothing to keep', () => {
    for (const name of ['..', '///', '   ', '\u0000']) {
      expect(() => templateId(name), name).toThrow(TemplateRefused);
    }
  });

  it('re-slugs an id that arrived from somewhere else', async () => {
    // An id over IPC is an id somebody else chose, so it goes through the same
    // allow-list rather than being trusted for having been ours once.
    const { root, manager, sessionId } = await realSession();
    await saveTemplate(root, fromSession(await manager.get(sessionId), 'Nightly review'));

    expect(await readTemplate(root, 'nightly-review')).not.toBeNull();
    expect(await readTemplate(root, '../../nightly-review')).not.toBeNull(); // slugged, not escaped
    await expect(readTemplate(root, '../../../etc/passwd')).resolves.toBeNull();
  }, 30_000);
});

describe('the list survives a bad file', () => {
  it('skips one that will not parse and keeps the rest', async () => {
    // These are committed and hand-editable by design, so one bad merge must not
    // take the list down.
    const { root, manager, sessionId } = await realSession();
    await saveTemplate(root, fromSession(await manager.get(sessionId), 'Good one'));
    await mkdir(templatesDir(root), { recursive: true });
    await writeFile(join(templatesDir(root), 'broken.json'), '{ not json', 'utf8');
    await writeFile(join(templatesDir(root), 'notes.txt'), 'ignore me', 'utf8');

    const found = await listTemplates(root);
    expect(found.map((t) => t.id)).toEqual(['good-one']);
  }, 30_000);

  it('skips one written by a newer Agbrte rather than guessing', async () => {
    // A roster is instructions for spending money on somebody's behalf, and a
    // shape we do not know is the wrong thing to be forgiving about.
    const { root, manager, sessionId } = await realSession();
    const template = fromSession(await manager.get(sessionId), 'Future');
    await saveTemplate(root, { ...template, schemaVersion: TEMPLATE_SCHEMA_VERSION + 1 });

    expect(await listTemplates(root)).toEqual([]);
    expect(await readTemplate(root, 'future')).toBeNull();
  }, 30_000);

  it('answers empty for a workspace nobody has saved one in', async () => {
    const { root } = await realSession();
    expect(await listTemplates(root)).toEqual([]);
    expect(await deleteTemplate(root, 'nothing-here')).toBe(false);
  }, 30_000);
});


describe('through the real protocol, host to client', () => {
  it('saves from one session and starts another from it', async () => {
    /**
     * The round trip that matters: a client asks the *host* to save, because the
     * template lives in the host's workspace — and asks the host to apply,
     * because the roster that runs must be the one in the file the host read. A
     * client assembling it from a template it fetched would be a client that can
     * quietly assemble a different one.
     */
    const { root, manager, sessionId } = await realSession();

    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: (await manager.get(sessionId)).instanceId,
        lineageId: 'lin' as LineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
      lingerMs: 0,
    });
    server.accept(host);

    const client = new HostConnection({ channel: main, client: 'test' });
    await client.ready;
    expect(client.supports('template.save')).toBe(true);

    const saved = await client.saveTemplate(sessionId, 'Nightly review');
    expect(saved.id).toBe('nightly-review');
    expect((await client.templates()).map((t) => t.id)).toEqual(['nightly-review']);

    const started = await client.applyTemplate('nightly-review', 'Tuesday');
    expect(started.title).toBe('Tuesday');
    expect(started.goal).toBe('review the diff');
    expect(started.agents.map((a) => a.role)).toEqual(['reviewer']);
    expect(started.sessionId).not.toBe(sessionId);

    expect(await client.deleteTemplate('nightly-review')).toBe(true);
    expect(await client.templates()).toEqual([]);

    client.disconnect();
    server.stop('done');
  }, 60_000);

  it('refuses a read-only client, because a template is a file in the repo', async () => {
    // Saving writes something colleagues will pull; applying spends money on
    // somebody's behalf. Both are writes, and §7's phone is not one.
    const { root, manager, sessionId } = await realSession();

    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: (await manager.get(sessionId)).instanceId,
        lineageId: 'lin' as LineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
      grantRole: () => ({ role: 'read-only', actor: { id: 'phone', via: 'asserted' } }),
      lingerMs: 0,
    });
    server.accept(host);

    const client = new HostConnection({ channel: main, client: 'agbrte-app@phone-1' });
    await client.ready;

    await expect(client.saveTemplate(sessionId, 'Nope')).rejects.toThrow(
      /read-only|save a session template/i,
    );
    await expect(client.applyTemplate('anything')).rejects.toThrow(
      /read-only|start a session from a template/i,
    );
    // Reading the list stays allowed: it is a read, like the transcript.
    await expect(client.templates()).resolves.toEqual([]);
    expect(await listTemplates(root)).toEqual([]);

    client.disconnect();
    server.stop('done');
  }, 60_000);

  it('says which template is missing rather than making an empty session', async () => {
    const { root, manager, sessionId } = await realSession();
    const { main, host } = memoryChannelPair<SessionCommand, SessionMessage>();
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: (await manager.get(sessionId)).instanceId,
        lineageId: 'lin' as LineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
      lingerMs: 0,
    });
    server.accept(host);
    const client = new HostConnection({ channel: main, client: 'test' });
    await client.ready;

    const before = (await client.list()).length;
    await expect(client.applyTemplate('not-a-template')).rejects.toThrow(/no template/);
    // And nothing was created on the way to failing.
    expect((await client.list()).length).toBe(before);

    client.disconnect();
    server.stop('done');
  }, 60_000);
});

/** Narrowing helper: `createSession` returns the record already. */
function await0<T>(value: T): T {
  return value;
}
