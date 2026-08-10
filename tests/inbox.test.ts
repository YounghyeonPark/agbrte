/**
 * The durable record (DESIGN.md §11, §15 Phase 4).
 *
 * > the **in-app inbox is the durable record** regardless.
 *
 * "Regardless" is doing the work in that sentence. The notifier is lossy on
 * purpose in three ways — silent while a window has focus, absent in a browser,
 * and unable to say anything at all while the app is closed and a detached host
 * works through the night. An inbox recording what was *delivered* would inherit
 * every one of those holes, so this records what *happened*, folded from the log
 * that was being written anyway.
 *
 * Which means the interesting tests are the ones about restarts and about what
 * is deliberately left out.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { entriesFrom, merge, ReadMarker } from '@main/inbox.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime, type EchoStep } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { workspaceLayout } from '@main/store/layout.js';
import type { AgbrteEvent, InstanceId, Session } from '@shared/types/index.js';

const SESSION = {
  sessionId: 's1',
  title: 'fix the parser',
  instanceId: 'i1',
} as unknown as Pick<Session, 'sessionId' | 'title' | 'instanceId'>;

function stateEvent(to: string, at: string, reason?: string): AgbrteEvent {
  return {
    type: 'session.state',
    from: 'working',
    to,
    at,
    ...(reason !== undefined ? { reason } : {}),
  } as unknown as AgbrteEvent;
}

describe('what earns a line', () => {
  it('records a session finishing', () => {
    const entries = entriesFrom(SESSION, [stateEvent('done', '2026-01-01T00:00:00Z')], 0);
    expect(entries).toMatchObject([{ trigger: 'result_produced', sessionTitle: 'fix the parser' }]);
  });

  it('records a window reopening, which nothing else would tell you', () => {
    // §11 singles this out: "parked work resuming hours later is exactly the
    // event you'd otherwise miss entirely." Nothing prompts you at 4 a.m.
    const unparked = {
      type: 'session.unparked',
      reason: 'quota-window-reset',
      at: '2026-01-01T04:00:00Z',
    } as unknown as AgbrteEvent;
    expect(entriesFrom(SESSION, [unparked], 0)).toMatchObject([{ trigger: 'quota_restored' }]);
  });

  it('says nothing about a turn merely ending', () => {
    // Every turn ends in `awaiting_input`. Recording it would bury every real
    // event under a per-turn log of nothing having happened — the same reason
    // the notifier is silent there.
    expect(entriesFrom(SESSION, [stateEvent('awaiting_input', '2026-01-01T00:00:00Z')], 0)).toEqual([]);
  });

  it('carries the reason recorded on the transition', () => {
    const entries = entriesFrom(
      SESSION,
      [stateEvent('awaiting_quota', '2026-01-01T00:00:00Z', 'window quota exhausted, resets at 4pm')],
      0,
    );
    // "ran out of quota" is not actionable; "resets at 4pm" is the difference
    // between waiting for it and doing something else.
    expect(entries[0]?.detail).toMatch(/resets at 4pm/);
  });
});

describe('how far you have read', () => {
  it('marks everything newer than the marker unread', () => {
    const readAt = Date.parse('2026-01-01T12:00:00Z');
    const entries = entriesFrom(
      SESSION,
      [stateEvent('done', '2026-01-01T09:00:00Z'), stateEvent('failed', '2026-01-01T15:00:00Z')],
      readAt,
    );
    expect(entries.map((e) => e.unread)).toEqual([false, true]);
  });

  it('treats a never-read workspace as entirely unread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-inbox-'));
    try {
      // The safe direction: showing you something twice is a nuisance, hiding it
      // is the failure this exists to prevent.
      expect(await ReadMarker.in(dir).read()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('survives a corrupt marker rather than failing to open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-inbox-'));
    try {
      const marker = ReadMarker.in(dir);
      await marker.mark(new Date('2026-01-01T00:00:00Z'));
      const { writeFile } = await import('node:fs/promises');
      await writeFile(join(dir, 'inbox.json'), '{ not json', 'utf8');
      expect(await marker.read()).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ordering', () => {
  it('puts the newest first across sessions', () => {
    const a = entriesFrom(SESSION, [stateEvent('done', '2026-01-01T01:00:00Z')], 0);
    const b = entriesFrom(
      { ...SESSION, sessionId: 's2' as never, title: 'other' },
      [stateEvent('failed', '2026-01-01T02:00:00Z')],
      0,
    );
    expect(merge([a, b]).map((e) => e.sessionTitle)).toEqual(['other', 'fix the parser']);
  });

  it('caps the list, because an inbox is not an archive', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      stateEvent('done', new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString()),
    );
    expect(merge([entriesFrom(SESSION, many, 0)], 10)).toHaveLength(10);
  });
});

describe('across a restart, which is the whole point', () => {
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-inbox-mgr-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true });
  });

  const FAILS: EchoStep[] = [{ kind: 'stop', stop: { kind: 'refused' } }];

  function manager(): SessionManager {
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: FAILS }), { label: 'Echo', model: 'none' });
    const m = new SessionManager({ registry, workspaceRoot: root, instanceId, stallAfterMs: 0 });
    managers.push(m);
    return m;
  }

  it('still lists what happened when nothing was watching', async () => {
    const first = manager();
    const session = await first.createSession({ title: 'overnight run', goal: 'g' });
    const agent = await first.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await first.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    first.dispose();

    // A different process, the way a relaunched app or a second device is.
    // Nothing in memory carried over; this all comes back out of the log.
    const second = manager();
    await second.resumeSession(session.sessionId);
    const entries = await second.inbox();

    expect(entries.map((e) => e.trigger)).toContain('failed');
    expect(entries[0]?.sessionTitle).toBe('overnight run');
    // And unread, because nobody has looked — which is the state that makes it
    // worth surfacing at all.
    expect(entries[0]?.unread).toBe(true);
  });

  it('remembers being read, on disk and across managers', async () => {
    const first = manager();
    const session = await first.createSession({ title: 'seen it', goal: 'g' });
    const agent = await first.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    await first.send(session.sessionId, agent.agentId, { content: [{ type: 'text', text: 'go' }] });
    await first.markInboxRead(new Date(Date.now() + 1000));
    first.dispose();

    const second = manager();
    await second.resumeSession(session.sessionId);
    // Two devices attached to one host should agree about what has been looked
    // at, which is why the marker lives beside the log rather than in a client.
    expect((await second.inbox()).every((e) => !e.unread)).toBe(true);
    expect(workspaceLayout(root).devagents).toBeTruthy();
  });
});
