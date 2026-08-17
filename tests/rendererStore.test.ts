/**
 * What the renderer does when a prompt is settled somewhere else (§15 Phase 5).
 *
 * The other half of the proving criterion. `tests/attribution.test.ts` shows the
 * announcement reaching a second *client*; this shows what a client does with it,
 * which is the part a user actually experiences: the question comes off the
 * screen, and it says who answered rather than vanishing without explanation.
 *
 * Tested against the store directly rather than through a browser. Driving it
 * end to end would need an agent that asks for permission, and the only way to
 * make one ask is a tool policy the UI has no field for — so a browser test
 * would have been testing a fixture, not the feature.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useAgbrte } from '../src/renderer/store.js';
import type { PermissionRequest } from '@shared/types/index.js';

const request = (requestId: string): PermissionRequest =>
  ({ requestId, sessionId: 's1', agentId: 'a1', tool: 'shell', args: { cmd: 'ls' } }) as never;

const BOB = { id: 'uid:1001', via: 'peer-credential', label: 'bob@desk' } as const;

beforeEach(() => {
  useAgbrte.setState({ pending: [], notice: null });
});

describe('a prompt settled elsewhere', () => {
  it('comes off this screen', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermission(request('r2'));

    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'allow', scope: 'once' },
      actor: BOB,
    });

    // Only that one. Another open question is not collateral.
    expect(useAgbrte.getState().pending.map((p) => p.requestId)).toEqual(['r2']);
  });

  it('says who answered, because a prompt vanishing alone reads as a bug', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'deny', reason: 'no' },
      actor: BOB,
    });

    const notice = useAgbrte.getState().notice ?? '';
    expect(notice).toContain('bob@desk');
    // The verb matters: "denied" and "allowed" prompt different next actions.
    expect(notice).toContain('denied');
  });

  it('explains a withdrawal without naming anyone', () => {
    const store = useAgbrte.getState();
    store.applyPermission(request('r1'));
    store.applyPermissionResolved({
      requestId: 'r1',
      sessionId: 's1' as never,
      outcome: 'withdrawn',
      reason: 'the agent that asked is no longer running',
    });

    const notice = useAgbrte.getState().notice ?? '';
    // Nobody decided, so nobody is named. Attributing it would invent a
    // decision that was never made.
    expect(notice).toContain('withdrawn');
    expect(notice).toContain('no longer running');
    expect(notice).not.toContain('Someone else');
  });

  it('says nothing about a prompt this client never saw', () => {
    const store = useAgbrte.getState();
    store.applyPermissionResolved({
      requestId: 'never-seen',
      sessionId: 's1' as never,
      outcome: 'answered',
      decision: { result: 'allow', scope: 'once' },
      actor: BOB,
    });

    // A device that was not showing the question does not need to be told about
    // its ending — a notice for something you never saw reads as a fault.
    expect(useAgbrte.getState().notice).toBeNull();
  });
});

/**
 * Events arriving while a gap refetch is in flight (§8 backpressure).
 *
 * Found from the other end: a live e2e run wrote `hello.txt`, the log held
 * `permission.decided … allow via policy`, and the row for it never appeared on
 * screen. §13 requires every decision be recorded *and* shown — a transcript
 * that quietly omits an allow reads as though the gate was never consulted.
 *
 * The hole is a stale closure. When main pauses the stream, `applyBatch` starts
 * an async refetch and, on resolution, writes `[...events, ...missed, ...batch]`
 * using the `events` captured *before* the await. Batches that arrive in the
 * meantime take the non-refetching path, land in the store correctly, and are
 * then overwritten by that stale write. Whatever they carried is gone — with no
 * error, no gap in `seq` that anything checks, and nothing on screen.
 */
describe('a batch that lands while a refetch is in flight', () => {
  const ev = (seq: number, type = 'agent.text'): never =>
    ({ id: `id${seq}`, seq, type, text: `e${seq}` }) as never;

  it('survives the refetch instead of being overwritten by it', async () => {
    let releaseSince: (events: never[]) => void = () => {};
    const since = new Promise<never[]>((resolve) => {
      releaseSince = resolve;
    });

    // The store reaches for `window.agbrte`; this suite runs in node, so the
    // bridge is stood up on globalThis rather than pulling in a DOM.
    const acked: number[] = [];
    (globalThis as unknown as { window: unknown }).window = {
      agbrte: {
        sessions: { since: () => since },
        ack: (_id: string, seq: number) => acked.push(seq),
      },
    };

    useAgbrte.setState({ activeId: 's1', events: [ev(1)], refetching: false });
    const store = useAgbrte.getState();

    // Main says it withheld events, which starts the refetch.
    store.applyBatch({ sessionId: 's1', paused: true, events: [ev(4)], lastSeq: 4 } as never);
    expect(useAgbrte.getState().refetching).toBe(true);

    // A live batch lands before the refetch resolves. This is the decision row.
    store.applyBatch({ sessionId: 's1', paused: false, events: [ev(5)], lastSeq: 5 } as never);
    expect(useAgbrte.getState().events.map((e) => e.seq)).toContain(5);

    releaseSince([ev(2), ev(3)] as never[]);
    await since;
    await Promise.resolve();

    expect(
      useAgbrte.getState().events.map((e) => e.seq),
      'the batch that arrived mid-refetch was dropped',
    ).toEqual([1, 2, 3, 4, 5]);

    // The ack is what lets main resume forwarding. The paused branch returned
    // without one, so a client that hit a gap could be left holding a stream
    // nobody was going to send anything else down.
    expect(acked, 'main was never told the gap had closed').toContain(4);
  });
});

/**
 * A snapshot landing on top of a turn that is already producing events.
 *
 * `send()` fetches a fresh snapshot in its `finally` and `applySnapshot`
 * *replaces* the event list with it. The turn is still running at that point —
 * the IPC resolves when the turn is accepted, not when it finishes — so any
 * event that arrived between the snapshot being taken on the main side and it
 * being applied here is overwritten by a view of the session from before it
 * existed. Everything after it appends normally.
 *
 * The result is one row missing from the middle of a transcript that otherwise
 * looks complete, which is why this went unnoticed: it does not look like data
 * loss, it looks like the thing never happened. In a live run the row that
 * vanished was `permission.decided … allow via policy`, and §13's audit trail
 * missing an allow is indistinguishable from a gate that never ran.
 */
describe('a snapshot arriving mid-turn', () => {
  const ev = (seq: number): never => ({ id: `id${seq}`, seq, type: 'agent.text', text: `e${seq}` }) as never;

  it('does not erase events that arrived while it was in flight', async () => {
    const session = { sessionId: 's1', agents: [{ agentId: 'a1' }] };

    (globalThis as unknown as { window: unknown }).window = {
      agbrte: {
        ack: () => {},
        sessions: {
          // The event the gate recorded, arriving while the send is in flight.
          send: async () => {
            useAgbrte.getState().applyBatch({
              sessionId: 's1',
              paused: false,
              events: [ev(3)],
              lastSeq: 3,
            } as never);
          },
          // Taken before that event existed, which is the whole race.
          snapshot: async () => ({ session, recent: [ev(1), ev(2)], queued: 0 }),
          list: async () => [],
        },
      },
    };

    useAgbrte.setState({
      activeId: 's1',
      active: session as never,
      events: [ev(1), ev(2)],
      refetching: false,
    });

    await useAgbrte.getState().send('hello');

    expect(
      useAgbrte.getState().events.map((e) => e.seq),
      'the snapshot replaced the transcript instead of catching up to it',
    ).toEqual([1, 2, 3]);
  });
});

/**
 * Two distinct events that share a seq.
 *
 * Should never happen — `EventLog` allocates seq synchronously now — but this
 * store used to key its dedupe on position rather than identity, so when the
 * writer did race, the *renderer* is what threw the second event away. A row
 * that was written, allowed, and logged simply never appeared. Keying on `id`
 * means a writer bug stays a writer bug instead of becoming silent data loss
 * three processes downstream.
 */
describe('two different events carrying the same seq', () => {
  it('renders both rather than treating one as a repeat', () => {
    (globalThis as unknown as { window: unknown }).window = {
      agbrte: { ack: () => {}, sessions: {} },
    };
    useAgbrte.setState({ activeId: 's1', events: [], refetching: false });

    useAgbrte.getState().applyBatch({
      sessionId: 's1',
      paused: false,
      lastSeq: 6,
      events: [
        { id: 'a', seq: 6, type: 'usage' },
        { id: 'b', seq: 6, type: 'permission.decided', tool: 'write' },
      ],
    } as never);

    expect(
      useAgbrte.getState().events.map((e) => e.id),
      'the decision was discarded as a duplicate of the usage row',
    ).toEqual(['a', 'b']);
  });
});

/**
 * A hosts push is what corrects the picker (§3.12, §6.4).
 *
 * A host is a detached process that can be replaced by one with a different set
 * of tools installed, and `Fleet` emits `host` on every reconnect — so the whole
 * of the client-side fix is that `applyHosts` asks each host again rather than
 * trusting what it learned on the first attach. That is what it already did, and
 * it was useless while main sent the same answer every time.
 *
 * Asserted here because the property is easy to lose by optimisation: skipping
 * the fetch for a host whose `instanceId` is unchanged looks like an obvious win
 * and would restore exactly the bug — the id is per *workspace* (§5.2) and is
 * the one thing that does **not** change when the process behind it does.
 */
describe('the runtime list a picker reads', () => {
  const host = (instanceId: string, available: string[]) =>
    ({
      instanceId,
      root: '/w',
      lineageId: 'l1',
      targetKind: 'local',
      label: 'w',
      available,
      endpoints: [],
      runtimeNotes: [],
      link: 'connected',
    }) as never;

  it('is re-asked on every hosts push, not only the first', async () => {
    const asked: string[] = [];
    let offered = [{ id: 'echo', version: '1', model: 'none' }];

    (globalThis as { window?: unknown }).window = {
      agbrte: {
        hosts: {
          runtimes: (instanceId: string) => {
            asked.push(instanceId);
            return Promise.resolve(offered);
          },
          conformance: () => Promise.resolve([]),
        },
      },
    };
    useAgbrte.setState({ hosts: [], runtimesByHost: {} });

    useAgbrte.getState().applyHosts([host('i1', ['echo'])]);
    await new Promise((r) => setTimeout(r, 0));
    expect(useAgbrte.getState().runtimesByHost['i1']?.map((r) => r.id)).toEqual(['echo']);

    // The same host, a new process behind it, with a CLI the old one lacked.
    offered = [
      { id: 'echo', version: '1', model: 'none' },
      { id: 'cli:claude-code', version: '1', model: 'optional' },
    ];
    useAgbrte.getState().applyHosts([host('i1', ['echo', 'cli:claude-code'])]);
    await new Promise((r) => setTimeout(r, 0));

    expect(asked, 'the second push did not re-ask').toEqual(['i1', 'i1']);
    expect(useAgbrte.getState().runtimesByHost['i1']?.map((r) => r.id)).toEqual([
      'echo',
      'cli:claude-code',
    ]);
  });

  it('carries what the host could not find, so the picker can explain a gap', () => {
    useAgbrte.setState({ hosts: [] });
    const withNote = host('i1', ['echo']) as { runtimeNotes: unknown[] };
    withNote.runtimeNotes = [
      { id: 'cli:claude-code', label: 'Claude Code', reason: '`claude` could not be started' },
    ];
    useAgbrte.setState({ hosts: [withNote as never] });

    // The renderer reads this off the host record rather than fetching again,
    // so it follows a replaced host by the same route the runtime list does.
    expect(useAgbrte.getState().hosts[0]?.runtimeNotes?.[0]?.id).toBe('cli:claude-code');
  });
});

describe('seating this session’s one model', () => {
  /**
   * A session holds one agent (§4.2), so choosing a model on a seated session
   * is a *replacement* and the host has to be told which seat is being taken
   * over — by id, so that two windows on one session cannot silently overwrite
   * each other's choice.
   */
  const seat = (agentId: string, status: string) =>
    ({
      agentId,
      role: 'lead',
      status,
      spec: { agentId, role: 'lead', runtimeId: 'echo', auth: { kind: 'none' } },
      resolvedCapabilities: { permissionFidelity: 'callback' },
      isolation: 'shared',
      resumeToken: null,
      lastEventSeq: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    }) as never;

  function stub(): { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = [];
    (globalThis as { window?: unknown }).window = {
      agbrte: {
        sessions: {
          addAgent: (r: Record<string, unknown>) => {
            sent.push(r);
            return Promise.resolve({});
          },
          snapshot: () => Promise.resolve({ session: null, events: [], pending: [] }),
        },
      },
    };
    return { sent };
  }

  it('names the seat it is replacing', async () => {
    const { sent } = stub();
    useAgbrte.setState({
      activeId: 's1' as never,
      active: { sessionId: 's1', agents: [seat('a1', 'idle')] } as never,
    });

    await useAgbrte.getState().addAgent('echo', null);
    expect(sent[0]?.['replacing']).toBe('a1');
  });

  it('sends nothing to replace on a session with no agent yet', async () => {
    const { sent } = stub();
    useAgbrte.setState({ activeId: 's1' as never, active: { sessionId: 's1', agents: [] } as never });

    await useAgbrte.getState().addAgent('echo', null);
    expect(sent[0]).not.toHaveProperty('replacing');
  });

  it('skips a retired seat when deciding what it is replacing', async () => {
    // A seat already retired by an earlier model change is in the roster to
    // name old transcript rows, not to be replaced a second time.
    const { sent } = stub();
    useAgbrte.setState({
      activeId: 's1' as never,
      active: { sessionId: 's1', agents: [seat('a1', 'retired'), seat('a2', 'idle')] } as never,
    });

    await useAgbrte.getState().addAgent('echo', null);
    expect(sent[0]?.['replacing']).toBe('a2');
  });
});
