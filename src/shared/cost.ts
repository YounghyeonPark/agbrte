/**
 * What a turn cost, or an honest admission that we cannot tell (DESIGN.md §10).
 *
 * > The third row must say so rather than showing zero. A subscription-backed
 * > agent has a real cost that we cannot see; displaying `$0.00` would be a lie,
 * > and displaying nothing would look like a bug.
 *
 * That sentence is the whole of this module. Three values have to stay distinct
 * and it is very easy to collapse two of them:
 *
 *  - **zero** — a local model, which genuinely costs nothing per token
 *  - **a figure** — a published price and a token count
 *  - **`'unknown'`** — a cost exists and is not observable from here
 *
 * A number type with an optional field collapses the third into the first the
 * moment anybody sums a list, which is why `Cost` is a union and why addition
 * is a function rather than `+`.
 */

import type { ProviderUsage, RuntimeCapabilities } from './types/index.js';

/** A figure, or the admission that there is not one. */
export type Cost = number | 'unknown';

/**
 * Add two costs, where not knowing is contagious.
 *
 * Unknown wins, always. A session that spent $2 on one agent and an unobservable
 * amount on another did not spend $2 — reporting it as $2 is a smaller number
 * than the truth, which is the direction a cost figure must never be wrong in.
 */
export function addCost(a: Cost, b: Cost): Cost {
  if (a === 'unknown' || b === 'unknown') return 'unknown';
  return a + b;
}

export function sumCost(costs: readonly Cost[]): Cost {
  return costs.reduce<Cost>(addCost, 0);
}

/**
 * Price a turn.
 *
 * `costReporting: 'none'` is checked **first and overrides pricing**, because
 * the two answer different questions: pricing is what a token costs, and
 * `costReporting` is whether we can see how many were spent. A CLI running under
 * somebody's subscription may well have a published per-token price, and we
 * still cannot say what this turn cost — §10's third row exactly.
 */
export function costOf(
  usage: ProviderUsage,
  caps: Pick<RuntimeCapabilities, 'pricing' | 'costReporting'>,
): Cost {
  if (caps.costReporting === 'none') return 'unknown';

  const { pricing } = caps;
  if (pricing === 'free') return 0;
  // `'opaque'` and absent are the same answer here and deliberately not
  // collapsed at the type: `'opaque'` is a provider saying it will not tell us,
  // absent is a capability nobody filled in, and the matrix (§3.13) shows those
  // differently even though the cost is unknown either way.
  if (pricing === undefined || pricing === 'opaque') return 'unknown';

  const perM = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

  // Cached tokens fall back to the input rate when the price list does not break
  // them out — which is what a provider that does not price them separately
  // actually charges. Where they *are* priced separately, guessing would be
  // wrong in whichever direction the cache was used.
  const cacheRead = pricing.cacheReadPerMTok ?? pricing.inputPerMTok;
  const cacheWrite = pricing.cacheWritePerMTok ?? pricing.inputPerMTok;

  return (
    perM(usage.inputTokens, pricing.inputPerMTok) +
    perM(usage.outputTokens, pricing.outputPerMTok) +
    perM(usage.cacheReadTokens ?? 0, cacheRead) +
    perM(usage.cacheWriteTokens ?? 0, cacheWrite)
  );
}

/**
 * How a cost should read on screen (§10).
 *
 * Here rather than in a component because the rule is a design decision, not a
 * formatting preference, and two surfaces showing it differently would put the
 * lie back.
 */
export function formatCost(cost: Cost, currency = 'USD'): string {
  if (cost === 'unknown') return 'cost not visible to Agbrte';
  if (cost === 0) return 'free';
  // Four places, because agent turns are routinely worth fractions of a cent and
  // `$0.00` on a real charge is the same lie in smaller type.
  const places = cost < 0.01 ? 4 : 2;
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${cost.toFixed(places)}`;
}
