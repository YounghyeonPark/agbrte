import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, LineAccumulator, parseWholeLines } from '@main/store/eventLog.js';

let dir: string;
let logPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'loom-log-'));
  logPath = join(dir, 'events.jsonl');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('parseWholeLines', () => {
  it('returns nothing and consumes nothing when no newline has arrived', () => {
    const r = parseWholeLines(Buffer.from('{"seq":1,"type":"agent.text"'));
    expect(r.events).toHaveLength(0);
    expect(r.consumed).toBe(0);
  });

  it('consumes only up to the last newline, retaining a partial tail', () => {
    const whole = '{"seq":1,"type":"agent.text","text":"a"}\n';
    const partial = '{"seq":2,"type":"agent';
    const r = parseWholeLines(Buffer.from(whole + partial));
    expect(r.events).toHaveLength(1);
    expect(r.consumed).toBe(Buffer.byteLength(whole));
  });

  it('counts a corrupt mid-file line instead of throwing', () => {
    const buf = Buffer.from('{"seq":1}\nnot json at all\n{"seq":3}\n');
    const r = parseWholeLines(buf);
    // One bad line must not make a session unopenable, but it must be reported.
    expect(r.events.map((e) => e.seq)).toEqual([1, 3]);
    expect(r.skipped).toBe(1);
  });

  it('handles multi-byte UTF-8 split across a chunk boundary via the accumulator', () => {
    const line = `${JSON.stringify({ seq: 1, type: 'agent.text', text: '日本語テキスト' })}\n`;
    const full = Buffer.from(line, 'utf8');
    const cut = 12; // lands mid-character
    const acc = new LineAccumulator();

    expect(acc.push(full.subarray(0, cut))).toHaveLength(0);
    const events = acc.push(full.subarray(cut));

    expect(events).toHaveLength(1);
    expect((events[0] as { text: string }).text).toBe('日本語テキスト');
  });
});

describe('EventLog', () => {
  it('assigns monotonic seq starting at 1', async () => {
    const { log } = await EventLog.open(logPath);
    const a = await log.append({ type: 'agent.text', text: 'one' });
    const b = await log.append({ type: 'agent.text', text: 'two' });
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(log.nextSeq).toBe(3);
  });

  it('continues seq across a reopen', async () => {
    const first = await EventLog.open(logPath);
    await first.log.append({ type: 'agent.text', text: 'one' });
    await first.log.append({ type: 'agent.text', text: 'two' });

    const second = await EventLog.open(logPath);
    expect(second.log.nextSeq).toBe(3);
    const c = await second.log.append({ type: 'agent.text', text: 'three' });
    expect(c.seq).toBe(3);
  });

  it('never rewrites earlier bytes — append-only', async () => {
    const { log } = await EventLog.open(logPath);
    await log.append({ type: 'agent.text', text: 'first' });
    const afterFirst = await readFile(logPath);

    await log.append({ type: 'agent.text', text: 'second' });
    const afterSecond = await readFile(logPath);

    expect(afterSecond.subarray(0, afterFirst.length)).toEqual(afterFirst);
  });

  it('truncates a torn trailing line on open so appends stay valid', async () => {
    const { log } = await EventLog.open(logPath);
    await log.append({ type: 'agent.text', text: 'complete' });

    // Simulate a process killed mid-write.
    await appendFile(logPath, '{"seq":2,"type":"agent.te');
    const tornSize = (await stat(logPath)).size;

    const reopened = await EventLog.open(logPath);
    expect(reopened.truncatedBytes).toBeGreaterThan(0);
    expect((await stat(logPath)).size).toBeLessThan(tornSize);

    // The next append must produce a parseable file, not a wedged record.
    await reopened.log.append({ type: 'agent.text', text: 'after recovery' });
    const { events, skipped } = await reopened.log.readAll();
    expect(skipped).toBe(0);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
  });

  it('reports byteLength as an offset a follower can resume from', async () => {
    const { log } = await EventLog.open(logPath);
    await log.append({ type: 'agent.text', text: 'one' });
    const offset = log.byteLength;
    expect(offset).toBe((await stat(logPath)).size);

    await log.append({ type: 'agent.text', text: 'two' });
    const { events } = await log.readFrom(offset);

    // Exactly the new record: zero loss, zero duplication (§6.6).
    expect(events).toHaveLength(1);
    expect((events[0] as { text: string }).text).toBe('two');
  });

  it('resumes correctly from every possible byte offset', async () => {
    const { log } = await EventLog.open(logPath);
    const offsets: number[] = [0];
    for (const text of ['a', 'bb', 'ccc', 'dddd']) {
      await log.append({ type: 'agent.text', text });
      offsets.push(log.byteLength);
    }

    for (const [i, offset] of offsets.entries()) {
      const { events } = await log.readFrom(offset);
      expect(events).toHaveLength(4 - i);
    }
  });

  it('stamps ordering on seq, not on the clock', async () => {
    const { log } = await EventLog.open(logPath);
    // A host whose clock jumps backwards must not reorder the transcript.
    const times = ['2026-07-29T12:00:05.000Z', '2026-07-29T12:00:00.000Z'];
    let i = 0;
    const now = () => new Date(times[i++] as string);

    const a = await log.append({ type: 'agent.text', text: 'earlier seq' }, { now });
    const b = await log.append({ type: 'agent.text', text: 'later seq' }, { now });

    expect(a.seq).toBeLessThan(b.seq);
    expect(Date.parse(b.at)).toBeLessThan(Date.parse(a.at));
  });

  it('records provenance so a transcript is reproducible', async () => {
    const { log } = await EventLog.open(logPath);
    const ev = await log.append(
      { type: 'agent.text', text: 'hello' },
      {
        origin: {
          runtimeId: 'claude-agent-sdk',
          adapterVersion: '0.0.1',
          model: { providerId: 'anthropic', modelId: 'claude-opus-5' },
        },
      },
    );
    expect(ev.origin?.model?.modelId).toBe('claude-opus-5');
  });

  it('omits optional envelope fields rather than writing undefined', async () => {
    const { log } = await EventLog.open(logPath);
    await log.append({ type: 'agent.text', text: 'x' });
    const line = (await readFile(logPath, 'utf8')).trim();
    expect(line).not.toContain('undefined');
    expect(Object.keys(JSON.parse(line))).not.toContain('agentId');
  });

  it('creates a missing log as empty so offsets start at 0', async () => {
    const { log } = await EventLog.open(logPath);
    expect(log.byteLength).toBe(0);
    expect((await stat(logPath)).size).toBe(0);
    const { events } = await log.readAll();
    expect(events).toEqual([]);
  });
});
