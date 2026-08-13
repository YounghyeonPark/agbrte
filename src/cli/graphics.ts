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
  return 'none';
}

/** Bytes the terminal will draw, or `null` when it would draw nothing useful. */
export function inlineImage(
  bytes: Uint8Array,
  opts: { name?: string; graphics?: TerminalGraphics } = {},
): string | null {
  const graphics = opts.graphics ?? detectGraphics();
  if (graphics === 'none') return null;

  const b64 = Buffer.from(bytes).toString('base64');
  return graphics === 'kitty' ? kitty(b64) : iterm2(b64, bytes.length, opts.name);
}

/**
 * `ESC ] 1337 ; File = … : <base64> BEL`
 *
 * `inline=1` is what separates "draw this" from "offer it as a download", and
 * the size is required — iTerm2 uses it to know when the payload is complete.
 */
function iterm2(b64: string, size: number, name?: string): string {
  const args = [
    'inline=1',
    `size=${size}`,
    ...(name !== undefined ? [`name=${Buffer.from(name).toString('base64')}`] : []),
  ].join(';');
  // `\x1b]` opens the OSC; `\x07` (BEL) closes it.
  return `\x1b]1337;File=${args}:${b64}\x07\n`;
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
