/**
 * Video and sound in the terminal (DESIGN.md §17 Q24, step 4): what a file is
 * from its first bytes, the CLI that sends one, the launcher that makes that CLI
 * reachable from the app's own shell, and the agent's recordings.
 *
 * The player itself is the renderer's and is exercised against the real app
 * (`tests/e2e/media.spec.ts`), which is the only place a browser decodes one.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Writable } from 'node:stream';
import { mediaType } from '@shared/terminal/mediaType.js';
import { ImageStream, type Picture } from '@shared/terminal/imageStream.js';
import { drawBlob, inlineMedia, playsMedia } from '../src/main/terminal/graphics.js';
import { MAX_SHOWN_BYTES, rowsFor, show } from '../src/cli/show.js';
import { cmdLauncher, shLauncher, withOnPath, writeLaunchers } from '../src/main/terminal/cliOnPath.js';
import { Shells, type Pty, type PtySpawner } from '../src/main/terminal/shell.js';
import { TerminalPrograms } from '../src/main/terminal/programs.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agbrte-media-'));
  dirs.push(d);
  return d;
};

const bytes = (...parts: Array<string | number[] | Uint8Array>): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [...p])),
  );
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
/** An MP4 box: size, type, contents. */
const box = (type: string, ...contents: Uint8Array[]): Uint8Array => {
  const body = bytes(...contents);
  return bytes(u32(8 + body.length), type, body);
};
/** A version-0 track header saying `width`×`height` (zero for a sound track). */
const tkhd = (width: number, height: number): Uint8Array =>
  box('tkhd', new Uint8Array(76), bytes(u32(width * 65536), u32(height * 65536)));
const ftyp = (brand: string): Uint8Array => box('ftyp', bytes(brand, u32(0), 'isom'));

/** A real, tiny WAV: a header and some silence. */
function wav(samples = 800): Uint8Array {
  const data = samples * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.alloc(data)]));
}

const PNG = bytes([0x89], 'PNG\r\n\u001a\n', u32(13), 'IHDR', u32(4), u32(2), [8, 2, 0, 0, 0], u32(0));

describe('what a file is, from its first bytes', () => {
  it('knows the sounds the app plays', () => {
    expect(mediaType(wav())).toEqual({ kind: 'audio', mime: 'audio/wav' });
    expect(mediaType(bytes('ID3', new Uint8Array(20)))?.mime).toBe('audio/mpeg');
    expect(mediaType(bytes([0xff, 0xfb, 0x90, 0x64], new Uint8Array(20)))?.mime).toBe('audio/mpeg');
    expect(mediaType(bytes([0xff, 0xf1, 0x50, 0x80], new Uint8Array(20)))?.mime).toBe('audio/aac');
    expect(mediaType(bytes('fLaC', new Uint8Array(20)))?.mime).toBe('audio/flac');
    expect(mediaType(bytes('OggS', new Uint8Array(24), [1], 'vorbis'))).toEqual({ kind: 'audio', mime: 'audio/ogg' });
  });

  it('tells a video from a sound in the containers that carry either', () => {
    expect(mediaType(bytes('OggS', new Uint8Array(24), [0x80], 'theora'))?.kind).toBe('video');
    const ebml = [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84];
    expect(mediaType(bytes(ebml, 'webm', new Uint8Array(30), [0x86, 0x85], 'V_VP9'))).toEqual({
      kind: 'video',
      mime: 'video/webm',
    });
    expect(mediaType(bytes(ebml, 'webm', new Uint8Array(30), [0x86, 0x86], 'A_OPUS'))).toEqual({
      kind: 'audio',
      mime: 'audio/webm',
    });
    // The two letters by chance, not as a codec id, are not a video.
    expect(mediaType(bytes(ebml, 'webm', new Uint8Array(30), 'xxV_xx', [0x86, 0x86], 'A_OPUS'))?.kind).toBe('audio');
  });

  it('reads an MP4’s picture size from its track header, and its kind from its tracks or its brand', () => {
    const video = bytes(ftyp('isom'), box('moov', box('trak', tkhd(0, 0)), box('trak', tkhd(1280, 720))));
    expect(mediaType(video)).toEqual({ kind: 'video', mime: 'video/mp4', width: 1280, height: 720 });
    const sound = bytes(ftyp('isom'), box('moov', box('trak', tkhd(0, 0))));
    expect(mediaType(sound)).toEqual({ kind: 'audio', mime: 'audio/mp4' });
    // The index at the end, as a file not written for streaming has it: the brand decides.
    expect(mediaType(bytes(ftyp('M4A '), box('mdat', new Uint8Array(64))))?.kind).toBe('audio');
    expect(mediaType(bytes(ftyp('mp42'), box('mdat', new Uint8Array(64))))).toEqual({ kind: 'video', mime: 'video/mp4' });
    expect(mediaType(bytes(ftyp('qt  '), box('mdat', new Uint8Array(64))))?.mime).toBe('video/quicktime');
  });

  it('says nothing for a picture, a container it cannot play, or noise', () => {
    expect(mediaType(PNG)).toBeNull();
    expect(mediaType(bytes('RIFF', u32(0), 'AVI LIST', new Uint8Array(20)))).toBeNull();
    expect(mediaType(bytes('hello, world, this is text'))).toBeNull();
    expect(mediaType(bytes('ID3'))).toBeNull();
  });
});

describe('sending one to the terminal', () => {
  it('plays only where the app’s own terminal is drawing', () => {
    expect(playsMedia({ TERM_PROGRAM: 'Agbrte' })).toBe(true);
    // Over ssh, which forwards LC_* and nothing else.
    expect(playsMedia({ LC_TERMINAL: 'Agbrte' })).toBe(true);
    expect(playsMedia({ TERM_PROGRAM: 'iTerm.app' })).toBe(false);
    expect(playsMedia({ TERM_PROGRAM: 'Agbrte', TMUX: '/tmp/tmux' })).toBe(false);
    expect(playsMedia({})).toBe(false);
  });

  it('rides in the picture sequence, which the stream reads back whole', () => {
    const got: Picture[] = [];
    const stream = new ImageStream((p) => {
      got.push(p);
      return '';
    });
    stream.write(inlineMedia(wav(), { name: 'tone.wav', autoplay: true }));
    expect(got).toHaveLength(1);
    const p = got[0]!;
    if (p.protocol !== 'iterm2') throw new Error(p.protocol);
    expect(p.args).toMatchObject({ inline: '1', autoplay: '1', name: Buffer.from('tone.wav').toString('base64') });
    expect(Buffer.from(p.data, 'base64')).toEqual(Buffer.from(wav()));
    expect(inlineMedia(wav())).not.toContain('autoplay');
  });

  it('gives the agent’s recording a player that waits, and nothing for what is neither', () => {
    expect(drawBlob(wav(), 'iterm2', { media: true })).toContain('1337;File=');
    expect(drawBlob(wav(), 'iterm2', { media: true })).not.toContain('autoplay');
    expect(drawBlob(wav(), 'iterm2', { media: false })).toBeNull();
    expect(drawBlob(PNG, 'iterm2', { media: false })).toContain('1337;File=');
    expect(drawBlob(bytes('%PDF-1.7 and so on'), 'iterm2', { media: true })).toBeNull();
  });
});

class Collect extends Writable {
  text = '';
  override _write(chunk: Buffer, _enc: string, done: () => void): void {
    this.text += chunk.toString('utf8');
    done();
  }
}

describe('agbrte show and agbrte play', () => {
  const run = async (argv: string[], env: NodeJS.ProcessEnv, play = false) => {
    const out = new Collect();
    const err = new Collect();
    const code = await show(argv, { play }, { env, out, err });
    return { code, out: out.text, err: err.text };
  };

  it('puts a player on the line, and starts it only for play', async () => {
    const dir = temp();
    const file = join(dir, 'tone.wav');
    writeFileSync(file, wav());
    const shown = await run([file], { TERM_PROGRAM: 'Agbrte' });
    expect(shown.code).toBe(0);
    expect(shown.out).toContain('\u001b]1337;File=inline=1;');
    expect(shown.out).not.toContain('autoplay');
    const played = await run([file], { TERM_PROGRAM: 'Agbrte' }, true);
    expect(played.out).toContain('autoplay=1');
  });

  it('feeds the rows itself in Agbrte’s terminal, so a pseudoconsole sees the cursor move', async () => {
    const dir = temp();
    const file = join(dir, 'tone.wav');
    writeFileSync(file, wav());
    const fed = await run([file], { TERM_PROGRAM: 'Agbrte' });
    expect(fed.out).toMatch(/;height=3;rows=3:[^\u0007]*\u0007\n\n\n$/u);
    // Anywhere else (forced), the terminal makes its own room and gets one line feed.
    const forced = await run([file, '--force'], { TERM_PROGRAM: 'iTerm.app' });
    expect(forced.out).not.toContain('rows=');
    expect(forced.out.endsWith('\u0007\n')).toBe(true);
  });

  it('reckons rows from a picture’s size, narrowed to the terminal and short of the screen', () => {
    // 160 px tall at 16 px a row.
    expect(rowsFor({ width: 320, height: 160 }, 'picture', 80, 40)).toBe(10);
    // Twice as wide as 80 columns of 8 px: half the height.
    expect(rowsFor({ width: 1280, height: 320 }, 'picture', 80, 40)).toBe(10);
    // Never taller than the screen less two rows.
    expect(rowsFor({ width: 100, height: 4000 }, 'picture', 80, 24)).toBe(22);
    expect(rowsFor(null, 'video', 80, 50)).toBe(23);
    expect(rowsFor(null, 'audio', 80, 24)).toBe(3);
  });

  it('draws a picture in any terminal that says it draws them', async () => {
    const dir = temp();
    const file = join(dir, 'p.png');
    writeFileSync(file, PNG);
    expect((await run([file], { TERM_PROGRAM: 'iTerm.app' })).out).toContain('1337;File=');
    expect((await run([file], { TERM: 'xterm-kitty' })).out).toContain('\u001b_G');
  });

  it('refuses by name where the terminal has not said it can, unless forced', async () => {
    const dir = temp();
    const file = join(dir, 'tone.wav');
    writeFileSync(file, wav());
    const refused = await run([file], { TERM_PROGRAM: 'iTerm.app' });
    expect(refused.code).toBe(1);
    expect(refused.out).toBe('');
    expect(refused.err).toContain('only Agbrte’s own terminal plays video and sound');
    expect((await run([file, '--force'], { TERM_PROGRAM: 'iTerm.app' })).out).toContain('1337;File=');
  });

  it('refuses what it cannot send, file by file, and goes on with the rest', async () => {
    const dir = temp();
    const good = join(dir, 'tone.wav');
    writeFileSync(good, wav());
    const text = join(dir, 'notes.txt');
    writeFileSync(text, 'just words, nothing to play');
    const big = join(dir, 'long.wav');
    writeFileSync(big, wav());
    truncateSync(big, MAX_SHOWN_BYTES + 1);
    const r = await run([join(dir, 'missing.mp4'), text, big, good, dir], { TERM_PROGRAM: 'Agbrte' });
    expect(r.code).toBe(1);
    expect(r.err).toContain('missing.mp4: no such file');
    expect(r.err).toContain('notes.txt: not a picture, a video or a sound');
    expect(r.err).toMatch(/long\.wav: .* is more than the .* a terminal is sent in one piece/u);
    expect(r.err).toContain(`${dir}: not a file`);
    // The one that could be sent was.
    expect(r.out.match(/1337;File=/gu)).toHaveLength(1);
  });

  it('says how to use it when given nothing, or an option it does not have', async () => {
    expect((await run([], {})).err).toContain('agbrte play <file>');
    const r = await run(['--loud', 'x.wav'], {});
    expect(r.code).toBe(1);
    expect(r.err).toContain('--loud is not an option here');
  });
});

describe('agbrte on the PATH of the app’s own shell', () => {
  const cli = { execPath: 'C:\\Program Files\\Agbrte\\Agbrte.exe', entry: "C:\\Users\\Jo O'Neil\\app\\cli\\agbrte.js", electron: true };

  it('writes a POSIX launcher that quotes what a path can hold', () => {
    const sh = shLauncher(cli);
    expect(sh.startsWith('#!/bin/sh\n')).toBe(true);
    expect(sh).toContain(`ELECTRON_RUN_AS_NODE=1 exec 'C:/Program Files/Agbrte/Agbrte.exe' 'C:/Users/Jo O'\\''Neil/app/cli/agbrte.js' "$@"`);
    expect(shLauncher({ ...cli, electron: false })).not.toContain('ELECTRON_RUN_AS_NODE');
  });

  it('writes a batch launcher that keeps a % in a path from being read as a variable', () => {
    const cmd = cmdLauncher({ ...cli, entry: 'C:\\100%\\agbrte.js' });
    expect(cmd).toContain('"C:\\Program Files\\Agbrte\\Agbrte.exe" "C:\\100%%\\agbrte.js" %*');
    expect(cmd).toContain('set ELECTRON_RUN_AS_NODE=1');
    expect(cmd.split('\r\n')).toContain('exit /b %ERRORLEVEL%');
  });

  it('writes them once, named by what they say, with the .cmd only on Windows', () => {
    const dir = temp();
    const bin = writeLaunchers(dir, cli, 'win32');
    expect(readFileSync(join(bin, 'agbrte'), 'utf8')).toBe(shLauncher(cli));
    expect(readFileSync(join(bin, 'agbrte.cmd'), 'utf8')).toBe(cmdLauncher(cli));
    expect(writeLaunchers(dir, cli, 'win32')).toBe(bin);
    expect(writeLaunchers(dir, { ...cli, entry: '/elsewhere/agbrte.js' }, 'win32')).not.toBe(bin);
    const posix = writeLaunchers(temp(), cli, 'linux');
    expect(() => readFileSync(join(posix, 'agbrte.cmd'))).toThrow();
  });

  it('puts the directory first on the PATH under the key the environment already uses', () => {
    expect(withOnPath({ Path: 'C:\\Windows' }, 'B')).toEqual({ Path: `B${delimiter}C:\\Windows` });
    expect(withOnPath({ PATH: '/usr/bin' }, 'B')).toEqual({ PATH: `B${delimiter}/usr/bin` });
    expect(withOnPath({}, 'B')).toEqual({ PATH: 'B' });
  });

  it('is given to a taught shell, and not to one started as it was', () => {
    const integrationDir = temp();
    const envs: Array<Record<string, string | undefined>> = [];
    const spawn: PtySpawner = (_file, _args, opts) => {
      envs.push(opts.env as Record<string, string | undefined>);
      return new (class implements Pty {
        readonly pid = 1;
        onData(): void {}
        onExit(): void {}
        write(): void {}
        resize(): void {}
        kill(): void {}
      })();
    };
    const make = (extra: NodeJS.ProcessEnv) => {
      const env = { AGBRTE_SHELL: '/bin/bash', PATH: '/usr/bin', ...extra };
      return new Shells<object>('/work', {
        onData: () => undefined,
        onExit: () => undefined,
        spawn,
        env,
        programs: new TerminalPrograms({ env, lookup: (n) => (n === '/bin/bash' ? '/bin/bash' : null) }),
        integrationDir,
        cli,
      });
    };
    make({}).open({}, { program: { kind: 'shell' } });
    const path = envs[0]!['PATH']!;
    const bin = path.split(delimiter)[0]!;
    expect(bin.startsWith(integrationDir)).toBe(true);
    expect(path.endsWith(`${delimiter}/usr/bin`)).toBe(true);
    expect(readFileSync(join(bin, 'agbrte'), 'utf8')).toBe(shLauncher(cli));

    make({ AGBRTE_SHELL_INTEGRATION: '0' }).open({}, { program: { kind: 'shell' } });
    expect(envs[1]!['PATH']).toBe('/usr/bin');
  });
});
