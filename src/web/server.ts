/**
 * The same app, in a browser (DESIGN.md §7, §10, §17 Q13).
 *
 * ## Why this is small
 *
 * The renderer only ever talks to `window.agbrte`, a single typed surface
 * (§7's `contextIsolation` rule made that a requirement, not a preference). So a
 * browser needs exactly two things: that surface implemented over a socket, and
 * the built renderer served to it. Not one line of UI changes, and there is no
 * second implementation of anything — the handler map driven here is the map
 * Electron drives, so a method added to one is present in both or neither.
 *
 * ## One workspace, not a fleet
 *
 * A desktop app attaches many hosts; this is served *by* a host, so it shows
 * that host's workspace and no other. `hosts.add` says so rather than offering a
 * path field, because attaching another machine is a thing you do where the
 * filesystem is.
 *
 * ## Where it listens
 *
 * Loopback unless told otherwise, and the address is a required decision rather
 * than a default: this serves a UI that can drive an agent with a shell, so
 * `0.0.0.0` is never chosen on the user's behalf. The intended arrangement is a
 * tailnet address — the phone is already on the same private network as the
 * server (that is what makes this possible at all), so nothing is exposed to the
 * internet and identity is already established by the network itself.
 *
 * ## It authenticates, and here is why that changed
 *
 * This used to say plainly that it did not, on the reasoning that the address is
 * the whole boundary "exactly as it is for the unix socket the host already
 * listens on". That comparison was the mistake, and `socketChannel.ts` had
 * already written down why: a unix socket is narrowed to its owner with
 * `chmod 0600` and a Windows named pipe's default DACL grants the creating user
 * — so `grantRole`'s reasoning, that *reaching the socket already proved who you
 * are*, is sound there because reaching it really is restricted. A TCP port
 * carries no such claim. §6.2 says so in as many words for the loopback control
 * channel and mints a bearer token there; this server is the same shape and was
 * the one place that skipped it.
 *
 * Measured rather than argued, on a real browser against a real host: a page on
 * `https://example.com` — nothing to do with this project — opened
 * `ws://127.0.0.1:7717/__agbrte/socket` and read the session list back. It needed
 * one thing, the browser's own Local Network Access prompt, and nothing from us.
 * On a tailnet address there is no prompt at all: anything on that network can
 * `curl` its way to a shell.
 *
 * So the socket now speaks the same handshake `loopback.ts` does, for the same
 * reasons and with the same properties: the token is checked **before there is a
 * channel**, compared in constant time, and a wrong one is closed rather than
 * argued with. The token rides in the URL *fragment*, which browsers never send
 * to a server and never write to a log or a `Referer`.
 *
 * What is unchanged: the address still decides who can *reach* this, so binding
 * to anything but loopback still has to be typed out in full. A token is not a
 * reason to expose a shell to the internet.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { CH } from '@shared/ipc/contract.js';
import { AUTH_DEADLINE_MS, tokensMatch } from '@shared/host/loopback.js';
import { createApi, type IpcDeps } from '@main/ipc/api.js';

/**
 * What a browser client must never be handed.
 *
 * All of these are *this machine's* hardware or storage, and the web server is
 * reached over a network by whoever holds the token for it, from wherever they
 * can address it (§13). Passing `screen` here
 * would let a browser on the tailnet capture the **server's** desktop; `clips`
 * would record somebody's dictation onto the server's disk; `selectRegion`
 * would open an overlay on a display nobody is sitting at.
 *
 * Excluded by type rather than by remembering. The list was previously "the two
 * Electron-only capabilities" and there are now five — which is the sort of
 * comment that goes stale silently, and the sort of mistake that is one line to
 * make and catastrophic to ship.
 */
type ClientOnly =
  | 'broadcast'
  | 'pickFolder'
  | 'screen'
  | 'selectRegion'
  | 'clips'
  | 'speaker'
  | 'previews';

export interface WebServerOptions {
  /** Everything `createApi` needs, minus what belongs to the machine it runs on. */
  api: Omit<IpcDeps, ClientOnly>;
  /** Directory holding the built renderer. */
  rendererDir: string;
  port: number;
  /** Loopback unless the caller names something else, deliberately. */
  host?: string;
  /**
   * The bearer this server's socket admits. Required, like the address.
   *
   * No default and no way to switch it off, because both would be chosen on
   * somebody's behalf for a server that can drive a shell. A caller that wants
   * a stable one — a phone bookmark that survives a restart — passes the same
   * string again; one that does not mints a fresh one per run.
   */
  token: string;
}

export interface RunningWebServer {
  url: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Injected before the app bundle, so `window.agbrte` exists when it boots. */
const SHIM = '/__agbrte/bridge.js';

/**
 * Whether one frame is the handshake, and the right one.
 *
 * Its own function so the decision can be tested without a socket, a server or a
 * build — the wiring is checked end to end in `web.spec.ts`, but the *rule* is
 * the part that must never quietly loosen, and this suite runs in CI while that
 * one does not.
 *
 * Every branch answers `false`. There is no shape of frame, and no shape of
 * configured token, that admits a client by accident: a server with an empty
 * token admits nobody rather than everybody, which is the direction a mistake
 * here has to fall.
 */
export function admitsFrame(frame: unknown, token: string): boolean {
  if (token === '') return false;
  if (typeof frame !== 'object' || frame === null) return false;
  const { t, token: offered } = frame as { t?: unknown; token?: unknown };
  if (t !== 'auth' || typeof offered !== 'string') return false;
  return tokensMatch(offered, token);
}

export async function serveWeb(opts: WebServerOptions): Promise<RunningWebServer> {
  const rendererDir = resolve(opts.rendererDir);
  const bridgeSource = await readFile(resolve(rendererDir, '..', 'web', 'bridge.js'), 'utf8').catch(
    () => null,
  );
  if (bridgeSource === null) throw new Error('the web bridge bundle is missing — run the build');

  const http = createServer((req, res) => {
    void serveFile(req, res, rendererDir, bridgeSource);
  });

  // Attached to the same server rather than a second port: one address to
  // reach, one address to reason about.
  const wss = new WebSocketServer({ server: http, path: '/__agbrte/socket' });

  wss.on('connection', (socket: WebSocket) => {
    // A fresh API per connection, so each browser is its own client of the host
    // — its own role, its own actor on anything it causes. Sharing one would
    // make every phone in the house the same person in the log.
    const post = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };

    /*
     * Nothing is wired until the first frame proves the caller has the token.
     *
     * Before the protocol rather than inside it, which is `loopback.ts`'s rule
     * and its reason: a connection that never authenticates would otherwise be
     * able to issue `sessions.list` — the exact call a page on example.com made
     * against a real host while this was being written.
     *
     * An unauthenticated socket also gets a deadline. Without one, anything that
     * connects and says nothing holds a socket open for as long as it likes.
     */
    let admitted = false;
    const deadline = setTimeout(() => {
      if (!admitted) socket.close();
    }, AUTH_DEADLINE_MS);
    deadline.unref?.();
    // Every push this connection's API produces goes to this socket and no
    // other. Electron broadcasts to all windows because they are one client;
    // two browsers are two clients.
    // Stripped rather than trusted. The type above already makes these
    // unrepresentable, so this is for the caller who reached for a cast: a
    // browser must not end up holding this machine's screen or microphone
    // because somebody silenced a compiler error.
    const {
      screen: _screen,
      selectRegion: _region,
      clips: _clips,
      speaker: _speaker,
      previews: _previews,
      ...safe
    } = opts.api as IpcDeps;

    const api = createApi({
      ...safe,
      broadcast: (channel, payload) => post({ push: channel, payload }),
    });

    socket.on('message', (raw) => {
      void (async () => {
        let request: { id?: number; channel?: string; args?: unknown[] };
        try {
          request = JSON.parse(String(raw)) as typeof request;
        } catch {
          return; // an unparseable frame is not worth killing a live session over
        }

        if (!admitted) {
          // Closed rather than answered. There is nothing useful to tell
          // somebody who did not have the token, and a retry loop would turn
          // the port into something to sit and guess against.
          if (!admitsFrame(request, opts.token)) return void socket.close();
          admitted = true;
          clearTimeout(deadline);
          // Acknowledged, for `loopback.ts`'s reason: without a reply the client
          // has to hand over the channel optimistically, and a refusal then
          // arrives a round trip later as `socket closed` — which is
          // indistinguishable from a host that crashed.
          post({ t: 'auth-ok' });
          return;
        }

        if (request.channel === CH.ack) {
          const [sessionId, seq] = (request.args ?? []) as [string, number];
          api.ack(sessionId, seq);
          return;
        }

        const fn = request.channel === undefined ? undefined : api.handlers.get(request.channel);
        if (fn === undefined) {
          post({ id: request.id, error: `no such method: ${String(request.channel)}` });
          return;
        }
        try {
          post({ id: request.id, value: await fn(...(request.args ?? [])) });
        } catch (err) {
          post({ id: request.id, error: err instanceof Error ? err.message : String(err) });
        }
      })();
    });

    socket.on('close', () => api.dispose());
  });

  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((done, fail) => {
    http.once('error', fail);
    http.listen(opts.port, host, done);
  });

  return {
    /*
     * The token rides in the **fragment**, which is the whole reason it is safe
     * to put in a link: a browser never sends `#…` to the server, so it reaches
     * no access log, no `Referer`, and no proxy. A query string would have been
     * in the host's own log the first time anybody opened the page.
     */
    url: `http://${host.includes(':') ? `[${host}]` : host}:${opts.port}/#t=${opts.token}`,
    close: () =>
      new Promise<void>((done) => {
        wss.close();
        http.close(() => done());
      }),
  };
}

/**
 * The page, with two edits made on the way out.
 *
 * The shim goes in ahead of the app's own bundle, because the app reads
 * `window.agbrte` while it boots and one loaded after would be too late.
 *
 * And the CSP gains this request's own `ws://` origin. The built policy names
 * `ws://localhost:*`, which is right for Electron and wrong for a phone reaching
 * a tailnet address. `connect-src 'self'` is *supposed* to cover a same-origin
 * WebSocket, but browsers have disagreed about that for years and Safari is
 * exactly the browser this has to work in. Taking the origin from the request
 * rather than from the bind address is what makes it correct whether the phone
 * arrives by IP or by MagicDNS name.
 */
function page(html: string, host: string | undefined): string {
  const origin = host === undefined ? '' : ` ws://${host} http://${host}`;
  /*
   * The stamp that says this page *has* a host, and which one.
   *
   * On an attribute rather than in an inline script, because the policy above is
   * `script-src 'self'` — an inline one is blocked, and loosening a policy to
   * carry a single string is the wrong trade. The bridge reads it from
   * `document.currentScript` as it runs.
   *
   * Its absence is the signal, and that is the point: a copy of this app served
   * from anywhere else gets no stamp, knows it has no host, and asks for one
   * instead of guessing at `location` and failing at a socket.
   */
  const stamp = host === undefined ? '' : ` data-agbrte-host="http://${host}"`;
  return html
    .replace('<head>', `<head><script src="${SHIM}"${stamp}></script>`)
    .replace("connect-src 'self'", `connect-src 'self'${origin}`);
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  rendererDir: string,
  bridgeSource: string,
): Promise<void> {
  const url = (req.url ?? '/').split('?')[0] ?? '/';

  if (url === SHIM) {
    res.writeHead(200, { 'content-type': MIME['.js'] as string });
    res.end(bridgeSource);
    return;
  }

  // Normalised and re-rooted before use. A request for `/../../etc/passwd` is
  // not a path to fix up, it is a request to refuse.
  const rel = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '');
  const file = url === '/' ? join(rendererDir, 'index.html') : join(rendererDir, rel);
  if (!resolve(file).startsWith(rendererDir)) {
    res.writeHead(403).end('no');
    return;
  }

  try {
    const body = await readFile(file);
    if (file.endsWith('index.html')) {
      res.writeHead(200, { 'content-type': MIME['.html'] as string });
      res.end(page(String(body), req.headers.host));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    // Single-page app: an unknown path is a route, not a missing file.
    const index = await readFile(join(rendererDir, 'index.html'), 'utf8').catch(() => null);
    if (index === null) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'] as string });
    res.end(page(index, req.headers.host));
  }
}
