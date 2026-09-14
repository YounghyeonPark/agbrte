/**
 * Writing what shipped into the landing page (`scripts/site-release.mjs`).
 *
 * Tested because of how it fails rather than because of what it does. A
 * replacement that silently matches nothing leaves a landing page confidently
 * advertising the release before last — and a landing page is the one surface
 * where being quietly wrong costs the most, since the reader has no way to tell
 * and is deciding whether to download something.
 *
 * So the assertions are mostly about refusals: a missing marker, a marker pair
 * in the wrong order, a release with no artifact this page knows how to offer.
 * The one about escaping is not theatre either — commit titles are free text
 * written by a person, and this repository's own titles contain backticks and
 * the occasional `&`.
 */

import { describe, expect, it } from 'vitest';
/*
 * On one line because the directive below covers exactly one, which is the
 * convention `catalogueMerge.test.ts` already follows: a deploy script is JS
 * with no declarations, and putting it under `src/` to get types would make a
 * build artifact out of something that only ever runs in CI.
 */
// @ts-expect-error — a build script, JS with no types, imported for its logic.
import { bake, changesFrom, escapeHtml, fromGh, inlineMarkup, readableDate, replaceRegion } from '../scripts/site-release.mjs';

/** The two regions the page promises to hold open, and nothing else. */
const PAGE = [
  '<html><body>',
  '<!-- RELEASE:BEGIN -->',
  '<div class="release">hand-written fallback</div>',
  '<!-- RELEASE:END -->',
  '<!-- DOWNLOADS:BEGIN -->',
  '<div class="downloads">a placeholder</div>',
  '<!-- DOWNLOADS:END -->',
  '</body></html>',
].join('\n');

const NOTES = [
  '# Agbrte 0.0.38',
  '',
  '## What changed',
  '',
  '- Show the screen of a remote machine',
  '- Call the remote screen `Display`, because `Screen` was taken',
  '',
  '## Which file',
  '',
  '- this line is about downloads and is not a change',
].join('\n');

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tagName: 'v0.0.38',
    url: 'https://github.com/o/r/releases/tag/v0.0.38',
    publishedAt: '2026-09-14T09:00:11Z',
    body: NOTES,
    assets: [
      { name: 'Agbrte-Setup-0.0.38.exe', url: 'https://x/Agbrte-Setup-0.0.38.exe' },
      { name: 'Agbrte-0.0.38.dmg', url: 'https://x/Agbrte-0.0.38.dmg' },
      { name: 'Agbrte-0.0.38-arm64.dmg', url: 'https://x/Agbrte-0.0.38-arm64.dmg' },
      { name: 'Agbrte-0.0.38.AppImage', url: 'https://x/Agbrte-0.0.38.AppImage' },
      { name: 'agbrte_0.0.38_amd64.deb', url: 'https://x/agbrte_0.0.38_amd64.deb' },
      { name: 'SHA256SUMS', url: 'https://x/SHA256SUMS' },
    ],
    ...over,
  };
}

describe('what goes on the first screen', () => {
  it('replaces the hand-written fallback with the real release', () => {
    const out = bake(PAGE, fromGh(release()));

    expect(out).not.toContain('hand-written fallback');
    expect(out).toContain('v0.0.38');
    // Spelled out, because `09/14` and `14/09` are the same six characters to
    // two different readers and this is the number that says how recent it is.
    expect(out).toContain('14 September 2026');
    expect(out).toContain('Show the screen of a remote machine');
    // The markers survive, or the next deploy has nothing to replace.
    expect(out).toContain('<!-- RELEASE:BEGIN -->');
    expect(out).toContain('<!-- RELEASE:END -->');
  });

  it('takes only the changes, not the sections after them', () => {
    /*
     * `## What changed` is followed by `## Which file`, which is also a list of
     * lines beginning with a dash. A reader that stopped at the blank line, or
     * that took every dash in the body, would put the download table on the
     * first screen as if it were a changelog.
     */
    expect(changesFrom(NOTES)).toEqual([
      'Show the screen of a remote machine',
      'Call the remote screen `Display`, because `Screen` was taken',
    ]);
  });

  it('renders nothing rather than an empty list when there were no changes', () => {
    /*
     * `release.yml` omits the heading on purpose for the first tag, where there
     * is nothing to measure from — and an empty "What changed" would say
     * something false about the build.
     */
    const out = bake(PAGE, fromGh(release({ body: '# Agbrte 0.0.1\n\nfirst one' })));
    expect(changesFrom('# Agbrte 0.0.1')).toEqual([]);
    expect(out).not.toContain('<ul>');
    // And the version is still there: no changelog is not no release.
    expect(out).toContain('v0.0.38');
  });
});

describe('the download buttons name files that exist', () => {
  it('offers one per artifact the release actually published', () => {
    const out = bake(PAGE, fromGh(release()));

    expect(out).toContain('Agbrte-Setup-0.0.38.exe');
    expect(out).toContain('agbrte_0.0.38_amd64.deb');
    // Not offered, because this release has none — a composed URL would answer
    // 404 on GitHub, which this page cannot explain and never had to promise.
    expect(out).not.toContain('arm64.AppImage');
    // And the checksums file is not a download button.
    expect(out).not.toContain('SHA256SUMS');
  });

  it('keeps the two Mac builds apart', () => {
    /*
     * `Agbrte-0.0.38.dmg` is a substring of nothing, but `Agbrte-0.0.38` is a
     * prefix of `Agbrte-0.0.38-arm64.dmg` — so a loose pattern hands an Intel
     * Mac a build that will not start on it. That is a control that fails after
     * a 127MB download rather than on press, which is worse than failing at once.
     */
    const out = bake(PAGE, fromGh(release()));
    expect(out).toMatch(/Apple silicon<\/span><span class="file">Agbrte-0\.0\.38-arm64\.dmg</u);
    expect(out).toMatch(/Intel<\/span><span class="file">Agbrte-0\.0\.38\.dmg</u);
    // Both marked `mac`, because Safari on an M-series machine still reports
    // `Intel`: the page marks the platform and lets the files say which is which.
    expect(out.match(/data-os="mac"/gu)).toHaveLength(2);
  });
});

describe('what it refuses, loudly', () => {
  it('refuses a page whose markers are gone', () => {
    /*
     * The failure this file exists for. A silent no-op leaves a page advertising
     * whatever was last baked into it, and nothing anywhere says so — the reader
     * sees a confident version number that happens to be months old.
     */
    expect(() => bake('<html><body>no markers here</body></html>', fromGh(release()))).toThrow(
      /no RELEASE region/u,
    );
    const half = PAGE.replace('<!-- DOWNLOADS:BEGIN -->', '');
    expect(() => bake(half, fromGh(release()))).toThrow(/DOWNLOADS/u);
  });

  it('refuses markers in the wrong order', () => {
    const swapped = [
      '<!-- RELEASE:END -->',
      'the middle',
      '<!-- RELEASE:BEGIN -->',
    ].join('\n');
    expect(() => replaceRegion(swapped, 'RELEASE', 'x')).toThrow(/comes before/u);
  });

  it('refuses a release with nothing to download, naming what it did have', () => {
    const bare = release({ assets: [{ name: 'SHA256SUMS', url: 'https://x/SHA256SUMS' }] });
    expect(() => bake(PAGE, fromGh(bare))).toThrow(/no artifact this page knows/u);
    // Named, so the fix is visible from the failure rather than from the source.
    expect(() => bake(PAGE, fromGh(bare))).toThrow(/SHA256SUMS/u);
  });
});

describe('text written by a person', () => {
  it('escapes a commit title before marking it up, not after', () => {
    /*
     * The order is the whole of it. Marking up first and escaping second would
     * escape the tags this just wrote, and the page would show the word `code`
     * in angle brackets; escaping first and marking up second is the only
     * arrangement where a title containing `<` is safe *and* a backtick span is
     * still a span.
     */
    expect(inlineMarkup('a `Display` & an <img> tag')).toBe(
      'a <code class="mono">Display</code> &amp; an &lt;img&gt; tag',
    );
    expect(escapeHtml('"quoted" & <angled>')).toBe('&quot;quoted&quot; &amp; &lt;angled&gt;');
  });

  it('says nothing for a date it cannot read', () => {
    expect(readableDate('not a date')).toBe('');
    expect(readableDate('2026-01-05T00:00:00Z')).toBe('5 January 2026');
  });
});
