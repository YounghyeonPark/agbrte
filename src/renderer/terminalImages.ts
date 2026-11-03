/**
 * Pictures drawn in the terminal (DESIGN.md §17 Q24, step 3).
 *
 * The stream is filtered before the emulator sees it (`imageStream.ts`, which
 * says why there and not in a parser handler). What this adds is everything
 * that needs the emulator: how big a cell is, where the cursor was when the
 * picture arrived, and drawing it on those cells with xterm's decorations — the
 * owner's rule is that what can be made here is, so this is not xterm's image
 * addon, and it does not need to be.
 *
 * ## One decoration per row, which is the part that took a second try
 *
 * A decoration is shown while the line its marker is on is in the viewport, and
 * hidden the moment that line scrolls off the top. One decoration for a picture
 * twenty rows tall made the whole picture vanish when its first row scrolled
 * away, with nineteen rows of it still meant to be on screen. So each row is its
 * own decoration, showing its own slice of the one image (the same URL, offset
 * by the row's height), and a picture scrolls off a row at a time, the way text
 * does.
 *
 * ## Where the cursor ends up, which programs depend on
 *
 * Each protocol says, and the tools that use it write their next line assuming
 * it:
 *
 *  - **iTerm2 and kitty**: on the picture's last row, just right of it — which
 *    is why `imgcat` prints a newline after the picture and the prompt lands
 *    right under it. Kitty's `C=1` leaves the cursor where it was.
 *  - **Sixel**: on the picture's last row, at the column it started in, which is
 *    xterm's behaviour and what `img2sixel` and `chafa` are written against.
 *
 * ## What it answers, so programs know to send pictures at all
 *
 * Nothing in a terminal's environment says "sixel", so programs ask the
 * terminal: device attributes (`CSI c`), which xterm.js answers as a VT100.
 * That answer is replaced by one that lists sixel (`4`), and kitty's own query
 * (`a=q`) is answered the way kitty answers it. The window's size in pixels,
 * which a sixel program uses to scale its output, is xterm.js's own answer,
 * switched on in the pane (`windowOptions`).
 *
 * ## Refused, on purpose
 *
 *  - **Kitty's file, temporary-file and shared-memory transmission** (`t=f`,
 *    `t=t`, `t=s`). They make the *terminal* open a path the program names. The
 *    program may be on another machine — a shell over ssh, a remote host's
 *    pane — and a terminal that reads local files on a remote program's say-so
 *    is a way to put this machine's files on a screen somebody else is looking
 *    at. Only bytes in the stream are drawn; the program is told `EBADF`.
 *  - **Pictures in a full-screen program's screen.** xterm.js has no markers in
 *    the alternate buffer, so there is nothing to hang a row on; the rows are
 *    still taken, so the program's layout is what it expected.
 *
 * ## Video and sound (step 4), in the same sequence
 *
 * A file in iTerm2's sequence that is not a picture is looked at again
 * (`mediaType.ts`), and a video or a sound gets a player on the line: the rows
 * are taken exactly as a picture's are, and one `<video>` or `<audio>` sits
 * over them. Not a new escape sequence, because everything one needs — a name,
 * a size, the bytes, the multipart form for a large file, the cap — is already
 * in this one and already read; a second would have been the same parser with
 * a different number. What the sequence cannot do is point at a file rather
 * than carry it, which a long video on another machine needs, and that is a
 * different thing (step 5). `autoplay=1` is ours: iTerm2 ignores a key it does
 * not know, so the same bytes are harmless there.
 *
 * ## Rows the sender feeds (`rows=N`), for Windows' pseudoconsole
 *
 * Everywhere else the terminal takes a picture's rows itself, by putting line
 * feeds in the stream where the picture was. On Windows the program is behind a
 * pseudoconsole that keeps its own copy of the screen and draws cmd.exe and
 * PowerShell from it with absolute cursor moves — and it never saw those line
 * feeds, because they were made here. So after `agbrte play` in cmd the prompt
 * was drawn rows above where the cursor really was, on top of the player, and
 * the next command was typed into the player's rows. The same was true of any
 * picture in cmd since step 3; the pictures test checked the line the script
 * printed and not the prompt after it.
 *
 * Only a line feed the program itself writes moves the pseudoconsole's cursor.
 * So a sender that knows it is talking to this terminal — our own CLI — says
 * `rows=N` and prints the N line feeds after the sequence, and the terminal
 * takes exactly those rows and adds none: one marker on the first row and one
 * element over all of them, placed like a player. A program that does not say
 * `rows=` is drawn as before. iTerm2 ignores a key it does not know, which is
 * why the CLI sends it only to this terminal: there, the line feeds would be
 * extra blank rows under a picture iTerm2 had already made room for.
 *
 * ## Bounds
 *
 * A picture holds one object URL for its life. Pictures go when their rows
 * leave the scrollback (the markers are disposed with the lines), when the
 * screen is cleared, and past `MAX_PICTURES` the oldest go first — the same
 * ring the scrollback is, for the same reason (§7).
 */

import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';
import { decodeBase64, ImageStream, type Picture } from '@shared/terminal/imageStream.js';
import { imageSize } from '@shared/terminal/imageSize.js';
import { decodeSixel, type Pixels } from '@shared/terminal/sixel.js';
import { mediaType, type MediaType } from '@shared/terminal/mediaType.js';

/** The most pictures kept on one terminal; past it the oldest are dropped. */
export const MAX_PICTURES = 64;
/** The tallest a picture is drawn, in screens. */
const MAX_SCREENS = 2;
/** Kitty images transmitted for later placement (`a=t`) kept by id. */
const MAX_KITTY_STORED = 32;

/** The private OSC that marks one row of a picture, in the filtered stream. */
const ROW_OSC = 7731;

/** What xterm.js says for DA1, plus sixel (4) — and 22, colour, which it has. */
const DEVICE_ATTRIBUTES = '\u001b[?62;4;22c';

export interface TerminalImages extends IDisposable {
  /** Filter a chunk of output; give what comes back to `term.write`. */
  write(data: string): string;
}

interface Size {
  width: number;
  height: number;
}

/** A picture waiting for its rows to be reached by the parser, then shown. */
interface Shown {
  id: number;
  cols: number;
  rows: number;
  /** The size it is drawn at, in CSS pixels. */
  width: number;
  height: number;
  cellHeight: number;
  protocol: 'iterm2' | 'sixel' | 'kitty';
  /** The kitty image id, for `a=d`. */
  kittyId: string | null;
  url: string | null;
  /** Set when the source turns out to be undrawable after its rows were taken. */
  failed: boolean;
  /** Set when this is a player rather than a picture (step 4). */
  media: Player | null;
  decorations: IDecoration[];
  elements: Set<HTMLElement>;
  markers: IMarker[];
  live: number;
  gone: boolean;
}

/** A video or a sound on a line: one element over its rows, placed by `layout`. */
interface Player {
  /** `null` for a picture drawn as one element, which is what a sender-fed picture is. */
  type: MediaType | null;
  autoplay: boolean;
  /** The file's name as the program gave it, for the tooltip. */
  name: string | null;
  /** Where its first row is, once the parser has reached it. */
  marker: IMarker | null;
  x: number;
  box: HTMLElement | null;
  element: HTMLMediaElement | HTMLImageElement | null;
}

/** A kitty image sent with `a=t`, kept for a later `a=p`. */
interface Stored {
  source: () => Promise<Blob | null>;
  size: Size | null;
}

export function showImages(
  term: Terminal,
  opts: {
    reply: (data: string) => void;
    /**
     * The URL a file the host is streaming plays from, by its token (step 5),
     * or `null` where this client cannot fetch one.
     */
    stream?: (token: string) => string | null;
  },
): TerminalImages {
  let next = 1;
  /** Pictures whose rows are still in the stream ahead of the parser, or on screen. */
  const shown = new Map<number, Shown>();
  const order: Shown[] = [];
  const stored = new Map<string, Stored>();
  /** A kitty transmission arriving in chunks (`m=1`). */
  let chunks: { control: Record<string, string>; parts: string[] } | null = null;
  let lastCell: Size = { width: 7, height: 15 };

  /** The size of one cell in CSS pixels, from the rendered screen. */
  const cell = (): Size => {
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    const w = screen?.clientWidth ?? 0;
    const h = screen?.clientHeight ?? 0;
    // A hidden tab measures zero: keep what it measured while it was shown.
    if (w > 0 && h > 0 && term.cols > 0 && term.rows > 0) {
      lastCell = { width: w / term.cols, height: h / term.rows };
    }
    return lastCell;
  };

  const forget = (picture: Shown): void => {
    if (picture.gone) return;
    picture.gone = true;
    shown.delete(picture.id);
    const at = order.indexOf(picture);
    if (at !== -1) order.splice(at, 1);
    for (const d of picture.decorations) d.dispose();
    for (const m of picture.markers) m.dispose();
    const media = picture.media;
    if (media !== null) {
      // Stopped before it goes, and its source let go of: a detached element
      // that still holds a blob plays on, and a sound with nothing on screen to
      // stop it is the failure §12.4 says a person cannot chase down.
      if (media.element instanceof HTMLMediaElement) {
        media.element.pause();
        media.element.removeAttribute('src');
        media.element.load();
      }
      media.box?.remove();
      media.marker?.dispose();
    }
    if (picture.url !== null) URL.revokeObjectURL(picture.url);
    picture.url = null;
  };

  const paint = (picture: Shown, element: HTMLElement): void => {
    if (picture.failed) element.dataset['failed'] = 'true';
    if (picture.url === null) return;
    if (element instanceof HTMLMediaElement || element instanceof HTMLImageElement) {
      if (element.getAttribute('src') !== picture.url) element.src = picture.url;
    } else element.style.backgroundImage = `url("${picture.url}")`;
  };

  /**
   * The layer players sit in: over the rows, clipped to the screen. Made on
   * first use, because a terminal that never plays anything should not have
   * one.
   */
  let players: HTMLElement | null = null;
  const layer = (): HTMLElement | null => {
    if (players !== null && players.isConnected) return players;
    const screen = term.element?.querySelector<HTMLElement>('.xterm-screen');
    if (screen === null || screen === undefined) return null;
    players = document.createElement('div');
    players.className = 'term-media-layer';
    screen.appendChild(players);
    return players;
  };

  /**
   * Put every player over its rows. A decoration is the wrong holder for one —
   * it hides when its first line leaves the top of the viewport, and a player
   * is one element, so it would vanish whole with most of it still meant to be
   * on screen (the reason pictures are one decoration *per row*). So players
   * are placed by hand from their marker, on every render and scroll, and the
   * layer's clipping does what scrolling off the edge does to text.
   */
  const layout = (): void => {
    const c = cell();
    const buffer = term.buffer.active;
    const screenHeight = term.rows * c.height;
    for (const picture of order) {
      const media = picture.media;
      if (media === null || media.box === null || media.marker === null) continue;
      const top = (media.marker.line - buffer.viewportY) * c.height;
      // The alternate screen is a full-screen program's, and covers the
      // normal one — the player is under it, not over it.
      const visible =
        buffer.type === 'normal' &&
        !media.marker.isDisposed &&
        top < screenHeight &&
        top + picture.height > 0;
      media.box.style.display = visible ? '' : 'none';
      if (visible) {
        media.box.style.top = `${top}px`;
        media.box.style.left = `${media.x * c.width}px`;
      }
    }
  };

  /**
   * Take the rows for a picture and return what stands in for it in the stream:
   * a row marker on each row, line feeds between them, and the cursor move the
   * protocol promises after the last.
   */
  const reserve = (
    protocol: Shown['protocol'],
    drawn: Size,
    /** The bytes, made into an object URL when they arrive; or a URL to read them from. */
    source: Promise<Blob | null> | string,
    opts2: {
      kittyId?: string | null;
      cursorStays?: boolean;
      media?: Player;
      fed?: number;
    } = {},
  ): string => {
    const c = cell();
    // No taller than two screens, whatever was asked: a row is a decoration,
    // and `height=1000000px` would otherwise be sixty thousand of them.
    drawn = fit(drawn, {
      width: Number.POSITIVE_INFINITY,
      height: MAX_SCREENS * term.rows * c.height,
    });
    const cols = Math.max(1, Math.min(term.cols, Math.ceil(drawn.width / c.width - 0.01)));
    const rows = opts2.fed ?? Math.max(1, Math.ceil(drawn.height / c.height - 0.01));
    const picture: Shown = {
      id: next,
      cols,
      rows,
      width: drawn.width,
      height: drawn.height,
      cellHeight: c.height,
      protocol,
      kittyId: opts2.kittyId ?? null,
      url: null,
      failed: false,
      media: opts2.media ?? null,
      decorations: [],
      elements: new Set(),
      markers: [],
      live: 0,
      gone: false,
    };
    next += 1;
    shown.set(picture.id, picture);
    order.push(picture);
    while (order.length > MAX_PICTURES) forget(order[0]!);

    if (typeof source === 'string') picture.url = source;
    else
      void source.then(
        (blob) => {
          if (picture.gone) return;
          if (blob === null) picture.failed = true;
          else picture.url = URL.createObjectURL(blob);
          for (const el of picture.elements) paint(picture, el);
        },
        () => {
          picture.failed = true;
          for (const el of picture.elements) paint(picture, el);
        },
      );

    // The sender feeds the lines (`rows=`): one marker, and nothing that
    // moves the cursor — the line feeds that follow are the program's own.
    if (opts2.fed !== undefined) return `\u001b]${ROW_OSC};${picture.id};0\u0007`;
    let text = opts2.cursorStays === true ? '\u001b7' : '';
    for (let r = 0; r < rows; r += 1) {
      text += `\u001b]${ROW_OSC};${picture.id};${r}\u0007`;
      if (r < rows - 1) text += '\n';
    }
    if (opts2.cursorStays === true) text += '\u001b8';
    else if (protocol !== 'sixel') text += `\u001b[${cols}C`;
    return text;
  };

  /** One row of a picture, reached by the parser: a decoration on this line. */
  const row = (data: string): boolean => {
    const [idText, rText] = data.split(';');
    const picture = shown.get(Number(idText));
    const r = Number(rText);
    if (picture === undefined || picture.gone || !Number.isInteger(r)) return true;
    if (picture.media !== null) return r === 0 ? playerAt(picture, picture.media) : true;
    const marker = term.registerMarker(0);
    // The alternate screen has no markers; see the header.
    if (marker === undefined) return true;
    const x = term.buffer.active.cursorX;
    const decoration = term.registerDecoration({
      marker,
      x,
      width: Math.max(1, Math.min(picture.cols, term.cols - x)),
      layer: 'top',
    });
    if (decoration === undefined) {
      marker.dispose();
      return true;
    }
    picture.markers.push(marker);
    picture.decorations.push(decoration);
    picture.live += 1;
    decoration.onRender((element) => {
      if (picture.elements.has(element)) return;
      picture.elements.add(element);
      element.classList.add('term-image');
      element.dataset['testid'] = 'term-image';
      element.dataset['picture'] = String(picture.id);
      element.dataset['row'] = String(r);
      element.dataset['protocol'] = picture.protocol;
      element.style.backgroundSize = `${picture.width}px ${picture.height}px`;
      element.style.backgroundPosition = `0 ${-r * picture.cellHeight}px`;
      paint(picture, element);
    });
    // A row trimmed off the scrollback takes its decoration with it; the last
    // one to go takes the picture's URL.
    decoration.onDispose(() => {
      picture.live -= 1;
      if (picture.live <= 0 && picture.decorations.length === picture.rows) forget(picture);
    });
    return true;
  };

  /** A player's first row, reached by the parser: the player goes here. */
  const playerAt = (picture: Shown, media: Player): boolean => {
    const marker = term.registerMarker(0);
    const host = layer();
    // The alternate screen has no markers; see the header.
    if (marker === undefined || host === null) {
      marker?.dispose();
      return true;
    }
    media.marker = marker;
    media.x = term.buffer.active.cursorX;
    // Trimmed off the scrollback: the player goes with its line.
    marker.onDispose(() => forget(picture));

    const box = document.createElement('div');
    box.className = 'term-media';
    box.dataset['testid'] = 'term-media';
    box.dataset['kind'] = media.type?.kind ?? 'picture';
    box.dataset['picture'] = String(picture.id);
    box.style.width = `${picture.width}px`;
    box.style.height = `${picture.height}px`;
    if (media.type === null) {
      // A picture is looked at, not pressed: the pointer goes through to the
      // terminal, so a selection can still be dragged across it, as across a
      // picture drawn by rows.
      box.style.pointerEvents = 'none';
      const img = document.createElement('img');
      img.alt = media.name ?? 'picture';
      img.draggable = false;
      img.addEventListener('error', () => {
        picture.failed = true;
        box.dataset['failed'] = 'true';
      });
      box.appendChild(img);
      host.appendChild(box);
      media.box = box;
      media.element = img;
      picture.elements.add(img);
      paint(picture, img);
      if (picture.failed) box.dataset['failed'] = 'true';
      layout();
      return true;
    }
    // The controls are the player's: a press on them is not the start of a
    // selection in the terminal underneath, which is what it would be if it
    // reached the emulator.
    for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'] as const) {
      box.addEventListener(type, (e) => e.stopPropagation());
    }
    const element = document.createElement(media.type.kind === 'video' ? 'video' : 'audio');
    element.controls = true;
    element.preload = 'metadata';
    // Only when the program asked (`agbrte play`): `agbrte show` and every
    // other sender put a player on the line and leave pressing play to the
    // person. A terminal that starts making sound because something printed
    // to it is one people mute and never unmute (§12.4).
    element.autoplay = media.autoplay;
    if (media.name !== null) element.title = media.name;
    element.setAttribute(
      'aria-label',
      media.name ?? (media.type.kind === 'video' ? 'video' : 'sound'),
    );
    element.addEventListener('error', () => {
      picture.failed = true;
      box.dataset['failed'] = 'true';
    });
    box.appendChild(element);
    host.appendChild(box);
    media.box = box;
    media.element = element;
    picture.elements.add(element);
    paint(picture, element);
    if (picture.failed) box.dataset['failed'] = 'true';
    layout();
    return true;
  };

  /** Text in place of a picture that will not be drawn, where the picture would have been. */
  const refuse = (why: string): string => `\u001b[2m[image not shown: ${why}]\u001b[22m`;

  const iterm2 = (args: Record<string, string>, data: string): string => {
    // `inline=0` is iTerm2's "offer this file as a download". There is no
    // download here, and drawing it would be drawing what was not asked for.
    if (args['inline'] !== '1') return '';
    if (args['stream'] !== undefined) return streamed(args);
    const bytes = decodeBase64(data);
    const native = imageSize(bytes);
    const c = cell();
    const screen = { width: term.cols * c.width, height: term.rows * c.height };
    if (native === null) {
      // Not a picture: perhaps a video or a sound (step 4), which travel in
      // the same sequence — see `player`.
      const type = mediaType(bytes);
      if (type === null) return refuse('not a picture, a video or a sound this terminal can play');
      return player(args, bytes, type, c, screen);
    }
    const w = size(args['width'], c.width, screen.width);
    const h = size(args['height'], c.height, screen.height);
    const keep = args['preserveAspectRatio'] !== '0';
    let drawn: Size;
    if (w === null && h === null) {
      // Its own size, made to fit the screen: a screenshot at 1920 pixels would
      // otherwise be wider than the pane and taller than several screens.
      drawn = fit(native, {
        width: screen.width,
        height: Math.max(c.height, screen.height - c.height),
      });
    } else if (w !== null && h === null) {
      drawn = {
        width: w,
        height: keep ? (w * native.height) / native.width : native.height,
      };
    } else if (w === null && h !== null) {
      drawn = {
        width: keep ? (h * native.width) / native.height : native.width,
        height: h,
      };
    } else {
      drawn = keep ? contain(native, { width: w!, height: h! }) : { width: w!, height: h! };
    }
    drawn = fit(drawn, {
      width: screen.width,
      height: Number.POSITIVE_INFINITY,
    });
    const blob = Promise.resolve(new Blob([bytes as BlobPart], { type: native.mime }));
    const fed = fedRows(args);
    if (fed === null) return reserve('iterm2', drawn, blob);
    // Sender-fed: one element over the rows the sender is about to feed, the
    // picture made to fit them.
    drawn = fit(drawn, { width: screen.width, height: fed * c.height });
    return reserve('iterm2', drawn, blob, { fed, media: overlay(null, args) });
  };

  /**
   * A video or a sound, sent the way a picture is (step 4). Its size: what the
   * sender asked for, in a picture's units; else a video's own size from its
   * header, made to fit like a picture; else a 16:9 box, which is what most
   * video is — the picture is fitted inside the box either way. A sound is a
   * strip of controls, two rows or more.
   */
  /**
   * A file the host is streaming (step 5): no bytes in the sequence, a token
   * instead, and what the host read from the file's header — its kind, its
   * type, its size in pixels — so the rows can be taken now. See
   * `mediaOffers.ts` for why the token, and not the path, is what arrives.
   */
  const streamed = (args: Record<string, string>): string => {
    const url = opts.stream?.(args['stream']!) ?? null;
    if (url === null) return refuse('a file streamed from the host plays in the desktop app');
    const c = cell();
    const screen = { width: term.cols * c.width, height: term.rows * c.height };
    const pw = Number(args['pw']);
    const ph = Number(args['ph']);
    const own = pw > 0 && ph > 0 ? { width: pw, height: ph } : null;
    const kind = args['kind'];
    if (kind === 'video' || kind === 'audio') {
      const type: MediaType = {
        kind,
        mime: args['mime'] ?? '',
        ...(own !== null ? own : {}),
      };
      return player(args, url, type, c, screen);
    }
    if (kind !== 'picture' || own === null)
      return refuse('not a picture, a video or a sound this terminal can play');
    const h = size(args['height'], c.height, screen.height);
    let drawn = h === null ? own : { width: (h * own.width) / own.height, height: h };
    drawn = fit(drawn, {
      width: screen.width,
      height: Math.max(c.height, screen.height - c.height),
    });
    const fed = fedRows(args);
    if (fed !== null) drawn = fit(drawn, { width: screen.width, height: fed * c.height });
    return reserve('iterm2', drawn, url, {
      media: overlay(null, args),
      ...(fed !== null ? { fed } : {}),
    });
  };

  const player = (
    args: Record<string, string>,
    bytes: Uint8Array | string,
    type: MediaType,
    c: Size,
    screen: Size,
  ): string => {
    const w = size(args['width'], c.width, screen.width);
    const h = size(args['height'], c.height, screen.height);
    const room = {
      width: screen.width,
      height: Math.max(c.height, screen.height - c.height),
    };
    let drawn: Size;
    if (type.kind === 'audio') {
      drawn = {
        width: Math.min(screen.width, w ?? Math.max(300, 48 * c.width)),
        height: Math.max(h ?? 0, Math.ceil(40 / c.height) * c.height),
      };
    } else {
      const own =
        type.width !== undefined && type.height !== undefined
          ? { width: type.width, height: type.height }
          : null;
      const shape = own ?? { width: 16, height: 9 };
      if (w !== null && h !== null) drawn = { width: w, height: h };
      else if (w !== null) drawn = { width: w, height: (w * shape.height) / shape.width };
      else if (h !== null) drawn = { width: (h * shape.width) / shape.height, height: h };
      else
        drawn =
          own ??
          contain(shape, {
            width: Math.min(screen.width, 640),
            height: room.height,
          });
      drawn = fit(drawn, room);
    }
    const fed = fedRows(args);
    if (fed !== null) drawn = fit(drawn, { width: screen.width, height: fed * c.height });
    const blob =
      typeof bytes === 'string'
        ? bytes
        : Promise.resolve(new Blob([bytes as BlobPart], { type: type.mime }));
    return reserve('iterm2', drawn, blob, {
      media: overlay(type, args),
      ...(fed !== null ? { fed } : {}),
    });
  };

  /** A player, or a picture drawn as one element, before its row is reached. */
  const overlay = (type: MediaType | null, args: Record<string, string>): Player => {
    let name: string | null = null;
    if (args['name'] !== undefined) {
      try {
        name = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64(args['name']));
      } catch {
        name = null;
      }
    }
    return {
      type,
      autoplay: args['autoplay'] === '1',
      name,
      marker: null,
      x: 0,
      box: null,
      element: null,
    };
  };

  /**
   * `rows=N`: the sender prints the N line feeds the picture takes, rather than
   * the terminal adding them — see "Rows the sender feeds" in the header. A
   * count past two screens is not believed, and is read as absent.
   */
  const fedRows = (args: Record<string, string>): number | null => {
    const n = Number(args['rows']);
    return Number.isInteger(n) && n >= 1 && n <= MAX_SCREENS * term.rows ? n : null;
  };

  const sixel = (data: string): string => {
    const pixels = decodeSixel(data);
    if (pixels === null) return '';
    const c = cell();
    // Drawn at its own size — sixel programs size their output to the window
    // themselves — and only made smaller where it would not fit across.
    const drawn = fit(pixels, {
      width: term.cols * c.width,
      height: Number.POSITIVE_INFINITY,
    });
    return reserve('sixel', drawn, toBlob(pixels));
  };

  const kittyReply = (control: Record<string, string>, message: string): void => {
    const id = control['i'];
    if (id === undefined || id === '') return;
    const quiet = control['q'] ?? '0';
    if (quiet === '2' || (quiet === '1' && message === 'OK')) return;
    const placement = control['p'] !== undefined ? `,p=${control['p']}` : '';
    opts.reply(`\u001b_Gi=${id}${placement};${message}\u001b\\`);
  };

  /** A whole kitty command (chunks joined). */
  const kitty = (control: Record<string, string>, payload: string): string => {
    const action = control['a'] ?? 't';
    if (action === 'd') {
      const what = control['d'] ?? 'a';
      for (const p of [...order]) {
        if (p.protocol !== 'kitty') continue;
        if (
          what === 'a' ||
          what === 'A' ||
          ((what === 'i' || what === 'I') && p.kittyId === control['i'])
        )
          forget(p);
      }
      if (what === 'A' || what === 'I') {
        if (what === 'A') stored.clear();
        else if (control['i'] !== undefined) stored.delete(control['i']);
      }
      return '';
    }
    if (action === 'p') {
      const kept = control['i'] !== undefined ? stored.get(control['i']) : undefined;
      if (kept === undefined) {
        kittyReply(control, 'ENOENT:no image with this id');
        return '';
      }
      kittyReply(control, 'OK');
      return place(control, kept);
    }
    if (action !== 't' && action !== 'T' && action !== 'q') {
      kittyReply(control, 'EINVAL:not supported');
      return '';
    }
    const medium = control['t'] ?? 'd';
    if (medium !== 'd') {
      // See the header: the terminal does not open files a program names.
      kittyReply(control, 'EBADF:only direct transmission is accepted');
      return '';
    }
    const image = kittyImage(control, payload);
    if (typeof image === 'string') {
      kittyReply(control, image);
      return '';
    }
    if (action === 'q') {
      kittyReply(control, 'OK');
      return '';
    }
    if (control['i'] !== undefined) {
      stored.set(control['i'], image);
      while (stored.size > MAX_KITTY_STORED) stored.delete(stored.keys().next().value!);
    }
    kittyReply(control, 'OK');
    return action === 'T' ? place(control, image) : '';
  };

  const place = (control: Record<string, string>, image: Stored): string => {
    const c = cell();
    const cols = Number(control['c'] ?? 0);
    const rows = Number(control['r'] ?? 0);
    const native = image.size;
    let drawn: Size;
    if (cols > 0 && rows > 0) drawn = { width: cols * c.width, height: rows * c.height };
    else if (native === null) return refuse('a compressed picture with no size given');
    else if (cols > 0)
      drawn = {
        width: cols * c.width,
        height: (cols * c.width * native.height) / native.width,
      };
    else if (rows > 0)
      drawn = {
        width: (rows * c.height * native.width) / native.height,
        height: rows * c.height,
      };
    else
      drawn = fit(native, {
        width: term.cols * c.width,
        height: Number.POSITIVE_INFINITY,
      });
    return reserve('kitty', drawn, image.source(), {
      kittyId: control['i'] ?? null,
      cursorStays: control['C'] === '1',
    });
  };

  const stream = new ImageStream((picture: Picture): string => {
    try {
      switch (picture.protocol) {
        case 'iterm2':
          return iterm2(picture.args, picture.data);
        case 'sixel':
          return sixel(picture.data);
        case 'dropped':
          return refuse(picture.why);
        case 'kitty': {
          // Chunks after the first carry `m` (and perhaps `q`) and nothing
          // else; the first chunk's keys are the command's.
          if (chunks !== null) {
            chunks.parts.push(picture.payload);
            if (picture.control['m'] === '1') return '';
            const whole = chunks;
            chunks = null;
            return kitty(whole.control, whole.parts.join(''));
          }
          if (picture.control['m'] === '1') {
            chunks = { control: picture.control, parts: [picture.payload] };
            return '';
          }
          return kitty(picture.control, picture.payload);
        }
      }
    } catch {
      // A picture that cannot be drawn must not take the rest of the output
      // with it: the stream goes on as if it had not been there.
      return '';
    }
  });

  const handlers: IDisposable[] = [
    term.onRender(layout),
    term.onScroll(layout),
    term.onResize(layout),
    term.buffer.onBufferChange(layout),
    term.parser.registerOscHandler(ROW_OSC, row),
    term.parser.registerCsiHandler({ final: 'c' }, (params) => {
      // DA1 only: `CSI c` or `CSI 0 c`. Anything with a prefix (DA2's `>`) is not this.
      if (params.length > 1 || (typeof params[0] === 'number' && params[0] !== 0)) return false;
      opts.reply(DEVICE_ATTRIBUTES);
      return true;
    }),
    term.parser.registerCsiHandler({ final: 'J' }, (params) => {
      // Erase the screen (2) or the scrollback too (3): pictures on what was
      // erased go with it, or they would float over the blank screen `clear`
      // asked for. Not consumed — the emulator still erases.
      const p = params[0];
      if (p === 3) for (const picture of [...order]) forget(picture);
      else if (p === 2) {
        const top = term.buffer.active.baseY;
        for (const picture of [...order]) {
          const first = picture.markers[0];
          if (first !== undefined && !first.isDisposed && first.line >= top) forget(picture);
        }
      }
      return false;
    }),
  ];

  return {
    write: (data) => stream.write(data),
    dispose: () => {
      for (const h of handlers) h.dispose();
      for (const picture of [...order]) forget(picture);
      stored.clear();
      players?.remove();
    },
  };
}

/** Parse a kitty transmission's payload, or say why not (kitty's own error words). */
function kittyImage(control: Record<string, string>, payload: string): Stored | string {
  const format = control['f'] ?? '32';
  const compressed = control['o'] === 'z';
  const bytes = decodeBase64(payload);
  if (format === '100') {
    const size = compressed ? null : imageSize(bytes);
    if (!compressed && size === null) return 'EBADPNG:not a picture this terminal can read';
    return {
      size,
      source: async () => {
        const raw = compressed ? await inflate(bytes) : bytes;
        const found = imageSize(raw);
        return found === null ? null : new Blob([raw as BlobPart], { type: found.mime });
      },
    };
  }
  if (format !== '24' && format !== '32') return 'EINVAL:unknown format';
  const width = Number(control['s'] ?? 0);
  const height = Number(control['v'] ?? 0);
  if (!(width > 0 && height > 0 && width <= 10000 && height <= 10000))
    return 'EINVAL:no size given';
  const channels = format === '24' ? 3 : 4;
  return {
    size: { width, height },
    source: async () => {
      const raw = compressed ? await inflate(bytes) : bytes;
      if (raw.length < width * height * channels) return null;
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let p = 0, q = 0; p < width * height; p += 1, q += channels) {
        rgba[p * 4] = raw[q]!;
        rgba[p * 4 + 1] = raw[q + 1]!;
        rgba[p * 4 + 2] = raw[q + 2]!;
        rgba[p * 4 + 3] = channels === 4 ? raw[q + 3]! : 255;
      }
      return toBlob({ width, height, rgba });
    },
  };
}

/** zlib (RFC 1950), which is what kitty's `o=z` is. The browser's own inflater. */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Pixels to a PNG, for drawing like any other picture. */
async function toBlob(pixels: Pixels): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext('2d');
  if (context === null) return null;
  context.putImageData(
    new ImageData(pixels.rgba as Uint8ClampedArray<ArrayBuffer>, pixels.width, pixels.height),
    0,
    0,
  );
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * One of iTerm2's size arguments in CSS pixels: `N` cells, `Npx`, `N%` of the
 * screen, or `auto`/absent, which is `null`.
 */
function size(spec: string | undefined, unit: number, whole: number): number | null {
  if (spec === undefined || spec === '' || spec === 'auto') return null;
  const n = Number.parseFloat(spec);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (spec.endsWith('px')) return n;
  if (spec.endsWith('%')) return (whole * n) / 100;
  return n * unit;
}

/** Smaller to fit inside `box`, keeping its shape; never larger. */
function fit(size: Size, box: Size): Size {
  const scale = Math.min(1, box.width / size.width, box.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}

/** As large as fits inside `box`, keeping its shape. */
function contain(size: Size, box: Size): Size {
  const scale = Math.min(box.width / size.width, box.height / size.height);
  return { width: size.width * scale, height: size.height * scale };
}
