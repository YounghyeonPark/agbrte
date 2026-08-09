/**
 * Voice, and the promise that it stays here (DESIGN.md §12.4).
 *
 * > Audio never traverses the transport and never reaches a model provider;
 * > dictating about proprietary code doesn't ship your voice to a third party.
 *
 * That is a §13-grade guarantee wearing a §12 heading, and before this it was
 * held by nothing at all: `fitContent` had no audio branch, so an `AudioBlock`
 * fell straight through to the adapter. It was true only because nothing
 * produced one yet — the same shape as redaction holding by not working.
 */

import { describe, expect, it } from 'vitest';
import { fitContent } from '@main/content/fit.js';
import { DEFAULT_ECHO_CAPABILITIES } from '@main/runtime/runtimes/echo.js';
import {
  findEngine,
  isWav,
  NoSpeechEngine,
  transcribe,
  wavDurationMs,
} from '@main/voice/stt.js';
import type { AudioBlock, ContentBlock, RuntimeCapabilities, Sha256 } from '@shared/types/index.js';

function caps(over: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    ...DEFAULT_ECHO_CAPABILITIES,
    input: { image: true, audio: false, pdf: false, video: false },
    ...over,
  };
}

const clip = (over: Partial<AudioBlock> = {}): AudioBlock => ({
  type: 'audio',
  sha256: 'deadbeef'.repeat(8) as Sha256,
  mime: 'audio/wav',
  durationMs: 4200,
  ...over,
});

const texts = (content: ContentBlock[]): string[] =>
  content.map((b) => (b as { text?: string }).text ?? `<${b.type}>`);

describe('audio does not reach a provider', () => {
  it('replaces a clip with its transcript', async () => {
    const result = await fitContent([clip({ transcript: 'run the tests again' })], caps());

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'run the tests again' });
  });

  it('does it even when the agent accepts audio', async () => {
    /**
     * The assertion that makes this a guarantee rather than a downgrade. A
     * provider that takes audio is exactly the case §12.4's sentence is about —
     * branching on the capability would make "your voice reached a third party"
     * depend on which model you happened to pick, which is not a property
     * anybody can reason about.
     */
    const result = await fitContent(
      [clip({ transcript: 'ship it' })],
      caps({ input: { image: true, audio: true, pdf: false, video: false } }),
    );

    expect(result.content.every((b) => b.type === 'text')).toBe(true);
    expect(result.content.some((b) => b.type === 'audio')).toBe(false);
  });

  it('never passes the hash through either', async () => {
    // Not merely "no audio block": the sha is the handle §6.7 resolves, and a
    // transcript carrying it would let a tool fetch the clip and send it on.
    const result = await fitContent([clip({ transcript: 'hello' })], caps());

    expect(JSON.stringify(result.content)).not.toContain('deadbeef');
  });

  it('names an untranscribed clip rather than dropping it', async () => {
    // STT can fail — no engine here, a model that will not load. An agent told
    // there was a voice message can ask about it; one handed silence cannot.
    const result = await fitContent([clip()], caps());

    expect(texts(result.content)[0]).toMatch(/voice message.*4\.2s.*not transcribed/i);
    // Its own reason: the agent's capabilities are irrelevant here, because
    // audio never reaches a provider whatever they say. The local engine failed.
    expect(result.downgrades.map((d) => d.reason)).toContain('not_transcribed');
  });

  it('treats a whitespace transcript as no transcript', async () => {
    // An engine that produced nothing usable should not read as a user who said
    // nothing, which is what an empty text block would look like.
    const result = await fitContent([clip({ transcript: '   \n ' })], caps());

    expect(texts(result.content)[0]).toMatch(/not transcribed/i);
  });

  it('sends the transcript unlabelled, because it is just what they said', async () => {
    // §12.4: the user edits the text before sending. By then it is the message,
    // and a "[voice]" prefix would tell a model how the words were typed.
    const result = await fitContent([clip({ transcript: 'why is this failing' })], caps());

    expect(texts(result.content)[0]).toBe('why is this failing');
  });

  it('leaves the rest of the turn alone', async () => {
    const result = await fitContent(
      [{ type: 'text', text: 'context' }, clip({ transcript: 'and this' })],
      caps(),
    );

    expect(texts(result.content)).toEqual(['context', 'and this']);
  });
});

describe('finding a local engine', () => {
  it('returns null rather than throwing when there is none', async () => {
    // Most machines. A client's job is to say so, not to fail starting up.
    const found = await findEngine({
      bins: ['definitely-not-whisper-xyz'],
      models: ['/no/such/model.bin'],
      env: {},
    });
    expect(found).toBeNull();
  });

  it('refuses a binary with no weights, rather than reporting half an engine', async () => {
    // Otherwise the failure moves to the first thing a user tries to say.
    const found = await findEngine({
      bins: ['/no/such/whisper'],
      models: [],
      env: { AGBRTE_WHISPER_BIN: 'whisper-cli' },
    });
    expect(found).toBeNull();
  });

  it('takes the user’s own answer over anything guessed', async () => {
    // Somebody who built whisper.cpp themselves knows where it is, and a search
    // that overrode them would be sometimes wrong and never overridable.
    const found = await findEngine({
      env: { AGBRTE_WHISPER_BIN: '/my/whisper', AGBRTE_WHISPER_MODEL: '/my/model.bin' },
    });
    expect(found).toEqual({ bin: '/my/whisper', model: '/my/model.bin' });
  });

  it('does not run an absolute candidate to find out whether it is there', async () => {
    // The lesson from `findBrowser`, where probing with `--version` stalled ten
    // seconds on Windows and then selected the wrong browser. The question is
    // whether a file exists, so the filesystem should answer it.
    let ran = 0;
    const exec = (async () => {
      ran += 1;
      throw new Error('should not be reached for a path');
    }) as never;

    await findEngine({ bins: ['/no/such/whisper'], models: [], env: {}, exec });
    expect(ran).toBe(0);
  });
});

describe('transcribing', () => {
  const wav = (): Buffer => {
    // A minimal 16-bit mono 16 kHz PCM header with a second of silence.
    const data = Buffer.alloc(32_000);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.writeUInt32LE(36 + data.length, 4);
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(1, 22);
    head.writeUInt32LE(16_000, 24);
    head.writeUInt32LE(32_000, 28); // byte rate
    head.writeUInt16LE(2, 32);
    head.writeUInt16LE(16, 34);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);
    return Buffer.concat([head, data]);
  };

  it('says there is no remote fallback, because that is the design', async () => {
    /**
     * The error names the reason rather than only the fact. "No engine" reads
     * as a bug to be worked around; "audio is never sent to a provider, so
     * there is no remote fallback by design" tells the user what to install and
     * why nothing else will happen.
     */
    await expect(transcribe(wav(), null)).rejects.toThrow(NoSpeechEngine);
    await expect(transcribe(wav(), null)).rejects.toThrow(/never sent to a provider/);
  });

  it('refuses anything that is not a WAV', async () => {
    // whisper.cpp takes 16-bit PCM. Handed a browser's webm it produces either
    // an error or a confident transcription of noise, and the second is worse.
    await expect(
      transcribe(Buffer.from('not audio'), { bin: 'whisper-cli', model: 'm.bin' }),
    ).rejects.toThrow(/not a WAV/);
  });

  it('reads the clip back out of the file the engine wrote', async () => {
    // Rather than parsing stdout: whisper prints timestamps and load messages
    // there and the shape has changed between releases.
    const calls: string[][] = [];
    const exec = (async (_bin: string, args: string[]) => {
      calls.push(args);
      const out = args[args.indexOf('-of') + 1]!;
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${out}.txt`, '  hello there \n');
      return { stdout: '', stderr: '' };
    }) as never;

    const result = await transcribe(wav(), { bin: 'whisper-cli', model: 'm.bin' }, { exec });
    expect(result.text).toBe('hello there');
    expect(calls[0]).toContain('-otxt');
  });

  it('passes a language rather than a locale', async () => {
    // whisper takes `en`, not `en-GB`, and rejects the pair.
    const calls: string[][] = [];
    const exec = (async (_bin: string, args: string[]) => {
      calls.push(args);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, 'x');
      return { stdout: '', stderr: '' };
    }) as never;

    await transcribe(wav(), { bin: 'w', model: 'm' }, { exec, locale: 'en-GB' });
    expect(calls[0]![calls[0]!.indexOf('-l') + 1]).toBe('en');
  });

  it('leaves no recording behind in the temp directory', async () => {
    /**
     * The same rule §12.1 states for screenshots. A recording of somebody
     * dictating about their own codebase left in `/tmp` is the leak this
     * section exists to prevent, arriving through a cleanup nobody wrote.
     */
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-stt-')).length;

    const exec = (async (_bin: string, args: string[]) => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(`${args[args.indexOf('-of') + 1]!}.txt`, 'x');
      return { stdout: '', stderr: '' };
    }) as never;
    await transcribe(wav(), { bin: 'w', model: 'm' }, { exec });

    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-stt-')).length;
    expect(after).toBe(before);
  });

  it('cleans up even when the engine fails', async () => {
    const { readdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const before = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-stt-')).length;

    const exec = (async () => {
      throw new Error('model would not load');
    }) as never;
    await expect(transcribe(wav(), { bin: 'w', model: 'm' }, { exec })).rejects.toThrow();

    const after = (await readdir(tmpdir())).filter((n) => n.startsWith('agbrte-stt-')).length;
    expect(after).toBe(before);
  });
});

describe('reading a clip’s length from its own header', () => {
  it('computes duration from the byte rate', () => {
    const data = Buffer.alloc(32_000);
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'ascii');
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt32LE(32_000, 28);
    head.write('data', 36, 'ascii');
    head.writeUInt32LE(data.length, 40);

    expect(wavDurationMs(Buffer.concat([head, data]))).toBe(1000);
  });

  it('walks past a chunk it does not care about', () => {
    // A browser-written WAV often carries a LIST chunk before the audio, so
    // assuming `data` at offset 36 reads a length out of the wrong place.
    const list = Buffer.alloc(8 + 10);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(10, 4);

    const head = Buffer.alloc(36);
    head.write('RIFF', 0, 'ascii');
    head.write('WAVE', 8, 'ascii');
    head.write('fmt ', 12, 'ascii');
    head.writeUInt32LE(16, 16);
    head.writeUInt32LE(16_000, 28);

    const dataHead = Buffer.alloc(8);
    dataHead.write('data', 0, 'ascii');
    dataHead.writeUInt32LE(8_000, 4);

    expect(wavDurationMs(Buffer.concat([head, list, dataHead, Buffer.alloc(8_000)]))).toBe(500);
  });

  it('says null rather than guessing at a header it does not understand', () => {
    // The same refusal `png.ts` makes: a plausible wrong number is worse than an
    // absent one, because the wrong one is displayed as a fact.
    expect(wavDurationMs(Buffer.from('not a wav at all'))).toBeNull();
    expect(isWav(Buffer.from('not a wav at all'))).toBe(false);
  });
});
