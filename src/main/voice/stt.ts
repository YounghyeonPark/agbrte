/**
 * Speech to text, on this machine only (DESIGN.md §12.4).
 *
 * > **STT runs locally, always** … Audio never traverses the transport and never
 * > reaches a model provider; dictating about proprietary code doesn't ship your
 * > voice to a third party.
 *
 * That sentence is the whole reason this file is not three lines calling a
 * hosted transcription API. It is also why `content/fit.ts` converts an
 * `AudioBlock` to its transcript unconditionally rather than checking whether
 * the model accepts audio: the guarantee is that the clip does not leave, not
 * that it leaves only where it would be understood.
 *
 * ## Detected, not bundled — and §12.4 says otherwise
 *
 * That section specifies a "bundled `whisper.cpp` with a small multilingual
 * model". Built the other way, deliberately, because bundling contradicts a
 * choice the rest of the document makes twice for the same reason.
 *
 * §3.12 refuses to vendor a CLI and §12.1 refuses to vendor a browser, both
 * because "the installer is one self-contained shell script" and a per-platform
 * download would be "the heaviest dependency in the project — for a feature many
 * sessions never use". The installer is ~370 KB and carries the three bundles
 * that *are* Agbrte on a headless machine. The smallest useful whisper model is
 * around 75 MB and a good multilingual one is several hundred; a native binary
 * per platform sits on top of that. Bundling would make the installer two orders
 * of magnitude larger so that a server which will never have a microphone
 * attached can carry a speech model.
 *
 * So it is the same shape as the other two: find what is installed, drive it,
 * and refuse clearly when it is absent. A user who wants dictation installs
 * `whisper.cpp` once; everyone else pays nothing. The contradiction is recorded
 * in §12.4 rather than resolved silently.
 *
 * ## Not streaming, and saying so
 *
 * §12.4 asks for live partials. `whisper-cli` transcribes a finished file and
 * exits — real partials need either its streaming example binary or bindings,
 * and offering a fake stream that emits the whole transcript at the end would
 * be worse than an honest absence: the UI would be built against a promise the
 * engine does not keep. `partials` is therefore empty for this provider and the
 * capability is declared, so a caller can show a plain "transcribing…" instead
 * of a cursor that never moves.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * How long a transcription gets.
 *
 * Generous, because a CPU-only whisper on a long clip is slow and killing it
 * loses the recording. The recording itself is capped elsewhere; this is the
 * backstop for an engine that has wedged rather than a limit on speech.
 */
const TRANSCRIBE_TIMEOUT_MS = 120_000;

export class NoSpeechEngine extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoSpeechEngine';
  }
}

/**
 * Where `whisper.cpp` usually is.
 *
 * `whisper-cli` first: upstream renamed `main` to it, and a bare `main` on
 * `PATH` is far more likely to be somebody else's program than a speech engine.
 * Nothing here is installed by us and nothing is downloaded.
 */
export const ENGINE_CANDIDATES: readonly string[] = [
  'whisper-cli',
  'whisper.cpp',
  '/usr/local/bin/whisper-cli',
  '/usr/bin/whisper-cli',
  '/opt/homebrew/bin/whisper-cli',
];

/** Where a model file usually is, relative to nothing we control. */
export const MODEL_CANDIDATES: readonly string[] = [
  '/usr/local/share/whisper.cpp/ggml-base.bin',
  '/opt/homebrew/share/whisper.cpp/ggml-base.bin',
];

export interface SpeechEngine {
  /** Absolute path or a name on `PATH`. */
  bin: string;
  /** The weights. Separate because the binary is useless without them. */
  model: string;
}

/**
 * Find an engine, or `null`.
 *
 * `null` rather than a throw, like `findBrowser` and `detectCli`: a machine
 * without one is an ordinary state of the world — most of them, in fact — and a
 * client's job is to say so rather than to fail starting up.
 *
 * An absolute candidate is checked by **existence** rather than by running it.
 * That lesson came from `findBrowser`, where probing with `--version` stalled
 * ten seconds on Windows and then picked the wrong browser; the question being
 * asked is whether a file is there, so the filesystem is what should answer it.
 */
export async function findEngine(
  opts: {
    bins?: readonly string[];
    models?: readonly string[];
    env?: NodeJS.ProcessEnv;
    exec?: typeof run;
  } = {},
): Promise<SpeechEngine | null> {
  const env = opts.env ?? process.env;
  const exec = opts.exec ?? run;

  // The user's own answer wins over anything guessed. Somebody who built
  // whisper.cpp themselves knows where it is, and a search that overrode them
  // would be a search that is sometimes wrong and never overridable.
  const bin = env['AGBRTE_WHISPER_BIN'] ?? (await firstPresent(opts.bins ?? ENGINE_CANDIDATES, exec));
  if (bin === null || bin === undefined) return null;

  const model = env['AGBRTE_WHISPER_MODEL'] ?? findFile(opts.models ?? MODEL_CANDIDATES);
  if (model === null || model === undefined) {
    // A binary with no weights is not an engine, and reporting it as one would
    // move the failure to the first thing a user tries to say.
    return null;
  }

  return { bin, model };
}

async function firstPresent(
  candidates: readonly string[],
  exec: typeof run,
): Promise<string | null> {
  for (const candidate of candidates) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    try {
      // A bare name only tells us whether it resolves on `PATH`. `--help`
      // rather than `--version`: whisper-cli prints usage and exits either way,
      // and the exit code is not what is being asked about.
      await exec(candidate, ['--help'], { timeout: 5_000 });
      return candidate;
    } catch {
      // Not on PATH. Try the next.
    }
  }
  return null;
}

function findFile(candidates: readonly string[]): string | null {
  return candidates.find((c) => existsSync(c)) ?? null;
}

export interface Transcription {
  text: string;
  /** Which engine and weights produced it, so a bad transcript is attributable. */
  engine: string;
  model: string;
}

/**
 * Transcribe a WAV clip.
 *
 * **WAV, and only WAV.** `whisper.cpp` takes 16-bit PCM and nothing else, and
 * feeding it a webm from a browser's `MediaRecorder` produces either an error or
 * a confident transcription of noise. Converting would mean ffmpeg — a second
 * detected dependency for a path that has not been shown to be needed — so the
 * recorder is what has to produce WAV, and this refuses anything else rather
 * than guessing.
 *
 * The temporary directory goes whatever happens, for the reason §12.1 gives
 * about screenshots: a recording of somebody dictating about their own codebase
 * left in `/tmp` is the leak this section exists to prevent, arriving through a
 * cleanup nobody wrote.
 */
export async function transcribe(
  wav: Buffer,
  engine: SpeechEngine | null,
  opts: { locale?: string; exec?: typeof run } = {},
): Promise<Transcription> {
  if (engine === null) {
    throw new NoSpeechEngine(
      'no local speech engine found — install whisper.cpp and a model, or set ' +
        'AGBRTE_WHISPER_BIN and AGBRTE_WHISPER_MODEL. Audio is never sent to a ' +
        'provider, so there is no remote fallback by design (§12.4)',
    );
  }
  if (!isWav(wav)) {
    throw new NoSpeechEngine(
      'that clip is not a WAV; whisper.cpp takes 16-bit PCM and would otherwise ' +
        'transcribe noise confidently',
    );
  }

  const exec = opts.exec ?? run;
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-stt-'));
  const input = join(dir, 'clip.wav');

  try {
    await writeFile(input, wav);
    await exec(
      engine.bin,
      [
        '-m',
        engine.model,
        '-f',
        input,
        // Plain text beside the input, rather than parsing the progress output:
        // whisper prints timestamps and load messages to stdout and the shape
        // has changed between releases, which is a bad thing to depend on.
        '-otxt',
        '-of',
        join(dir, 'clip'),
        '--no-prints',
        ...(opts.locale !== undefined ? ['-l', shortLocale(opts.locale)] : []),
      ],
      { timeout: TRANSCRIBE_TIMEOUT_MS },
    );

    const text = await readFile(join(dir, 'clip.txt'), 'utf8');
    return { text: text.trim(), engine: basename(engine.bin), model: basename(engine.model) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** `en-GB` → `en`. whisper takes a language, not a locale, and rejects the pair. */
function shortLocale(locale: string): string {
  return locale.split('-')[0]!.toLowerCase();
}

/** RIFF/WAVE, checked rather than trusted from a file extension. */
export function isWav(data: Buffer): boolean {
  return (
    data.length > 12 &&
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WAVE'
  );
}

/**
 * Milliseconds of audio in a PCM WAV, from its header.
 *
 * Read rather than taken from the recorder, because it is stored in the
 * transcript as a fact about the clip and a caller's own timing includes
 * whatever happened between pressing and releasing a key.
 *
 * `null` when the header is not the simple shape this understands — the same
 * refusal `png.ts` makes, and for the same reason: a plausible wrong number is
 * worse than an absent one.
 */
export function wavDurationMs(data: Buffer): number | null {
  if (!isWav(data)) return null;

  // Walk the chunks rather than assuming `fmt ` at 12 and `data` at 36: a WAV
  // written by a browser often carries a LIST chunk before the audio.
  let at = 12;
  let byteRate = 0;
  while (at + 8 <= data.length) {
    const id = data.toString('ascii', at, at + 4);
    const size = data.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 8 + 16 <= data.length) byteRate = data.readUInt32LE(at + 16);
    if (id === 'data') {
      if (byteRate === 0) return null;
      return Math.round((size / byteRate) * 1000);
    }
    at += 8 + size + (size % 2);
  }
  return null;
}
