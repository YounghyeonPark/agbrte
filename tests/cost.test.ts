/**
 * Cost, and the three answers that must stay apart (DESIGN.md §10).
 *
 * > The third row must say so rather than showing zero. A subscription-backed
 * > agent has a real cost that we cannot see; displaying `$0.00` would be a lie,
 * > and displaying nothing would look like a bug.
 *
 * Free, a figure, and unobservable are three different facts, and every one of
 * these tests is about a way to accidentally turn one into another.
 */

import { describe, expect, it } from 'vitest';
import { addCost, costOf, formatCost, sumCost } from '@shared/cost.js';
import type { ProviderUsage, RuntimeCapabilities } from '@shared/types/index.js';

const usage = (over: Partial<ProviderUsage> = {}): ProviderUsage => ({
  inputTokens: 1_000_000,
  outputTokens: 1_000_000,
  ...over,
});

type Econ = Pick<RuntimeCapabilities, 'pricing' | 'costReporting'>;
const PRICED: Econ = {
  pricing: { inputPerMTok: 3, outputPerMTok: 15, currency: 'USD' },
  costReporting: 'per-request',
};

describe('pricing a turn', () => {
  it('multiplies published rates by tokens', () => {
    expect(costOf(usage(), PRICED)).toBeCloseTo(18, 10);
  });

  it('calls a local model free, which is a figure and not an absence', () => {
    // Zero is a real answer for a model running on your own machine, and it must
    // not read the same as "we cannot tell".
    expect(costOf(usage(), { pricing: 'free', costReporting: 'per-request' })).toBe(0);
  });

  it('says unknown when the provider will not price it', () => {
    expect(costOf(usage(), { pricing: 'opaque', costReporting: 'per-request' })).toBe('unknown');
  });

  it('says unknown when nobody filled the capability in', () => {
    expect(costOf(usage(), { costReporting: 'per-request' })).toBe('unknown');
  });

  it('lets unobservable beat a published price', () => {
    /**
     * The §10 row that matters, and the ordering that makes it work. Pricing and
     * `costReporting` answer different questions: what a token costs, and
     * whether we can see how many were spent. A CLI under somebody's
     * subscription may have a perfectly public price list and we still cannot
     * say what this turn cost.
     */
    expect(costOf(usage(), { ...PRICED, costReporting: 'none' })).toBe('unknown');
  });
});

describe('cached tokens are priced, because they are priced differently', () => {
  it('bills cache reads at their own rate when one is published', () => {
    const cost = costOf(usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), {
      pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, currency: 'USD' },
      costReporting: 'per-request',
    });
    expect(cost).toBeCloseTo(0.3, 10);
  });

  it('bills cache writes at their own rate too', () => {
    const cost = costOf(usage({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }), {
      pricing: { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, currency: 'USD' },
      costReporting: 'per-request',
    });
    expect(cost).toBeCloseTo(3.75, 10);
  });

  it('falls back to the input rate where the price list omits them', () => {
    // Which is what a provider that does not price them separately charges.
    const cost = costOf(usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), PRICED);
    expect(cost).toBeCloseTo(3, 10);
  });

  it('would have been wrong with the old single field', () => {
    /**
     * The reason `cachedInputTokens` was split. One number cannot carry two
     * prices, so a cost built on it is wrong by however the caller happened to
     * use the cache — reads are far cheaper than input, writes dearer. Here the
     * same token count costs an order of magnitude apart.
     */
    const econ: Econ = {
      pricing: {
        inputPerMTok: 3,
        outputPerMTok: 15,
        cacheReadPerMTok: 0.3,
        cacheWritePerMTok: 3.75,
        currency: 'USD',
      },
      costReporting: 'per-request',
    };
    const read = costOf(usage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }), econ);
    const write = costOf(usage({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }), econ);

    expect(read).not.toBeCloseTo(write as number, 2);
  });

  it('treats an absent count as absent, not as zero-cost certainty', () => {
    // A provider that does not report cache tokens is not a provider that used
    // none. The figure is still the best available, but the fields stay optional
    // so nothing downstream can claim otherwise.
    expect(costOf(usage(), PRICED)).toBeCloseTo(18, 10);
  });
});

describe('adding costs, where not knowing is contagious', () => {
  it('sums two figures', () => {
    expect(addCost(1.5, 2.25)).toBeCloseTo(3.75, 10);
  });

  it('lets one unknown poison the total', () => {
    /**
     * A session that spent $2 on one agent and an unobservable amount on another
     * did not spend $2. Reporting it as $2 is a *smaller* number than the truth,
     * which is the one direction a cost figure must never be wrong in.
     */
    expect(addCost(2, 'unknown')).toBe('unknown');
    expect(addCost('unknown', 2)).toBe('unknown');
    expect(sumCost([1, 2, 'unknown', 4])).toBe('unknown');
  });

  it('sums an empty list to free rather than to unknown', () => {
    // Nothing spent is a known amount. Starting at `unknown` would make every
    // fresh session claim its cost was unobservable.
    expect(sumCost([])).toBe(0);
  });
});

describe('how it reads on screen', () => {
  it('says the sentence §10 asks for', () => {
    expect(formatCost('unknown')).toBe('cost not visible to Agbrte');
  });

  it('says free rather than $0.00', () => {
    // `$0.00` is the number a broken price table produces. `free` is a claim
    // somebody made on purpose.
    expect(formatCost(0)).toBe('free');
  });

  it('keeps four places on a fraction of a cent', () => {
    // Agent turns are routinely worth less than a cent, and `$0.00` on a real
    // charge is the same lie in smaller type.
    expect(formatCost(0.0034)).toBe('$0.0034');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});
