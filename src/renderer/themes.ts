/**
 * The palettes this interface can wear (DESIGN.md §4.1, §14).
 *
 * One theme shipped for a long time and the reasoning behind it is in
 * `styles.css` at length. None of that reasoning is a preference, and that is
 * what makes a theme picker a narrower feature than it sounds: the palette is
 * **functional**, so what a theme may vary is smaller than what it may not.
 *
 * ## What every theme here holds fixed, and why
 *
 * - **Greyscale surfaces and exactly one accent.** Four sessions all waiting on a
 *   person once drew four orange-outlined cards under a heading that already said
 *   "Needs you", so the loudest thing on screen was the thing every card had in
 *   common. Neutral is the resting state of the whole interface, and that is what
 *   makes a single mark of colour mean anything.
 * - **Amber asks, red warns.** §4.1 requires a pause and a failure never to blur,
 *   and greyscale cannot hold that distinction. So `paused` is the accent and
 *   `fail` is a red, in every theme.
 * - **A ground that is not blue-tinted.** This is the one that rules a whole
 *   family out. The interface used to be Tokyo Night and moved off it
 *   deliberately: a blue ground makes an amber signal read as a colour clash,
 *   where on a neutral ground it reads as a lamp coming on. So the grounds below
 *   range from warm to near-black to faintly cool, and none of them is blue.
 *
 * What a theme varies is the temperature of the neutrals and how far apart the
 * surfaces sit. That is enough to change how the program feels and not enough to
 * change what its colours mean.
 *
 * ## Every one of these is measured, and a test enforces it
 *
 * `themes.test.ts` walks every palette and checks each colour that carries text
 * against that palette's own ground. This is the project's own rule made into a
 * gate rather than a paragraph: the first `fail` red ever chosen here looked
 * right and measured 4.30:1, under AA, on the one state a person most needs to
 * read. One palette drifting like that is a bug; four palettes maintained by hand
 * is that bug waiting to happen four times.
 */

/** The tokens a theme sets. Every one of them overrides a `@theme` default. */
export interface Palette {
  /** Behind the raised things: the terminal, code, the deepest surface. */
  sunken: string;
  /** The window's ground. */
  bg: string;
  /** A surface holding content, one step up from the ground. */
  panel: string;
  /** A surface on a panel: cards, the composer's bubble. */
  raised: string;
  /** Borders. Not text, and still has to be findable. */
  line: string;
  ink: string;
  muted: string;
  /** Focus, the active control, and a session that needs a person. */
  accent: string;
  /** The one thing allowed to disagree with the accent (§4.1). */
  fail: string;
  /** The user's own message. */
  bubble: string;
  /** That bubble's edge, and the terminal's selection. */
  edge: string;
}

export interface Theme {
  id: string;
  label: string;
  /** One line, shown beside the name: what it is for, not what it looks like. */
  hint: string;
  palette: Palette;
}

/**
 * The default, and the values in `styles.css`'s `@theme` block.
 *
 * Duplicated deliberately and guarded by a test. The stylesheet needs literals
 * because Tailwind reads them at build time; this module needs them because the
 * picker sets them at run time. Two copies of one fact is one that gets updated
 * and one that does not, so `themes.test.ts` reads the stylesheet and fails if
 * they ever disagree.
 */
const WARM: Palette = {
  sunken: '#0f0e0c',
  bg: '#151412',
  panel: '#1e1c18',
  raised: '#282520',
  line: '#37332c',
  ink: '#f2ece0',
  muted: '#b3aa96',
  accent: '#ee9633',
  fail: '#e4766a',
  bubble: '#282520',
  edge: '#443f35',
};

/**
 * The same structure with the warmth taken out.
 *
 * True greys, to a channel spread of zero. It is the plainest of the three and
 * the one that makes the amber read loudest, because there is nothing else on
 * screen with a hue in it at all.
 */
const GRAPHITE: Palette = {
  sunken: '#0c0c0c',
  bg: '#121212',
  panel: '#1b1b1b',
  raised: '#252525',
  line: '#343434',
  ink: '#f0f0f0',
  muted: '#a9a9a9',
  accent: '#ee9633',
  fail: '#e4766a',
  bubble: '#252525',
  edge: '#3f3f3f',
};

/**
 * Black where black is free.
 *
 * For an OLED panel, where a zero pixel is an unlit pixel rather than a dark
 * one — and for anybody who works at night. The surfaces are pushed further
 * apart than elsewhere to compensate: on a ground this dark the usual steps stop
 * being visible, and a panel whose edge cannot be found is a panel that reads as
 * part of the window behind it.
 */
const MIDNIGHT: Palette = {
  sunken: '#000000',
  bg: '#070707',
  panel: '#131313',
  raised: '#1e1e1e',
  line: '#333333',
  ink: '#f4f4f4',
  muted: '#a6a6a6',
  accent: '#f09a37',
  fail: '#e77a6e',
  bubble: '#1e1e1e',
  edge: '#3d3d3d',
};

/**
 * Cool, and deliberately stopping well short of blue.
 *
 * The rule this comes closest to breaking is the one about a blue ground and an
 * amber signal, so it is built to stay on the right side of it: the channel
 * spread here is a handful of levels, not the thirty-odd of a Tokyo Night or a
 * Nord. The effect is graphite that has been left out in the cold rather than a
 * blue theme, and the amber still reads as a lamp against it.
 */
const SLATE: Palette = {
  sunken: '#0b0c0e',
  bg: '#101214',
  panel: '#191c1f',
  raised: '#232729',
  line: '#333a3e',
  ink: '#eef1f2',
  muted: '#a4adb2',
  accent: '#ee9633',
  fail: '#e4766a',
  bubble: '#232729',
  edge: '#3d4448',
};

export const THEMES: readonly Theme[] = [
  { id: 'warm', label: 'Warm', hint: 'Cream on a warm neutral. The default.', palette: WARM },
  { id: 'graphite', label: 'Graphite', hint: 'True greys, nothing but the accent.', palette: GRAPHITE },
  { id: 'midnight', label: 'Midnight', hint: 'Black grounds, for an OLED panel.', palette: MIDNIGHT },
  { id: 'slate', label: 'Slate', hint: 'Cool greys, a shade off neutral.', palette: SLATE },
];

export const DEFAULT_THEME = 'warm';

export function themeById(id: string | null | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? (THEMES[0] as Theme);
}

/**
 * The CSS custom properties one palette sets, by their Tailwind names.
 *
 * Kept here rather than in the stylesheet because the stylesheet cannot hold
 * four of them without four copies of the same list — and a fifth theme would
 * be a fifth. Setting the variables on the root element overrides `@theme`'s
 * `:root` block, which is exactly what a variable is for.
 */
export function cssVariables(palette: Palette): Record<string, string> {
  return {
    '--color-sunken': palette.sunken,
    '--color-bg': palette.bg,
    '--color-panel': palette.panel,
    '--color-raised': palette.raised,
    '--color-line': palette.line,
    '--color-ink': palette.ink,
    '--color-muted': palette.muted,
    '--color-accent': palette.accent,
    '--color-state-paused': palette.accent,
    '--color-state-fail': palette.fail,
    // Finished is not an event: it reads as ordinary text and is `muted` in use.
    // Kept as a token so the state map stays total rather than falling through.
    '--color-state-done': palette.muted,
    '--color-user-bubble': palette.bubble,
    '--color-user-edge': palette.edge,
  };
}
