/**
 * The one command that carries a credential (DESIGN.md §6.5, §13, §3.8).
 *
 * `endpoints.add` sends an API key from the app to the host, which is a
 * deliberate crossing of the boundary §6.5 otherwise avoids — so the properties
 * that make it defensible are asserted rather than described. Each of these is a
 * way it could have been wrong and looked fine:
 *
 *  - the file is `0600` under a `0700` directory
 *  - the key is in the file and in **nothing else** — not the reply, not an
 *    error, not a log line
 *  - an existing endpoint is never silently redirected to a new provider
 *  - the endpoints that were already in force survive the write, including the
 *    implicit local fallback and the pre-rename legacy file
 *
 * The Windows ACL half is covered by `hostRecordAcl.test.ts`, which exercises
 * the same `restrictToOwner` this now shares with the host record.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEndpoint, EndpointRejected, loadEndpoints, setChain } from '../src/host/endpoints.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';

const KEY = 'sk-test-do-not-log-me';

/*
 * Collected, because `scratch()` is called once per test and nothing removed
 * them: this file alone left ten directories under the system temp folder per
 * run. Neighbouring `endpoints.test.ts` has always done this with a
 * `beforeEach`/`afterEach` pair; here the directory is made inside the test, so
 * the list is what makes one hook enough.
 */
const scratches: string[] = [];
afterAll(async () => {
  for (const dir of scratches) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      () => undefined,
    );
  }
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agbrte-endpoints-'));
  scratches.push(dir);
  return join(dir, '.agbrte', 'endpoints.json');
}

describe('writing an endpoint', () => {
  it('lands in a file only its owner can read', async () => {
    const path = await scratch();
    const written = await addEndpoint(
      { id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
      path,
    );

    expect(written).toEqual({ endpointId: 'openai', path, authenticated: true });

    const file = await stat(path);
    // POSIX only: on Windows the mode is close to a no-op and the ACL is what
    // does the work — see `hostRecordAcl.test.ts` for that half.
    if (process.platform !== 'win32') {
      expect(file.mode & 0o777).toBe(0o600);
      const dir = await stat(join(path, '..'));
      expect(dir.mode & 0o777).toBe(0o700);
    }

    // The key is in the file, which is the point.
    expect(await readFile(path, 'utf8')).toContain(KEY);
  });

  it('never puts the key in what comes back', async () => {
    const path = await scratch();
    const written = await addEndpoint(
      { id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
      path,
    );
    // Serialised whole, because the reply crosses two process boundaries and a
    // field added later would ride along without anybody looking.
    expect(JSON.stringify(written)).not.toContain(KEY);
    expect(written.authenticated).toBe(true);

    // And the registry that clients are handed strips it too, which is the
    // property `PublicEndpoint` exists for.
    const registry = await loadEndpoints(path, null);
    expect(JSON.stringify(registry.list())).not.toContain(KEY);
    expect(registry.list().find((e) => e.id === 'openai')?.authenticated).toBe(true);
    // The one place it is readable is where the request is made.
    expect(registry.keyFor('openai')).toBe(KEY);
  });

  it('keeps the key out of every refusal', async () => {
    const path = await scratch();
    await addEndpoint(
      { id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY },
      path,
    );
    // A duplicate id is the failure most likely to happen twice in a row, which
    // is exactly when a message gets pasted into a chat window.
    await expect(
      addEndpoint(
        { id: 'openai', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: KEY },
        path,
      ),
    ).rejects.toSatisfy((err: unknown) => {
      expect((err as Error).message).not.toContain(KEY);
      expect((err as Error).message).toContain('already has an endpoint called "openai"');
      return true;
    });
  });

  it('refuses to redirect an endpoint an agent may already name', async () => {
    const path = await scratch();
    await addEndpoint({ id: 'work', provider: 'openai', baseUrl: 'https://a.example/v1' }, path);
    // An id is what `AuthMode` names, so replacing one silently would point
    // every agent already using it at a different provider — the quiet change
    // §13 forbids.
    await expect(
      addEndpoint({ id: 'work', provider: 'other', baseUrl: 'https://b.example/v1' }, path),
    ).rejects.toBeInstanceOf(EndpointRejected);
    const registry = await loadEndpoints(path, null);
    expect(registry.list().find((e) => e.id === 'work')?.provider).toBe('openai');
  });

  it('will not store a key that would be sent in the clear', async () => {
    const path = await scratch();
    await expect(
      addEndpoint({ id: 'x', provider: 'p', baseUrl: 'http://build-01.local/v1', apiKey: KEY }, path),
    ).rejects.toThrow(/plain http/);
    // Loopback is exempt: there is no network to observe, and a keyed local
    // server is ordinary.
    await expect(
      addEndpoint({ id: 'y', provider: 'p', baseUrl: 'http://127.0.0.1:8000/v1', apiKey: KEY }, path),
    ).resolves.toMatchObject({ endpointId: 'y' });
  });

  it('refuses an id that could not survive being written down', async () => {
    const path = await scratch();
    for (const id of ['', 'Has Spaces', 'two\nlines', '-leading', 'ünicode']) {
      await expect(
        addEndpoint({ id, provider: 'p', baseUrl: 'https://a/v1' }, path),
      ).rejects.toBeInstanceOf(EndpointRejected);
    }
  });

  it('refuses a base URL that is not one, and one that is not http', async () => {
    const path = await scratch();
    await expect(
      addEndpoint({ id: 'a', provider: 'p', baseUrl: 'not a url' }, path),
    ).rejects.toThrow(/is not a URL/);
    await expect(
      addEndpoint({ id: 'a', provider: 'p', baseUrl: 'file:///etc/passwd' }, path),
    ).rejects.toThrow(/http or https/);
  });
});

describe('which API the endpoint speaks', () => {
  it('writes the adapter the caller named, and reads back as that', async () => {
    const path = await scratch();
    await addEndpoint(
      { id: 'claude', provider: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic', apiKey: KEY },
      path,
    );

    /*
     * Through `loadEndpoints` rather than by reading the JSON, because the field
     * is only worth writing if the thing that routes turns can see it. The two
     * halves were built a release apart — the file grew `api` while this command
     * could not set it — so an endpoint added through the app was
     * `openai-compatible` whatever it actually was.
     */
    const registry = await loadEndpoints(path, null);
    expect(registry.resolve('claude').providerId).toBe('anthropic');
  });

  it('defaults to openai-compatible, which is what vLLM and NIM need', async () => {
    const path = await scratch();
    // No `api`, no key: a model server on the agent's own box, which is §6.5's
    // `target-local` row and the case this form exists for as much as any cloud.
    await addEndpoint({ id: 'gpubox', provider: 'local', baseUrl: 'http://127.0.0.1:8000/v1' }, path);

    const registry = await loadEndpoints(path, null);
    expect(registry.resolve('gpubox').providerId).toBe('openai-compatible');
    expect(registry.keyFor('gpubox')).toBeUndefined();
  });

  it('refuses an adapter this host does not speak, naming the ones it does', async () => {
    const path = await scratch();
    /*
     * The same refusal `loadEndpoints` makes, at the other door — and this door
     * needs it more: nothing reads the file back before a turn is sent, so an
     * unknown value would sit there until it fell through the router to
     * `openai-compatible`. That is source code going to an API the person did
     * not name (§13), which is the worst version of the silent misroute the id
     * and URL checks already guard.
     */
    await expect(
      addEndpoint(
        { id: 'x', provider: 'x', baseUrl: 'http://127.0.0.1:8000/v1', api: 'anthropc' },
        path,
      ),
    ).rejects.toThrow(/anthropc/);
    await expect(
      addEndpoint(
        { id: 'x', provider: 'x', baseUrl: 'http://127.0.0.1:8000/v1', api: 'anthropc' },
        path,
      ),
    ).rejects.toThrow(/openai-compatible, anthropic/);
  });

  it('carries the field across the wire, where it was silently dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-endpoint-api-'));
    scratches.push(dir);
    const file = join(dir, 'endpoints.json');
    const identity = await openWorkspace(dir);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });

    // What the host was actually handed, which is the thing under test.
    const received: Array<Record<string, unknown>> = [];
    const server = new SessionHostServer({
      manager: new SessionManager({ registry, workspaceRoot: dir, instanceId: identity.instanceId }),
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: dir,
        runtimes: ['echo'],
      },
      addEndpoint: (input) => {
        received.push(input as unknown as Record<string, unknown>);
        return addEndpoint(input, file);
      },
    });

    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const connection = new HostConnection({ channel: pair.main });
    await connection.ready;

    await connection.addEndpoint({
      id: 'gpubox',
      provider: 'local',
      baseUrl: 'http://127.0.0.1:8000/v1',
      api: 'anthropic',
    });

    /*
     * Asserted on what crossed, because this is exactly where it went missing.
     * `HostConnection.addEndpoint`'s parameter type did not carry the field, and
     * its caller passes a *variable* rather than an object literal — so
     * TypeScript's excess-property check never fired, the build was clean, and
     * the endpoint went over the wire without it. CLAUDE.md's first hazard
     * arriving through a signature rather than a transport.
     *
     * `anthropic` rather than the default, so a version that drops the field
     * fails instead of accidentally agreeing.
     */
    expect(received).toHaveLength(1);
    expect(received[0]?.['api']).toBe('anthropic');
    const written = await loadEndpoints(file, null);
    expect(written.resolve('gpubox').providerId).toBe('anthropic');
  });
});

describe('what the write preserves', () => {
  it('keeps the settings beside the entries, which decide which entry is used', async () => {
    const path = await scratch();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        endpoints: [
          { id: 'gpubox', baseUrl: 'http://gpubox/v1' },
          { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        ],
        default: 'gpubox',
        fallback: ['gpubox', 'local'],
      }),
      'utf8',
    );

    await addEndpoint({ id: 'nim', provider: 'nvidia', baseUrl: 'http://nim/v1' }, path);

    /*
     * This wrote `{ endpoints: [...] }` and nothing else, so adding an endpoint
     * through the app **deleted `default`** — and `loadEndpoints` then fell back
     * to `entries[0]`, a different endpoint. Every turn afterwards went
     * somewhere the person had not chosen, with nothing saying the default had
     * moved: the quiet change of recipient §13 forbids, produced by the one
     * command written so nobody would have to edit this file by hand.
     *
     * The neighbouring test asserting that "the endpoints already in force
     * survive the write" is why it lasted. It checked the *entries*, and the
     * fields beside them are what decide which entry is used.
     */
    const registry = await loadEndpoints(path, null);
    expect(registry.resolve().endpointId).toBe('gpubox');
    expect(registry.nextAfter('gpubox')).toBe('local');
    // And the new one is there, which is what the write was for.
    expect(registry.list().map((e) => e.id)).toContain('nim');
  });

  it('materialises the implicit local endpoint rather than removing it', async () => {
    const path = await scratch();
    // With no file, a host falls back to a local Ollama. Writing a file stops
    // that fallback applying — so adding an unrelated API key would otherwise
    // take a working local model server away as a side effect.
    await addEndpoint({ id: 'openai', provider: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: KEY }, path);
    const registry = await loadEndpoints(path, null);
    const ids = registry.list().map((e) => e.id);
    expect(ids).toContain('local');
    expect(ids).toContain('openai');
    expect(registry.list().find((e) => e.id === 'local')?.baseUrl).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('keeps endpoints that were already configured, with their keys', async () => {
    const path = await scratch();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        endpoints: [
          { id: 'existing', baseUrl: 'https://old.example/v1', provider: 'old', apiKey: 'sk-old' },
        ],
      }),
      'utf8',
    );

    await addEndpoint({ id: 'new', provider: 'new', baseUrl: 'https://new.example/v1' }, path);
    const registry = await loadEndpoints(path, null);
    expect(registry.list().map((e) => e.id)).toEqual(['existing', 'new']);
    // A rewrite that dropped somebody else's credential would be silent and
    // would only surface as a turn failing hours later.
    expect(registry.keyFor('existing')).toBe('sk-old');
  });

  it('refuses to rewrite a file it could not parse', async () => {
    const path = await scratch();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, '{ this is not json', 'utf8');
    await expect(
      addEndpoint({ id: 'new', provider: 'new', baseUrl: 'https://new.example/v1' }, path),
    ).rejects.toThrow();
    // Untouched: destroying a file whose meaning we could not read would be the
    // worst possible response to a typo in it.
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });
});

/**
 * The gate on the wire, not only on the writer (§7, §13).
 *
 * `addEndpoint` refuses bad input; that is a different question from *who may
 * ask*. A phone pinned to `read-only` by a workspace's access policy must not be
 * able to point a build box at an endpoint that bills somebody — which is a
 * property of the dispatch, so it is asserted through a real server over a real
 * channel rather than by calling the writer.
 */
describe('who may add one', () => {
  it('refuses a read-only client and writes nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agbrte-endpoint-role-'));
    scratches.push(dir);
    const file = join(dir, 'endpoints.json');
    const identity = await openWorkspace(dir);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime(), { label: 'Echo', model: 'none' });
    const server = new SessionHostServer({
      manager: new SessionManager({ registry, workspaceRoot: dir, instanceId: identity.instanceId }),
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: dir,
        runtimes: ['echo'],
      },
      addEndpoint: (input) => addEndpoint(input, file),
    });

    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    const watcher = new HostConnection({ channel: pair.main, role: 'read-only' });
    await watcher.ready;

    await expect(
      watcher.addEndpoint({ id: 'x', provider: 'p', baseUrl: 'https://a/v1', apiKey: KEY }),
    ).rejects.toThrow(/read-only/);
    // Nothing on disk: a refusal that still wrote the file would be worse than
    // no gate at all, because it would look enforced.
    await expect(readFile(file, 'utf8')).rejects.toThrow();
  });
});

/*
 * Setting the order, which had no command until now (§3.9).
 *
 * The mechanism that walks the chain has worked for a while. What could not
 * happen was a person changing it: `endpoints.add` was the only endpoint write
 * on the wire, so the order every turn on a machine follows could be edited in
 * exactly one way — by opening `endpoints.json` on that machine, which for the
 * remote GPU box the feature exists for means an ssh session and hand-edited
 * JSON.
 */
describe('the order to try endpoints in', () => {
  const three = async (path: string): Promise<void> => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        endpoints: [
          { id: 'gpubox', baseUrl: 'http://gpu:8000/v1' },
          { id: 'nim', baseUrl: 'http://nim:8000/v1' },
          { id: 'local', baseUrl: 'http://127.0.0.1:11434/v1' },
        ],
      }),
      'utf8',
    );
  };

  it('writes an order the chain-walker actually follows', async () => {
    const path = await scratch();
    await three(path);

    await setChain(['gpubox', 'nim', 'local'], path);

    /*
     * Through `loadEndpoints` rather than by reading the JSON. The two fields in
     * that file are only worth writing if the thing that routes turns agrees
     * about what they mean, and the meaning is not obvious from the names: the
     * chain is the *whole* order, with the default as its first entry, so
     * `nextAfter` of the default is the second name rather than nothing.
     */
    const registry = await loadEndpoints(path, null);
    expect(registry.resolve().endpointId).toBe('gpubox');
    expect(registry.nextAfter('gpubox')).toBe('nim');
    expect(registry.nextAfter('nim')).toBe('local');
    expect(registry.nextAfter('local')).toBeUndefined();
  });

  it('cannot produce a first endpoint that failover never leaves', async () => {
    const path = await scratch();
    await three(path);

    await setChain(['nim', 'local'], path);
    const written = JSON.parse(await readFile(path, 'utf8')) as {
      default: string;
      fallback: string[];
    };

    /*
     * The trap this command exists to make unreachable. The file format permits
     * a `default` that is absent from `fallback`, and that combination is not a
     * feature: `nextAfter` finds the starting endpoint nowhere in the chain and
     * answers nothing, so the one endpoint every turn begins on is the one
     * endpoint a refusal can never move off. Deriving both from one order means
     * a client cannot ask for it.
     */
    expect(written.fallback[0]).toBe(written.default);
    expect((await loadEndpoints(path, null)).nextAfter('nim')).toBe('local');
  });

  it('keeps the endpoints, which is the failure the add side already had', async () => {
    const path = await scratch();
    await three(path);
    // `addEndpoint` once wrote `{ endpoints: [...] }` and deleted `default`.
    // This is the same write from the other direction, and the same mistake
    // available: writing only the two fields it owns would delete the endpoints
    // the order refers to.
    await setChain(['local'], path);

    const registry = await loadEndpoints(path, null);
    expect(registry.list().map((e) => e.id)).toEqual(['gpubox', 'nim', 'local']);
  });

  it('refuses a name that is not an endpoint, and says what is', async () => {
    const path = await scratch();
    await three(path);
    // Refused where somebody can still fix it. A typo does not fail loudly at
    // the next session: the chain ends one step early, so a turn that should
    // have moved to the local server stops, and it reads as the fallback being
    // broken rather than as a misspelling.
    await expect(setChain(['gpubox', 'nimm'], path)).rejects.toThrow(
      /"nimm" is not an endpoint.*gpubox, nim, local/s,
    );
  });

  it('refuses a name twice, and an empty order', async () => {
    const path = await scratch();
    await three(path);
    await expect(setChain(['nim', 'nim'], path)).rejects.toThrow(/appears twice/);
    // Not "clear it": an empty order leaves `default` naming nothing, and
    // `loadEndpoints` then picks `entries[0]` — an endpoint chosen by file
    // position rather than by anyone, which is §13's quiet change of recipient.
    await expect(setChain([], path)).rejects.toThrow(/at least one/);
  });

  it('leaves the file alone when it refuses', async () => {
    const path = await scratch();
    await three(path);
    await setChain(['local', 'nim'], path);

    await expect(setChain(['gpubox', 'nope'], path)).rejects.toThrow();

    // A rejected write that had already truncated the file would take the
    // working order down with the bad one.
    const registry = await loadEndpoints(path, null);
    expect(registry.resolve().endpointId).toBe('local');
    expect(registry.nextAfter('local')).toBe('nim');
  });
});

describe('the effort an endpoint declares', () => {
  it('reaches both the resolved endpoint and the advertised one', async () => {
    const path = await scratch();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        endpoints: [
          { id: 'gpubox', baseUrl: 'http://gpu:8000/v1', defaultReasoning: { mode: 'max' } },
          { id: 'claude', baseUrl: 'http://api/v1', defaultReasoning: { mode: 'low' } },
          { id: 'plain', baseUrl: 'http://plain/v1' },
        ],
      }),
      'utf8',
    );

    const registry = await loadEndpoints(path, null);

    /*
     * Both, because they are read by different processes for different reasons.
     * `resolve` answers the agent host, which is where `ModelEndpoint` declared
     * the field in the first place; `list` answers the *session host*, which is
     * where a new seat's effort is actually decided — the endpoints file is read
     * in the forked agent host (§8), so the deciding process has to be told.
     */
    expect(registry.resolve('claude').defaultReasoning).toEqual({ mode: 'low' });
    expect(registry.list().find((e) => e.id === 'gpubox')?.defaultReasoning).toEqual({
      mode: 'max',
    });
    // Absent stays absent: an endpoint that declares nothing must not read as
    // one that declared the constant, or nobody could tell the two apart.
    expect(registry.list().find((e) => e.id === 'plain')?.defaultReasoning).toBeUndefined();
  });

  it('refuses an effort that is not one, and says what is', async () => {
    const path = await scratch();
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        endpoints: [{ id: 'gpubox', baseUrl: 'http://gpu/v1', defaultReasoning: { mode: 'MAX' } }],
      }),
      'utf8',
    );

    /*
     * Refused rather than dropped, and the reason is this field's own history:
     * it sat in the type unread, so writing it changed nothing and said nothing.
     * Tolerating a typo now would reproduce exactly that — silence over a value
     * somebody wrote on purpose — and this time they have been told it works.
     */
    await expect(loadEndpoints(path, null)).rejects.toThrow(/not an effort.*off, auto, low/s);
  });
});
