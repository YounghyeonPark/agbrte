/**
 * Video and sound in the terminal (DESIGN.md §17 Q24, step 4), through the real
 * app, a real host and the shell the tab opens.
 *
 * Typed the way a person would — `agbrte play tone.wav` at the tab's prompt —
 * because the whole path is what is new: the launcher the host put on the
 * shell's PATH (`cliOnPath.ts`), our CLI under the app's own runtime (on
 * Windows, Electron, which a pseudoconsole hears nothing from unless a shell is
 * its parent), the sequence through the pseudoconsole, the stream filter, and
 * a player the page's CSP lets load a `blob:`. The pictures spec learned the
 * last of those the hard way: rows reserved and nothing in them.
 *
 * The video is recorded by the page itself — a canvas, `MediaRecorder`, WebM —
 * so it is a file this browser can certainly decode, made without a fixture or
 * an encoder on the machine.
 */

import { expect, test, type Page } from '@playwright/test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchWith, makeRepo } from './harness.js';

const ACTIVE = '[data-testid=terminal-tab-pane][data-active=true]';

async function screen(page: Page): Promise<string> {
  return (await page.locator(`${ACTIVE} [data-testid=pty-screen]`).innerText()).replace(/\s+/g, ' ');
}

/** Half a second of silence: a real WAV, and nothing a test machine will say out loud. */
function silence(): Buffer {
  const samples = 4000;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + samples * 2, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(samples * 2, 40);
  return Buffer.concat([header, Buffer.alloc(samples * 2)]);
}

/** A short WebM recorded in the page, as base64. */
const RECORD = `(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 160; canvas.height = 90;
  const g = canvas.getContext('2d');
  const stream = canvas.captureStream(15);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const parts = [];
  recorder.ondataavailable = (e) => parts.push(e.data);
  const done = new Promise((r) => (recorder.onstop = r));
  recorder.start();
  for (let i = 0; i < 12; i++) {
    g.fillStyle = i % 2 ? '#2a7' : '#a27';
    g.fillRect(0, 0, 160, 90);
    await new Promise((r) => setTimeout(r, 60));
  }
  recorder.stop();
  await done;
  const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
})()`;

/** What the player in the terminal reports, read in the page. */
const PLAYER = (kind: string): string => `(async () => {
  const el = document.querySelector('${ACTIVE} [data-testid=term-media][data-kind=${kind}] ${kind}');
  if (el === null) return 'no player';
  if (el.readyState < 1) await new Promise((r) => { el.onloadedmetadata = r; el.onerror = r; setTimeout(r, 10000); });
  if (el.error) return 'error ' + el.error.code;
  return (el.duration > 0 ? 'loaded' : 'no duration') + (el.autoplay ? ' autoplay' : '') + (el.videoWidth ? ' ' + el.videoWidth + 'x' + el.videoHeight : '');
})()`;

test('agbrte play and agbrte show, typed in the tab, put a working player on the line', async () => {
  const repo = await makeRepo();
  await writeFile(join(repo, 'tone.wav'), silence());
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const folder = repo.split(/[\\/]/).pop()!;

  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    const video = (await w.evaluate(RECORD)) as string;
    await writeFile(join(repo, 'clip.webm'), Buffer.from(video, 'base64'));

    await w.locator(`${ACTIVE} [data-testid=pty-screen]`).click();
    await w.keyboard.type('agbrte play tone.wav');
    await w.keyboard.press('Enter');
    const sound = w.locator(`${ACTIVE} [data-testid=term-media][data-kind=audio]`);
    await expect(sound, 'no player for the sound').toHaveCount(1, { timeout: 30_000 });
    await expect.poll(async () => await w.evaluate(PLAYER('audio')), { timeout: 20_000 }).toBe('loaded autoplay');

    // The prompt after it is a prompt, and what is typed lands on it. On
    // Windows this is the pseudoconsole's cursor agreeing with the terminal's:
    // the first version drew cmd's prompt below the player and the next command
    // three rows up, inside it.
    await w.keyboard.type('agbrte show clip.webm && echo after-video');
    await expect
      .poll(async () => await screen(w), { timeout: 30_000 })
      // The folder, the shell's prompt mark (`>`, `$`, `>` after `PS …`), the command.
      .toMatch(new RegExp(`${folder}\\S{0,2} ?agbrte show clip\\.webm && echo after-video`, 'u'));
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('after-video after-video');
    // The kinds on screen, and the screen, so a failure says what was there instead.
    const kinds = async (): Promise<string> =>
      `${String(await w.evaluate("[...document.querySelectorAll('[data-testid=term-media]')].map((e) => e.dataset.kind + (e.dataset.failed ? '!' : '')).join(' ')"))} || ${await screen(w)}`;
    await expect.poll(kinds, { timeout: 15_000 }).toMatch(/^audio video \|\|/u);
    // Shown, not played: `show` leaves pressing play to the person.
    await expect.poll(async () => await w.evaluate(PLAYER('video')), { timeout: 20_000 }).toBe('loaded 160x90');

    // The text after the player is below it, not under it.
    const player = (await w.locator(`${ACTIVE} [data-testid=term-media][data-kind=video]`).boundingBox())!;
    const lines = w.locator(`${ACTIVE} .xterm-rows > div`, { hasText: /^after-video\s*$/u });
    const line = (await lines.last().boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(player.y + player.height - 1);

    // A picture through the same command is one element over the rows the CLI
    // fed, and it loads.
    const png = (await w.evaluate(
      `(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 32;` +
        ` const g = c.getContext('2d'); g.fillStyle = '#e33'; g.fillRect(0, 0, 64, 32);` +
        ` return c.toDataURL('image/png').split(',')[1]; })()`,
    )) as string;
    await writeFile(join(repo, 'dot.png'), Buffer.from(png, 'base64'));
    await w.keyboard.type('agbrte show dot.png && echo after-picture');
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('after-picture after-picture');
    await expect
      .poll(
        async () =>
          await w.evaluate(
            `(() => { const i = document.querySelector('${ACTIVE} [data-testid=term-media][data-kind=picture] img');` +
              ` return i === null ? 'none' : i.complete && i.naturalWidth > 0 ? i.naturalWidth + 'x' + i.naturalHeight : 'not loaded'; })()`,
          ),
        { timeout: 20_000 },
      )
      .toBe('64x32');

    // A refusal is a sentence in the terminal, not a broken player.
    await w.keyboard.type('agbrte show pictures-of-nothing.mp4');
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('pictures-of-nothing.mp4: no such file');

    await w.screenshot({ path: test.info().outputPath('media.png') });
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

/** `seconds` of silence as a WAV header and a sparse file: big without being written. */
async function longSilence(path: string, seconds: number): Promise<void> {
  const { open } = await import('node:fs/promises');
  const header = silence().subarray(0, 44);
  const data = seconds * 16000;
  header.writeUInt32LE(36 + data, 4);
  header.writeUInt32LE(data, 40);
  const file = await open(path, 'w');
  await file.write(header, 0, 44, 0);
  await file.truncate(44 + data);
  await file.close();
}

test('a file past the inline cap is streamed from the host, and seeks', async () => {
  const repo = await makeRepo();
  // 2,500 seconds: 40 MB, past the 36 MB a sequence may carry.
  await longSilence(join(repo, 'long.wav'), 2500);
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  const folder = repo.split(/[\\/]/).pop()!;
  try {
    await expect.poll(async () => await screen(w), { timeout: 60_000 }).toContain(folder);
    // A picture past the stream threshold, as noise so it does not compress.
    const png = (await w.evaluate(
      `(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 200;` +
        ` const g = c.getContext('2d'); const d = g.createImageData(400, 200);` +
        ` for (let i = 0; i < d.data.length; i++) d.data[i] = (i % 4 === 3) ? 255 : Math.random() * 255;` +
        ` g.putImageData(d, 0, 0); return c.toDataURL('image/png').split(',')[1]; })()`,
    )) as string;
    await writeFile(join(repo, 'noise.png'), Buffer.from(png, 'base64'));
    expect(Buffer.from(png, 'base64').length).toBeGreaterThan(64 * 1024);

    await w.locator(`${ACTIVE} [data-testid=pty-screen]`).click();
    await w.keyboard.type('agbrte show long.wav noise.png && echo after-stream');
    await w.keyboard.press('Enter');
    await expect.poll(async () => await screen(w), { timeout: 30_000 }).toContain('after-stream after-stream');

    const sound = `document.querySelector('${ACTIVE} [data-testid=term-media][data-kind=audio] audio')`;
    expect(await w.evaluate(`${sound}.src`)).toMatch(/^agbrte-media:\/\/pane\//u);
    await expect.poll(async () => await w.evaluate(PLAYER('audio')), { timeout: 20_000 }).toBe('loaded');
    expect(await w.evaluate(`Math.round(${sound}.duration)`)).toBe(2500);
    // Seeking near the end reads a range from there, not the 40 MB before it.
    const seeked = await w.evaluate(`(async () => { const a = ${sound};
      a.currentTime = 2400;
      await new Promise((r) => { a.onseeked = r; setTimeout(r, 15000); });
      if (a.readyState < 2) await new Promise((r) => { a.oncanplay = r; setTimeout(r, 15000); });
      return Math.round(a.currentTime) + ' ' + a.readyState; })()`);
    expect(seeked).toMatch(/^2400 [234]$/u);

    await expect
      .poll(
        async () =>
          await w.evaluate(
            `(() => { const i = document.querySelector('${ACTIVE} [data-testid=term-media][data-kind=picture] img');` +
              ` return i === null ? 'none' : i.complete && i.naturalWidth > 0 ? i.naturalWidth + 'x' + i.naturalHeight : 'not loaded'; })()`,
          ),
        { timeout: 20_000 },
      )
      .toBe('400x200');
    await w.screenshot({ path: test.info().outputPath('streamed.png') });
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});

test('the palette turns reading replies aloud on for a tab, and the tab says so', async () => {
  const repo = await makeRepo();
  const agbrte = await launchWith({ ui: 'terminal' }, repo);
  const w = agbrte.window;
  try {
    await expect(w.locator('[data-testid=tab]')).toHaveCount(1, { timeout: 60_000 });
    await expect(w.locator('[data-testid=tab-reading]')).toHaveCount(0);
    await w.keyboard.press('Control+Shift+P');
    await w.locator('[data-testid=palette-input]').fill('read replies');
    await w.locator('[data-testid=palette-item][data-command=read-aloud]').click();
    await expect(w.locator('[data-testid=tab-reading]')).toHaveCount(1);
    // And the indicator is the way to turn it off.
    await w.locator('[data-testid=tab-reading]').click();
    await expect(w.locator('[data-testid=tab-reading]')).toHaveCount(0);
  } finally {
    await agbrte.close();
    await rm(repo, { recursive: true, force: true, maxRetries: 100, retryDelay: 100 });
  }
});
