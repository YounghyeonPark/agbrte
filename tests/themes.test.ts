/**
 * Every palette, measured (DESIGN.md §4.1, §14).
 *
 * `styles.css` argues at length that contrast is the property of a palette that
 * confident visual judgement is worst at, and it has the scar to prove it: the
 * first `fail` red chosen here looked right and measured 4.30:1 — under AA, on
 * the one state a person most needs to be able to read. That was one palette,
 * checked by hand, once.
 *
 * A theme picker makes it four palettes maintained by hand, which is that bug
 * waiting to happen four times. So the rule stops being a paragraph and becomes
 * a gate: every colour that carries text, against its own theme's ground.
 *
 * The floors are the ones the shipped palette already clears rather than the
 * bare standard. A new theme that merely scraped AA would pass a WCAG check and
 * still be the dingiest thing in the list — which is exactly the complaint that
 * started this work.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cssVariables, DEFAULT_THEME, THEMES, themeById } from '../src/renderer/themes.js';

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

/** How far a colour leans from grey, and which way. */
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

describe('every theme is legible on its own ground', () => {
  for (const theme of THEMES) {
    describe(theme.label, () => {
      const p = theme.palette;
      // Three grounds, because a card sits on a panel and a panel sits on the
      // window: text that clears the darkest and fails the lightest is text that
      // fails wherever it is actually read.
      const grounds = [p.sunken, p.bg, p.panel] as const;

      it('carries body text well past AA', () => {
        /*
         * Seven, not 4.5. `muted` carries most of the text on every screen, and
         * it sat at 5.39:1 for a long time — over AA, under AAA, and in the band
         * where text stops looking read and starts looking grey. That measurement
         * is what "the interface looks drab" turned out to mean, so the floor is
         * set above it on purpose.
         *
         * Against `panel` too, which is the strictest of the three and the one a
         * card's own text is actually on.
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
        /*
         * §4.1: a pause and a failure must never blur. Both are read as text, and
         * `fail` is the one somebody most needs to be able to read — it was under
         * AA once and the comment in `styles.css` still records it.
         */
        for (const ground of grounds) {
          expect(contrast(p.accent, ground), `accent on ${ground}`).toBeGreaterThanOrEqual(5.5);
          expect(contrast(p.fail, ground), `fail on ${ground}`).toBeGreaterThanOrEqual(4.6);
        }
      });

      it('keeps the two signals apart from each other', () => {
        // Not a contrast requirement — a hue one. Amber and red at the same
        // lightness on the same ground is exactly the blur §4.1 forbids, and a
        // reader who cannot tell them apart has lost the distinction whatever
        // the label says.
        const red = parseInt(p.fail.slice(1, 3), 16) - parseInt(p.fail.slice(3, 5), 16);
        const amber = parseInt(p.accent.slice(1, 3), 16) - parseInt(p.accent.slice(3, 5), 16);
        expect(Math.abs(amber - red), `${theme.id}: accent and fail are too close in hue`)
          .toBeGreaterThan(20);
      });

      it('gives a border enough to be found', () => {
        // Not text, so there is no WCAG figure for it — and a panel whose edge
        // cannot be found reads as part of the window behind it, which is a real
        // complaint this palette has already had.
        expect(contrast(p.line, p.panel), `line on panel`).toBeGreaterThanOrEqual(1.3);
        expect(contrast(p.edge, p.bubble), `edge on bubble`).toBeGreaterThanOrEqual(1.25);
      });

      it('stacks its surfaces in the order they are named', () => {
        // `sunken` under `bg` under `panel` under `raised`. A theme that got this
        // backwards would compile, render, and be quietly wrong everywhere a
        // depth is meant to say something.
        const steps = [p.sunken, p.bg, p.panel, p.raised].map(luminance);
        for (let i = 1; i < steps.length; i += 1) {
          expect(steps[i] as number, `${theme.id}: surface ${i} is not above ${i - 1}`)
            .toBeGreaterThan(steps[i - 1] as number);
        }
      });

      it('does not put an amber signal on a blue ground', () => {
        /*
         * The rule that rules out a whole family, and the reason there is no
         * Tokyo Night here. The interface *was* Tokyo Night and moved off it: a
         * blue-tinted ground makes an amber signal read as a colour clash, where
         * on a neutral ground it reads as a lamp coming on.
         *
         * Stated as a bound rather than a ban, because `slate` is deliberately a
         * little cool. What it may not be is *blue* — a handful of levels is a
         * temperature, thirty is a hue.
         */
        for (const ground of [p.bg, p.panel]) {
          if (isBlueLeaning(ground)) {
            expect(spread(ground), `${theme.id}: ${ground} is blue rather than cool`).toBeLessThan(
              12,
            );
          }
        }
      });
    });
  }
});

describe('the default and the stylesheet cannot drift apart', () => {
  it('sets exactly what `@theme` already says', () => {
    /*
     * The one duplication in this feature, and the reason it is safe.
     *
     * Tailwind reads `styles.css` at build time and needs literals there; the
     * picker sets variables at run time and needs them here. Two copies of one
     * fact is one that gets updated and one that does not — so this reads the
     * stylesheet and fails if the default theme and the shipped palette ever
     * disagree, which is the only way that drift becomes visible before somebody
     * ships a picker whose "Warm" is not the warm they have been looking at.
     */
    const css = readFileSync('src/renderer/styles.css', 'utf8');
    const block = css.slice(css.indexOf('@theme {'), css.indexOf('@layer base'));
    const declared = new Map<string, string>();
    for (const line of block.split('\n')) {
      const found = /^\s*(--color-[a-z-]+):\s*(#[0-9a-fA-F]{6});/u.exec(line);
      if (found !== null) declared.set(found[1] as string, (found[2] as string).toLowerCase());
    }
    expect(declared.size, 'no colour tokens found in @theme').toBeGreaterThan(8);

    const wanted = cssVariables(themeById(DEFAULT_THEME).palette);
    for (const [name, value] of Object.entries(wanted)) {
      expect(declared.get(name), `${name} in styles.css`).toBe(value.toLowerCase());
    }
  });

  it('names every theme once, with an id a stored preference can survive', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME);
    // Falls back rather than throwing: `localStorage` outlives app versions, so
    // a theme that was removed must land on the default instead of a blank app.
    expect(themeById('a theme that no longer exists').id).toBe(DEFAULT_THEME);
    expect(themeById(null).id).toBe(DEFAULT_THEME);
  });
});
