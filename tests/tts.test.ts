/**
 * Reading a reply out loud (DESIGN.md §12.4).
 *
 * The interesting properties are not "does it make noise" — they are what
 * happens when somebody wants it to *stop*, and what happens to text that
 * contains characters a shell would take an interest in.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { findVoice, NoSpeechOutput, Speaker, type Spawner } from '@main/voice/tts.js';

/** A child that never exits until told, so "still speaking" is observable. */
class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  }
  finish(): void {
    this.emit('exit', 0, null);
  }
}

function recorder(): {
  spawn: Spawner;
  calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }>;
  children: FakeChild[];
} {
  const calls: Array<{ bin: string; args: string[]; env?: NodeJS.ProcessEnv }> = [];
  const children: FakeChild[] = [];
  return {
    calls,
    children,
    spawn: ((bin, args, env) => {
      calls.push({ bin, args, ...(env !== undefined ? { env } : {}) });
      const child = new FakeChild();
      children.push(child);
      return child as never;
    }) as Spawner,
  };
}

const ENGINE = { bin: 'say', args: (t: string) => [t] };

describe('stopping actually stops', () => {
  it('kills rather than letting it finish', async () => {
    /**
     * The reason somebody presses stop is that something is being said aloud
     * that they did not want said aloud. Every word after the press is the
     * failure still happening, so a polite "finish this sentence" is the wrong
     * behaviour even though it sounds nicer.
     */
    const r = recorder();
    const speaker = new Speaker(ENGINE, r.spawn);

    const speaking = speaker.speak('a long reply');
    expect(speaker.speaking).toBe(true);

    speaker.stop();
    await speaking;

    expect(r.children[0]!.killed).toBe(true);
    expect(speaker.speaking).toBe(false);
  });

  it('replaces what is being said rather than queueing behind it', async () => {
    // Two sessions finishing together must produce the newer announcement, not
    // both of them over each other.
    const r = recorder();
    const speaker = new Speaker(ENGINE, r.spawn);

    const first = speaker.speak('older news');
    const second = speaker.speak('newer news');
    await first;

    expect(r.children[0]!.killed).toBe(true);
    expect(r.calls).toHaveLength(2);

    r.children[1]!.finish();
    await second;
    expect(speaker.speaking).toBe(false);
  });

  it('is a no-op when nothing is being said', () => {
    const speaker = new Speaker(ENGINE, recorder().spawn);
    expect(() => speaker.stop()).not.toThrow();
  });
});

describe('text that a shell would take an interest in', () => {
  it('hands it to the process as an argument, not as script', async () => {
    /**
     * `spawn` without a shell passes argv straight through, so an apostrophe is
     * an apostrophe. This asserts the text arrives *whole* — the failure being
     * guarded is a reply like `it's done; rm -rf /` becoming two things.
     */
    const r = recorder();
    const speaker = new Speaker(ENGINE, r.spawn);

    const hostile = `it's done; rm -rf / && echo "$(whoami)"`;
    const done = speaker.speak(hostile);
    r.children[0]!.finish();
    await done;

    expect(r.calls[0]!.args).toEqual([hostile]);
  });

  it('sends Windows text through the environment, where there is no quoting', () => {
    /**
     * The version before this passed the text as a trailing argument and read
     * `$args[0]`, which does not work at all: with `-Command`, anything after
     * the script is appended to the *script string*, so PowerShell tried to
     * parse the agent's reply as code. Found by running it against real SAPI.
     */
    const engine = findVoice('win32')!;
    expect(engine.args('some reply')).not.toContain('some reply');
    expect(engine.env?.('some reply')).toMatchObject({ AGBRTE_TTS_TEXT: 'some reply' });
  });

  it('says nothing for an empty reply rather than spawning to be silent', async () => {
    const r = recorder();
    await new Speaker(ENGINE, r.spawn).speak('   \n ');
    expect(r.calls).toEqual([]);
  });
});

describe('a machine with no voice', () => {
  it('says so, and names the remedy where there is one', async () => {
    // Detected, never bundled — the fourth time this project makes that choice
    // (§3.12, §12.1, §12.4).
    const speaker = new Speaker(null);
    expect(speaker.available).toBe(false);
    await expect(speaker.speak('anything')).rejects.toThrow(NoSpeechOutput);
  });

  it('finds the platform voice where the platform has one', () => {
    expect(findVoice('darwin')?.bin).toBe('/usr/bin/say');
    expect(findVoice('win32')?.bin).toBe('powershell');
  });

  it('treats a failed synthesiser as silence, not a crash', async () => {
    // The reply is already on screen; this was the optional half.
    const r = recorder();
    const speaker = new Speaker(ENGINE, r.spawn);

    const done = speaker.speak('hello');
    r.children[0]!.emit('error', new Error('no audio device'));

    await expect(done).resolves.toBeUndefined();
    expect(speaker.speaking).toBe(false);
  });
});
