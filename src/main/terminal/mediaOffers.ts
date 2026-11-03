/**
 * A file on the host, played in the terminal by reading only the parts that
 * are watched (DESIGN.md §17 Q24, step 5).
 *
 * Step 4 sends a video's bytes in the terminal stream, whole, which has two
 * limits that are one problem: a cap (36 MB), and the stream itself — a pane
 * on a server across an ssh link carries every byte of a film before the
 * prompt after it can arrive, and the host's own output buffer drops the
 * oldest of a burst larger than it holds (`MAX_PENDING_BYTES`), which is the
 * start of the sequence. What a player needs instead is to ask for a range —
 * the first megabyte, then whatever the person seeks to — and that is a
 * request from the client to the host, not bytes from the program.
 *
 * ## Who may name a file, which is the whole design
 *
 * The obvious shape — a sequence in the output saying "stream /path" — makes
 * any text that reaches the terminal able to make the host read a file: a
 * `cat` of a hostile log, a remote program's output. That is the reason kitty's
 * file transmission is refused in `terminalImages.ts`, and it applies here with
 * the host in place of the client.
 *
 * So the request carries a **key** the host gave the shell it started
 * (`AGBRTE_PANE_KEY`), and a request without it is dropped with a line saying
 * so. Text that merely passes through the terminal does not have the key; a
 * process descended from the shell does — something the person ran, *including
 * an agent CLI they started there*, which runs as them and could read the file
 * itself. The host opens the file *then*, keeps the handle, and replaces the
 * request with a sequence the client can act on that names a random **token**,
 * never the path; the client reads by token, from this pane only. A file
 * renamed or replaced afterwards does not change what the token reads, because
 * it reads the handle.
 *
 * The key is a bearer, so where it goes matters. The CLI streams only to a
 * terminal (`show.ts`), so `agbrte show x | tee log` or a tool capturing its
 * output does not write the key into a file or a model's context. No host or
 * pane the host starts inherits one (`terminalEnv`, `hostMain`), so a host run
 * from inside a pane does not hand that pane's key to its own agents.
 *
 * That is also why this is not limited to granted folders (§9, step 6), which
 * the plan said it would be: grants bound what the *agent* reaches on its own
 * initiative, and what is read here goes to one place — the screen of the
 * person whose pane it is, who is the user the file belongs to. A key in the
 * wrong hands shows that person their own file. What it could do beyond that
 * is in the *opening*, which is where the guards are.
 *
 * ## The open, which runs on the one host every session shares
 *
 * Synchronous, because the answer replaces the request at its place in the
 * stream and everything after waits behind it. So what it may open is narrowed
 * first, by an independent review's findings: the path is `stat`ed and must be
 * a regular file before it is opened — a FIFO would block `open` until a writer
 * came, freezing every session on the machine — and opened non-blocking where
 * the platform has it, then checked to be the same file. On Windows a UNC or
 * device path is refused outright: opening `\\server\share\x.mp4` authenticates
 * to that server with the user's credentials, and a share that answers slowly
 * stalls the host for as long. A slow *local* mount (NFS, a cloud placeholder)
 * can still stall it for an open and a 1 MB read; that is noted in
 * docs/status.md rather than made asynchronous here.
 */

import { closeSync, constants, fstatSync, openSync, read, readSync, statSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { imageSize } from '@shared/terminal/imageSize.js';
import { mediaType } from '@shared/terminal/mediaType.js';

/** The private OSC a request to stream a file comes in. */
export const OFFER_OSC = 7732;
/** Files one pane holds open; past it the oldest is closed and its player stops. */
export const MAX_OFFERS = 32;
/**
 * Files the whole host holds open for players, across every pane. One host
 * serves the machine (§8), and a GUI-started process on macOS may have 256
 * descriptors in all — the log, the sockets and the agents need theirs.
 */
export const MAX_HOST_OFFERS = 64;
/** The most one read returns: a range request is answered in pieces this size. */
export const MAX_READ = 1024 * 1024;
/** The environment variable a taught shell finds its key in. */
export const PANE_KEY_ENV = 'AGBRTE_PANE_KEY';

const MARKER = `\u001b]${OFFER_OSC};`;
/** A request is a key and a path; one longer than this is not one. */
const MAX_REQUEST = 16 * 1024;
/** How much of a file is read to tell what it is. An MP4 written for streaming has its index in here. */
const HEAD = 1024 * 1024;

/** What `agbrte show` asks for. */
export interface OfferRequest {
  /** Absolute, as the CLI resolved it against its own working directory. */
  path: string;
  /** The name shown on the player. */
  name: string;
  autoplay?: boolean;
  /** The rows the CLI feeds after the request (`terminalImages.ts`). */
  rows?: number;
}

/** The sequence `agbrte show` writes: the key, then the request as base64 JSON. */
export function offerSequence(key: string, request: OfferRequest): string {
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  return `${MARKER}${key};${payload}\u0007`;
}

export function newPaneKey(): string {
  return randomBytes(16).toString('hex');
}

/**
 * One open file. Closed only when no read is in flight on it: a read runs on
 * the thread pool, and a descriptor closed under it can be reused by the next
 * open on the main thread — the read would then return another file's bytes,
 * labelled as this one's.
 */
class Offer {
  private reading = 0;
  private closing = false;

  constructor(
    readonly fd: number,
    readonly size: number,
    readonly mime: string,
    private readonly owner: MediaOffers,
  ) {}

  get closed(): boolean {
    return this.closing;
  }

  async read(start: number, want: number): Promise<Buffer> {
    const buffer = Buffer.alloc(want);
    if (want === 0) return buffer;
    this.reading += 1;
    try {
      const got = await new Promise<number>((resolve, reject) =>
        read(this.fd, buffer, 0, want, start, (err, n) => (err === null ? resolve(n) : reject(err))),
      );
      return buffer.subarray(0, got);
    } finally {
      this.reading -= 1;
      if (this.closing && this.reading === 0) closeFd(this.fd);
    }
  }

  close(): void {
    if (this.closing) return;
    this.closing = true;
    open.delete(this);
    this.owner.forget(this);
    if (this.reading === 0) closeFd(this.fd);
  }
}

/** Every offer the host holds, oldest first, for `MAX_HOST_OFFERS`. */
const open = new Set<Offer>();

/** The files one pane has been asked to stream, by token. */
export class MediaOffers {
  private readonly offers = new Map<string, Offer>();

  /** Open `path` and say what it is, or why not. See the header for what it will not open. */
  offer(request: OfferRequest): string {
    const refused = refusedPath(request.path);
    if (refused !== null) return notice(`${request.name}: ${refused}`);
    let before;
    try {
      before = statSync(request.path);
    } catch (err) {
      return notice(`cannot open ${request.name}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    if (!before.isFile()) return notice(`${request.name} is not a file`);
    let fd: number;
    try {
      // Non-blocking where the platform has it: the file may have been
      // swapped for a FIFO since the `stat`, and the check after the open is
      // only reached if the open returns.
      const flags = process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;
      fd = openSync(request.path, flags);
    } catch (err) {
      return notice(`cannot open ${request.name}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev) {
        throw new Refused(`${request.name} changed while it was being opened`);
      }
      const head = Buffer.alloc(Math.min(HEAD, stat.size));
      const got = readSync(fd, head, 0, head.length, 0);
      const bytes = new Uint8Array(head.buffer, head.byteOffset, got);
      const picture = imageSize(bytes);
      const media = picture === null ? mediaType(bytes) : null;
      const what =
        picture !== null
          ? { kind: 'picture', mime: picture.mime, width: picture.width, height: picture.height }
          : media !== null
            ? { kind: media.kind, mime: media.mime, width: media.width, height: media.height }
            : null;
      if (what === null) throw new Refused(`${request.name} is not a picture, a video or a sound`);

      const token = randomBytes(16).toString('hex');
      const offer = new Offer(fd, stat.size, what.mime, this);
      this.offers.set(token, offer);
      open.add(offer);
      while (this.offers.size > MAX_OFFERS) this.offers.values().next().value!.close();
      while (open.size > MAX_HOST_OFFERS) open.values().next().value!.close();
      const rows = request.rows;
      const args = [
        'inline=1',
        `size=${stat.size}`,
        `name=${Buffer.from(request.name, 'utf8').toString('base64')}`,
        `stream=${token}`,
        `kind=${what.kind}`,
        `mime=${what.mime}`,
        ...(what.width !== undefined && what.height !== undefined ? [`pw=${what.width}`, `ph=${what.height}`] : []),
        ...(rows !== undefined && Number.isInteger(rows) && rows > 0 ? [`height=${rows}`, `rows=${rows}`] : []),
        ...(request.autoplay === true ? ['autoplay=1'] : []),
      ];
      return `\u001b]1337;File=${args.join(';')}:\u0007`;
    } catch (err) {
      closeFd(fd);
      if (err instanceof Refused) return notice(err.message);
      return notice(`cannot read ${request.name}: ${(err as NodeJS.ErrnoException).code ?? 'error'}`);
    }
  }

  /** Up to `MAX_READ` bytes at `offset`, or `null` for a token this pane did not give out. */
  async read(
    token: string,
    offset: number,
    length: number,
  ): Promise<{ size: number; mime: string; data: Buffer } | null> {
    const offer = this.offers.get(token);
    if (offer === undefined || offer.closed) return null;
    const start = Math.max(0, Math.min(Math.floor(offset), offer.size));
    const want = Math.max(0, Math.min(Math.floor(length), MAX_READ, offer.size - start));
    return { size: offer.size, mime: offer.mime, data: await offer.read(start, want) };
  }

  /** Every handle, for a pane that ended. */
  closeAll(): void {
    for (const offer of [...this.offers.values()]) offer.close();
  }

  /** An offer closed, by this pane or by the host's cap. */
  forget(offer: Offer): void {
    for (const [token, held] of this.offers) {
      if (held === offer) this.offers.delete(token);
    }
  }
}

/**
 * Why a path is not opened at all, or `null`. On Windows: a UNC path
 * (`\\server\share`, which also covers `\\?\UNC\` and WebDAV's `\\host@80\`)
 * and the device namespace (`\\.\`), whose opening is the harm — see the header.
 */
export function refusedPath(path: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'win32') return null;
  const p = path.replace(/\//gu, '\\');
  if (p.startsWith('\\\\?\\') && !p.toUpperCase().startsWith('\\\\?\\UNC\\')) return null;
  if (p.startsWith('\\\\')) return 'a network or device path is not streamed; copy it here first';
  return null;
}

class Refused extends Error {}

function closeFd(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Already closed; the outcome wanted.
  }
}

/** A line in the terminal, dim, where the player would have been. */
function notice(text: string): string {
  return `\u001b[2m[agbrte: ${text}]\u001b[22m`;
}

/**
 * Takes requests out of a shell's output and puts the host's answer in their
 * place. Everything else comes out as it went in, in order, whatever the
 * chunking — a request cut across two reads is held until it can be told apart,
 * and nothing else is held but a tail that could be the start of one.
 *
 * A request ends where the emulator would end it: BEL or `ESC \` finish it, and
 * any other ESC, CAN or SUB abandons it — the ESC beginning whatever comes
 * next. Ending only on BEL or ST, as the first version did, let an unfinished
 * `ESC ] 7732 ;` in hostile text swallow everything up to the next BEL, which
 * was usually the shell's own prompt mark.
 */
export class OfferFilter {
  private held = '';
  private body: string | null = null;
  private overflow = false;

  constructor(
    private readonly key: string,
    private readonly offers: MediaOffers,
  ) {}

  write(chunk: string): string {
    let s = this.held + chunk;
    this.held = '';
    let out = '';
    while (s.length > 0) {
      if (this.body === null) {
        const at = s.indexOf(MARKER);
        if (at === -1) {
          const keep = partialTail(s);
          out += s.slice(0, s.length - keep);
          this.held = s.slice(s.length - keep);
          return out;
        }
        out += s.slice(0, at);
        s = s.slice(at + MARKER.length);
        this.body = '';
        this.overflow = false;
        continue;
      }
      const end = s.search(/[\u0007\u0018\u001a\u001b]/u);
      if (end === -1) {
        this.take(s);
        return out;
      }
      this.take(s.slice(0, end));
      const c = s[end]!;
      if (c === '\u001b' && end + 1 === s.length) {
        // An ESC at the very end may be half a string terminator.
        this.held = '\u001b';
        return out;
      }
      if (c === '\u0007' || (c === '\u001b' && s[end + 1] === '\\')) {
        s = s.slice(end + (c === '\u0007' ? 1 : 2));
        out += this.answer(this.body);
      } else {
        // Abandoned, as the emulator would: CAN and SUB are consumed, an ESC
        // starts what follows.
        s = s.slice(c === '\u001b' ? end : end + 1);
      }
      this.body = null;
    }
    return out;
  }

  private take(piece: string): void {
    if (this.body === null || this.overflow) return;
    if (this.body.length + piece.length > MAX_REQUEST) {
      this.overflow = true;
      this.body = '';
    } else this.body += piece;
  }

  private answer(body: string): string {
    if (this.overflow) return notice('a request to stream a file was too long, and was ignored');
    const semi = body.indexOf(';');
    const key = semi === -1 ? '' : body.slice(0, semi);
    if (!sameKey(key, this.key)) {
      // Text that is not from the person's own shell: see the header.
      return notice('a request to stream a file did not come from this terminal, and was ignored');
    }
    let request: OfferRequest;
    try {
      const parsed = JSON.parse(Buffer.from(body.slice(semi + 1), 'base64').toString('utf8')) as Partial<OfferRequest>;
      if (typeof parsed.path !== 'string' || parsed.path === '') throw new Error('no path');
      request = {
        path: parsed.path,
        name: typeof parsed.name === 'string' ? parsed.name : 'file',
        ...(parsed.autoplay === true ? { autoplay: true } : {}),
        ...(typeof parsed.rows === 'number' ? { rows: parsed.rows } : {}),
      };
    } catch {
      return notice('a request to stream a file could not be read');
    }
    return this.offers.offer(request);
  }
}

/** How many characters at the end of `s` could be the start of the marker. */
function partialTail(s: string): number {
  for (let k = Math.min(s.length, MARKER.length - 1); k > 0; k -= 1) {
    if (MARKER.startsWith(s.slice(s.length - k))) return k;
  }
  return 0;
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
