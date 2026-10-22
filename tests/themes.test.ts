/**
 * The palette, measured where it lives (DESIGN.md §4.1, §14).
 *
 * `styles.css` argues at length that contrast is the property of a palette that
 * confident visual judgement is worst at, and it has the scar to prove it: the
 * first `fail` red chosen here looked right and measured 4.30:1 — under AA, on
 * the one state a person most needs to be able to read. That was one palette,
 * checked by hand, once.
 *
 * For a while there were five palettes and this file walked all of them. There
 * is one again — the terminal's navy, white and yellow — and it lives only in
 * the stylesheet's `@theme` block, so that is what is read. The gate stays a
 * gate: a palette that is the only one is also the one every screen is drawn
 * in, and the period's own colours already failed it once (DOS's light red,
 * 4.06:1 on the panel).
 *
 * The floors are the ones the shipped palette clears rather than the bare
 * standard. A palette that merely scraped AA would pass a WCAG check and still
 * look dingy — which is exactly the complaint that started this work.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** WCAG relative luminance, and the ratio between two of them. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** How far a colour leans from grey. */
function spread(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function isBlueLeaning(hex: string): boolean {
  const [r, , b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [
    number,
    number,
    number,
  ];
  return b > r;
}

/** The colour tokens of `@theme`, by name, lowercased. */
function readPalette(): Map<string, string> {
  const css = readFileSync('src/renderer/styles.css', 'utf8');
  const block = css.slice(css.indexOf('@theme {'), css.indexOf('@layer base'));
  const declared = new Map<string, string>();
  for (const line of block.split('\n')) {
    const found = /^\s*--color-([a-z-]+):\s*(#[0-9a-fA-F]{6});/u.exec(line);
    if (found !== null) declared.set(found[1] as string, (found[2] as string).toLowerCase());
  }
  return declared;
}

const tokens = readPalette();
const token = (name: string): string => {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`--color-${name} is not declared in @theme`);
  return value;
};

const p = {
  sunken: token('sunken'),
  bg: token('bg'),
  panel: token('panel'),
  raised: token('raised'),
  line: token('line'),
  ink: token('ink'),
  muted: token('muted'),
  accent: token('accent'),
  paused: token('state-paused'),
  fail: token('state-fail'),
  bubble: token('user-bubble'),
  edge: token('user-edge'),
};

// Three grounds, because a card sits on a panel and a panel sits on the window:
// text that clears the darkest and fails the lightest is text that fails
// wherever it is actually read.
const grounds = [p.sunken, p.bg, p.panel] as const;

describe('the palette is legible on its own grounds', () => {
  it('carries body text well past AA', () => {
    /*
     * Six and a half, not 4.5. `muted` carries most of the text on every screen,
     * and it sat at 5.39:1 for a long time — over AA, under AAA, and in the band
     * where text stops looking read and starts looking grey. That measurement is
     * what "the interface looks drab" turned out to mean.
     */
    for (const ground of grounds) {
      expect(contrast(p.muted, ground), `muted on ${ground}`).toBeGreaterThanOrEqual(6.5);
    }
  });

  it('keeps the heading text far above everything else', () => {
    for (const ground of grounds) {
      expect(contrast(p.ink, ground), `ink on ${ground}`).toBeGreaterThanOrEqual(12);
    }
  });

  it('makes the two signals readable, the warning most of all', () => {
    // §4.1: a pause and a failure must never blur. Both are read as text, and
    // `fail` is the one somebody most needs to be able to read.
    for (const ground of grounds) {
      expect(contrast(p.accent, ground), `accent on ${ground}`).toBeGreaterThanOrEqual(5.5);
      expect(contrast(p.fail, ground), `fail on ${ground}`).toBeGreaterThanOrEqual(4.6);
    }
  });

  it('keeps the two signals apart from each other', () => {
    // Not a contrast requirement — a hue one. Two signals at one lightness on
    // one ground with nearly one hue is exactly the blur §4.1 forbids.
    const red = parseInt(p.fail.slice(1, 3), 16) - parseInt(p.fail.slice(3, 5), 16);
    const highlight = parseInt(p.accent.slice(1, 3), 16) - parseInt(p.accent.slice(3, 5), 16);
    expect(Math.abs(highlight - red), 'accent and fail are too close in hue').toBeGreaterThan(20);
  });

  it('uses the accent as the one signal that asks', () => {
    // There is one accent and it is the colour of "this needs you". A paused
    // state drawn in anything else would be a second accent by the back door.
    expect(p.paused).toBe(p.accent);
  });

  it('gives a border enough to be found', () => {
    expect(contrast(p.line, p.panel), 'line on panel').toBeGreaterThanOrEqual(1.3);
    expect(contrast(p.edge, p.bubble), 'edge on bubble').toBeGreaterThanOrEqual(1.25);
  });

  it('stacks its surfaces in the order they are named', () => {
    // `sunken` under `bg` under `panel` under `raised`. Backwards would compile,
    // render, and be quietly wrong everywhere a depth is meant to say something.
    const steps = [p.sunken, p.bg, p.panel, p.raised].map(luminance);
    for (let i = 1; i < steps.length; i += 1) {
      expect(steps[i] as number, `surface ${i} is not above ${i - 1}`).toBeGreaterThan(
        steps[i - 1] as number,
      );
    }
  });

  it('puts no ground in the blue-grey band that fights the signal', () => {
    /*
     * The interface *was* Tokyo Night and moved off it: a desaturated blue-grey
     * ground makes an amber signal read as a colour clash. Two kinds of blue
     * ground exist, and only one is that:
     *
     *   - a *tint* — grey leaning blue by a dozen to a few dozen levels, the
     *     Tokyo Night and Nord band, close enough to the accent to fight it;
     *   - a *hue* — saturated navy, sixty levels of spread and more, carrying a
     *     yellow, its complement. That is a dial-up terminal's screen, and the
     *     palette this app now has.
     *
     * Under a dozen levels is a temperature and passes too. What may not exist
     * is the band in between, or a saturated blue carrying anything but yellow.
     */
    const [ar, ag, ab] = [1, 3, 5].map((at) => parseInt(p.accent.slice(at, at + 2), 16)) as [
      number,
      number,
      number,
    ];
    const yellow = Math.abs(ar - ag) <= 16 && ab <= 0x80 && ar >= 0xc0;
    for (const ground of [p.bg, p.panel]) {
      if (!isBlueLeaning(ground)) continue;
      const s = spread(ground);
      if (s < 12) continue;
      expect(s, `${ground} is a blue tint rather than a temperature or a hue`).toBeGreaterThanOrEqual(60);
      expect(yellow, `a saturated blue ground needs a yellow accent, not ${p.accent}`).toBe(true);
    }
  });
});

describe('the literals outside the stylesheet cannot drift from it', () => {
  it('paints the window the palette ground before any CSS exists', () => {
    /*
     * `main.ts` gives Electron a `backgroundColor` for the frames before the
     * renderer loads, and it is a literal because no stylesheet exists yet. Its
     * comment once said "kept in step by hand" and records the time it was not
     * — a cold flash of an old ground on every launch after a restyle walked
     * past it. So the hand is a test.
     */
    const main = readFileSync('src/main/main.ts', 'utf8');
    const painted = /backgroundColor:\s*'(#[0-9a-fA-F]{6})'/u.exec(main)?.[1];
    expect(painted, 'no backgroundColor literal in main.ts').toBeDefined();
    expect(painted?.toLowerCase()).toBe(p.bg);
  });

  it('gives the landing page the same palette', () => {
    // The page reports this program and its screenshots are of it; a second set
    // of colours there would misreport them. Read from its `:root`.
    const page = readFileSync('docs/index.html', 'utf8');
    const root = page.slice(page.indexOf(':root {'), page.indexOf('}', page.indexOf(':root {')));
    for (const [name, value] of [
      ['bg', p.bg],
      ['panel', p.panel],
      ['sunken', p.sunken],
      ['line', p.line],
      ['ink', p.ink],
      ['muted', p.muted],
      ['accent', p.accent],
    ] as const) {
      expect(new RegExp(`--${name}:\\s*${value}`, 'iu').test(root), `--${name} on the landing page`).toBe(
        true,
      );
    }
  });
});
