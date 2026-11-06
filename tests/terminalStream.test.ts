/**
 * Files the host streams to a player in the terminal (DESIGN.md §17 Q24, step
 * 5): the request a shell's output carries and who may make it, the files a
 * pane holds open and the ranges read from them, the pane that owns them, and
 * the HTTP answer the window's player gets.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  MAX_HOST_OFFERS,
  MAX_OFFERS,
  refusedPath,
  MAX_READ,
  MediaOffers,
  OfferFilter,
  offerSequence,
  PANE_KEY_ENV,
} from '../src/main/terminal/mediaOffers.js';
import { answer, parseRange } from '../src/main/mediaRanges.js';
import { Shells, type AgentBinding, type Pty, type PtySpawner } from '../src/main/terminal/shell.js';
import type { Block } from '@shared/terminal/marks.js';
import { TerminalPrograms } from '../src/main/terminal/programs.js';
import { MARK_NONCE_ENV } from '../src/main/terminal/integration.js';
import { show, STREAM_ABOVE } from '../src/cli/show.js';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const temp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agbrte-stream-'));
  dirs.push(d);
  return d;
};

/** A WAV of `samples` 16-bit samples, each sample's low byte its index, so a range can be checked. */
function wav(samples: number): Buffer {
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
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < data.length; i += 1) data[i] = i & 0xff;
  return Buffer.concat([header, data]);
}

const KEY = 'k'.repeat(32);
const tokenOf = (text: string): string => /;stream=([0-9a-f]+);/u.exec(text)?.[1] ?? '';

/** Every way of cutting `text` in two. */
function everyCut(filter: () => OfferFilter, text: string): string[] {
  const outs: string[] = [];
  for (let at = 0; at <= text.length; at += 1) {
    const f = filter();
    outs.push(f.write(text.slice(0, at)) + f.write(text.slice(at)));
  }
  return outs;
}

describe('a request to stream a file, in a shell’s output', () => {
  it('lets everything else through unchanged, however it is cut', () => {
    const text = 'ls\r\n\u001b]133;A\u0007\u001b]1337;File=inline=1:AAAA\u0007\u001b]77;x\u0007done\u001b';
    for (const out of everyCut(() => new OfferFilter(KEY, new MediaOffers()), text + 'x')) {
      expect(out).toBe(text + 'x');
    }
  });

  it('is answered in place by a sequence naming a token, not the path, however it is cut', () => {
    const dir = temp();
    const file = join(dir, 'tone.wav');
    writeFileSync(file, wav(4000));
    const request = offerSequence(KEY, { path: file, name: 'tone.wav', autoplay: true, rows: 3 });
    for (const out of everyCut(() => new OfferFilter(KEY, new MediaOffers()), `a${request}b`)) {
      expect(out).toMatch(/^a\u001b\]1337;File=inline=1;size=8044;name=[^;]+;stream=[0-9a-f]{32};kind=audio;mime=audio\/wav;height=3;rows=3;autoplay=1:\u0007b$/u);
      expect(out).not.toContain(dir);
    }
  });

  it('is ignored, and says so, without this pane’s key — text that only passes through has none', () => {
    const dir = temp();
    const file = join(dir, 'secret.wav');
    writeFileSync(file, wav(10));
    const offers = new MediaOffers();
    const out = new OfferFilter(KEY, offers).write(offerSequence('x'.repeat(32), { path: file, name: 'secret.wav' }));
    expect(out).toContain('did not come from this terminal');
    expect(out).not.toContain('stream=');
  });

  it('is abandoned where the emulator would abandon it, and swallows nothing after', () => {
    const f = new OfferFilter(KEY, new MediaOffers());
    // An unfinished request, then the shell's own prompt mark: the mark survives.
    expect(f.write('\u001b]7732;junk\u001b]133;A\u0007$ ')).toBe('\u001b]133;A\u0007$ ');
    expect(f.write('\u001b]7732;junk\u0018after')).toBe('after');
    expect(f.write('\u001b]7732;junk\u001a\u001b[1mbold')).toBe('\u001b[1mbold');
  });

  it('ends at ST as well as BEL, and drops one too long to be a request', () => {
    const f = new OfferFilter(KEY, new MediaOffers());
    expect(f.write(`\u001b]7732;${KEY};e30=\u001b\\after`)).toMatch(/could not be read\]\u001b\[22mafter$/u);
    expect(f.write(`\u001b]7732;${'z'.repeat(20_000)}\u0007after`)).toMatch(/too long.*after$/u);
  });

  it('says why a file cannot be streamed, where the player would have been', () => {
    const dir = temp();
    const text = join(dir, 'notes.txt');
    writeFileSync(text, 'words');
    const offers = new MediaOffers();
    expect(offers.offer({ path: join(dir, 'missing.mp4'), name: 'missing.mp4' })).toContain('cannot open missing.mp4: ENOENT');
    expect(offers.offer({ path: text, name: 'notes.txt' })).toContain('not a picture, a video or a sound');
    expect(offers.offer({ path: dir, name: 'dir' })).toMatch(/not a file|cannot/u);
  });
});

describe('what the host will open', () => {
  it('refuses a network or device path on Windows, whose opening is the harm', () => {
    expect(refusedPath('\\\\attacker\\share\\a.mp4', 'win32')).toMatch(/network or device path/u);
    expect(refusedPath('//attacker/share/a.mp4', 'win32')).toMatch(/network or device path/u);
    expect(refusedPath('\\\\?\\UNC\\attacker\\share\\a.mp4', 'win32')).toMatch(/network or device path/u);
    expect(refusedPath('\\\\.\\PhysicalDrive0', 'win32')).toMatch(/network or device path/u);
    expect(refusedPath('\\\\host@80\\dav\\a.mp4', 'win32')).toMatch(/network or device path/u);
    expect(refusedPath('C:\\Users\\me\\a.mp4', 'win32')).toBeNull();
    expect(refusedPath('\\\\?\\C:\\long\\a.mp4', 'win32')).toBeNull();
    expect(refusedPath('//server/x', 'linux')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('refuses a FIFO before opening it, which would block the host', async () => {
    const { execFileSync } = await import('node:child_process');
    const dir = temp();
    const fifo = join(dir, 'pipe.mp4');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    expect(new MediaOffers().offer({ path: fifo, name: 'pipe.mp4' })).toContain('is not a file');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('holds no more files open across the whole host than its cap, oldest closed first', async () => {
    const dir = temp();
    const file = join(dir, 'a.wav');
    writeFileSync(file, wav(10));
    const panes = [new MediaOffers(), new MediaOffers(), new MediaOffers()];
    const tokens: Array<[MediaOffers, string]> = [];
    for (let i = 0; i < MAX_HOST_OFFERS + 1; i += 1) {
      const pane = panes[i % 3]!;
      tokens.push([pane, tokenOf(pane.offer({ path: file, name: 'a.wav' }))]);
    }
    expect(await tokens[0]![0].read(tokens[0]![1], 0, 4)).toBeNull();
    expect(await tokens.at(-1)![0].read(tokens.at(-1)![1], 0, 4)).not.toBeNull();
    for (const pane of panes) pane.closeAll();
  });

  it('lets a read in flight finish on its own file when the pane closes under it', async () => {
    const dir = temp();
    const file = join(dir, 'a.wav');
    const bytes = wav(MAX_READ);
    writeFileSync(file, bytes);
    const offers = new MediaOffers();
    const token = tokenOf(offers.offer({ path: file, name: 'a.wav' }));
    const reading = offers.read(token, 100, 1000);
    offers.closeAll();
    // Another file opened at once would take a reused descriptor, were it closed.
    const other = join(dir, 'b.txt');
    writeFileSync(other, 'x'.repeat(2000));
    expect((await reading)?.data).toEqual(bytes.subarray(100, 1100));
  });
});

describe('the files a pane holds open', () => {
  it('reads a range, no more than a read’s worth, and nothing past the end', async () => {
    const dir = temp();
    const file = join(dir, 'long.wav');
    const bytes = wav(MAX_READ);
    writeFileSync(file, bytes);
    const offers = new MediaOffers();
    const token = tokenOf(offers.offer({ path: file, name: 'long.wav' }));
    const middle = await offers.read(token, 1000, 64);
    expect(middle?.size).toBe(bytes.length);
    expect(middle?.mime).toBe('audio/wav');
    expect(middle?.data).toEqual(bytes.subarray(1000, 1064));
    expect((await offers.read(token, 0, 10 * MAX_READ))?.data.length).toBe(MAX_READ);
    expect((await offers.read(token, bytes.length - 4, 100))?.data).toEqual(bytes.subarray(bytes.length - 4));
    expect((await offers.read(token, bytes.length + 10, 100))?.data.length).toBe(0);
    expect(await offers.read('0'.repeat(32), 0, 10)).toBeNull();
    offers.closeAll();
    expect(await offers.read(token, 0, 10)).toBeNull();
  });

  it('reads what was opened, whatever the path says now', async () => {
    const dir = temp();
    const file = join(dir, 'a.wav');
    writeFileSync(file, wav(100));
    const offers = new MediaOffers();
    const token = tokenOf(offers.offer({ path: file, name: 'a.wav' }));
    rmSync(file);
    writeFileSync(file, 'replaced with something else entirely');
    expect((await offers.read(token, 0, 4))?.data.toString('latin1')).toBe('RIFF');
    offers.closeAll();
  });

  it('keeps the newest few open and closes the oldest', async () => {
    const dir = temp();
    const file = join(dir, 'a.wav');
    writeFileSync(file, wav(10));
    const offers = new MediaOffers();
    const tokens = Array.from({ length: MAX_OFFERS + 1 }, () => tokenOf(offers.offer({ path: file, name: 'a.wav' })));
    expect(await offers.read(tokens[0]!, 0, 4)).toBeNull();
    expect(await offers.read(tokens.at(-1)!, 0, 4)).not.toBeNull();
    offers.closeAll();
  });
});

describe('the pane that streams', () => {
  class FakePty implements Pty {
    readonly pid = 1;
    data: ((d: string) => void) | null = null;
    onData(cb: (d: string) => void): void {
      this.data = cb;
    }
    onExit(): void {}
    write(): void {}
    resize(): void {}
    kill(): void {}
  }

  function harness() {
    const integrationDir = temp();
    const ptys: FakePty[] = [];
    const envs: Array<Record<string, string | undefined>> = [];
    const spawn: PtySpawner = (_f, _a, o) => {
      envs.push(o.env as Record<string, string | undefined>);
      const pty = new FakePty();
      ptys.push(pty);
      return pty;
    };
    const screen: string[] = [];
    // A credential the shell inherits, for the masking of what it prints.
    const env = { AGBRTE_SHELL: '/bin/bash', PATH: '/usr/bin', GITHUB_TOKEN: 'ghp_inherited0123456789' };
    const shells = new Shells<object>('/work', {
      onData: (_id, data) => screen.push(data),
      onExit: () => undefined,
      spawn,
      setTimer: (fn) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimer: () => undefined,
      env,
      programs: new TerminalPrograms({ env, lookup: (n) => (n === '/bin/bash' ? '/bin/bash' : null) }),
      integrationDir,
      cli: { execPath: '/usr/bin/node', entry: '/opt/agbrte/cli/agbrte.js', electron: false },
    });
    return { shells, ptys, envs, screen };
  }

  it('masks its key and its inherited credentials in what it records', () => {
    // `set` in cmd.exe printed the pane key into the log, the export and the
    // model's context — the one place the key is promised never to go.
    const h = harness();
    const recorded: Array<{ block: Block; held: readonly string[] }> = [];
    const agent: AgentBinding = {
      link: {
        send: async () => undefined,
        interrupt: async () => undefined,
        respond: async () => undefined,
        record: (block, held) => recorded.push({ block, held: held ?? [] }),
      },
      subscribe: () => () => undefined,
      pending: () => [],
    };
    h.shells.open({}, { program: { kind: 'terminal' }, agent });
    const key = h.envs[0]![PANE_KEY_ENV]!;
    const osc = (body: string): string => '\u001b]' + body + '\u0007';
    // Every mark with the nonce the shell was given, as its script writes them.
    const nonce = h.envs[0]![MARK_NONCE_ENV]!;
    h.ptys[0]!.data!(osc(`133;A;${nonce}`) + '$ ' + osc(`133;B;${nonce}`));
    h.ptys[0]!.data!(
      osc(`633;E;env;${nonce}`) +
        osc(`133;C;${nonce}`) +
        'AGBRTE_PANE_KEY=' +
        key +
        '\r\n' +
        osc(`133;D;0;${nonce}`),
    );
    h.ptys[0]!.data!(osc(`133;A;${nonce}`) + '$ ' + osc(`133;B;${nonce}`));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.held).toContain(key);
    expect(recorded[0]!.held).toContain('ghp_inherited0123456789');
    expect(recorded[0]!.held).not.toContain('/usr/bin');
  });

  it('gives its shell a key, answers that key’s requests, and reads only for its owner', async () => {
    const h = harness();
    const owner = {};
    const handle = h.shells.open(owner, { program: { kind: 'shell' } });
    const key = h.envs[0]![PANE_KEY_ENV]!;
    expect(key).toMatch(/^[0-9a-f]{32}$/u);

    const dir = temp();
    const file = join(dir, 'tone.wav');
    writeFileSync(file, wav(500));
    h.ptys[0]!.data!(`$ agbrte show tone.wav\r\n${offerSequence(key, { path: file, name: 'tone.wav', rows: 3 })}\n\n\n$ `);
    const shown = h.screen.join('');
    expect(shown).toContain('stream=');
    expect(shown).not.toContain(file);
    const token = tokenOf(shown);

    expect((await h.shells.media(owner, handle.shellId, token, 0, 4))?.data.toString('latin1')).toBe('RIFF');
    expect(await h.shells.media({}, handle.shellId, token, 0, 4)).toBeNull();
    h.shells.close(owner, handle.shellId);
    expect(await h.shells.media(owner, handle.shellId, token, 0, 4)).toBeNull();
  });

  it('gives no key to a shell it did not teach, and passes requests there through untouched', () => {
    const h = harness();
    // A shell somebody started with arguments is not taught (`integrate`).
    const programs = new TerminalPrograms({ env: { AGBRTE_SHELL: '/bin/bash', AGBRTE_SHELL_INTEGRATION: '0' }, lookup: () => '/bin/bash' });
    const shells = new Shells<object>('/work', {
      onData: (_id, data) => h.screen.push(data),
      onExit: () => undefined,
      spawn: (_f, _a, o) => {
        h.envs.push(o.env as Record<string, string | undefined>);
        const pty = new FakePty();
        h.ptys.push(pty);
        return pty;
      },
      setTimer: (fn) => {
        fn();
        return 0 as unknown as NodeJS.Timeout;
      },
      clearTimer: () => undefined,
      env: { AGBRTE_SHELL: '/bin/bash', AGBRTE_SHELL_INTEGRATION: '0' },
      programs,
      integrationDir: temp(),
    });
    shells.open({}, { program: { kind: 'shell' } });
    expect(h.envs[0]![PANE_KEY_ENV]).toBeUndefined();
    const request = offerSequence('k', { path: '/etc/hosts', name: 'hosts' });
    h.ptys[0]!.data!(request);
    expect(h.screen.join('')).toBe(request);
  });
});

describe('the answer a player gets', () => {
  const file = wav(MAX_READ);
  const read = async (shellId: string, token: string, offset: number, length: number) =>
    shellId === 'shell-1' && token === 'tok'
      ? { size: file.length, mime: 'audio/wav', data: file.subarray(offset, Math.min(file.length, offset + Math.min(length, MAX_READ))) }
      : null;
  const get = (url: string, range?: string) =>
    answer(new Request(url, range === undefined ? {} : { headers: { range } }), read);

  it('answers a range with that range, and an open one with the rest of the file', async () => {
    const r = await get('agbrte-media://pane/shell-1/tok', 'bytes=100-199');
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${file.length}`);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(Buffer.from(await r.arrayBuffer())).toEqual(file.subarray(100, 200));
    const open = await get('agbrte-media://pane/shell-1/tok', 'bytes=5-');
    expect(open.headers.get('content-range')).toBe(`bytes 5-${file.length - 1}/${file.length}`);
    expect(open.headers.get('content-length')).toBe(String(file.length - 5));
    expect(Buffer.from(await open.arrayBuffer())).toEqual(file.subarray(5));
  });

  it('answers a request with no range as the whole file, with its true length — not the first read', async () => {
    // The player took a one-read answer for the whole file: 66 seconds of 2,500.
    const r = await get('agbrte-media://pane/shell-1/tok');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe(String(file.length));
    expect(r.headers.get('content-range')).toBeNull();
  });

  it('reads from the host only as the body is taken', async () => {
    const reads: number[] = [];
    const counting = async (shellId: string, token: string, offset: number, length: number) => {
      reads.push(offset);
      return await read(shellId, token, offset, length);
    };
    const r = await answer(new Request('agbrte-media://pane/shell-1/tok', { headers: { range: 'bytes=0-' } }), counting);
    const reader = r.body!.getReader();
    await reader.read();
    await reader.cancel();
    // The first piece, and at most one ahead — not the file.
    expect(reads.length).toBeLessThanOrEqual(2);
  });

  it('is 404 for a token this pane did not give out, and 416 past the end', async () => {
    expect((await get('agbrte-media://pane/shell-1/other', 'bytes=0-')).status).toBe(404);
    expect((await get('agbrte-media://pane/shell-2/tok', 'bytes=0-')).status).toBe(404);
    expect((await get('agbrte-media://elsewhere/shell-1/tok')).status).toBe(404);
    expect((await get('agbrte-media://pane/shell-1/tok', `bytes=${file.length + 5}-`)).status).toBe(416);
  });

  it('reads the range forms a player sends, and refuses the rest', () => {
    expect(parseRange(null)).toBeNull();
    expect(parseRange('bytes=5-')).toEqual({ start: 5 });
    expect(parseRange('bytes=5-9')).toEqual({ start: 5, end: 9 });
    expect(parseRange('bytes=9-5')).toBe('unsatisfiable');
    expect(parseRange('bytes=-500')).toBe('unsatisfiable');
  });
});

describe('agbrte show in the app’s own shell', () => {
  class Collect extends Writable {
    text = '';
    override _write(chunk: Buffer, _e: string, done: () => void): void {
      this.text += chunk.toString('utf8');
      done();
    }
  }

  it('asks the host to stream a file past the threshold, and sends a small one', async () => {
    const dir = temp();
    const big = join(dir, 'long.wav');
    writeFileSync(big, wav(STREAM_ABOVE));
    const small = join(dir, 'short.wav');
    writeFileSync(small, wav(100));
    const env = { TERM_PROGRAM: 'Agbrte', [PANE_KEY_ENV]: KEY };
    const out = new Collect();
    const code = await show([big, small], { play: true }, { env, out, err: new Collect(), tty: true });
    expect(code).toBe(0);
    const [streamed, sent] = out.text.split('\u001b]1337;');
    expect(streamed).toMatch(/^\u001b\]7732;k{32};[A-Za-z0-9+/=]+\u0007\n\n\n$/u);
    const request = JSON.parse(Buffer.from(streamed!.split(';')[2]!.replace(/\u0007\n*$/u, ''), 'base64').toString('utf8'));
    expect(request).toEqual({ path: big, name: 'long.wav', autoplay: true, rows: 3 });
    expect(sent).toContain('File=inline=1');
  });

  it('streams past the inline cap, where without a key it refuses', async () => {
    const dir = temp();
    const file = join(dir, 'huge.wav');
    writeFileSync(file, wav(100));
    const { truncateSync } = await import('node:fs');
    truncateSync(file, 40 * 1024 * 1024);
    const keyed = await show([file], { play: false }, { env: { TERM_PROGRAM: 'Agbrte', [PANE_KEY_ENV]: KEY }, out: new Collect(), err: new Collect(), tty: true });
    expect(keyed).toBe(0);
    const err = new Collect();
    expect(await show([file], { play: false }, { env: { TERM_PROGRAM: 'Agbrte' }, out: new Collect(), err, tty: true })).toBe(1);
    expect(err.text).toContain('a terminal is sent in one piece');
  });

  it('never writes the key anywhere but a terminal — a pipe, a file, a tool capturing output', async () => {
    const dir = temp();
    const big = join(dir, 'long.wav');
    writeFileSync(big, wav(STREAM_ABOVE));
    const out = new Collect();
    await show([big], { play: false }, { env: { TERM_PROGRAM: 'Agbrte', [PANE_KEY_ENV]: KEY }, out, err: new Collect(), tty: false });
    expect(out.text).not.toContain(KEY);
    expect(out.text).not.toContain('7732');
    expect(out.text).toContain('File=inline=1');
  });
});
