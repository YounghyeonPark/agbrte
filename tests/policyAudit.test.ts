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
import type { InstanceId, PolicyRule, Session, ToolPolicy } from '@shared/types/index.js';

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
