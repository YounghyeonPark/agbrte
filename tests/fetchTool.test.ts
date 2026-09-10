/**
 * The `fetch` tool, and mostly the addresses it will not go to
 * (DESIGN.md §3.7, §13, §6.2).
 *
 * The tool adds no capability — an agent with `bash` could always `curl` — so
 * almost nothing here is about fetching. It is about the boundary that makes a
 * named tool worth having: §6.2's control channel is on this machine's loopback
 * and is authenticated by a bearer token, and cloud metadata answers on
 * `169.254.169.254` with credentials for the box. A fetch tool that could reach
 * either would be a hole underneath every other boundary in this project.
 *
 * ## How the success path is exercised at all
 *
 * A real server has to listen somewhere, and everywhere a test can listen is
 * exactly what the tool refuses. So `node:dns/promises` is mocked to answer with
 * a public address while the socket still lands on 127.0.0.1 — a test double for
 * the resolver, not a bypass in the tool.
 *
 * That is also, precisely, the DNS-rebinding hole `fetch.ts` says it does not
 * close: vetting resolves the name and the request is then made by name. Having
 * the test be that scenario is the honest way to record it — if the tool ever
 * pins its connection to the vetted address, this file stops working and the
 * comment stops being true on the same day.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * Public by construction: `example.com`'s documentation address. The vetting
 * only ever sees this; the connection is made by name and lands on loopback.
 */
const PUBLIC = '93.184.216.34';
let resolves: string[] = [PUBLIC];

vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    if (host === 'unresolvable.invalid') throw new Error('ENOTFOUND');
    return resolves.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
}));

const { fetchTool, htmlToText, isMetadataAddress, isPrivateAddress, vetScreenshotUrl, vetUrl } =
  await import('../src/main/tools/fetch.js');
const { WorkspaceLeases } = await import('../src/main/tools/leases.js');
type Ctx = Parameters<typeof fetchTool.run>[1];

let server: Server;
let port = 0;
/** What the next request gets, so one server serves every case below. */
let reply: (path: string) => { status: number; headers: Record<string, string>; body: string };

beforeAll(async () => {
  server = createServer((req, res) => {
    const answer = reply(req.url ?? '/');
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});
afterEach(() => {
  resolves = [PUBLIC];
});

function ctx(): Ctx {
  return {
    workspaceRoot: process.cwd(),
    agentId: 'agent-1',
    leases: new WorkspaceLeases(),
    signal: new AbortController().signal,
  } as Ctx;
}

/*
 * `localhost`, so the *real* resolver lands the socket on 127.0.0.1 while the
 * mocked one tells the vetting a public address. Any other name would fail to
 * connect, which is what the first version of this file did.
 */
const at = (path = '/'): string => `http://localhost:${port}${path}`;

describe('addresses it refuses', () => {
  it('knows the ranges that mean this machine or this network', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fd00::1',
      'fe80::1',
      // The v4-in-v6 spelling, which walks past a v4-only check and is why the
      // prefix is stripped before the family is decided.
      '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it('refuses a name that resolves to a private address, and says which', async () => {
    resolves = ['169.254.169.254'];
    const said = await vetUrl('http://metadata.example/latest/meta-data/');
    expect('error' in said && said.error).toContain('169.254.169.254');
    // A name check alone is defeated by any of the public services that resolve
    // to whatever you ask them to, which is why this is a resolution.
    expect('error' in said && said.error).toContain('on this machine or this network');
  });

  it('refuses when any answer is private, not only the first', async () => {
    // Otherwise a name resolving to one public and one private address is a
    // coin flip decided by resolver ordering.
    resolves = [PUBLIC, '127.0.0.1'];
    expect('error' in (await vetUrl('http://both.example/'))).toBe(true);
  });

  it('refuses an address literal without asking anybody', async () => {
    expect('error' in (await vetUrl('http://127.0.0.1:8080/'))).toBe(true);
    expect('error' in (await vetUrl('http://[::1]:8080/'))).toBe(true);
  });

  it('refuses a scheme that is not http, naming file: for what it would be', async () => {
    const said = await vetUrl('file:///etc/passwd');
    // A way round the workspace confinement every other tool here is built on.
    expect('error' in said && said.error).toContain('file');
  });

  it('refuses a URL carrying a username or password', async () => {
    // A credential in a URL is a credential in the transcript, which is the one
    // place §13 says it must never be.
    expect('error' in (await vetUrl('https://user:secret@example.com/'))).toBe(true);
  });

  it('says a name that does not resolve did not resolve', async () => {
    const said = await vetUrl('http://unresolvable.invalid/');
    expect('error' in said && said.error).toContain('could not resolve');
  });
});

describe('fetching', () => {
  it('reads a page and names the URL it read', async () => {
    reply = () => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello there' });
    const result = await fetchTool.run({ url: at() }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('hello there');
    // The URL is in the output because it is the provenance of everything under
    // it — which is the whole argument for this being a tool and not a shell line.
    expect(result.content).toContain(at());
  });

  it('turns HTML into the words in it', async () => {
    reply = () => ({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><head><style>p{color:red}</style><script>var x=1</script></head><body><h1>Title</h1><p>One &amp; two</p></body></html>',
    });
    const result = await fetchTool.run({ url: at() }, ctx());
    expect(result.content).toContain('Title');
    expect(result.content).toContain('One & two');
    // The two tags whose contents are not prose and are usually most of the
    // bytes: a model reading a page should spend its window on the words.
    expect(result.content).not.toContain('color:red');
    expect(result.content).not.toContain('var x=1');
  });

  it('follows a redirect and vets the hop', async () => {
    reply = (path) =>
      path === '/start'
        ? { status: 302, headers: { location: '/end' }, body: '' }
        : { status: 200, headers: { 'content-type': 'text/plain' }, body: 'arrived' };
    const result = await fetchTool.run({ url: at('/start') }, ctx());
    expect(result.ok).toBe(true);
    expect(result.content).toContain('arrived');
    // The final URL, not the one asked for: after a redirect they differ and the
    // one that answered is what the content came from.
    expect(result.summary).toContain('/end');
  });

  it('refuses a redirect into a private address, which is the oldest way round', async () => {
    reply = () => ({
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      body: '',
    });
    const result = await fetchTool.run({ url: at('/start') }, ctx());
    expect(result.ok).toBe(false);
    // Named as a redirect, because "169.254.169.254 is on this network" about a
    // URL nobody typed is confusing on its own.
    expect(result.summary).toContain('after a redirect');
  });

  it('gives up rather than following a redirect loop', async () => {
    reply = () => ({ status: 302, headers: { location: at('/again') }, body: '' });
    const result = await fetchTool.run({ url: at('/start') }, ctx());
    expect(result.summary).toContain('redirects');
  });

  it('reports a status rather than pretending it read something', async () => {
    reply = () => ({ status: 404, headers: {}, body: 'nope' });
    const result = await fetchTool.run({ url: at('/missing') }, ctx());
    expect(result.ok).toBe(false);
    // A 404 is a fact about the page, and a model asked to check a link needs
    // to be told it rather than handed the error body.
    expect(result.summary).toContain('404');
  });

  it('refuses a body it cannot read, naming the type', async () => {
    reply = () => ({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4' });
    const result = await fetchTool.run({ url: at() }, ctx());
    expect(result.ok).toBe(false);
    // Bytes the model cannot read are a window it cannot get back.
    expect(result.summary).toContain('application/pdf');
  });

  it('stops reading a body that will not stop', async () => {
    // `content-length` is a claim rather than a promise, so the ceiling is
    // counted off the chunks actually read.
    reply = () => ({
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(2 * 1024 * 1024),
    });
    const result = await fetchTool.run({ url: at() }, ctx());
    expect(result.ok).toBe(true);
    expect((result.content ?? '').length).toBeLessThan(1024 * 1024);
  });

  it('refuses a url that is not one before touching the network', async () => {
    reply = () => ({ status: 200, headers: {}, body: '' });
    expect((await fetchTool.run({ url: 'not a url' }, ctx())).ok).toBe(false);
    expect((await fetchTool.run({ url: '' }, ctx())).ok).toBe(false);
  });
});

describe('what the screenshot tool may open', () => {
  /*
   * A different verdict on the same question, and the difference is the tool's
   * purpose. §12.1 built `screenshot` so "an agent starts a dev server, looks at
   * what it rendered, and fixes it" — every one of those pages is on this
   * machine — so refusing private addresses there would refuse the tool.
   *
   * What is refused is link-local: `169.254.169.254` serves a cloud instance's
   * credentials as plain text, a browser renders them, and a model that reads
   * images reads them back. No dev-server loop wants that.
   */
  it('allows loopback and the private ranges, which are the whole point', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '::1']) {
      resolves = [address];
      const said = await vetScreenshotUrl('http://dev.local:5173/');
      expect('url' in said, address).toBe(true);
    }
    // And an address literal, which is how the dev-server case is usually typed.
    expect('url' in (await vetScreenshotUrl('http://127.0.0.1:5173/'))).toBe(true);
  });

  it('refuses the metadata address, naming what a picture of it would be', async () => {
    resolves = ['169.254.169.254'];
    const said = await vetScreenshotUrl('http://metadata.example/');
    expect('error' in said && said.error).toContain('credentials');
    // And by literal, which is how it would actually be reached.
    expect('error' in (await vetScreenshotUrl('http://169.254.169.254/latest/'))).toBe(true);
  });

  it('refuses a scheme the browser would read off the disk', async () => {
    // Refused since this tool existed, by a regex; now by a parse, so a URL the
    // browser reads differently from a pattern cannot slip past one.
    for (const raw of ['file:///etc/passwd', 'data:text/html,<h1>x', 'not a url']) {
      expect('error' in (await vetScreenshotUrl(raw)), raw).toBe(true);
    }
  });

  it('tells link-local apart from the rest of the private space', () => {
    expect(isMetadataAddress('169.254.169.254')).toBe(true);
    expect(isMetadataAddress('fe80::1')).toBe(true);
    expect(isMetadataAddress('::ffff:169.254.169.254')).toBe(true);
    // The ranges `screenshot` is *for*, which `isPrivateAddress` still covers
    // and this deliberately does not.
    for (const ok of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '8.8.8.8']) {
      expect(isMetadataAddress(ok), ok).toBe(false);
    }
  });
});

describe('the stripper on its own', () => {
  it('unescapes in an order that cannot make a tag', () => {
    // `&amp;lt;` is the case: unescaping `&amp;` first would leave `&lt;`, and a
    // second pass would turn it into `<`.
    expect(htmlToText('<p>&amp;lt;script&amp;gt;</p>')).toBe('&lt;script&gt;');
  });

  it('keeps block boundaries as line breaks', () => {
    expect(htmlToText('<li>one</li><li>two</li>')).toBe('one\ntwo');
  });
});
