/**
 * How many terminal columns a string takes.
 *
 * Needed by anything that puts the cursor somewhere after drawing text: the
 * agent's input line redraws itself on every key, and a line that counted one
 * column per character put the cursor in the middle of what somebody had typed
 * the moment it held Korean, Chinese or Japanese — each of those characters is
 * two columns wide. Written here rather than taken from a package: the rule is
 * Unicode's East Asian Width, and the ranges that matter for an input line fit
 * on a screen.
 */

/** Wide (two-column) ranges: Hangul, CJK, kana, fullwidth forms, and the emoji planes. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo initial consonants
  [0x2e80, 0x303e], // CJK radicals, punctuation
  [0x3041, 0x33ff], // kana, CJK symbols, compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa960, 0xa97f], // Hangul Jamo extended A
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // fullwidth forms
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], // pictographs, emoticons
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd], // CJK extensions B and beyond
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/** The columns one code point takes: 0 for combining marks and controls, 2 for wide, else 1. */
export function charWidth(cp: number): number {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  // Combining marks and zero-width joiners draw on the character before them.
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfe0f) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** The columns `text` takes, ignoring escape sequences. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Remove SGR and other CSI sequences, and OSC sequences such as hyperlinks. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)/gu, '');
}
