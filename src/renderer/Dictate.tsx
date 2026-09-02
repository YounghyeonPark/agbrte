/**
 * Push-to-talk (DESIGN.md §12.4).
 *
 * > Streaming partials render live; the user edits before sending. **Voice never
 * > auto-sends.** … Push-to-talk scoped to the focused session; the mic is never
 * > hot by default, with an unmistakable live indicator.
 *
 * Three of those four are the whole of this component, and each is a property
 * rather than a preference:
 *
 *  - **Never hot by default.** The stream is opened on press and every track is
 *    stopped on release. Not muted, not paused — stopped, because a muted track
 *    still holds the device and the OS still shows the app as recording, which
 *    teaches a user that the indicator means nothing.
 *  - **Never auto-sends.** The transcript lands in the composer as editable
 *    text. Speech recognition is wrong often enough that sending on release
 *    would make it a liability, and it is the user's message either way.
 *  - **An unmistakable indicator.** While the stream is live the button says so
 *    in words and colour, and it is the same element that is being held down, so
 *    it cannot be scrolled out of view while the mic is open.
 *
 * The fourth — live partials — is honestly absent: `whisper-cli` transcribes a
 * finished file and exits, so this shows "transcribing…" rather than a cursor
 * that never moves. `voice/stt.ts` says the same thing at more length.
 *
 * ## Raw samples, not MediaRecorder
 *
 * `MediaRecorder` gives webm/Opus and whisper.cpp takes 16-bit PCM; converting
 * would mean shipping ffmpeg, and sending the webm anyway makes whisper
 * transcribe noise *confidently*. So the samples are taken from the graph and
 * `shared/audio/wav.ts` writes the header.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { downsample, encodeWav, SAMPLE_RATE, toPcm16 } from '@shared/audio/wav.js';
import type { VoiceStatusDto } from '@shared/ipc/contract.js';

const agbrte = (): Window['agbrte'] => window.agbrte;

/**
 * A ceiling on one press.
 *
 * Not a limit on what anybody has to say — it is what stops a stuck key from
 * holding the microphone open and accumulating samples until the tab dies.
 */
const MAX_SECONDS = 120;

type State = 'idle' | 'recording' | 'transcribing';

interface Live {
  context: AudioContext;
  stream: MediaStream;
  chunks: Float32Array[];
  rate: number;
}

export function Dictate({
  sessionId,
  onTranscript,
}: {
  sessionId: string;
  /** Handed to the composer as editable text. Never sent from here (§12.4). */
  onTranscript: (text: string) => void;
}): JSX.Element | null {
  const [status, setStatus] = useState<VoiceStatusDto | null>(null);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const live = useRef<Live | null>(null);

  useEffect(() => {
    let mounted = true;
    void agbrte()
      .voice.status()
      .then((s) => mounted && setStatus(s))
      .catch(() => mounted && setStatus({ available: false, reason: 'voice is unavailable here' }));
    return () => {
      mounted = false;
    };
  }, []);

  /**
   * Close the device, on every path out.
   *
   * An unmount effect as well as the release handler, because a component that
   * disappears mid-press — a session closed, a window navigated — must not leave
   * the microphone open. This is the one piece of cleanup where forgetting is
   * visible to the operating system and invisible to the user.
   */
  useEffect(() => () => stop(live.current), []);

  const start = async (): Promise<void> => {
    if (state !== 'idle' || status?.available !== true) return;
    setError(null);

    try {
      // Not held open between presses. `getUserMedia` per press is what makes
      // "the mic is never hot by default" a fact about the code.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const context = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = context.createMediaStreamSource(stream);
      const node = context.createScriptProcessor(4096, 1, 1);
      const held: Live = { context, stream, chunks: [], rate: context.sampleRate };

      node.onaudioprocess = (e) => {
        const seconds = held.chunks.length * (4096 / held.rate);
        if (seconds > MAX_SECONDS) return;
        held.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      // Through a silent gain node: `ScriptProcessor` only runs when connected to
      // a destination, and connecting it directly plays the microphone back
      // through the speakers, which is both startling and a feedback loop.
      const silence = context.createGain();
      silence.gain.value = 0;
      node.connect(silence);
      silence.connect(context.destination);

      live.current = held;
      setState('recording');
    } catch (err) {
      // Denied permission, no device, or an insecure context — in a browser
      // reached over plain http, `mediaDevices` is not there at all (§14).
      setError(
        navigator.mediaDevices === undefined
          ? 'this browser will not open a microphone over http — use the desktop app'
          : `could not open the microphone: ${err instanceof Error ? err.message : String(err)}`,
      );
      setState('idle');
    }
  };

  const finish = async (): Promise<void> => {
    const held = live.current;
    live.current = null;
    if (held === null || state !== 'recording') return;

    const samples = concat(held.chunks);
    stop(held);

    if (samples.length < SAMPLE_RATE / 5) {
      // A tap rather than a press. Transcribing a fifth of a second wastes a
      // couple of seconds to produce nothing, and reads as the feature being
      // broken rather than as the gesture being too short.
      setState('idle');
      return;
    }

    setState('transcribing');
    try {
      const wav = encodeWav(toPcm16(downsample(samples, held.rate)));
      const result = await agbrte().voice.transcribe({
        wavBase64: base64(wav),
        sessionId,
        locale: navigator.language,
      });
      // Into the composer, never onto the wire. §12.4: voice never auto-sends.
      onTranscript(result.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setState('idle');
    }
  };

  // Nothing at all where dictation cannot work, rather than a button that
  // explains itself only after being pressed. The reason is on the tooltip of
  // the composer's own hint, not on a control that does nothing.
  if (status === null) return null;
  if (!status.available) {
    return (
      <span className="control-note shrink-0" title={status.reason}>
        no mic
      </span>
    );
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      {error !== null && (
        <span className="text-state-fail max-w-60 truncate text-xs" title={error}>
          {error}
        </span>
      )}
      <button
        type="button"
        data-testid="dictate"
        className={`btn-quiet text-xs ${state === 'recording' ? 'text-state-fail' : ''}`}
        title="Hold to dictate. The recording stays on this machine."
        disabled={state === 'transcribing'}
        // Pointer events rather than mouse: a press that ends outside the button,
        // or on a touch screen, still has to close the device.
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          void start();
        }}
        onPointerUp={() => void finish()}
        onPointerCancel={() => void finish()}
      >
        {state === 'recording' ? '● recording' : state === 'transcribing' ? 'transcribing…' : 'Hold to talk'}
      </button>
    </span>
  );
}

function stop(held: Live | null): void {
  if (held === null) return;
  // Stopped, not muted. A muted track still holds the device and still shows the
  // OS recording indicator, which teaches a user that the indicator is noise.
  for (const track of held.stream.getTracks()) track.stop();
  void held.context.close().catch(() => undefined);
}

function concat(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** Chunked, because `String.fromCharCode(...)` on a megabyte overflows the stack. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}
