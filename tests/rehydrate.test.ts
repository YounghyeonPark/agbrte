import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { estimateTokens, rehydrate } from '@main/store/rehydrate.js';
import { SessionStore } from '@main/store/sessionStore.js';
import { openWorkspace } from '@main/store/identity.js';
import { newSessionId, type InstanceId } from '@shared/types/index.js';

let root: string;
let instanceId: InstanceId;
let store: SessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'loom-rehyd-'));
  instanceId = (await openWorkspace(root)).instanceId;
  store = await SessionStore.create(root, {
    sessionId: newSessionId(),
    instanceId,
    title: 'Migrate the auth module',
    goal: 'move auth off the legacy session store',
    createdAt: new Date().toISOString(),
  });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const BIG = 1_000_000;

async function conversation(turns: number): Promise<void> {
  for (let i = 0; i < turns; i += 1) {
    await store.append({ type: 'user.turn', content: [{ type: 'text', text: `question ${i}` }] });
    await store.append({ type: 'agent.text', text: `answer ${i}` });
  }
}

describe('estimateTokens', () => {
  it('over-estimates deliberately', () => {
    // Overshooting carries less history than it could, which is recoverable.
    // Undershooting overflows the context window, which is not (§3.6).
    expect(estimateTokens('abcdef')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('rehydrate', () => {
  it('reports an empty seed when there is genuinely nothing to carry', async () => {
    const result = await rehydrate(store, { budgetTokens: BIG });
    // Only `session.created` exists — a fresh start here is honest.
    expect(result.isEmpty).toBe(true);
    expect(result.seed).toEqual([]);
  });

  it('leads with the goal so an agent resumed weeks later knows what it is doing', async () => {
    await conversation(1);
    const { seed } = await rehydrate(store, { budgetTokens: BIG });

    const first = seed[0];
    expect(first?.role).toBe('system');
    const text = first?.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    expect(text).toContain('Migrate the auth module');
    expect(text).toContain('move auth off the legacy session store');
    expect(text).toContain('rebuilt from the session log');
  });

  it('carries recent turns verbatim and summarizes the rest', async () => {
    await conversation(10);
    const result = await rehydrate(store, { budgetTokens: BIG, verbatimTurns: 4 });

    // brief + 4 verbatim turns
    expect(result.seed).toHaveLength(5);
    expect(result.summarizedTurns).toBe(16); // 20 turns total, 4 kept
    const last = result.seed.at(-1);
    expect(last?.content.some((b) => b.type === 'text' && b.text.includes('answer 9'))).toBe(true);
  });

  it('drops older turns to fit a budget but never drops the brief', async () => {
    await conversation(20);
    const tight = await rehydrate(store, { budgetTokens: 200, verbatimTurns: 40 });

    // An agent with conversation but no goal is worse off than the reverse.
    expect(tight.seed[0]?.role).toBe('system');
    expect(tight.estimatedTokens).toBeLessThanOrEqual(200 + estimateTokens('x'));
    expect(tight.summarizedTurns).toBeGreaterThan(0);
  });

  it('includes the checklist with completion state', async () => {
    await store.append({ type: 'checklist.updated', itemId: 'a', state: 'done', text: 'Read code' });
    await store.append({ type: 'checklist.updated', itemId: 'b', state: 'todo', text: 'Write tests' });

    const { seed } = await rehydrate(store, { budgetTokens: BIG });
    const text = seed[0]?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    expect(text).toContain('[done] Read code');
    expect(text).toContain('[todo] Write tests');
  });

  it('surfaces the compaction count — the split signal', async () => {
    await conversation(1);
    await store.append({ type: 'agent.compacted', beforeTokens: 900, afterTokens: 300 });
    await store.append({ type: 'agent.compacted', beforeTokens: 900, afterTokens: 310 });

    const { seed } = await rehydrate(store, { budgetTokens: BIG });
    const text = seed[0]?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    // §4.3: compacted twice and still growing means decompose, not compact again.
    expect(text).toContain('compacted 2 time(s)');
  });

  it('points at artifacts rather than inlining them', async () => {
    await conversation(1);
    await store.append({ type: 'artifact.created', artifactId: 'art-1', kind: 'report' });

    const { seed } = await rehydrate(store, { budgetTokens: BIG });
    const text = seed[0]?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    expect(text).toContain('report:art-1');
    expect(text).toContain('Read them if you need');
  });

  it('includes curated project memory when supplied', async () => {
    await conversation(1);
    const { seed } = await rehydrate(store, {
      budgetTokens: BIG,
      memory: ['This repo uses tabs, not spaces.'],
    });
    const text = seed[0]?.content.map((b) => (b.type === 'text' ? b.text : '')).join('') ?? '';
    expect(text).toContain('tabs, not spaces');
  });

  it('reports how far through the log the seed reaches', async () => {
    await conversation(3);
    const { projection } = await store.load();
    const result = await rehydrate(store, { budgetTokens: BIG });
    expect(result.seededThroughSeq).toBe(projection.lastSeq);
  });

  it('merges consecutive agent text into one assistant turn', async () => {
    await store.append({ type: 'user.turn', content: [{ type: 'text', text: 'q' }] });
    await store.append({ type: 'agent.text', text: 'part one' });
    await store.append({ type: 'agent.text', text: 'part two' });

    const { seed } = await rehydrate(store, { budgetTokens: BIG, verbatimTurns: 10 });
    const assistant = seed.filter((t) => t.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.content).toHaveLength(2);
  });

  it('renders non-text content as a pointer, not as payload', async () => {
    await store.append({
      type: 'user.turn',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'file_ref', path: { $ws: 'src/auth.ts' } },
      ],
    });

    const { seed } = await rehydrate(store, { budgetTokens: BIG, verbatimTurns: 10 });
    const user = seed.find((t) => t.role === 'user');
    expect(user?.content.some((b) => b.type === 'file_ref')).toBe(true);
  });
});
