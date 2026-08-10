/**
 * Two holes found auditing this session's work against §13.
 *
 * Both were mine, both were in code I had written days earlier, and both are the
 * same shape: a rule §13 states plainly, and an addition that quietly stepped
 * outside it. They are kept in their own file because each is a property of the
 * *section* rather than of the module that broke it — the next tool and the next
 * spawn path have to satisfy them too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultLocalPolicy, evaluatePolicy } from '@main/policy/evaluate.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import type {
  InstanceId,
  PolicyRule,
  Session,
  Sha256,
  ToolPolicy,
} from '@shared/types/index.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { createApi } from '@main/ipc/api.js';
import { Fleet } from '@main/fleet.js';
import { CH } from '@shared/ipc/contract.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';

const ROOT = '/tmp/ws';

const decide = (policy: ToolPolicy, tool: string, args: Record<string, unknown>): string =>
  evaluatePolicy(policy, tool, args, { workspaceRoot: ROOT }).outcome;

describe('a screenshot is egress, and one grant must not open all of them', () => {
  /**
   * §13: "The last two rows must be explicit rules, not left to the catch-all …
   * because `Allow for this session` on one `bash` call grants the *tool*, and
   * if `git push` and egress were reachable only through `defaultAction`, that
   * single grant would silently take both from `ask` to allowed."
   *
   * `screenshot` fetches a URL and puts the rendering into a model's context, so
   * it is egress by that definition — I said so in its own commit message and
   * then left it to the catch-all anyway.
   */
  it('asks by an explicit rule rather than by default', () => {
    const policy = defaultLocalPolicy();
    expect(decide(policy, 'screenshot', { url: 'http://localhost:5173' })).toBe('ask');
    // The distinction that matters: an actual rule, not the fallback.
    expect(policy.rules.some((r) => r.tool === 'screenshot' && r.action === 'ask')).toBe(true);
  });

  it('keeps asking after a session grant on the tool', () => {
    // What "Allow for this session" records: the whole tool, unscoped.
    const granted: ToolPolicy = {
      ...defaultLocalPolicy(),
      rules: [
        ...defaultLocalPolicy().rules,
        { tool: 'screenshot', action: 'allow' } satisfies PolicyRule,
      ],
    };

    // Resolution scans deny → ask → allow, so the explicit ask survives. Without
    // it, approving one screenshot of your own dev server would silently permit
    // a screenshot of an internal dashboard for the rest of the session.
    expect(decide(granted, 'screenshot', { url: 'http://internal-admin/' })).toBe('ask');
  });

  it('cannot be pattern-allowed out of asking either', () => {
    /**
     * I first wrote this expecting the opposite — that pinning
     * `screenshot(http://localhost:*)` would let a dev server through while
     * everything else still asked. §13 says otherwise, in as many words:
     * resolution scans deny → ask → allow "so an `ask` rule cannot be defeated
     * by an `allow` rule added later, **whatever its scope**".
     *
     * Which is right. Egress asks every time; a pattern that could switch it off
     * would be a standing grant on a moving target, since what a URL resolves to
     * is not fixed by the string.
     */
    const pinned: ToolPolicy = {
      ...defaultLocalPolicy(),
      rules: [
        { tool: 'screenshot', match: 'http://localhost:*', action: 'allow' },
        ...defaultLocalPolicy().rules,
      ],
    };
    expect(decide(pinned, 'screenshot', { url: 'http://localhost:5173/x' })).toBe('ask');
  });

  it('can be denied precisely, which is what the designated argument buys', () => {
    // A `deny` outranks the `ask`, so this is the direction that *is*
    // expressible — and it is exact because `screenshot` names `url`. Absent
    // from that table §13 would let the rule match any string argument, which
    // tightens the gate but blurs what it caught.
    const pinned: ToolPolicy = {
      ...defaultLocalPolicy(),
      rules: [
        { tool: 'screenshot', match: '*internal-admin*', action: 'deny' },
        ...defaultLocalPolicy().rules,
      ],
    };
    expect(decide(pinned, 'screenshot', { url: 'http://internal-admin/' })).toBe('deny');
    expect(decide(pinned, 'screenshot', { url: 'http://localhost:5173/' })).toBe('ask');
  });

  it('reads the url and not whichever string the model put first', () => {
    // §13: "the model never chooses which argument is inspected." JSON insertion
    // order is the model's to control.
    const pinned: ToolPolicy = {
      defaultAction: 'ask',
      rules: [{ tool: 'screenshot', match: '*internal-admin*', action: 'deny' }],
    };
    // The deny fires on the real `url`, and a decoy string in another field
    // neither triggers it nor deflects it.
    expect(
      decide(pinned, 'screenshot', { note: 'harmless', url: 'http://internal-admin/' }),
    ).toBe('deny');
    expect(
      decide(pinned, 'screenshot', { note: 'http://internal-admin/', url: 'http://localhost:1' }),
    ).toBe('ask');
  });
});

describe('splitting is not a way to get permissions back', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-audit-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function manager(): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      requiresModel: false,
    });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  const policyOf = (m: SessionManager, id: string): ToolPolicy =>
    (m as unknown as { sessions: Map<string, { policy: ToolPolicy }> }).sessions.get(id)!.policy;

  const split = {
    title: 'child',
    scope: 'do the narrow thing',
    outOfScope: ['everything else'],
    contract: { summaryMaxTokens: 500, artifacts: [] },
    tokenCeiling: 10_000,
  };

  it('gives a child the parent policy, not the default', async () => {
    /**
     * §13: "A child **never inherits more permission than its parent held** …
     * so 'decompose the work' can never be a route to escalating privilege."
     *
     * `spawnChild` passed no policy, so the child took
     * `defaultPolicyForTarget` — and a parent that had been narrowed produced a
     * child with the restriction gone.
     */
    const m = manager();
    const parent = await m.createSession({
      title: 'p',
      goal: 'g',
      budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
      policy: { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
    });

    const child = await m.spawnChild(parent.sessionId, split);

    expect(decide(policyOf(m, child.sessionId), 'bash', { command: 'ls' })).toBe('deny');
  });

  it('copies rather than shares, so a child cannot widen its parent', async () => {
    // The reason `addAgent` copies too: a grant made below would otherwise
    // reach back up and take every sibling with it.
    const m = manager();
    const parent = await m.createSession({
      title: 'p',
      goal: 'g',
      budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
      policy: { defaultAction: 'ask', rules: [{ tool: 'bash', action: 'deny' }] },
    });
    const child = await m.spawnChild(parent.sessionId, split);

    policyOf(m, child.sessionId).rules.push({ tool: 'bash', action: 'allow' });

    expect(decide(policyOf(m, parent.sessionId), 'bash', { command: 'ls' })).toBe('deny');
  });

  it('leaves an unrestricted parent unrestricted', async () => {
    // Inheriting must not be a narrowing either: a child of an ordinary session
    // gets the ordinary defaults.
    const m = manager();
    const parent = await m.createSession({
      title: 'p',
      goal: 'g',
      budget: { tokenCeiling: 100_000, spent: 0, reservedForChildren: 0 },
    });
    const child = await m.spawnChild(parent.sessionId, split);

    const inherited = policyOf(m, child.sessionId);
    expect(decide(inherited, 'read', { file_path: join(ROOT, 'a.ts') })).toBe(
      decide(defaultLocalPolicy(), 'read', { file_path: join(ROOT, 'a.ts') }),
    );
    void ({} as Session);
  });
});

describe('a read-only client is read-only, including where the name lies', () => {
  /**
   * §6.4: "a read-only client that can still send is not read-only", and
   * enforcement lives with the owner because a client cannot police itself.
   *
   * `blob.has` reads as a question and is not one. On a miss it copies the blob
   * from a sibling session on this host into the target session's attachments —
   * §6.7's "transfers once" — so answering it writes files. Found by auditing
   * §13 against this session's code rather than by anything failing, which is
   * how both of the holes above turned up too.
   */
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-ro-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function rig(): { connect: (role?: 'read-write' | 'read-only') => HostConnection } {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      requiresModel: false,
    });
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    managers.push(manager);
    const server = new SessionHostServer({
      manager,
      identity: { instanceId, lineageId: 'lin' as never, workspaceRoot: root, runtimes: ['echo'] },
    });
    return {
      connect: (role) => {
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main, ...(role !== undefined ? { role } : {}) });
      },
    };
  }

  it('will not let a read-only client make the host copy a blob', async () => {
    const r = rig();
    const writer = r.connect();
    const session = await writer.createSession({ title: 's', goal: 'g' });

    const reader = r.connect('read-only');
    await reader.ready;

    await expect(
      reader.hasBlob(session.sessionId, 'a'.repeat(64) as Sha256, 'image/png'),
    ).rejects.toThrow(/read-only|transfer a blob/i);
  });

  it('still lets a read-write client ask', async () => {
    // The guard must not turn §6.7's dedup into a permission error for the
    // clients that are meant to use it.
    const r = rig();
    const writer = r.connect();
    const session = await writer.createSession({ title: 's', goal: 'g' });

    await expect(
      writer.hasBlob(session.sessionId, 'b'.repeat(64) as Sha256, 'image/png'),
    ).resolves.toBe(false);
  });
});

describe('refused at the handshake means disconnected', () => {
  it('does not leave a client this host declined able to read', async () => {
    /**
     * The refusal used to be a message. The channel stayed open with the
     * default `read-only` role, and dispatch went on serving `session.list` and
     * `session.events` — so a client the host had just declined to serve could
     * read every transcript on it. §6.4 says a mismatch is "refused at
     * handshake"; a sentence is not a refusal.
     */
    const root = await mkdtemp(join(tmpdir(), 'agbrte-refuse-'));
    try {
      const identity = await openWorkspace(root);
      const registry = new RuntimeRegistry();
      registry.register(
        new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }),
        { label: 'Echo', requiresModel: false },
      );
      const manager = new SessionManager({
        registry,
        workspaceRoot: root,
        instanceId: identity.instanceId,
      });
      const server = new SessionHostServer({
        manager,
        identity: {
          instanceId: identity.instanceId,
          lineageId: identity.lineageId,
          workspaceRoot: root,
          runtimes: ['echo'],
        },
      });

      const pair = memoryChannelPair<SessionCommand, SessionMessage>();
      server.accept(pair.host);

      let closed = false;
      pair.main.onClose(() => (closed = true));
      pair.main.post({ t: 'hello', id: 'h1', role: 'read-write', client: 'ancient', protocol: 0 });

      const deadline = Date.now() + 2_000;
      while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(closed).toBe(true);

      manager.dispose();
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});

describe('a browser must not be handed this machine', () => {
  /**
   * The web server is reached over a network by whoever can address it — §13
   * says so in the banner it prints: "Anyone who can reach this can drive this
   * session. There is no login."
   *
   * So the capture and voice capabilities are excluded from it *by type*, and
   * stripped again at construction. The failure they prevent is not subtle: a
   * browser on the tailnet capturing the **server's** desktop, or recording
   * somebody's dictation onto the server's disk.
   *
   * The comment on that type used to read "the two Electron-only capabilities"
   * when there were five, which is how this kind of exclusion rots.
   */
  it('refuses to capture where there is nobody sitting', async () => {
    const api = createApi({
      fleet: new Fleet({ runtimes: [], connect: () => Promise.reject(new Error('none')) }),
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
      // Exactly what the web server constructs: no screen, no overlay, no clips.
    });

    await expect(
      api.handlers.get(CH.capturePreview)!({ sourceId: 'screen:0' }),
    ).rejects.toThrow(/cannot capture a screen/i);
    await expect(api.handlers.get(CH.captureRegion)!('s')).rejects.toThrow(/cannot draw a region/i);
    await expect(
      api.handlers.get(CH.voiceTranscribe)!({ wavBase64: '', sessionId: 's' }),
    ).rejects.toThrow(/cannot record/i);

    api.dispose();
  });

  it('lists nothing rather than throwing, so a picker can still render', async () => {
    // Asymmetric on purpose, and the same choice `capture/client.ts` makes:
    // asking what is capturable is a question a UI asks on open; capturing is
    // something a person did and deserves a sentence.
    const api = createApi({
      fleet: new Fleet({ runtimes: [], connect: () => Promise.reject(new Error('none')) }),
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
    });

    await expect(api.handlers.get(CH.captureSources)!()).resolves.toEqual([]);
    await expect(api.handlers.get(CH.voiceClips)!()).resolves.toEqual([]);
    api.dispose();
  });
});
