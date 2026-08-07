/**
 * Which models a host can reach (DESIGN.md §3.8, §13).
 *
 * Two properties carry the weight here.
 *
 * **A credential never leaves this module.** `ModelEndpoint` is passed around,
 * logged, and sent to clients, so the key lives behind `keyFor` and the endpoint
 * carries only a reference. That is not a convention to remember — it is checked,
 * because "remember to strip the secret" is exactly how secrets reach transcripts.
 *
 * **A malformed file stops the host.** The dangerous failure is not a crash, it
 * is a typo that drops one endpoint so a turn quietly goes somewhere else and
 * bills someone who never agreed to it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EndpointsInvalid, loadEndpoints } from '../src/host/endpoints.js';

let dir: string;
const file = (): string => join(dir, 'endpoints.json');

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gilmok-endpoints-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (body: unknown): Promise<void> =>
  writeFile(file(), JSON.stringify(body), 'utf8');

describe('with no file', () => {
  it('still offers a local endpoint, so an unconfigured machine works', async () => {
    const registry = await loadEndpoints(join(dir, 'nothing-here.json'));
    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve().auth.kind).toBe('none');
  });
});

describe('reading the file', () => {
  it('offers every endpoint, and keeps the keys to itself', async () => {
    await write({
      endpoints: [
        { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        { id: 'openai', baseUrl: 'https://api.openai.com/v1', provider: 'OpenAI', apiKey: 'sk-secret' },
      ],
      default: 'local',
    });
    const registry = await loadEndpoints(file());

    const advertised = JSON.stringify(registry.list());
    // The whole list is sent to clients. A key in it would reach a browser.
    expect(advertised).not.toContain('sk-secret');
    expect(JSON.stringify(registry.resolve('openai'))).not.toContain('sk-secret');
    // Reachable only through the one door meant for it.
    expect(registry.keyFor('openai')).toBe('sk-secret');
    expect(registry.keyFor('local')).toBeUndefined();
  });

  it('says who receives the code, per endpoint', async () => {
    await write({
      endpoints: [
        { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        { id: 'openai', baseUrl: 'https://api.openai.com/v1', provider: 'OpenAI', apiKey: 'k' },
      ],
    });
    const registry = await loadEndpoints(file());

    // §13: adding a provider must never quietly change where source code goes,
    // so the recipient travels with the endpoint rather than being assumed.
    expect(registry.resolve('local').dataHandling.provider).toBe('local');
    expect(registry.resolve('openai').dataHandling.provider).toBe('OpenAI');
    // A keyed endpoint is one that bills someone and takes code over the
    // network. Calling it app-local would be the quiet reclassification.
    expect(registry.resolve('openai').locality).toBe('cloud');
  });

  it('refuses a request for an endpoint it does not have', async () => {
    await write({ endpoints: [{ id: 'local', baseUrl: 'http://x/v1' }] });
    const registry = await loadEndpoints(file());
    // Rather than falling back to the default: that would send the turn
    // somewhere nobody asked for and bill the wrong account.
    expect(() => registry.resolve('openai')).toThrow(/no endpoint "openai"/);
  });

  it('refuses a malformed entry rather than skipping it', async () => {
    await write({ endpoints: [{ id: 'local' }] });
    // A dropped endpoint is worse than a stopped host: the turn still runs, just
    // somewhere else.
    await expect(loadEndpoints(file())).rejects.toThrow(EndpointsInvalid);
  });

  it('refuses a default that names nothing', async () => {
    await write({ endpoints: [{ id: 'local', baseUrl: 'http://x/v1' }], default: 'gone' });
    await expect(loadEndpoints(file())).rejects.toThrow(/not in the list/);
  });

  it('refuses unparseable JSON', async () => {
    await writeFile(file(), '{ nope', 'utf8');
    await expect(loadEndpoints(file())).rejects.toThrow(EndpointsInvalid);
  });
});

describe('the credential on the wire', () => {
  it('is sent as a bearer token, and only when the endpoint has one', async () => {
    // A real HTTP server, because the claim is about a header that leaves the
    // process. Asserting on a mock would test the mock.
    const { createServer } = await import('node:http');
    const seen: Array<string | undefined> = [];
    const server = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'a-model' }] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/v1`;

    try {
      await write({
        endpoints: [
          { id: 'open', baseUrl: base },
          { id: 'keyed', baseUrl: base, provider: 'Somewhere', apiKey: 'sk-on-the-wire' },
        ],
      });
      const registry = await loadEndpoints(file());
      const { OpenAiCompatibleProvider } = await import('@main/runtime/providers/openaiCompatible.js');
      const provider = new OpenAiCompatibleProvider({ keyFor: (id) => registry.keyFor(id) });

      await provider.listModels(registry.resolve('open'));
      await provider.listModels(registry.resolve('keyed'));

      // Absent stays absent rather than being sent empty: a 401 for a missing
      // key says something true, and `Bearer undefined` does not.
      expect(seen[0]).toBeUndefined();
      expect(seen[1]).toBe('Bearer sk-on-the-wire');
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});
