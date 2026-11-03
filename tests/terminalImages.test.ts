/**
 * Pictures in a terminal's stream (DESIGN.md §17 Q24, step 3): taking them out
 * of the output before the emulator, decoding sixel, reading an image's size
 * from its header, and the agent's pictures in the terminal it works in.
 *
 * Most of what is pinned about the filter is what it must *not* do: every byte
 * that is not a picture comes out as it went in, whatever the chunking — a
 * filter in front of a terminal that lost or reordered one byte of a full-screen
 * program's output would be a broken terminal, not a missing feature.
 */

import { describe, expect, it, vi } from 'vitest';
import { decodeBase64, ImageStream, type Picture } from '@shared/terminal/imageStream.js';
import { decodeSixel, MAX_SIXEL_SIDE } from '@shared/terminal/sixel.js';
import { imageSize } from '@shared/terminal/imageSize.js';
import { PICTURE_WAIT_MS, TerminalSession } from '../src/main/terminal/mux/session.js';
import { plainStyle } from '../src/main/terminal/mux/markdown.js';
import { drawPicture } from '../src/main/terminal/graphics.js';
import type { AgbrteEvent } from '@shared/types/index.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;

/** Run `input` through a stream in the given chunk sizes; what came out, and what was taken. */
function filter(input: string, sizes: number[] | 'bytes' = [input.length], limit?: number) {
  const pictures: Picture[] = [];
  const stream = new ImageStream((p) => {
    pictures.push(p);
    return `<${p.protocol}>`;
  }, limit);
  let out = '';
  let at = 0;
  let k = 0;
  while (at < input.length) {
    const n = sizes === 'bytes' ? 1 : (sizes[k % sizes.length] ?? input.length);
    out += stream.write(input.slice(at, at + n));
    at += n;
    k += 1;
  }
  return { out, pictures };
}

/** A minimal PNG header: signature, IHDR length and type, width, height. */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, width);
  new DataView(b.buffer).setUint32(20, height);
  return b;
}

describe('the stream around pictures', () => {
  const everythingElse =
    `plain text\r\n${ESC}[1;31mred${ESC}[0m ${ESC}]133;A${BEL}$ ${ESC}]133;B${BEL}` +
    `${ESC}]0;a title${ST}${ESC}]1337;CurrentDir=/tmp${BEL}${ESC}P+q544e${ST}` +
    `${ESC}Ptmux;${ESC}${ESC}]0;x${BEL}${ST}${ESC}_Xnot kitty${ST}${ESC}c 한글 ✓`;

  it('lets everything that is not a picture through unchanged, however it is cut', () => {
    for (const sizes of [[everythingElse.length], 'bytes' as const, [2], [3, 7], [5, 1, 11]]) {
      const { out, pictures } = filter(everythingElse, sizes);
      expect(out).toBe(everythingElse);
      expect(pictures).toEqual([]);
    }
  });

  it('takes an iTerm2 picture out, with its arguments, ended by BEL or by ST', () => {
    for (const end of [BEL, ST]) {
      const input = `before${ESC}]1337;File=inline=1;size=4;width=10:QUJD${end}after`;
      for (const sizes of [[input.length], 'bytes' as const, [4]]) {
        const { out, pictures } = filter(input, sizes);
        expect(out).toBe('before<iterm2>after');
        expect(pictures).toEqual([{ protocol: 'iterm2', args: { inline: '1', size: '4', width: '10' }, data: 'QUJD' }]);
      }
    }
  });

  it('puts a multipart iTerm2 picture back together, and drops parts with no start', () => {
    const input =
      `${ESC}]1337;MultipartFile=inline=1;size=6${BEL}${ESC}]1337;FilePart=QUJD${BEL}` +
      `${ESC}]1337;FilePart=REVG${BEL}${ESC}]1337;FileEnd${BEL}$ `;
    const { out, pictures } = filter(input, 'bytes');
    expect(out).toBe('<iterm2>$ ');
    expect(pictures).toEqual([{ protocol: 'iterm2', args: { inline: '1', size: '6' }, data: 'QUJDREVG' }]);

    const orphan = filter(`${ESC}]1337;FilePart=QUJD${BEL}${ESC}]1337;FileEnd${BEL}`);
    expect(orphan.pictures[0]?.protocol).toBe('dropped');
  });

  it('takes a sixel out with its parameters, and leaves other device control strings', () => {
    const input = `a${ESC}P0;1;0q"1;1;2;6#1~~${ST}b${ESC}P$qm${ST}c`;
    const { out, pictures } = filter(input, 'bytes');
    expect(out).toBe(`a<sixel>b${ESC}P$qm${ST}c`);
    expect(pictures).toEqual([{ protocol: 'sixel', params: '0;1;0', data: '"1;1;2;6#1~~' }]);
  });

  it('takes a kitty command out, keys and payload apart', () => {
    const input = `${ESC}_Ga=T,f=100,i=7;iVBORw0K${ST}x`;
    for (const sizes of [[input.length], 'bytes' as const]) {
      const { out, pictures } = filter(input, sizes);
      expect(out).toBe('<kitty>x');
      expect(pictures).toEqual([{ protocol: 'kitty', control: { a: 'T', f: '100', i: '7' }, payload: 'iVBORw0K' }]);
    }
  });

  it('abandons a picture that an ESC interrupts, and reads what the ESC began', () => {
    const { out, pictures } = filter(`${ESC}]1337;File=inline=1:QUJD${ESC}[31mred`);
    expect(out).toBe(`${ESC}[31mred`);
    expect(pictures).toEqual([]);
  });

  it('reads a picture past the cap to its end, keeps none of it, and says so', () => {
    const big = 'A'.repeat(500);
    const { out, pictures } = filter(`${ESC}]1337;File=inline=1:${big}${BEL}$ `, [64], 100);
    expect(out).toBe('<dropped>$ ');
    expect(pictures).toEqual([{ protocol: 'dropped', why: 'too large to show' }]);
  });

  it('decodes base64, skipping what is not base64', () => {
    expect([...decodeBase64('QUJD')]).toEqual([65, 66, 67]);
    expect([...decodeBase64('QU\nJD\r\nRA==')]).toEqual([65, 66, 67, 68]);
    expect([...decodeBase64('_-8')]).toEqual([0xff, 0xef]);
  });
});

describe('sixel', () => {
  it('draws six pixels down per character, in the colour chosen', () => {
    // Colour 1 defined as pure red (RGB, percent); `~` is all six bits.
    const pixels = decodeSixel('#1;2;100;0;0#1~~')!;
    expect(pixels.width).toBe(2);
    expect(pixels.height).toBe(6);
    expect([...pixels.rgba.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...pixels.rgba.subarray((5 * 2 + 1) * 4, (5 * 2 + 1) * 4 + 4)]).toEqual([255, 0, 0, 255]);
  });

  it('repeats, returns to the band start, moves down a band, and leaves undrawn pixels clear', () => {
    // `!3@` is bit 0 three times; `$` back; `#2!3A`… `A` is bit 1. `-` the next band.
    const pixels = decodeSixel('#1;2;0;100;0#1!3@$#2;2;0;0;100#2A-#1@')!;
    expect(pixels.width).toBe(3);
    expect(pixels.height).toBe(7);
    const at = (x: number, y: number): number[] => [...pixels.rgba.subarray((y * 3 + x) * 4, (y * 3 + x) * 4 + 4)];
    expect(at(2, 0)).toEqual([0, 255, 0, 255]);
    expect(at(0, 1)).toEqual([0, 0, 255, 255]);
    expect(at(1, 1)).toEqual([0, 0, 0, 0]);
    expect(at(0, 6)).toEqual([0, 255, 0, 255]);
  });

  it('turns DEC’s hue wheel, where blue is at 0°', () => {
    const pixels = decodeSixel('#1;1;0;50;100#1@')!;
    expect([...pixels.rgba.subarray(0, 3)]).toEqual([0, 0, 255]);
  });

  it('takes the raster size as at least the size, and caps what it will allocate', () => {
    expect(decodeSixel('"1;1;10;12#0@')).toMatchObject({ width: 10, height: 12 });
    expect(decodeSixel('!99999~')!.width).toBe(MAX_SIXEL_SIDE);
    expect(decodeSixel('')).toBeNull();
  });
});

describe('an image’s size from its header', () => {
  it('reads PNG, GIF, BMP and WebP', () => {
    expect(imageSize(png(640, 480))).toEqual({ width: 640, height: 480, mime: 'image/png' });
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x01, 0x10, 0x00]);
    expect(imageSize(gif)).toEqual({ width: 288, height: 16, mime: 'image/gif' });
    const bmp = new Uint8Array(26);
    bmp.set([0x42, 0x4d]);
    new DataView(bmp.buffer).setInt32(18, 100, true);
    new DataView(bmp.buffer).setInt32(22, -50, true);
    expect(imageSize(bmp)).toEqual({ width: 100, height: 50, mime: 'image/bmp' });
    const webp = new Uint8Array(30);
    webp.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
    webp.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
    webp.set([199, 0, 0, 99, 0, 0], 24);
    expect(imageSize(webp)).toEqual({ width: 200, height: 100, mime: 'image/webp' });
  });

  it('walks a JPEG past an EXIF block to its frame', () => {
    const exif = new Uint8Array(2 + 300).fill(0x11);
    exif[0] = 0x01;
    exif[1] = 0x2e; // length 302, itself included
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe1, ...exif,
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 800, height: 600, mime: 'image/jpeg' });
  });

  it('says nothing for what it cannot read', () => {
    expect(imageSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageSize(new Uint8Array(0))).toBeNull();
  });

  it('draws a picture the session holds, and passes over a blob that is not one', () => {
    const drawn = drawPicture(png(2, 2), 'iterm2', 'abc');
    expect(drawn).toMatch(/^\u001b\]1337;File=inline=1;size=33;/u);
    expect(drawPicture(new TextEncoder().encode('a log, not a picture'), 'iterm2')).toBeNull();
  });
});

describe('the agent’s pictures in the terminal', () => {
  const PROMPT = `${ESC}]133;A${BEL}$ ${ESC}]133;B${BEL}`;

  function harness(picture?: (blob: { sha256: string }) => Promise<string | null>) {
    const screen: string[] = [];
    const session = new TerminalSession({
      out: (b) => screen.push(b),
      columns: () => 80,
      shell: { write: () => undefined, resize: () => undefined, kill: () => undefined },
      integration: 'full',
      agent: {
        send: async () => undefined,
        interrupt: async () => undefined,
        respond: async () => undefined,
        ...(picture !== undefined ? { picture } : {}),
      },
      style: plainStyle,
      exit: () => undefined,
    });
    let seq = 0;
    const event = (body: Record<string, unknown>): void =>
      session.event({ seq: (seq += 1), id: `e${seq}`, at: '', ...body } as unknown as AgbrteEvent);
    session.shellOutput(PROMPT);
    session.input('?');
    session.input('look\r');
    event({ type: 'session.state', from: 'idle', to: 'working' });
    return { screen: () => screen.join(''), event };
  }

  it('draws a capture where it came, and holds the next line until it is drawn', async () => {
    let resolve: (s: string) => void = () => undefined;
    const asked: string[] = [];
    const h = harness((blob) => {
      asked.push(blob.sha256);
      return new Promise((r) => (resolve = r));
    });
    h.event({ type: 'capture.attached', sha256: 'f'.repeat(64), mime: 'image/png' });
    h.event({ type: 'agent.text', text: 'that is the screen' });
    expect(asked).toEqual(['f'.repeat(64)]);
    expect(h.screen()).not.toContain('that is the screen');
    resolve(`${ESC}]1337;File=inline=1:QUJD${BEL}\n`);
    await vi.waitFor(() => expect(h.screen()).toContain('that is the screen'));
    const s = h.screen();
    expect(s.indexOf('1337;File=')).toBeLessThan(s.indexOf('that is the screen'));
  });

  it('goes on without a picture that takes too long', async () => {
    vi.useFakeTimers();
    try {
      const h = harness(() => new Promise(() => undefined));
      h.event({ type: 'capture.attached', sha256: 'a'.repeat(64), mime: 'image/png' });
      h.event({ type: 'agent.text', text: 'after the picture' });
      await vi.advanceTimersByTimeAsync(PICTURE_WAIT_MS + 10);
      expect(h.screen()).toContain('after the picture');
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks for nothing where the terminal shows no pictures', () => {
    const h = harness();
    h.event({ type: 'capture.attached', sha256: 'a'.repeat(64), mime: 'image/png' });
    h.event({ type: 'agent.text', text: 'straight on' });
    expect(h.screen()).toContain('straight on');
  });
});
