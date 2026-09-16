/**
 * Asking a compositor for its screen (DESIGN.md §12.1, §3.3).
 *
 * `spawn` is injected, so what is exercised here is everything around the
 * portal: the helper's answers turning into a stream or into a sentence somebody
 * can act on, the token that makes the second grab silent, and the refusals.
 *
 * What is **not** here is a real portal. That half was measured by hand against
 * a live GNOME 46 machine before any of this was written — `CreateSession` and
 * `SelectSources` returned success with exactly the options the helper sends,
 * and `Start` was seen to raise its dialog by name. Nobody has approved one yet,
 * so no `restore_token` has come back and no frame has been read; `status.md`
 * says so rather than letting these tests imply otherwise.
 */

import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  frameFrom,
  openCast,
  readToken,
  tokenFile,
  writeToken,
  type PortalTools,
  type Spawn,
} from '../src/host/portalCapture.js';

const TOOLS: PortalTools = {
  python: '/usr/bin/python3',
  gst: '/usr/bin/gst-launch-1.0',
  bus: 'unix:path=/run/user/1000/bus',
};

interface Scripted {
  stdout?: string | Buffer | readonly Buffer[] | undefined;
  stderr?: string | undefined;
  code?: number | undefined;
  /** Answers and then holds the session, as the real helper does. */
  hold?: boolean;
}

function fakeSpawn(reply: (args: readonly string[]) => Scripted): {
  run: Spawn;
  started: string[][];
  killed: string[];
} {
  const started: string[][] = [];
  const killed: string[] = [];

  const run = ((_command: string, args: readonly string[]) => {
    started.push([...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let dead = false;
    child.kill = (signal?: string): boolean => {
      dead = true;
      killed.push(signal ?? 'SIGTERM');
      return true;
    };

    const script = reply(args);
    setImmediate(() => {
      if (script.stderr !== undefined) child.stderr.emit('data', Buffer.from(script.stderr, 'utf8'));
      const out = script.stdout;
      if (out !== undefined) {
        const parts = typeof out === 'string' ? [Buffer.from(out, 'utf8')] : Buffer.isBuffer(out) ? [out] : out;
        for (const part of parts) {
          if (dead) return;
          child.stdout.emit('data', part);
        }
      }
      if (dead || script.hold === true) return;
      child.emit('close', script.code ?? 0);
    });
    return child;
  }) as unknown as Spawn;

  return { run, started, killed };
}

/** What the helper prints when the portal agreed. */
const AGREED = `${JSON.stringify({ ok: true, node: 42, restoreToken: 'tok-abc', session: '/s' })}\n`;

describe('opening a cast', () => {
  it('takes the node and the token, and holds the session open', async () => {
    const { run, started, killed } = fakeSpawn(() => ({ stdout: AGREED, hold: true }));

    const { stream, close } = await openCast({ run, tools: TOOLS, token: 'tok-abc' });

    expect(stream).toEqual({ node: 42, restoreToken: 'tok-abc' });
    // The stored token is handed back so the portal can restore silently, and
    // the wait is the short one because this is not an approval.
    expect(started[0]?.[2]).toBe('tok-abc');
    // `-c`, the script, then the two arguments. Indexed past the script rather
    // than from the front, because the script *is* an argument.
    expect(Number(started[0]?.[3])).toBeLessThan(30);

    /*
     * Still running. The helper owns the portal session — closing its bus
     * connection closes the session and the PipeWire node vanishes — so a caller
     * that let it exit would be handed a node id for a stream that no longer
     * exists.
     */
    expect(killed).toEqual([]);
    close();
    expect(killed).toEqual(['SIGKILL']);
  });

  it('waits far longer when it is allowed to ask', async () => {
    /*
     * Two numbers because they are two questions. A silent restore that takes
     * more than seconds is not working, and waiting hides that; a first approval
     * is somebody walking to a machine. Measured: two four-minute waits on a
     * real machine ended with the dialog still on its screen, unanswered.
     */
    const { run, started } = fakeSpawn(() => ({ stdout: AGREED, hold: true }));
    const { close } = await openCast({ run, tools: TOOLS, mayAsk: true });
    close();
    expect(Number(started[0]?.[3])).toBeGreaterThan(60);
    // No token to restore from, and the helper is told so by an empty argument
    // rather than by a missing one — argv positions are not optional.
    expect(started[0]?.[2]).toBe('');
  });

  it('says who declined, and distinguishes it from nobody answering', async () => {
    /*
     * The two that will actually happen, and they need different sentences: a
     * person who said no is finished, and a dialog nobody reached is waiting on
     * a screen somebody can still walk to.
     */
    const declined = fakeSpawn(() => ({ stdout: `${JSON.stringify({ ok: false, reason: 'start', code: 1 })}\n` }));
    await expect(openCast({ run: declined.run, tools: TOOLS })).rejects.toThrow(/declined/u);

    const unanswered = fakeSpawn(() => ({ stdout: `${JSON.stringify({ ok: false, reason: 'start', code: -1 })}\n` }));
    await expect(openCast({ run: unanswered.run, tools: TOOLS })).rejects.toThrow(
      /dialog is on its screen/u,
    );
  });

  it('names the package to install when the bindings are missing', async () => {
    // A machine with python3 and no `python3-gi` is ordinary, and "the portal
    // refused" would send somebody to debug a compositor instead of running one
    // apt command.
    const { run } = fakeSpawn(() => ({ stdout: `${JSON.stringify({ ok: false, reason: 'no-gi' })}\n` }));
    await expect(openCast({ run, tools: TOOLS })).rejects.toThrow(/python3-gi/u);
  });

  it('refuses before spawning anything when the machine cannot be asked', async () => {
    /*
     * Judged first, which is the ordering lesson this repository has now learned
     * three times: a validator that runs after the thing it guards reports a
     * plausible-sounding failure about the wrong step.
     */
    const { run, started } = fakeSpawn(() => ({ stdout: AGREED }));
    await expect(
      openCast({ run, tools: { ...TOOLS, python: null } }),
    ).rejects.toThrow(/no python3/u);
    await expect(openCast({ run, tools: { ...TOOLS, bus: null } })).rejects.toThrow(/session bus/u);
    expect(started).toEqual([]);
  });

  it('kills the helper when it exits without answering', async () => {
    // The helper prints a line whatever happens, so a silent exit is python
    // failing to start rather than the portal saying no — and the process must
    // not be left behind either way.
    const { run, killed } = fakeSpawn(() => ({ stdout: undefined, code: 127 }));
    await expect(openCast({ run, tools: TOOLS })).rejects.toThrow(/without answering/u);
    expect(killed).toEqual(['SIGKILL']);
  });
});

describe('one frame off the stream', () => {
  it('reads the PNG the pipeline writes, from the node it was given', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { run, started } = fakeSpawn(() => ({ stdout: [png] }));

    expect(await frameFrom(42, { run, tools: TOOLS })).toEqual(png);
    // One frame, not a stream: the viewer pulls and waits, so a pipeline left
    // running would be making pictures nobody asked for on somebody's machine.
    expect(started[0]).toContain('num-buffers=1');
    expect(started[0]).toContain('path=42');
  });

  it('names the package when there is nothing to read the stream with', async () => {
    const { run } = fakeSpawn(() => ({ stdout: undefined }));
    await expect(frameFrom(42, { run, tools: { ...TOOLS, gst: null } })).rejects.toThrow(
      /gstreamer1\.0-tools/u,
    );
  });

  it('passes on what the pipeline complained about', async () => {
    // GStreamer's last line is usually the useful one — a missing plugin, a node
    // that went away — and "exited 1" is not something anybody can act on.
    const { run } = fakeSpawn(() => ({
      stderr: 'WARNING: erroneous pipeline\nERROR: no element "pipewiresrc"',
      code: 1,
    }));
    await expect(frameFrom(42, { run, tools: TOOLS })).rejects.toThrow(/no element "pipewiresrc"/u);
  });

  it('refuses a frame too large to be a screen', async () => {
    const megabyte = Buffer.alloc(1024 * 1024);
    const { run, killed } = fakeSpawn(() => ({ stdout: new Array<Buffer>(140).fill(megabyte) }));
    await expect(frameFrom(42, { run, tools: TOOLS })).rejects.toThrow(/could be/u);
    expect(killed).toEqual(['SIGKILL']);
  });
});

describe('the approval this machine keeps', () => {
  it('round-trips a token, and treats every kind of absence the same', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-portal-'));
    const file = join(dir, 'nested', 'screencast.json');

    // Nothing stored yet, and the directory does not even exist. Both mean
    // "nobody has approved this machine", which is not an error in front of
    // somebody who is about to be asked.
    expect(await readToken(file)).toBeUndefined();

    await writeToken('tok-xyz', file);
    expect(await readToken(file)).toBe('tok-xyz');

    // Survives a file somebody edited by hand into nonsense.
    writeFileSync(file, '{ not json', 'utf8');
    expect(await readToken(file)).toBeUndefined();
    // And an empty string is absence rather than a token, because the portal
    // treats it as one and a restore with it would ask again with no explanation.
    writeFileSync(file, JSON.stringify({ restoreToken: '' }), 'utf8');
    expect(await readToken(file)).toBeUndefined();
  });

  it('writes it where the machine keeps its own facts, and only for its owner', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agbrte-portal-'));
    const file = join(dir, 'screencast.json');
    await writeToken('tok-xyz', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ restoreToken: 'tok-xyz' });
  });

  it('honours AGBRTE_HOME, because a shared default once broke a whole test run', () => {
    /*
     * CLAUDE.md's second hazard, applied to one more file. A `= homedir()`
     * default made every host in a run share one directory, and it only failed
     * in CI — because CI runs parallel.
     */
    expect(tokenFile('/tmp/some-machine')).toBe(join('/tmp/some-machine', 'screencast.json'));

    /*
     * And with nothing passed, which is how every caller in the tree calls it.
     *
     * The first version of this only checked the explicit argument, and a
     * revert-check found it unfailable: an implementation that ignored
     * `AGBRTE_HOME` entirely kept the whole file green, because no assertion ever
     * reached the default. That is the exact defect this test is named after,
     * sitting inside the test meant to catch it.
     */
    const had = process.env['AGBRTE_HOME'];
    process.env['AGBRTE_HOME'] = '/tmp/from-the-environment';
    try {
      expect(tokenFile()).toBe(join('/tmp/from-the-environment', 'screencast.json'));

      /*
       * Then the fallback, with the variable genuinely absent.
       *
       * The first version of this passed `undefined` and believed it was testing
       * the fallback. It was not: `undefined` triggers the *default parameter*,
       * which reads the environment, and this suite runs with `AGBRTE_HOME` set
       * to a temp directory — so it was reading the variable while claiming to
       * prove what happens without it.
       */
      delete process.env['AGBRTE_HOME'];
      expect(tokenFile().endsWith(join('.agbrte', 'screencast.json'))).toBe(true);
    } finally {
      if (had === undefined) delete process.env['AGBRTE_HOME'];
      else process.env['AGBRTE_HOME'] = had;
    }
  });
});
