/**
 * The same app, in a browser (DESIGN.md §7, §10, §17 Q13).
 *
 * ## Why this is small
 *
 * The renderer only ever talks to `window.gilmok`, a single typed surface
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
 * **What this does not do is authenticate.** Anyone who can reach the address can
 * drive the session, so the address is the whole security boundary — exactly as
 * it is for the unix socket the host already listens on. That is honest for a
 * tailnet and would not be for a public interface, which is why binding to one
 * has to be typed out in full.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { CH } from '@shared/ipc/contract.js';
import { createApi, type IpcDeps } from '@main/ipc/api.js';

export interface WebServerOptions {
  /** Everything `createApi` needs, minus the two Electron-only capabilities. */
  api: Omit<IpcDeps, 'broadcast' | 'pickFolder'>;
  /** Directory holding the built renderer. */
  rendererDir: string;
  port: number;
  /** Loopback unless the caller names something else, deliberately. */
  host?: string;
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

/** Injected before the app bundle, so `window.gilmok` exists when it boots. */
const SHIM = '/__gilmok/bridge.js';

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
  const wss = new WebSocketServer({ server: http, path: '/__gilmok/socket' });

  wss.on('connection', (socket: WebSocket) => {
    // A fresh API per connection, so each browser is its own client of the host
    // — its own role, its own actor on anything it causes. Sharing one would
    // make every phone in the house the same person in the log.
    const post = (message: unknown): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
    };
    // Every push this connection's API produces goes to this socket and no
    // other. Electron broadcasts to all windows because they are one client;
    // two browsers are two clients.
    const api = createApi({
      ...opts.api,
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
    url: `http://${host.includes(':') ? `[${host}]` : host}:${opts.port}/`,
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
 * `window.gilmok` while it boots and one loaded after would be too late.
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
  return html
    .replace('<head>', `<head><script src="${SHIM}"></script>`)
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
