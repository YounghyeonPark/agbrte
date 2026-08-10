/**
 * A workspace that moved (DESIGN.md §5.2, §5.3, §15 Phase 2).
 *
 * > *Done when:* you move a workspace to a new drive with the app closed,
 * > reopen, and an agent resumes mid-task with context intact — **verified with
 * > the native resume token deliberately invalidated**, so the durable path is
 * > what is under test.
 *
 * The awkward part is that a move leaves no trace. Identity is never derived
 * from a path — that is exactly what makes relocation survivable — so
 * `project.json` and `instance.json` travel with the folder and every field
 * matches. A moved workspace is byte-identical to one that never moved. The only
 * way to notice is to have written down where it was, which is the whole of the
 * detection.
 *
 * These tests move real directories rather than simulating one. A rename is the
 * cheapest possible version of "you moved it to another drive", and it exercises
 * the thing that actually matters: the path changed underneath identity that did
 * not.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspace } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';

let dirs: string[] = [];

async function make(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-move-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  dirs = [];
});
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

describe('opening a workspace', () => {
  it('is `created` the first time and `existing` the second', async () => {
    const root = await make();
    expect((await openWorkspace(root)).origin).toBe('created');
    expect((await openWorkspace(root)).origin).toBe('existing');
  });

  it('notices when the folder has moved, and says where from', async () => {
    const first = await make();
    const before = await openWorkspace(first);

    // The app is closed and the folder is moved. Nothing inside it changes.
    const second = `${first}-moved`;
    dirs.push(second);
    await rename(first, second);

    const after = await openWorkspace(second);
    expect(after.origin).toBe('relocated');
    expect(after.movedFrom).toBe(first);
    // Identity survives the move — which is the point. A new id here would
    // orphan every session in the folder.
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.lineageId).toBe(before.lineageId);
  });

  it('reports a move once, not on every open afterwards', async () => {
    const first = await make();
    await openWorkspace(first);
    const second = `${first}-moved`;
    dirs.push(second);
    await rename(first, second);

    // Recording is what ends the report, and only an owner records — see
    // `OpenOptions.record`. A client inspecting the folder keeps seeing the move
    // precisely so it cannot swallow it before the host arrives.
    expect((await openWorkspace(second)).origin).toBe('relocated');
    expect((await openWorkspace(second)).origin).toBe('relocated');

    // The host records, and from then on it is simply where it lives.
    expect((await openWorkspace(second, { record: true })).origin).toBe('relocated');
    expect((await openWorkspace(second)).origin).toBe('existing');
  });

  it('does not call a separator change a move', async () => {
    const root = await make();
    await openWorkspace(root);
    // The same directory reached by a different spelling. Treating this as a
    // relocation would throw away every resume token for a slash.
    const reslashed = root.replace(/\\/g, '/');
    expect((await openWorkspace(reslashed)).origin).toBe('existing');
  });

  it('claims nothing about a workspace written before this was tracked', async () => {
    const root = await make();
    await openWorkspace(root);

    // An `instance.json` from an older build has no `lastKnownPath`.
    const file = workspaceLayout(root).instanceFile;
    const instance = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    delete instance['lastKnownPath'];
    await writeFile(file, JSON.stringify(instance), 'utf8');

    // Absent means "unknown", not "unmoved" and not "moved". Guessing either way
    // on the first open after an upgrade would be inventing history.
    expect((await openWorkspace(root)).origin).toBe('existing');
    expect((await openWorkspace(root)).origin).toBe('existing');
  });

  it('does not inherit a path through a clone', async () => {
    const source = await make();
    await openWorkspace(source);

    // A clone carries `project.json` — tracked — but not `instance.json`, which
    // is gitignored. So it gets its own instance and no previous path.
    const clone = await make();
    const layout = workspaceLayout(clone);
    await openWorkspace(clone);
    await writeFile(
      layout.projectFile,
      await readFile(workspaceLayout(source).projectFile, 'utf8'),
      'utf8',
    );
    await rm(layout.instanceFile, { force: true });

    const opened = await openWorkspace(clone);
    // Not `relocated`: nothing moved. Believing otherwise would make every
    // clone discard resume tokens it never had.
    expect(opened.origin).toBe('cloned');
    expect(opened.movedFrom).toBeUndefined();
  });
});

/**
 * The phase criterion itself: resume after a move.
 *
 * The native token is made *valid* on purpose. Testing with one that would have
 * failed anyway proves nothing — the criterion says "verified with the native
 * resume token deliberately invalidated", and the only way to show the durable
 * path carried it is to give the native path every chance and confirm it was not
 * taken.
 */
describe('resuming after a move', () => {
  it('discards a native token minted at the old path, and rehydrates instead', async () => {
    const { SessionManager } = await import('@main/sessionManager.js');
    const { RuntimeRegistry } = await import('@main/runtime/registry.js');
    const { EchoRuntime } = await import('@main/runtime/runtimes/echo.js');

    const first = await make();
    const before = await openWorkspace(first);

    // A runtime that *can* resume natively and would happily do so.
    const runtime = (): InstanceType<typeof EchoRuntime> =>
      new EchoRuntime({ capabilities: { nativeResume: true } });
    const build = (root: string, relocatedFrom?: string): InstanceType<typeof SessionManager> => {
      const registry = new RuntimeRegistry();
      registry.register(runtime(), { label: 'Echo', model: 'none' });
      return new SessionManager({
        registry,
        workspaceRoot: root,
        instanceId: before.instanceId,
        ...(relocatedFrom !== undefined ? { relocatedFrom } : {}),
      });
    };

    const one = build(first);
    const session = await one.createSession({ title: 's', goal: 'g' });
    const agent = await one.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await one.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'first' }] });

    // App closed. Folder moved. Nothing inside it touched.
    const second = `${first}-moved`;
    dirs.push(second);
    await rename(first, second);

    const identity = await openWorkspace(second);
    expect(identity.origin).toBe('relocated');

    const two = build(second, identity.movedFrom);
    await two.resumeSession(session.sessionId);
    await two.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'after' }] });

    const events = await two.events(session.sessionId);

    // The move is in the log, so the transcript explains a resume mode that
    // would otherwise change for no visible reason.
    expect(events.some((e) => e.type === 'workspace.relocated')).toBe(true);

    // And the durable path is what carried it. A native resume here would have
    // handed the agent state describing a directory the code is no longer in.
    const started = events.filter((e) => e.type === 'agent.started');
    expect(started.at(-1)).toMatchObject({ resumeMode: 'rehydrated' });
    expect(started.some((e) => e.type === 'agent.started' && e.resumeMode === 'native')).toBe(false);

    // Context intact: the first turn is still in the transcript after the move.
    const turns = events.filter((e) => e.type === 'user.turn');
    expect(turns).toHaveLength(2);
  });

  it('records the move once per session, not once per agent', async () => {
    const { SessionManager } = await import('@main/sessionManager.js');
    const { RuntimeRegistry } = await import('@main/runtime/registry.js');
    const { EchoRuntime } = await import('@main/runtime/runtimes/echo.js');

    const first = await make();
    const before = await openWorkspace(first);
    const build = (root: string, relocatedFrom?: string) => {
      const registry = new RuntimeRegistry();
      registry.register(new EchoRuntime({ capabilities: { nativeResume: true } }), {
        label: 'Echo',
        model: 'none',
      });
      return new SessionManager({
        registry,
        workspaceRoot: root,
        instanceId: before.instanceId,
        ...(relocatedFrom !== undefined ? { relocatedFrom } : {}),
      });
    };

    const one = build(first);
    const session = await one.createSession({ title: 's', goal: 'g' });
    const a = await one.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const b = await one.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await one.send(session.sessionId, a.agentId, { content: [{ type: 'text', text: 'x' }] });
    await one.send(session.sessionId, b.agentId, { content: [{ type: 'text', text: 'y' }] });

    const second = `${first}-moved`;
    dirs.push(second);
    await rename(first, second);
    const identity = await openWorkspace(second);

    const two = build(second, identity.movedFrom);
    await two.resumeSession(session.sessionId);
    await two.send(session.sessionId, a.agentId, { content: [{ type: 'text', text: 'x2' }] });
    await two.send(session.sessionId, b.agentId, { content: [{ type: 'text', text: 'y2' }] });

    const events = await two.events(session.sessionId);
    // The move is a fact about the workspace. Repeating it per agent would pad
    // the log with the same sentence.
    expect(events.filter((e) => e.type === 'workspace.relocated')).toHaveLength(1);
  });
});
