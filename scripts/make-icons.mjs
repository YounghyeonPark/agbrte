/**
 * Cut the application icon from one piece of geometry.
 *
 * `electron-builder` wants three files and each wants a different composition,
 * which is the trap: hand-editing three exports is how the Windows icon and the
 * macOS icon slowly stop being the same drawing. Here the mark is defined once,
 * the two compositions are a function of it, and every file is rasterised from
 * that — so they cannot drift.
 *
 * ## The mark
 *
 * A small hollow node, a stub reaching out of it, a gap, and a larger solid one.
 * The hollow node near is your window — a view. The solid mass far is the host
 * where the work actually is. **The gap is the idea**: the link is allowed to
 * drop and the far side keeps running, which is the one thing this program does
 * that a picture of a connected line would say the opposite of.
 *
 * The near node used to be the solid one. That put the substance where the
 * person is standing, which is backwards.
 *
 * ## Why there is only one stub
 *
 * There were two. The right one sat at x=36..43 against a disc whose left edge
 * is at 38, so **two units of it were visible** — a stub 0.5 px wide at 16 px —
 * and the gap it was supposed to define was really 11 units rather than the 9 it
 * was drawn to. A mass does not need a stub to look anchored; only the small
 * hollow node does.
 *
 * ## Sizes are not decoration
 *
 * At 16 px one unit of this 64-unit drawing is a quarter of a pixel. A 9-unit
 * gap is 2.25 px and survives; 6 units is 1.5 px and closes, which was measured
 * rather than guessed. Every dimension below is chosen against that render and
 * not against the 1024 one.
 *
 * ## Rendering
 *
 * Through the browser the machine already has — the same detect-don't-bundle
 * choice §12.1 makes for capture. No image library is installed for this, and
 * the `.ico` and `.icns` containers are written here because both are, underneath,
 * a header and some PNGs.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'build');
const work = join(tmpdir(), `agbrte-icons-${process.pid}`);

/** Agbrte's own accent (§10's palette), and the plate the app's window uses. */
const ACCENT = '#7aa2f7';
const PLATE_TOP = '#23233a';
const PLATE_BOTTOM = '#16161a';

/**
 * The mark, in a 64-unit box.
 *
 *   ring outer  6 → 22      stub  19 → 29 (visible from 22)
 *   gap        29 → 38      disc  38 → 58
 */
const MARK = `
  <circle cx="14" cy="32" r="5.75" fill="none" stroke="${ACCENT}" stroke-width="4.5" />
  <rect x="19" y="28.75" width="10" height="6.5" rx="3.25" fill="${ACCENT}" />
  <circle cx="48" cy="32" r="10" fill="${ACCENT}" />
`;

/**
 * @param {number} px
 * @param {'square' | 'squircle'} shape
 */
function svg(px, shape) {
  // macOS icons are inset further than everything else: the tile is the artwork
  // and it sits inside a grid Apple defines, so a mark filling the tile edge to
  // edge looks oversized beside every native app.
  const inset = shape === 'squircle' ? 0.2 : 0.14;
  const markSize = 1 - inset * 2;
  const radius = shape === 'squircle' ? 22.37 : 0;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0.55" y2="1">
      <stop offset="0" stop-color="${PLATE_TOP}" />
      <stop offset="0.62" stop-color="${PLATE_BOTTOM}" />
    </linearGradient>
  </defs>
  <!--
    Full bleed, and it needs nothing special to be.

    I thought it did. Reading the corner pixel of the rendered PNG as RGBA gave
    "34, 34, 57, 1" and I took the 1 for a nearly-transparent edge, added an
    overdraw and then a crispEdges hint to chase it, and neither
    changed the number — because the number was not an alpha. Chrome writes this
    file as **colorType 2**: RGB, no alpha channel, because there is no
    transparency in it to keep. The fourth byte I was reading was the next
    pixel's Paeth residual.

    Two wrong fixes shipped against a measurement I had misread. The squircle is
    colorType 6 and genuinely does carry transparency, which is what made the
    comparison look meaningful.
  -->
  <rect x="0" y="0" width="100" height="100" rx="${radius}" ry="${radius}" fill="url(#plate)" />
  <svg x="${inset * 100}" y="${inset * 100}" width="${markSize * 100}" height="${markSize * 100}" viewBox="0 0 64 64">
    ${MARK}
  </svg>
</svg>`;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((c) => existsSync(c));
  if (found === undefined) {
    throw new Error('no Chrome or Edge found — this script renders through the browser you already have');
  }
  return found;
}

const chrome = findChrome();

/**
 * @param {number} px
 * @param {'square' | 'squircle'} shape
 * @returns {Buffer}
 */
function render(px, shape) {
  const page = join(work, `p-${shape}-${px}.html`);
  const png = join(work, `i-${shape}-${px}.png`);
  writeFileSync(
    page,
    `<!doctype html><meta charset="utf-8">
     <style>html,body{margin:0;padding:0;background:transparent}svg{display:block}</style>
     ${svg(px, shape)}`,
    'utf8',
  );

  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      // Transparent, or the squircle's corners come back black and the whole
      // point of baking the shape in is lost.
      '--default-background-color=00000000',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${px},${px}`,
      `--screenshot=${png}`,
      `--user-data-dir=${join(work, `profile-${shape}-${px}`)}`,
      pathToFileURL(page).href,
    ],
    { stdio: 'ignore', timeout: 60_000 },
  );

  const bytes = readFileSync(png);
  // A screenshot that silently produced nothing is worse than a crash: the icon
  // would ship as a valid file containing a blank square.
  if (bytes.length < 200) throw new Error(`render at ${px}px produced ${bytes.length} bytes`);
  return bytes;
}

/**
 * Pack PNGs into an `.ico`.
 *
 * A 6-byte header, one 16-byte directory entry each, then the payloads. Windows
 * has accepted PNG inside ICO since Vista, so no bitmap conversion is needed —
 * which is the only reason writing this by hand is reasonable.
 */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    // 256 is written as 0: the field is one byte and 256 does not fit.
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += data.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

/**
 * Pack PNGs into an `.icns`.
 *
 * `icns` + total length, then typed chunks. The type code *is* the size — macOS
 * does not read the PNG header to find out — so a payload filed under the wrong
 * code is an icon that renders at the wrong scale with no error anywhere.
 */
function icns(images) {
  const chunks = images.map(({ type, data }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

// ---------------------------------------------------------------------------

mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });

try {
  console.log(`rendering through ${chrome}\n`);

  // Full bleed for Windows and Linux.
  const square = new Map();
  for (const px of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    square.set(px, render(px, 'square'));
    console.log(`  square   ${String(px).padStart(4)}  ${square.get(px).length} bytes`);
  }

  // The rounded tile for macOS, which does not mask icons the way iOS does.
  const round = new Map();
  for (const px of [32, 64, 128, 256, 512, 1024]) {
    round.set(px, render(px, 'squircle'));
    console.log(`  squircle ${String(px).padStart(4)}  ${round.get(px).length} bytes`);
  }

  writeFileSync(join(out, 'icon.png'), square.get(1024));

  writeFileSync(
    join(out, 'icon.ico'),
    ico([16, 24, 32, 48, 64, 128, 256].map((size) => ({ size, data: square.get(size) }))),
  );

  writeFileSync(
    join(out, 'icon.icns'),
    icns([
      { type: 'ic11', data: round.get(32) }, //  16pt @2x
      { type: 'ic12', data: round.get(64) }, //  32pt @2x
      { type: 'ic07', data: round.get(128) },
      { type: 'ic13', data: round.get(256) }, // 128pt @2x
      { type: 'ic08', data: round.get(256) },
      { type: 'ic14', data: round.get(512) }, // 256pt @2x
      { type: 'ic09', data: round.get(512) },
      { type: 'ic10', data: round.get(1024) }, // 512pt @2x
    ]),
  );

  console.log('\nwrote build/icon.png, build/icon.ico, build/icon.icns');
} finally {
  rmSync(work, { recursive: true, force: true });
}
