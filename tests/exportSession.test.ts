/**
 * A session as a readable document (DESIGN.md §15 Phase 8).
 *
 * Two jobs: attach a run to a bug report, and keep one after the workspace it
 * lived in is gone. Both mean the file **leaves** — and everything protecting a
 * transcript until now has been about a `0700` directory (§13), none of which
 * applies to an attachment on an email.
 *
 * So the properties worth testing are not "does it render nicely". They are:
 * does it say what it contains, does it keep the evidence that makes a
 * transcript worth having, and does it avoid claiming to be the whole story when
 * it is not.
 */

import { describe, expect, it } from 'vitest';
import { exportSessionMarkdown } from '@main/store/exportSession.js';
import type { AgbrteEvent, Session } from '@shared/types/index.js';

const NOW = (): Date => new Date('2026-02-03T04:05:06.000Z');

const session = (over: Partial<Session> = {}): Session =>
  ({
    sessionId: 'sess-1',
    instanceId: 'inst-1',
    target: { kind: 'local' },
    title: 'Fix the parser',
    goal: 'make the tests pass',
    state: 'awaiting_input',
    agents: [],
    createdAt: '2026-02-03T00:00:00.000Z',
    updatedAt: '2026-02-03T00:00:00.000Z',
    checklist: [],
    artifacts: [],
    needsAttention: null,
    tree: { rootSessionId: 'sess-1', depth: 0, ancestry: [] },
    children: [],
    pendingSplits: [],
    ...over,
  }) as Session;

let seq = 0;
const ev = (body: Record<string, unknown>): AgbrteEvent =>
  ({ id: `e${(seq += 1)}`, seq, at: '2026-02-03T00:01:00.000Z', ...body }) as AgbrteEvent;

const md = (events: AgbrteEvent[], over: Partial<Session> = {}, opts = {}): string =>
  exportSessionMarkdown(session(over), events, { now: NOW, ...opts });

describe('the export says what it contains', () => {
  it('warns that tool arguments are in full, because a reader cannot tell', () => {
    /**
     * The disclosure is the point of the header. A person exporting is about to
     * attach the file to something, and full `bash` arguments carry the commands
     * run and the paths touched — which is exactly what makes the export useful
     * as evidence and exactly what nobody thinks about before hitting send.
     */
    const out = md([ev({ type: 'agent.tool_use', toolUseId: 't', tool: 'bash', args: { command: 'ls' } })]);

    expect(out).toMatch(/full \*\*tool arguments\*\*|\*\*full tool arguments\*\*/i);
    expect(out).toMatch(/commands run and the paths touched/i);
  });

  it('says so differently when they are truncated', () => {
    const out = md([], {}, { toolArgs: 'summary' });
    expect(out).toMatch(/truncated/i);
    expect(out).not.toMatch(/commands run and the paths touched/i);
  });

  it('names the attachments it did not include, and where they are', () => {
    // Otherwise a reader assumes nothing was captured, which is a different
    // session from the one that happened.
    const out = md([
      ev({ type: 'capture.attached', sha256: 'abc123def456', mime: 'image/png' }),
      ev({ type: 'capture.attached', sha256: 'ffee00112233', mime: 'image/png' }),
    ]);

    expect(out).toMatch(/2 attachment\(s\).*not included/i);
    // Not `.agbrte/sessions/...`: the workspace directory is `.agbrte/` on a
    // workspace made today and `.devagents/` on one made before the rename
    // (§5.1), and the exporter has no workspace root to ask which.
    expect(out).toContain('sessions/sess-1/attachments/');
    expect(out).not.toContain('.agbrte/sessions/');
    expect(out).not.toContain('.devagents/sessions/');
  });

  it('says plainly when there were none, rather than staying silent', () => {
    // Silence reads the same as "the exporter dropped them".
    expect(md([])).toMatch(/No attachments were captured/i);
  });
});

describe('the evidence a transcript exists to carry', () => {
  it('keeps permission decisions, including the ones policy settled', () => {
    /**
     * §13: without the settled ones "a transcript can show hundreds of tool
     * calls and no evidence the gate was ever consulted". An export that dropped
     * them would be precisely that transcript.
     */
    const out = md([
      ev({ type: 'agent.tool_use', toolUseId: 't', tool: 'write', args: { file_path: 'a.ts' } }),
      ev({
        type: 'permission.decided',
        requestId: 'r1',
        tool: 'write',
        args: { file_path: 'a.ts' },
        decision: { result: 'allow', scope: 'once' },
        via: 'policy',
      }),
    ]);

    expect(out).toContain('allow');
    expect(out).toContain('via policy');
  });

  it('keeps a denial and the reason given', () => {
    // The reason is fed back to the agent so it can adapt (§13); a reader of the
    // transcript needs it for the same reason.
    const out = md([
      ev({
        type: 'permission.decided',
        requestId: 'r1',
        tool: 'bash',
        args: { command: 'rm -rf /' },
        decision: { result: 'deny', reason: 'absolutely not' },
        via: 'user',
      }),
    ]);

    expect(out).toContain('deny');
    expect(out).toContain('absolutely not');
  });

  it('keeps content downgrades, which are what "it ignored my screenshot" means', () => {
    // §3.5 exists so that is diagnosable rather than folklore, and the export is
    // where somebody else does the diagnosing.
    const out = md([
      ev({
        type: 'content.downgraded',
        note: { reason: 'no_image_support', detail: 'this agent has input.image: false' },
      }),
    ]);

    expect(out).toContain('input.image: false');
  });

  it('names why a run stopped, including which ceiling', () => {
    const out = md([
      ev({ type: 'agent.stopped', stop: { kind: 'limit_reached', limit: 'tokens', detail: '1000 tokens' } }),
    ]);

    expect(out).toContain('limit_reached');
    expect(out).toContain('tokens');
  });

  it('attributes a turn to the person who sent it', () => {
    const out = md([
      {
        ...ev({ type: 'user.turn', content: [{ type: 'text', text: 'do the thing' }] }),
        actor: { id: 'uid:1000', via: 'peer-credential' },
      } as AgbrteEvent,
    ]);

    expect(out).toContain('do the thing');
    expect(out).toContain('uid:1000');
  });
});

describe('images are referenced, never embedded', () => {
  it('names an image in a turn by size and hash', () => {
    // Base64ing a screenshot into Markdown turns a 40 KB transcript into a 4 MB
    // one, and the bytes are already content-addressed beside the log.
    const out = md([
      ev({
        type: 'user.turn',
        content: [
          { type: 'text', text: 'look at this' },
          {
            type: 'image',
            sha256: 'aabbccddeeff00112233',
            mime: 'image/png',
            width: 800,
            height: 600,
            provenance: { kind: 'screen_capture', origin: 'client' },
          },
        ],
      }),
    ]);

    expect(out).toContain('800×600');
    expect(out).toContain('aabbccddeeff');
    expect(out).not.toMatch(/base64|data:image/i);
  });
});

describe('totals', () => {
  it('adds up tokens and cost', () => {
    const out = md([
      ev({ type: 'usage', inputTokens: 1000, outputTokens: 200, cost: 0.5 }),
      ev({ type: 'usage', inputTokens: 500, outputTokens: 100, cost: 0.25 }),
    ]);

    expect(out).toContain('1,500 in / 300 out');
    expect(out).toContain('$0.75');
  });

  it('says the cost was not visible rather than showing a partial sum', () => {
    // §10, and the same contagion rule as everywhere else: a total that quietly
    // drops an unobservable agent is smaller than the truth.
    const out = md([
      ev({ type: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.5 }),
      ev({ type: 'usage', inputTokens: 10, outputTokens: 5, cost: 'unknown' }),
    ]);

    expect(out).toContain('cost not visible to Agbrte');
    expect(out).not.toContain('$0.50');
  });
});

describe('what it leaves out', () => {
  it('drops bookkeeping that would bury the conversation', () => {
    // A `checklist.updated` per tool call renders a transcript nobody reads.
    const out = md([
      ev({ type: 'agent.text', text: 'the actual answer' }),
      ev({ type: 'checklist.updated', itemId: 'i1', title: 'x', status: 'done' }),
    ]);

    expect(out).toContain('the actual answer');
    expect(out).not.toContain('checklist');
  });

  it('still counts everything it did not render', () => {
    // So a reader can tell the document is a view of a log rather than the log.
    const out = md([
      ev({ type: 'agent.text', text: 'hi' }),
      ev({ type: 'checklist.updated', itemId: 'i1', title: 'x', status: 'done' }),
    ]);

    expect(out).toContain('2 events');
  });
});

describe('an agent has a name a person can read', () => {
  /**
   * Found by generating an export and looking at it, not by an assertion: the
   * heading read `### 🤖 019fe9dc-a82f-7ce3-bd28-cd8127df67f7`, which is not a
   * document anybody reads. Every test above passed on that output.
   */
  const withAgents = (roles: string[]): Partial<Session> => ({
    agents: roles.map((role, i) => ({
      agentId: `agent-${i}${'0'.repeat(8)}`,
      role,
      status: 'idle',
      spec: { runtimeId: 'echo' },
      resolvedCapabilities: {},
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0 },
    })) as Session['agents'],
  });

  it('uses the role', () => {
    const out = md(
      [ev({ type: 'agent.text', text: 'hello', agentId: 'agent-000000000' })],
      withAgents(['reviewer']),
    );

    expect(out).toContain('🤖 reviewer');
    expect(out).not.toContain('agent-000000000');
  });

  it('adds a short id when two agents share a role', () => {
    // Two `worker`s are two agents, and a transcript calling them both `worker`
    // is worse than one showing UUIDs.
    const out = md(
      [ev({ type: 'agent.text', text: 'hello', agentId: 'agent-000000000' })],
      withAgents(['worker', 'worker']),
    );

    expect(out).toMatch(/🤖 worker agent-0/);
  });

  it('falls back to a short id for an agent the session no longer lists', () => {
    // A rehydrated log can mention an agent the record dropped. A raw UUID is
    // ugly; an exception is worse.
    const out = md([ev({ type: 'agent.text', text: 'hello', agentId: 'ghost-1234567' })]);
    expect(out).toContain('ghost-12');
  });
});
