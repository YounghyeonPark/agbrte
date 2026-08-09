/**
 * Dictation against a real engine (DESIGN.md §12.4, §15 Phase 7).
 *
 * Everything in `voice.test.ts` drives `transcribe` with an injected `exec`,
 * which proves the arguments and the cleanup and nothing about whether
 * whisper.cpp actually accepts them. That is the gap that has produced a real
 * bug every time it was closed today — a `--version` probe that hung, a browser
 * that wrote no file, an annotation that never reached the model.
 *
 * So this runs the actual binary against actual speech, and it is skipped
 * **loudly** when the engine is absent, which is most machines:
 *
 *   AGBRTE_WHISPER_BIN=<dir>/whisper-cli.exe \
 *   AGBRTE_WHISPER_MODEL=<dir>/ggml-tiny.en.bin \
 *   AGBRTE_WHISPER_SPEECH=<dir>/speech.wav npm run test
 *
 * The clip is synthesized with the platform's own TTS rather than committed as
 * a fixture — a checked-in WAV of a human voice is a strange thing to have in a
 * repository, and §12.4 names SAPI for TTS anyway.
 */

import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { findEngine, isWav, transcribe, wavDurationMs } from '@main/voice/stt.js';
import { fitContent } from '@main/content/fit.js';
import { DEFAULT_ECHO_CAPABILITIES } from '@main/runtime/runtimes/echo.js';
import type { Sha256 } from '@shared/types/index.js';

const BIN = process.env['AGBRTE_WHISPER_BIN'] ?? '';
const MODEL = process.env['AGBRTE_WHISPER_MODEL'] ?? '';
const SPEECH = process.env['AGBRTE_WHISPER_SPEECH'] ?? '';
const HAVE = [BIN, MODEL, SPEECH].every((p) => p !== '' && existsSync(p));

if (!HAVE) {
  // eslint-disable-next-line no-console
  console.warn(
    'whisperReal.test.ts: skipped — set AGBRTE_WHISPER_BIN, AGBRTE_WHISPER_MODEL and ' +
      'AGBRTE_WHISPER_SPEECH to run against a real engine. The injected-exec version ' +
      'of these checks is in voice.test.ts.',
  );
}

describe.skipIf(!HAVE)('whisper.cpp, for real', () => {
  it('finds the engine the way the app does', async () => {
    // Through `findEngine`, not by reading the env directly: the point is that
    // the discovery path a user's machine takes is the one under test.
    const found = await findEngine();
    expect(found).not.toBeNull();
    expect(found!.bin).toBe(BIN);
  });

  it('transcribes real speech into something recognisable', async () => {
    /**
     * Asserted on content words rather than on an exact string. `tiny.en` is the
     * smallest model there is and will differ on punctuation and casing; pinning
     * the whole sentence would make this a test of one model's quirks rather
     * than of whether the pipeline works.
     */
    const wav = await readFile(SPEECH);
    expect(isWav(wav)).toBe(true);

    const result = await transcribe(wav, { bin: BIN, model: MODEL });
    const said = result.text.toLowerCase();

    for (const word of ['run', 'tests', 'failing']) {
      expect(said, `transcript was: ${result.text}`).toContain(word);
    }
    expect(result.engine).toMatch(/whisper/i);
  }, 180_000);

  it('survives a locale the model does not speak', async () => {
    /**
     * The renderer passes `navigator.language` on every press, so `-l` is always
     * on the real path — and a Korean user with an English-only model is the
     * obvious way for that to go wrong. Checked rather than assumed: whisper
     * warns that the model is not multilingual, ignores the flag, and
     * transcribes anyway.
     *
     * Worth a test rather than a comment, because "it degrades" is a claim about
     * a program we do not control and a future release could decide otherwise.
     */
    const wav = await readFile(SPEECH);
    const result = await transcribe(wav, { bin: BIN, model: MODEL }, { locale: 'ko-KR' });

    expect(result.text.toLowerCase()).toContain('tests');
  }, 180_000);

  it('reports the clip’s length from its own header', async () => {
    // The encoder and this parser are written separately and checked against
    // each other in `voice.test.ts`; here the WAV comes from an unrelated
    // program, which is the stronger check on the parser.
    const wav = await readFile(SPEECH);
    const ms = wavDurationMs(wav);

    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(1_000);
    expect(ms!).toBeLessThan(30_000);
  });

  it('sends the words and not the recording', async () => {
    /**
     * The §12.4 guarantee, end to end on a real transcript: what leaves is text
     * a person could have typed, and no part of the clip — not the audio, not
     * its hash — is in the content handed to an adapter.
     */
    const wav = await readFile(SPEECH);
    const { text } = await transcribe(wav, { bin: BIN, model: MODEL });

    const fitted = await fitContent(
      [
        {
          type: 'audio',
          sha256: 'a'.repeat(64) as Sha256,
          mime: 'audio/wav',
          durationMs: wavDurationMs(wav) ?? 0,
          transcript: text,
        },
      ],
      {
        ...DEFAULT_ECHO_CAPABILITIES,
        // Even here, where the agent would accept audio.
        input: { image: true, audio: true, pdf: false, video: false },
      },
    );

    expect(fitted.content).toEqual([{ type: 'text', text }]);
    expect(JSON.stringify(fitted.content)).not.toContain('a'.repeat(64));
  }, 180_000);
});
