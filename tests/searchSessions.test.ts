/**
 * Finding the session where you did that thing (DESIGN.md §15 Phase 8).
 *
 * Two claims worth testing and one worth resisting.
 *
 * The claims: a hit is something a *person* wrote or ran, and a search across
 * machines is not failed by one machine being asleep.
 *
 * The one worth resisting is "did it find the string". A search that greps the
 * raw JSONL passes that trivially and is useless — it matches ids, hashes and
 * field names, so `image` hits every event carrying an `imageMaxCount`
 * capability. Most of these tests are about *not* matching.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchWorkspace, searchableText } from '@main/store/searchSessions.js';
import { sessionLayout } from '@main/store/layout.js';
import type { AgbrteEvent } from '@shared/types/index.js';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-search-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

/** Write a session directory the way the store lays one out. */
async function plant(id: string, title: string, events: Array<Partial<AgbrteEvent>>): Promise<void> {
  const layout = sessionLayout(root, id as never);
  await mkdir(layout.dir, { recursive: true });
  await writeFile(layout.sessionFile, JSON.stringify({ sessionId: id, title }), 'utf8');
  await writeFile(
    layout.eventLog,
    events
      .map((e, i) => JSON.stringify({ id: `e${i}`, seq: i + 1, at: '2026-01-01T00:00:00Z', ...e }))
      .join('\n') + '\n',
    'utf8',
  );
}

describe('a hit is something a person wrote or ran', () => {
  it('finds what you typed', async () => {
    await plant('019a', 'Parser work', [
      { type: 'user.turn', content: [{ type: 'text', text: 'the parser drops trailing commas' }] },
    ]);

    const hits = await searchWorkspace(root, 'trailing commas');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBe('Parser work');
    expect(hits[0]?.snippet).toContain('trailing commas');
  });

  it('finds what an agent said', async () => {
    await plant('019a', 's', [{ type: 'agent.text', text: 'I rewrote the tokenizer' }]);
    expect(await searchWorkspace(root, 'tokenizer')).toHaveLength(1);
  });

  it('finds a command an agent ran', async () => {
    // Often the most useful hit: "which session was it where I ran that".
    await plant('019a', 's', [
      { type: 'agent.tool_use', toolUseId: 't', tool: 'bash', args: { command: 'npm run e2e' } },
    ]);

    const hits = await searchWorkspace(root, 'npm run e2e');
    expect(hits[0]?.kind).toBe('agent.tool_use');
  });

  it('does not match ids, hashes or field names', async () => {
    /**
     * The test that stops this being a `grep`. A raw scan of the JSONL matches
     * the event id, the sha of an attachment, and every field name in the
     * schema — so searching for `image` would hit any event carrying an
     * `imageMaxCount` capability, and the result list would be noise.
     */
    await plant('019a', 's', [
      { type: 'capture.attached', sha256: 'imagehash0000' as never, mime: 'image/png' },
      { type: 'agent.text', text: 'nothing relevant here' },
    ]);

    expect(await searchWorkspace(root, 'image')).toHaveLength(0);
  });

  it('is case-insensitive, because a search box is', async () => {
    await plant('019a', 's', [{ type: 'agent.text', text: 'The Tokenizer' }]);
    expect(await searchWorkspace(root, 'tokenizer')).toHaveLength(1);
  });

  it('treats the query as characters, not a pattern', async () => {
    // `parse.ts` means those characters. As a regex the `.` matches anything,
    // and the surprise would land on the result count — the one place nobody
    // checks their assumptions.
    await plant('019a', 's', [{ type: 'agent.text', text: 'edited parseXts by mistake' }]);
    expect(await searchWorkspace(root, 'parse.ts')).toHaveLength(0);
  });

  it('returns nothing for an empty query rather than everything', async () => {
    // Every session would look like a feature rather than a mistake.
    await plant('019a', 's', [{ type: 'agent.text', text: 'anything' }]);
    expect(await searchWorkspace(root, '   ')).toEqual([]);
  });
});

describe('reading logs that may be damaged or absent', () => {
  it('says nothing rather than failing on a workspace with no sessions', async () => {
    expect(await searchWorkspace(root, 'anything')).toEqual([]);
  });

  it('skips a torn line instead of losing the session', async () => {
    /**
     * An append-only log can end mid-write after a crash (§5.4). One bad line
     * must not make a session unsearchable — which is exactly when somebody is
     * searching for it.
     */
    const layout = sessionLayout(root, '019a' as never);
    await mkdir(layout.dir, { recursive: true });
    await writeFile(layout.sessionFile, JSON.stringify({ title: 's' }), 'utf8');
    await writeFile(
      layout.eventLog,
      `${JSON.stringify({ id: 'e1', seq: 1, at: 'now', type: 'agent.text', text: 'findable' })}\n{"id":"e2","seq":2,"type":"agen`,
      'utf8',
    );

    expect(await searchWorkspace(root, 'findable')).toHaveLength(1);
  });

  it('falls back to the id when the record will not parse', async () => {
    const layout = sessionLayout(root, '019a' as never);
    await mkdir(layout.dir, { recursive: true });
    await writeFile(layout.sessionFile, '{ not json', 'utf8');
    await writeFile(
      layout.eventLog,
      `${JSON.stringify({ id: 'e1', seq: 1, at: 'n', type: 'agent.text', text: 'findable' })}\n`,
      'utf8',
    );

    expect((await searchWorkspace(root, 'findable'))[0]?.title).toBe('019a');
  });
});

describe('budget and order', () => {
  it('stops at the limit', async () => {
    await plant(
      '019a',
      's',
      Array.from({ length: 20 }, () => ({ type: 'agent.text' as const, text: 'match me' })),
    );

    expect(await searchWorkspace(root, 'match me', { limit: 5 })).toHaveLength(5);
  });

  it('spends the budget on the newest sessions first', async () => {
    /**
     * uuidv7 ids sort by time (§5.4), so descending id is descending time — and
     * a capped result set should spend itself on what you are most likely
     * looking for. No `stat` per directory, and no dependence on a clock we did
     * not write.
     */
    await plant('019a-old', 'Old', [{ type: 'agent.text', text: 'shared phrase' }]);
    await plant('019z-new', 'New', [{ type: 'agent.text', text: 'shared phrase' }]);

    const hits = await searchWorkspace(root, 'shared phrase', { limit: 1 });
    expect(hits[0]?.title).toBe('New');
  });

  it('gives a snippet with context, not the whole event', async () => {
    const long = `${'x'.repeat(400)} needle ${'y'.repeat(400)}`;
    await plant('019a', 's', [{ type: 'agent.text', text: long }]);

    const snippet = (await searchWorkspace(root, 'needle'))[0]!.snippet;
    expect(snippet).toContain('needle');
    expect(snippet.length).toBeLessThan(200);
    expect(snippet.startsWith('…')).toBe(true);
  });
});

describe('what counts as searchable text', () => {
  it('ignores events that carry no human language', () => {
    // A `usage` event is numbers. Including it would put a hit on any query that
    // happened to appear in a field name.
    expect(searchableText({ type: 'usage', inputTokens: 1, outputTokens: 2 } as AgbrteEvent)).toBe('');
  });

  it('includes the title and goal a session was created with', () => {
    const text = searchableText({
      type: 'session.created',
      title: 'Fix the parser',
      goal: 'make the tests pass',
    } as AgbrteEvent);

    expect(text).toContain('Fix the parser');
    expect(text).toContain('make the tests pass');
  });
});
