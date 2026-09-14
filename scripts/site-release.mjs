/**
 * Write what shipped into the landing page, at deploy time.
 *
 * The page carries a version, the list of what changed, and a download button
 * per artifact. All three are **markup**, written here and served as HTML —
 * not fetched from the GitHub API by a script in the visitor's browser.
 *
 * Three reasons, in the order they mattered:
 *
 * 1. The API is rate-limited per source address. A limit reached is an empty box
 *    where the version should be, on a page whose one job at that moment is to
 *    tell somebody what they are about to download.
 * 2. A page that needs JavaScript to say what it is says nothing when the script
 *    fails, and that is the moment a visitor is deciding whether to trust it.
 * 3. The deploy already knows. Asking the network at read time is asking twice.
 *
 * The cost is that the page is right as of the last deploy rather than as of
 * this second, which is why `pages.yml` builds on `release: published`. Those are
 * the same instant.
 *
 * ## It fails loudly, and that is the whole point of the markers
 *
 * A replacement that silently does nothing leaves a landing page confidently
 * advertising the release before last — the exact failure `release.yml` already
 * spends a paragraph on about installers. So every marker is required, every
 * pattern that matches nothing is an error, and a release with no downloadable
 * artifact is refused rather than rendered as a page with no buttons.
 */

/** What the page promises to hold open for this script. */
const REGIONS = ['RELEASE', 'DOWNLOADS'];

/**
 * The artifacts worth a button, and what to call each one.
 *
 * Anchored rather than loose. `Agbrte-0.0.38.dmg` and `Agbrte-0.0.38-arm64.dmg`
 * differ by one segment, and a pattern matching the first inside the second
 * would offer an Intel Mac a build that will not start on it — which is a
 * control that fails after the download rather than on press, and therefore
 * worse than one that fails immediately.
 *
 * `os` is what the browser can actually recognise about itself. Both Mac entries
 * carry `mac`, because Safari on an M-series machine still reports `Intel`: the
 * honest answer is to mark the platform and let the two files say which is which.
 */
const WANTED = [
  { os: 'windows', label: 'Windows', match: /^Agbrte-Setup-[\d.]+\.exe$/u },
  { os: 'mac', label: 'macOS · Apple silicon', match: /^Agbrte-[\d.]+-arm64\.dmg$/u },
  { os: 'mac', label: 'macOS · Intel', match: /^Agbrte-[\d.]+\.dmg$/u },
  { os: 'linux', label: 'Linux · AppImage', match: /^Agbrte-[\d.]+\.AppImage$/u },
  { os: 'linux', label: 'Linux · AppImage, arm64', match: /^Agbrte-[\d.]+-arm64\.AppImage$/u },
  { os: 'linux', label: 'Debian or Ubuntu', match: /^agbrte_[\d.]+_amd64\.deb$/u },
];

/** How many changes the first screen carries before it stops being a first screen. */
const MAX_CHANGES = 6;

export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/**
 * A commit title as one line of HTML.
 *
 * Escaped first and marked up second, which is the only safe order: doing it the
 * other way round would escape the tags this function just wrote. The backtick
 * spans are worth keeping because this repository's commit titles use them for
 * identifiers — "Call the remote screen `Display`" reads as a sentence about a
 * label only when the label looks like one.
 */
export function inlineMarkup(text) {
  return escapeHtml(text).replace(/`([^`]+)`/gu, '<code class="mono">$1</code>');
}

/**
 * The bullets under `## What changed`.
 *
 * Read out of the release body rather than recomputed from the git log, because
 * `release.yml` already derived them there and two derivations of one list is
 * one that gets fixed and one that does not. Stops at the next heading: the
 * sections after it are about downloads and signing, which this page says in its
 * own words.
 */
export function changesFrom(body) {
  const lines = String(body ?? '').split(/\r?\n/u);
  const start = lines.findIndex((line) => /^##\s+What changed\s*$/u.test(line.trim()));
  if (start === -1) return [];

  const found = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) break;
    if (trimmed.startsWith('- ')) found.push(trimmed.slice(2).trim());
  }
  return found;
}

/**
 * A date a reader cannot misread.
 *
 * Spelled out rather than numeric, because `09/14` and `14/09` are the same six
 * characters to two different readers and this is the one number on the page
 * that says how recently the project moved.
 */
export function readableDate(iso) {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(when);
}

/** Replace one marked region, or say which marker was missing. */
export function replaceRegion(html, name, body) {
  const open = `<!-- ${name}:BEGIN -->`;
  const close = `<!-- ${name}:END -->`;
  const from = html.indexOf(open);
  const to = html.indexOf(close);
  if (from === -1) throw new Error(`the page has no ${open} marker`);
  if (to === -1) throw new Error(`the page has no ${close} marker`);
  if (to < from) throw new Error(`${close} comes before ${open} in the page`);
  return html.slice(0, from + open.length) + body + html.slice(to);
}

function releaseHtml(release) {
  const changes = changesFrom(release.body).slice(0, MAX_CHANGES);
  const when = readableDate(release.publishedAt);
  /*
   * A release whose notes have no `What changed` section is rendered without the
   * list rather than with an empty one. `release.yml` omits that heading on
   * purpose when there is no previous tag to measure from, and an empty list
   * under it would say something false about the build.
   */
  const items =
    changes.length === 0
      ? ''
      : `\n      <ul>\n${changes
          .map((change) => `        <li>${inlineMarkup(change)}</li>`)
          .join('\n')}\n      </ul>`;

  return `
    <div class="release" id="release">
      <div class="release-head">
        <span class="release-version">${escapeHtml(release.tag)}</span>
        <span class="release-when">${escapeHtml(when)}</span>
        <span class="release-tag">What changed</span>
      </div>${items}
      <a class="release-more" href="${escapeHtml(release.url)}">All of it, with the reasoning &rarr;</a>
    </div>
  `;
}

function downloadsHtml(release) {
  const assets = release.assets ?? [];
  const tiles = [];
  for (const want of WANTED) {
    const asset = assets.find((a) => want.match.test(a.name));
    // Skipped rather than linked to a guess. A composed URL for an artifact this
    // build did not produce is a button that answers 404 on GitHub, which this
    // page cannot explain and did not have to promise.
    if (asset === undefined) continue;
    tiles.push(
      `      <a class="dl" data-os="${want.os}" href="${escapeHtml(asset.url)}">\n` +
        `        <span class="os">${escapeHtml(want.label)}</span>` +
        `<span class="file">${escapeHtml(asset.name)}</span>\n` +
        `      </a>`,
    );
  }

  if (tiles.length === 0) {
    throw new Error(
      `release ${release.tag} has no artifact this page knows how to offer — ` +
        `assets were: ${assets.map((a) => a.name).join(', ') || '(none)'}`,
    );
  }

  return `\n    <div class="downloads" id="downloads">\n${tiles.join('\n')}\n    </div>\n    `;
}

/** The page with this release written into it. */
export function bake(html, release) {
  for (const name of REGIONS) {
    if (!html.includes(`<!-- ${name}:BEGIN -->`)) throw new Error(`the page has no ${name} region`);
  }
  let out = replaceRegion(html, 'RELEASE', releaseHtml(release));
  out = replaceRegion(out, 'DOWNLOADS', downloadsHtml(release));
  return out;
}

/**
 * Shape the `gh release view --json …` answer into what `bake` takes.
 *
 * Separate from `bake` so the interesting half is testable without a network or
 * a `gh`: this function knows the API's field names and nothing else does.
 */
export function fromGh(payload) {
  return {
    tag: payload.tagName,
    url: payload.url,
    publishedAt: payload.publishedAt,
    body: payload.body ?? '',
    assets: (payload.assets ?? []).map((a) => ({ name: a.name, url: a.url })),
  };
}

// --------------------------------------------------------------------- cli

/*
 * `node scripts/site-release.mjs <release.json> <page.html>`, editing the page
 * in place. Run by `pages.yml` against the assembled copy under `site/`, never
 * against `docs/` — the version in the repository stays hand-written, so the
 * file is a working page on its own and a diff of it is about the page rather
 * than about whatever shipped that day.
 */
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const [, , releasePath, pagePath] = process.argv;
  if (releasePath === undefined || pagePath === undefined) {
    console.error('usage: node scripts/site-release.mjs <release.json> <page.html>');
    process.exit(2);
  }

  const release = fromGh(JSON.parse(readFileSync(releasePath, 'utf8')));
  const page = readFileSync(pagePath, 'utf8');
  writeFileSync(pagePath, bake(page, release), 'utf8');
  console.log(`wrote ${release.tag} into ${pagePath}`);
}
