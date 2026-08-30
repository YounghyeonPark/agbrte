/**
 * What `agbrte web` does when it cannot have the port it was given (§6.2).
 *
 * ## The crash this is about
 *
 * `ws` attaches to the http server and re-emits that server's errors on itself.
 * An EventEmitter with no `error` listener throws instead of reporting, so
 * `serveWeb` died on a busy port with a raw stack trace — despite already
 * having `http.once('error', fail)`, which is why reading the code was not
 * enough to see it:
 *
 * ```
 * Error: listen EADDRINUSE: address already in use 127.0.0.1:7981
 *     at Server.setupListenHandle (node:net:2009:16)
 * Emitted 'error' event on WebSocketServer2 instance at:
 * ```
 *
 * Reached two ways, both real. Somebody typing `agbrte web . --port 3000` while
 * a dev server holds 3000 saw those twelve lines; and the e2e harness spawns
 * this with `stdio: 'ignore'`, so there the same crash produced no output at all
 * and surfaced thirty seconds later as "the web server never came up".
 *
 * ## Why the whole server is started here rather than the message unit-tested
 *
 * `listenFailure` is pure and is checked below, and a suite that stopped there
 * would have gone green against the broken code: the defect was never in the
 * sentence, it was in nobody being subscribed to hear it. So the first test
 * takes a real port with a real listener and calls the real `serveWeb`. The
 * assertion that matters is not the wording — it is that this **rejects** at
 * all, rather than taking the process down.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listenFailure, serveWeb, type WebServerOptions } from '../src/web/server.js';

/**
 * The two files `serveWeb` insists on before it will listen.
 *
 * Built here rather than pointed at `dist/`: a test that needs a build is a test
 * that fails for a reason unrelated to what it claims, and this one is about a
 * socket rather than about the bundle.
 */
async function rendererDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-listen-'));
  await mkdir(join(root, 'renderer'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'bridge.js'), '// not run by this test\n', 'utf8');
  return root;
}

/** A port with something already on it, and the port number. */
async function occupied(): Promise<{ port: number; free: () => Promise<void>; server: Server }> {
  const server = createServer();
  const port = await new Promise<number>((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      done(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
  return {
    port,
    server,
    free: () => new Promise<void>((done) => server.close(() => done())),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const done of cleanups.splice(0)) await done().catch(() => undefined);
});

describe('a port this server cannot have', () => {
  it('rejects instead of crashing the process, and names the port', async () => {
    const held = await occupied();
    cleanups.push(held.free);
    const root = await rendererDir();
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const opts: WebServerOptions = {
      // Never reached: this fails at `listen`, before a connection can exist.
      api: {} as WebServerOptions['api'],
      rendererDir: join(root, 'renderer'),
      port: held.port,
      token: 'not-used-either',
    };

    /*
     * `rejects` is the whole assertion. Against the old code this line did not
     * fail — the worker died, because an unhandled `error` event is a throw and
     * not a rejected promise, and no `expect` can catch a process that is gone.
     */
    await expect(serveWeb(opts)).rejects.toThrow(String(held.port));
  });
});

describe('the sentence a failed listen turns into', () => {
  const inUse = Object.assign(new Error('listen EADDRINUSE: address already in use'), {
    code: 'EADDRINUSE',
  });

  it('says another program has it, and how to pick a different one', () => {
    const said = listenFailure(inUse, 3000, '127.0.0.1').message;
    // The two facts the errno leaves out, which are the two that help.
    expect(said).toContain('something else is listening');
    expect(said).toContain('--port');
    expect(said).toContain('3000');
    // And not the vocabulary somebody would have to look up.
    expect(said).not.toContain('EADDRINUSE');
  });

  it('explains a refused low port, since nobody guesses that from EACCES', () => {
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    expect(listenFailure(denied, 80, '0.0.0.0').message).toContain('administrator rights');
    // Above 1024 the privilege line would be a wrong guess, so it is absent.
    expect(listenFailure(denied, 8080, '0.0.0.0').message).not.toContain('administrator');
  });

  it('points a bad --bind at the flag that set it', () => {
    const nope = Object.assign(new Error('listen EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' });
    const said = listenFailure(nope, 7717, '10.9.9.9').message;
    expect(said).toContain('10.9.9.9');
    expect(said).toContain('--bind');
  });

  it('passes through anything it was not written for, rather than guessing', () => {
    // A paraphrase of an error nobody here anticipated is worse than the error:
    // it costs the one string somebody could have searched for.
    const strange = Object.assign(new Error('listen EMFILE: too many open files'), {
      code: 'EMFILE',
    });
    expect(listenFailure(strange, 7717, '127.0.0.1')).toBe(strange);
  });
});
