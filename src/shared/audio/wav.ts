/**
 * PCM to WAV (DESIGN.md §12.4).
 *
 * `MediaRecorder` — the obvious way to record in a renderer — produces webm or
 * ogg with Opus inside, and `whisper.cpp` takes 16-bit PCM. That mismatch has
 * exactly three resolutions and two of them are bad:
 *
 *  - Convert with ffmpeg. A second detected native dependency, for a path that
 *    has not been shown to need one.
 *  - Send the webm and hope. whisper handed a container it does not understand
 *    either errors or **transcribes noise confidently**, and the second is much
 *    worse than a refusal.
 *  - Record raw samples through the Web Audio API and write the header
 *    ourselves. Forty lines, no dependency, and it is what `stt.ts` already
 *    demands by refusing anything that is not RIFF/WAVE.
 *
 * This is the third. It lives in `shared/` because the renderer encodes and the
 * main process reads the result back, and a header written by one and parsed by
 * the other should be described in one place.
 *
 * ## 16 kHz mono, deliberately
 *
 * whisper resamples everything to 16 kHz mono internally, so recording at 48 kHz
 * stereo produces a file six times larger that the engine immediately throws
 * five sixths of away. On a path where the clip is held in memory, base64'd
 * across an IPC boundary, and written to a bounded on-disk store, that is six
 * times the cost for no accuracy at all.
 */

/** What whisper.cpp wants, so nothing downstream has to resample. */
export const SAMPLE_RATE = 16_000;

/** 16-bit signed PCM: two bytes a sample, which is the only depth whisper takes. */
const BYTES_PER_SAMPLE = 2;

/**
 * Write a WAV around 16-bit mono samples.
 *
 * Takes `Int16Array` rather than `Float32Array` so the clipping decision is the
 * caller's and visible — see `toPcm16`.
 */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * BYTES_PER_SAMPLE;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  // Everything after this field. Not the file length — a mistake that produces a
  // file most players accept and some parsers truncate.
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');

  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // format: PCM
  view.setUint16(22, 1, true); // channels: mono
  view.setUint32(24, sampleRate, true);
  // Byte rate, which is what `wavDurationMs` divides by. Wrong here means a
  // duration that is confidently wrong everywhere it is displayed.
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  view.setUint16(32, BYTES_PER_SAMPLE, true); // block align
  view.setUint16(34, 16, true); // bits per sample

  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * BYTES_PER_SAMPLE, samples[i]!, true);
  }

  return new Uint8Array(out);
}

/**
 * Float samples as the Web Audio API produces them, to 16-bit PCM.
 *
 * Clamped before scaling. A microphone gained too high delivers values outside
 * ±1, and letting those wrap through `Math.round` turns a loud syllable into
 * full-scale noise of the opposite sign — which whisper hears as a click and
 * sometimes transcribes as a word.
 */
export function toPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    // Asymmetric on purpose: 16-bit signed runs -32768..32767, and scaling both
    // directions by 32768 makes a full-scale positive sample overflow to -32768.
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/**
 * Downsample by averaging, for a context that would not give us 16 kHz.
 *
 * `AudioContext` honours a requested sample rate on most platforms and ignores
 * it on some, so the recorder cannot assume it got what it asked for. Averaging
 * rather than dropping samples: decimation aliases, and aliased speech is the
 * kind of degradation that makes a transcript subtly wrong rather than obviously
 * broken.
 */
export function downsample(samples: Float32Array, from: number, to = SAMPLE_RATE): Float32Array {
  if (from <= to) return samples;

  const ratio = from / to;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += samples[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}
