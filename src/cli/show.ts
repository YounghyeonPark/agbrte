/**
 * `agbrte show` and `agbrte play`: a file, drawn or played on the line it was
 * asked for on (DESIGN.md §17 Q24, step 4).
 *
 * `imgcat` for everything the app's terminal can put on a line — a picture in
 * any terminal that draws them, and a video or a sound in the app's own. The
 * two verbs differ in one thing: `play` starts it, `show` puts the player there
 * and leaves pressing play to the person. A sound that begins because a command
 * printed something is the speaker turning itself on, which §12.4 does not let
 * the app do anywhere else either.
 *
 * Above the host entirely, like `workflows`: it reads a file and writes to the
 * terminal it was run in. Starting a session host to print a picture would be
 * absurd, and would make `show` fail on a machine where the host cannot start.
 *
 * ## What it refuses, and why it says so
 *
 * The terminal is told the file's bytes, never its path — the terminal may be
 * on another machine, and one that opened paths it was sent would read *its*
 * files on a remote program's say-so (`terminalImages.ts`, kitty's `t=f`). So
 * the whole file goes in the sequence, and the sequence has a cap
 * (`MAX_PICTURE`): a file over it is refused here, by size, rather than sent
 * and replaced on screen by a line saying it was too large.
 *
 * ## Streamed instead, in the app's own terminal (step 5)
 *
 * In a shell the host started there is a better way, and anything past
 * `STREAM_ABOVE` takes it: the CLI asks the *host* to stream the file, with
 * the key the host put in this shell's environment, and the host answers in the
 * output with a token the player reads ranges by (`mediaOffers.ts`). Nothing
 * of the file goes through the terminal, so there is no cap — and nothing past
 * its first megabyte is read until somebody plays it. Small files still go in
 * the stream, where every client can show them, a browser included.
 *
 * And a terminal that has not said it can draw gets nothing unless `--force`
 * says otherwise, for `graphics.ts`'s reason: the escape sequence in a terminal
 * that does not know it is a screenful of base64.
 */

import { open, readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { offerSequence, PANE_KEY_ENV } from '@main/terminal/mediaOffers.js';
import { detectGraphics, inlineImage, inlineMedia, playsMedia } from '@main/terminal/graphics.js';
import { MAX_PICTURE } from '@shared/terminal/imageStream.js';
import { imageSize } from '@shared/terminal/imageSize.js';
import { mediaType } from '@shared/terminal/mediaType.js';
import { c } from './format.js';

/**
 * Past this, a file in the app's own shell is streamed rather than sent. Low,
 * because sending is the worse of the two wherever streaming works: the host
 * holds a quarter of a megabyte of a pane's output before it drops the oldest
 * (`MAX_PENDING_BYTES`), and a sequence that loses its start is base64 on the
 * screen.
 */
export const STREAM_ABOVE = 64 * 1024;

/** How much of a file is read to tell what it is, when it will be streamed. */
const HEAD = 1024 * 1024;

/** The largest file that fits in one sequence: the stream's cap, which is counted in base64. */
export const MAX_SHOWN_BYTES = Math.floor((MAX_PICTURE * 3) / 4);

export const SHOW_USAGE = `agbrte show <file>…   draw a picture, or put a player for a video or a sound
agbrte play <file>…   the same, and start playing

  --force             send it even where the terminal has not said it can show it

Pictures: PNG, JPEG, GIF, WebP, BMP, in any terminal that draws them (iTerm2,
WezTerm, kitty, Ghostty, and Agbrte's own). Video and sound: MP4, WebM, Ogg, MP3,
AAC, FLAC and WAV, in Agbrte's terminal. Up to ${Math.round(MAX_SHOWN_BYTES / 1024 / 1024)} MB a file.
`;

interface Io {
  env: NodeJS.ProcessEnv;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** The terminal's size in cells, where it says; 80×24 where it does not. */
  columns?: number | undefined;
  rows?: number | undefined;
  /**
   * Whether `out` is the terminal itself. Only then is a file streamed: the
   * request carries the pane's key, and written to a pipe — `| tee log`, or an
   * agent CLI's tool capturing a command's output into a model's context — the
   * key would land somewhere other than the terminal it unlocks.
   */
  tty?: boolean | undefined;
}

/**
 * A cell's size, guessed. The terminal could be asked (`CSI 16 t`), and its
 * answer arrives on stdin — which, under the packaged app's runtime on
 * Windows, this process cannot read (`cliOnPath.ts`). So the rows are reckoned
 * from a typical cell, and the terminal fits the picture into whatever rows
 * that comes to; a guess off by a pixel or two changes the size, never the
 * layout.
 */
const CELL = { width: 8, height: 16 };

/**
 * How many rows a file is given in Agbrte's terminal, where this side feeds
 * them (`inlineImage`): a picture or a video at its own size, narrowed to the
 * terminal and never taller than the screen less two rows, so the command
 * above it and the prompt below are both still in sight; a video of unknown
 * size as 16:9 across up to 80 columns; a sound as three rows of controls.
 */
export function rowsFor(
  size: { width: number; height: number } | null,
  kind: 'picture' | 'video' | 'audio',
  columns: number,
  rows: number,
): number {
  if (kind === 'audio') return 3;
  const across = Math.min(columns, 80) * CELL.width;
  const own = size ?? { width: across, height: (across * 9) / 16 };
  const scale = Math.min(1, (columns * CELL.width) / own.width);
  return Math.min(Math.max(3, rows - 2), Math.max(1, Math.ceil((own.height * scale) / CELL.height)));
}

export async function show(
  argv: string[],
  opts: { play: boolean },
  io: Io = {
    env: process.env,
    out: process.stdout,
    err: process.stderr,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
    tty: process.stdout.isTTY,
  },
): Promise<number> {
  // Only Agbrte's terminal is sent `rows=`; see `inlineImage`.
  const feeds = playsMedia(io.env);
  const columns = io.columns !== undefined && io.columns > 0 ? io.columns : 80;
  const lines = io.rows !== undefined && io.rows > 0 ? io.rows : 24;
  const force = argv.includes('--force');
  const files = argv.filter((a) => !a.startsWith('--'));
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--force');
  if (unknown.length > 0 || files.length === 0) {
    if (unknown.length > 0) io.err.write(`${c.fail(`agbrte: ${unknown.join(' ')} is not an option here`)}\n`);
    io.err.write(SHOW_USAGE);
    return 1;
  }

  const fail = (file: string, why: string): void => {
    io.err.write(`${c.fail(`agbrte: ${file}: ${why}`)}\n`);
  };

  let failed = 0;
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) {
      fail(file, info === null ? 'no such file' : 'not a file');
      failed += 1;
      continue;
    }
    const key = io.env[PANE_KEY_ENV];
    const stream = feeds && io.tty === true && key !== undefined && key !== '' && info.size > STREAM_ABOVE;
    if (!stream && info.size > MAX_SHOWN_BYTES) {
      const mb = (n: number): string => `${(n / 1024 / 1024).toFixed(1)} MB`;
      fail(file, `${mb(info.size)} is more than the ${mb(MAX_SHOWN_BYTES)} a terminal is sent in one piece`);
      failed += 1;
      continue;
    }
    const bytes = stream ? await head(file) : new Uint8Array(await readFile(file));
    const name = basename(file);
    let text: string | null;
    const picture = imageSize(bytes);
    const media = picture === null ? mediaType(bytes) : null;
    if (stream && (picture !== null || media !== null)) {
      const own =
        picture ?? (media?.width !== undefined && media.height !== undefined ? { width: media.width, height: media.height } : null);
      const rows = rowsFor(own, picture !== null ? 'picture' : media!.kind, columns, lines);
      // The request, then the rows the answer will take: see `inlineImage`.
      text = offerSequence(key!, { path: resolve(file), name, autoplay: opts.play, rows }) + '\n'.repeat(rows);
    } else if (picture !== null) {
      const graphics = detectGraphics(io.env);
      text =
        graphics === 'none' && !force
          ? null
          : inlineImage(bytes, {
              name,
              graphics: graphics === 'none' ? 'iterm2' : graphics,
              ...(feeds ? { rows: rowsFor(picture, 'picture', columns, lines) } : {}),
            });
      if (text === null) {
        fail(file, 'this terminal has not said it draws pictures (--force sends it anyway)');
        failed += 1;
        continue;
      }
    } else if (media !== null) {
      if (!feeds && !force) {
        fail(file, 'only Agbrte’s own terminal plays video and sound (--force sends it anyway)');
        failed += 1;
        continue;
      }
      const own = media.width !== undefined && media.height !== undefined ? { width: media.width, height: media.height } : null;
      text = inlineMedia(bytes, {
        name,
        autoplay: opts.play,
        ...(feeds ? { rows: rowsFor(own, media.kind, columns, lines) } : {}),
      });
    } else {
      fail(file, 'not a picture, a video or a sound this can show');
      failed += 1;
      continue;
    }
    await write(io.out, text);
  }
  return failed === 0 ? 0 : 1;
}

/** The first megabyte, which is all that is read of a file the host will stream. */
async function head(file: string): Promise<Uint8Array> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEAD);
    const { bytesRead } = await handle.read(buffer, 0, HEAD, 0);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Write and wait for it to be taken. Tens of megabytes to a pipe is not taken
 * in one go, and returning — which ends the process — before it drains would
 * cut the sequence off mid-file, leaving the terminal holding an unterminated
 * one until something else ended it.
 */
function write(out: NodeJS.WritableStream, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    out.write(text, (err) => (err === null || err === undefined ? resolve() : reject(err)));
  });
}
