import { describe, expect, it } from 'vitest';
import { asSha256, isUuid, uuidv7, uuidv7Timestamp } from '@shared/types/ids.js';

describe('uuidv7', () => {
  it('produces a well-formed uuid with version 7 and variant 10', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('encodes the supplied timestamp in the first 48 bits', () => {
    const now = Date.parse('2026-07-29T17:44:00.123Z');
    expect(uuidv7Timestamp(uuidv7(now))).toBe(now);
  });

  it('sorts lexicographically in creation order — what the dashboard relies on', () => {
    const early = uuidv7(Date.parse('2026-01-01T00:00:00Z'));
    const mid = uuidv7(Date.parse('2026-06-01T00:00:00Z'));
    const late = uuidv7(Date.parse('2026-12-01T00:00:00Z'));

    const shuffled = [late, early, mid];
    expect([...shuffled].sort()).toEqual([early, mid, late]);
  });

  it('is unique across a tight loop at one millisecond', () => {
    const fixed = Date.parse('2026-07-29T00:00:00Z');
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7(fixed)));
    expect(ids.size).toBe(5000);
  });

  it('handles a timestamp above 2^32 ms without losing the high bits', () => {
    // ~2106, past the 32-bit second boundary that trips naive implementations.
    const far = 4_300_000_000_000;
    expect(uuidv7Timestamp(uuidv7(far))).toBe(far);
  });
});

describe('asSha256', () => {
  it('accepts a lowercase 64-char hex digest', () => {
    const hex = 'a'.repeat(64);
    expect(asSha256(hex)).toBe(hex);
  });

  it('rejects anything else rather than letting it into a log', () => {
    expect(() => asSha256('deadbeef')).toThrow(/not a sha256/);
    expect(() => asSha256('A'.repeat(64))).toThrow(/not a sha256/);
    expect(() => asSha256(`${'a'.repeat(63)}z`)).toThrow(/not a sha256/);
  });
});
