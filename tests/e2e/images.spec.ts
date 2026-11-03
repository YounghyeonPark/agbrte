/**
 * Pictures in the terminal (DESIGN.md §17 Q24, step 3), through the real app,
 * a real host and a real shell.
 *
 * A script in the tab's own shell prints one picture in each protocol — iTerm2,
 * sixel and kitty (in chunks) — the way `imgcat`, `img2sixel` and `icat` would,
 * and the test reads what the emulator drew: a row of decoration per row of
 * picture, in the protocol it came in, with the text after each picture below
 * it rather than on top of it. On Windows this is also the proof that the
 * pseudoconsole hands the sequences through, which nothing else here can show.
 */

import { expect, test, type Page } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchWith, makeRepo } from './harness.js';

const ACTIVE = '[data-testid=terminal-tab-pane][data-active=true]';

async function screen(page: Page): Promise<string> {
  return (await page.locator(`${ACTIVE} [data-testid=pty-screen]`).innerText()).replace(/\s+/g, ' ');
}

/**
 * The script the shell runs. A real PNG built with zlib, because the emulator
 * reads the size from its header and the browser has to decode it; a sixel
 * written by hand, two colours in two bands.
 */
const SCRIPT = String.raw`
const zlib = require('node:zlib');
const ESC = '\u001b', BEL = '\u0007', ST = ESC + '\\';
const table = [];
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
const png = (w, h, rgb) => {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
};
const out = (s) => process.stdout.write(s);
const red = png(80, 45, [220, 40, 40]).toString('base64');
out(ESC + ']1337;File=inline=1;size=' + red.length + ':' + red + BEL + '\n');
out('after-iterm2\n');
out(ESC + 'Pq#1;2;0;80;0#1!40~-#2;2;90;90;0#2!40~' + ST + '\n');
out('after-sixel\n');
const blue = png(60, 30, [40, 80, 230]).toString('base64');
for (let i = 0; i < blue.length; i += 64) {
  const more = i + 64 < blue.length ? 1 : 0;
  out(ESC + '_G' + (i === 0 ? 'a=T,f=100,q=2,m=' : 'm=') + more + ';' + blue.slice(i, i + 64) + ST);
}
out('\nafter-kitty\n');
`;

test('draws iTerm2, sixel and kitty pictures from a program in the shell', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'pictures.cjs'), SCRIPT);
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    await w.locator(`${ACTIVE} [data-testid=pty-screen]`).click();
    await w.keyboard.type('node pictures.cjs');
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('after-kitty');

    const rows = (protocol: string) => w.locator(`${ACTIVE} [data-testid=term-image][data-protocol=${protocol}]`);
    for (const protocol of ['iterm2', 'sixel', 'kitty']) {
      await expect.poll(async () => await rows(protocol).count(), { message: `no ${protocol} picture` }).toBeGreaterThan(0);
    }

    // Drawn, not just reserved: every row has its picture as its background, and
    // the picture loads. The first run had rows with a URL and nothing on them —
    // the page's CSP did not allow `blob:` images — which only loading shows.
    // (Through locators and a string for the page: these specs compile without
    // the DOM's types.)
    for (const protocol of ['iterm2', 'sixel', 'kitty']) {
      await expect
        .poll(
          async () => {
            const styles = await rows(protocol).evaluateAll((els) => els.map((el) => el.getAttribute('style') ?? ''));
            const urls = styles.map((style) => /url\("([^"]+)"\)/u.exec(style)?.[1]);
            if (urls.length === 0 || urls.some((u) => u === undefined)) return 'a row with no picture';
            return await w.evaluate(
              `(async () => { const i = new Image(); i.src = ${JSON.stringify(urls[0])};` +
                ` return await i.decode().then(() => i.naturalWidth + 'x' + i.naturalHeight, () => 'did not load'); })()`,
            );
          },
          { message: `the ${protocol} picture` },
        )
        .toMatch(/^\d+x\d+$/u);
    }

    // The text after a picture is below it: the line that says so is on a row
    // under the picture's last row, not on one of its rows.
    const boxes = await rows('iterm2').evaluateAll((els) => els.map((el) => el.getAttribute('data-row')));
    const lastRow = rows('iterm2').and(w.locator(`[data-row="${Math.max(...boxes.map(Number))}"]`));
    const pictureBottom = (await lastRow.boundingBox())!;
    const line = (await w.locator(`${ACTIVE} .xterm-rows > div`, { hasText: 'after-iterm2' }).boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(pictureBottom.y + pictureBottom.height - 1);

    await w.screenshot({ path: test.info().outputPath('pictures.png') });
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
