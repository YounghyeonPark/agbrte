/**
 * Reading a reply out loud (DESIGN.md §12.4).
 *
 * > **TTS is OS-native** by default (`say` on macOS, SAPI on Windows) — offline,
 * > free, adequate.
 *
 * Three words of justification and all three are load-bearing. *Offline* means
 * an agent's answer is not shipped to a speech API to be spoken, which would
 * undo §12.4's whole argument from the other end: the section takes care that
 * your voice never leaves the machine, and reading the reply aloud through a
 * cloud service would send the conversation out anyway. *Free* means nobody
 * needs a second account. *Adequate* is the honest word — these voices are not
 * good, and the alternative is a bundled model, which §12.4 already rejected for
 * the input direction and which would be a heavier dependency for the less
 * useful half.
 *
 * ## Detected, like everything else the machine already has
 *
 * The fourth time this project makes the same choice: §3.12 for a CLI, §12.1 for
 * a browser, §12.4 for whisper, and now this. Find what is installed, drive it,
 * and say so plainly when there is nothing — a machine with no speech synthesis
 * is a fact about the machine, not an error.
 *
 * ## Stopping has to actually stop
 *
 * A speaker that keeps talking after you press stop is worse than one that never
 * starts: the reason you pressed it is that something is being said you did not
 * want said aloud, and every extra word is the failure continuing. So `stop`
 * kills the process rather than asking it to finish, and speaking again replaces
 * whatever was in progress rather than queueing behind it — two agents finishing
 * at once must not produce two voices.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';

export class NoSpeechOutput extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'NoSpeechOutput';
  }
}

/** How a platform speaks, when it does. */
export interface SpeechEngine {
  bin: string;
  /** Built per utterance, because every one of these takes the text differently. */
  args: (text: string) => string[];
  /**
   * Extra environment for the child, where the text travels that way.
   *
   * Windows needs it — see below — and nothing else does, because `spawn`
   * without a shell hands argv straight to the process and a quote in an
   * argument is just a quote.
   */
  env?: (text: string) => NodeJS.ProcessEnv;
}

/**
 * What each platform ships.
 *
 * Nothing is installed by us and nothing is downloaded. macOS and Windows always
 * have one; Linux usually does not, and says so rather than pretending.
 */
export function findVoice(platform: NodeJS.Platform = process.platform): SpeechEngine | null {
  if (platform === 'darwin') {
    return { bin: '/usr/bin/say', args: (text) => [text] };
  }

  if (platform === 'win32') {
    /**
     * SAPI through PowerShell, which is the only route needing nothing
     * installed — and the text goes through the **environment**, not the
     * command line.
     *
     * The obvious version interpolates the reply into the script, which is a
     * quoting hazard the first time an agent says `it's`. The next obvious one
     * passes it as a trailing argument and reads `$args[0]` — that is what this
     * was, and it does not work at all: with `-Command`, anything after the
     * script is *appended to the script string* rather than bound to `$args`, so
     * PowerShell tried to parse the agent's reply as code. Found by running it.
     *
     * An environment variable has no quoting layer to get wrong.
     */
    return {
      bin: 'powershell',
      args: () => [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Add-Type -AssemblyName System.Speech; ' +
          '(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:AGBRTE_TTS_TEXT)',
      ],
      env: (text) => ({ AGBRTE_TTS_TEXT: text }),
    };
  }

  // Linux, where speech synthesis is not a given. `spd-say` ships with
  // speech-dispatcher on most desktops; `espeak` is the older fallback.
  for (const bin of ['/usr/bin/spd-say', '/usr/bin/espeak-ng', '/usr/bin/espeak']) {
    if (existsSync(bin)) return { bin, args: (text) => [text] };
  }
  return null;
}

export type Spawner = (bin: string, args: string[], env?: NodeJS.ProcessEnv) => ChildProcess;

const defaultSpawn: Spawner = (bin, args, env) =>
  spawn(bin, args, {
    stdio: 'ignore',
    windowsHide: true,
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });

/**
 * One voice per client, because a machine has one pair of speakers.
 *
 * Not a function, because *stopping* needs something to stop and the thing being
 * stopped has to outlive the call that started it.
 */
export class Speaker {
  private current: ChildProcess | null = null;

  constructor(
    private readonly engine: SpeechEngine | null,
    private readonly spawnFn: Spawner = defaultSpawn,
  ) {}

  get available(): boolean {
    return this.engine !== null;
  }

  /** Whether something is being said right now. */
  get speaking(): boolean {
    return this.current !== null;
  }

  /**
   * Say it, replacing anything already being said.
   *
   * Resolves when the utterance finishes or is replaced — not when it starts, so
   * a caller can tell "done" from "queued" without polling. Replacement rather
   * than queueing: two sessions finishing together should produce the newer
   * announcement, not both of them over each other.
   */
  async speak(text: string): Promise<void> {
    if (this.engine === null) {
      throw new NoSpeechOutput(
        process.platform === 'linux'
          ? 'no speech synthesis on this machine — install speech-dispatcher or espeak'
          : 'no speech synthesis available on this machine',
      );
    }

    const trimmed = text.trim();
    // Spawning a process to say nothing is a spinning cursor and a surprised
    // user, so an empty reply is silence rather than a no-op that looks broken.
    if (trimmed === '') return;

    this.stop();
    const child = this.spawnFn(
      this.engine.bin,
      this.engine.args(trimmed),
      this.engine.env?.(trimmed),
    );
    this.current = child;

    await new Promise<void>((resolve) => {
      const done = (): void => {
        if (this.current === child) this.current = null;
        resolve();
      };
      child.once('exit', done);
      // A synthesiser that cannot start is silence, not a crash: the reply is
      // already on screen and this was the optional half.
      child.once('error', done);
    });
  }

  /**
   * Stop now.
   *
   * A kill rather than a polite finish. The reason somebody presses stop is that
   * something is being said aloud that they did not want said aloud, and every
   * word after the press is the failure still happening.
   */
  stop(): void {
    const child = this.current;
    this.current = null;
    child?.kill();
  }
}
