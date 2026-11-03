/**
 * Showing a picture in a terminal that can, and saying so where it cannot.
 *
 * Agents produce images — screenshots, plots, rendered diagrams — and until now
 * the CLI could only mention that one existed. Terminals have carried inline
 * graphics for years; the awkwardness is that three protocols do it and none of
 * them can be probed. A terminal that does not understand the escape sequence
 * prints its bytes as garbage across the screen, so guessing wrong is worse than
 * not trying: the alternative to a picture is one clean line naming the file,
 * and the alternative to a bad guess is a wrecked transcript.
 *
 * So detection is by declaration — the environment variables terminals set about
 * themselves — and the fallback is a path, in the shape §3.3 uses everywhere
 * else: refuse by name rather than degrade silently.
 *
 * ## The three protocols
 *
 * **iTerm2** is the simplest: one OSC sequence carrying the whole file base64'd,
 * and it is understood by iTerm2, WezTerm, and most Sixel terminals.
 *
 * **Kitty** is where the ecosystem is heading — kitty itself, Ghostty, WezTerm
 * and Konsole all speak it — and it chunks, which matters because a large image
 * in one write can exceed what a pty will accept in a single burst.
 *
 * **Sixel** is not implemented here. It needs the image decoded, quantised to a
 * palette and re-encoded, which is a dependency and a lot of code for terminals
 * that mostly also accept the iTerm2 form.
 */

import { imageSize } from '@shared/terminal/imageSize.js';
import { mediaType } from '@shared/terminal/mediaType.js';

/** What the terminal on the other end has said about itself. */
export type TerminalGraphics = 'kitty' | 'iterm2' | 'none';

/**
 * Which protocol to use, from the environment alone.
 *
 * Order matters: several terminals speak both, and Kitty's is chunked, so it
 * survives a large image where the single-write iTerm2 form can be truncated by
 * a pty buffer.
 *
 * `TERM_PROGRAM` and friends are set by the terminal, not by the shell, so this
 * is the terminal's own claim rather than an inference. Absent means no — a
 * terminal that says nothing gets a filename, which is always readable.
 */
export function detectGraphics(env: NodeJS.ProcessEnv = process.env): TerminalGraphics {
  // An explicit override first, because a multiplexer or an ssh session can
  // hide the real terminal and only the person at the keyboard knows.
  const forced = env['AGBRTE_TERM_GRAPHICS'];
  if (forced === 'kitty' || forced === 'iterm2' || forced === 'none') return forced;

  /*
   * Inside tmux or screen the escape sequence reaches the multiplexer rather
   * than the terminal, and passing it through needs per-multiplexer wrapping
   * that only sometimes works. Declining is the honest answer; the override
   * above is there for anyone who has configured their way around it.
   */
  if (env['TMUX'] !== undefined || (env['TERM'] ?? '').startsWith('screen')) return 'none';

  if (env['TERM'] === 'xterm-kitty' || env['KITTY_WINDOW_ID'] !== undefined) return 'kitty';
  if (env['TERM_PROGRAM'] === 'ghostty' || env['GHOSTTY_RESOURCES_DIR'] !== undefined) {
    return 'kitty';
  }
  if (env['TERM_PROGRAM'] === 'WezTerm') return 'kitty';
  if (env['TERM_PROGRAM'] === 'iTerm.app' || env['LC_TERMINAL'] === 'iTerm2') return 'iterm2';
  /*
   * The app's own terminal (§17 Q24 step 3), which draws all three; iTerm2's
   * form because it is one sequence and the app's emulator reads it whole
   * whatever its size. `LC_TERMINAL` as well as `TERM_PROGRAM` for the reason
   * iTerm2 sets both: ssh forwards `LC_*` by default and nothing else, so a
   * shell in the app that sshes somewhere still says what is drawing it.
   */
  if (env['TERM_PROGRAM'] === 'Agbrte' || env['LC_TERMINAL'] === 'Agbrte') return 'iterm2';
  return 'none';
}

/**
 * Whether the terminal plays a video or a sound sent the way a picture is
 * (§17 Q24 step 4) — which only the app's own does. Declared the same way and
 * for the same reason as pictures: iTerm2 given an MP4 in its file sequence
 * draws a broken-picture icon, so the bytes go only where they will play.
 */
export function playsMedia(env: NodeJS.ProcessEnv = process.env): boolean {
  if (detectGraphics(env) === 'none') return false;
  return env['TERM_PROGRAM'] === 'Agbrte' || env['LC_TERMINAL'] === 'Agbrte';
}

/**
 * A video or a sound in iTerm2's sequence, with `autoplay=1` when it should
 * start on its own. `rows`: see `inlineImage`.
 */
export function inlineMedia(
  bytes: Uint8Array,
  opts: { name?: string; autoplay?: boolean; rows?: number } = {},
): string {
  return iterm2(Buffer.from(bytes).toString('base64'), bytes.length, opts.name, {
    extra: opts.autoplay === true ? ['autoplay=1'] : [],
    ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
  });
}

/**
 * Bytes the terminal will draw, or `null` when it would draw nothing useful.
 *
 * `rows` is for Agbrte's terminal only: the picture is drawn `rows` tall and
 * the line feeds it takes are written here, after the sequence, rather than
 * made by the terminal — the only way Windows' pseudoconsole learns that the
 * cursor moved (`terminalImages.ts`, "Rows the sender feeds").
 */
export function inlineImage(
  bytes: Uint8Array,
  opts: { name?: string; graphics?: TerminalGraphics; rows?: number } = {},
): string | null {
  const graphics = opts.graphics ?? detectGraphics();
  if (graphics === 'none') return null;

  const b64 = Buffer.from(bytes).toString('base64');
  return graphics === 'kitty'
    ? kitty(b64)
    : iterm2(b64, bytes.length, opts.name, opts.rows !== undefined ? { rows: opts.rows } : {});
}

/**
 * `ESC ] 1337 ; File = … : <base64> BEL`
 *
 * `inline=1` is what separates "draw this" from "offer it as a download", and
 * the size is required — iTerm2 uses it to know when the payload is complete.
 */
function iterm2(
  b64: string,
  size: number,
  name?: string,
  opts: { extra?: string[]; rows?: number } = {},
): string {
  const args = [
    'inline=1',
    `size=${size}`,
    ...(name !== undefined ? [`name=${Buffer.from(name).toString('base64')}`] : []),
    ...(opts.extra ?? []),
    ...(opts.rows !== undefined ? [`height=${opts.rows}`, `rows=${opts.rows}`] : []),
  ].join(';');
  // `\x1b]` opens the OSC; `\x07` (BEL) closes it. Then the line feeds: the
  // picture's own when this side feeds them, else the one after it.
  return `\x1b]1337;File=${args}:${b64}\x07${'\n'.repeat(opts.rows ?? 1)}`;
}

/** Kitty's chunked form: 4096 base64 characters per escape, `m=1` until the last. */
function kitty(b64: string): string {
  const CHUNK = 4096;
  let out = '';
  for (let i = 0; i < b64.length; i += CHUNK) {
    const piece = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    // `a=T` transmits and displays in one step; `f=100` means "the file's own
    // format", so PNG and JPEG both work without being decoded here.
    const control = i === 0 ? `a=T,f=100,m=${more}` : `m=${more}`;
    // `\x1b_G` opens the APC; `\x1b\\` (ST) closes it.
    out += `\x1b_G${control};${piece}\x1b\\`;
  }
  return `${out}\n`;
}

/**
 * A blob the session holds, drawn — or `null` where it is not a picture.
 *
 * A tool's result blob can be anything (a PDF, a log), and the event does not
 * say which; the first bytes do (`imageSize`), so a non-picture is passed over
 * rather than sent to a terminal that would say it cannot read it.
 */
export function drawPicture(bytes: Uint8Array, graphics: TerminalGraphics, name?: string): string | null {
  if (imageSize(bytes) === null) return null;
  return inlineImage(bytes, { graphics, ...(name !== undefined ? { name } : {}) });
}

/**
 * The same for anything the terminal can put on a line: a picture, or — where
 * `media` says the terminal plays them (`playsMedia`) — a video or a sound, as
 * a player that waits to be pressed (§17 Q24 step 4). An agent's tool that
 * returns a recording is the case; it is never started on its own, because the
 * agent producing a sound is not the person asking to hear it.
 */
export function drawBlob(
  bytes: Uint8Array,
  graphics: TerminalGraphics,
  opts: { name?: string; media: boolean },
): string | null {
  const picture = drawPicture(bytes, graphics, opts.name);
  if (picture !== null || !opts.media || mediaType(bytes) === null) return picture;
  return inlineMedia(bytes, opts.name !== undefined ? { name: opts.name } : {});
}
