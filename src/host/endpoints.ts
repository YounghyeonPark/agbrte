/**
 * Which models this host can reach, and what it may use to reach them
 * (DESIGN.md §3.8, §6.5, §13).
 *
 * ## Why a registry rather than one endpoint
 *
 * The first version read a single `AGBRTE_MODEL_BASE_URL` and built one endpoint
 * at startup. That encodes "this server has one model", which stops being true
 * the moment a machine has a local Ollama and a hosted API, or two GPUs serving
 * different weights. The types anticipated this all along — `AuthMode` is
 * `{ kind: 'api-key'; endpointId: string }` and `ModelRef` carries an
 * `endpointId` — so an agent has always been able to name the endpoint it wants.
 * Only the host's answer was hardcoded.
 *
 * ## Why a file rather than the environment
 *
 * A host starts three ways, and an environment variable covers two of them. The
 * app spawning a *remote* host builds an explicit `ssh <alias> '<command>'`,
 * which runs a non-interactive, non-login shell: it never sources `~/.profile`,
 * so anything exported there simply is not present. A file the host reads for
 * itself works identically however it was started.
 *
 * `~/.agbrte/` and not `.devagents/`, because `.devagents/` lives inside the
 * user's git repository and a credential put there is a credential that gets
 * committed.
 *
 * ## What this does and does not separate
 *
 * Credentials belong to the **host**, which means to whoever owns the workspace —
 * not to whoever is attached. One workspace has one host process running as one
 * unix user, so a second person driving that session spends the owner's budget.
 * That is a consequence of there being one process, not a gap to close: two hosts
 * on one workspace would both own the log, which §8 forbids outright.
 *
 * What is separated is *attribution*. Every event a person causes carries an
 * actor, and `usage` events carry tokens and cost, so "who spent what" is
 * answerable from the log even though "whose key" is not. On a shared server
 * that is usually the question actually being asked.
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { restrictToOwner } from './ownerOnly.js';
import type { ModelEndpoint } from '@shared/types/index.js';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@main/runtime/providers/openaiCompatible.js';

/** An endpoint as advertised to clients: everything except the secret. */
export interface PublicEndpoint {
  id: string;
  /** Shown in a picker. Falls back to the id. */
  label: string;
  /**
   * Who receives the code sent to it.
   *
   * Carried to clients and into the log because §13 requires that adding a
   * provider never quietly change where source code is transmitted. A UI that
   * cannot say "this turn went to OpenAI" is a UI that has changed it quietly.
   */
  provider: string;
  baseUrl: string;
  /** Whether a credential is attached. The credential itself never leaves here. */
  authenticated: boolean;
}

export interface EndpointRegistry {
  /** Every endpoint, secrets stripped. Safe to send anywhere. */
  list(): PublicEndpoint[];
  /**
   * The endpoint to use. Contains **no credential**, deliberately.
   *
   * `AuthMode` is `{ kind: 'api-key'; endpointId }` — a *reference* to a
   * credential, not the credential. Keeping it that way means a `ModelEndpoint`
   * can be logged, sent to a client, or put in an event without anyone having to
   * remember to strip it first, and "remember to strip it" is how keys end up in
   * transcripts.
   */
  resolve(endpointId?: string): ModelEndpoint;
  /** The secret behind an endpoint. Called only where the request is made. */
  keyFor(endpointId: string): string | undefined;
}

export class EndpointsInvalid extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is not a usable endpoint list: ${detail}`);
    this.name = 'EndpointsInvalid';
  }
}

interface Entry {
  id: string;
  baseUrl: string;
  label?: string;
  provider?: string;
  apiKey?: string;
}

export function endpointsPath(): string {
  return join(homedir(), '.agbrte', 'endpoints.json');
}

/**
 * Where this file lived when the project was called Gilmok.
 *
 * Read only when the current path has nothing, and never written. A rename is
 * our problem rather than the user's, and the failure it prevents is not a
 * missing feature: a host that finds no endpoints file falls back to the default
 * local Ollama and sends turns somewhere the user did not configure. That is the
 * silent misroute `EndpointsInvalid` exists to prevent, arriving through a
 * renamed directory instead of a typo.
 *
 * Deletable once no install predates the rename. Deliberately without an expiry
 * date, because a machine nobody has opened in a year is exactly the one that
 * still needs it.
 */
export function legacyEndpointsPath(): string {
  return join(homedir(), '.gilmok', 'endpoints.json');
}

/** `null` for a file that is not there; anything else still throws. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new EndpointsInvalid(path, (err as Error).message);
    }
    return null;
  }
}

/**
 * The endpoint every host has without being configured.
 *
 * Kept so a machine with a local Ollama works with no file at all, which is the
 * setup most people start from and the one the tests use.
 */
function fallback(): Entry {
  return {
    id: 'local',
    label: 'local model',
    provider: 'local',
    baseUrl: process.env['AGBRTE_MODEL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
  };
}

export async function loadEndpoints(
  path = endpointsPath(),
  /**
   * Defaulted from `path` rather than unconditionally, so a caller naming a file
   * — a test, a `--endpoints` flag — means *that* file. Otherwise a temp path
   * that happens to be empty would quietly pick up whatever is in the developer's
   * own home directory.
   */
  legacy: string | null = path === endpointsPath() ? legacyEndpointsPath() : null,
): Promise<EndpointRegistry> {
  let entries: Entry[];
  let fallbackId: string;

  let text = await readIfPresent(path);
  if (text === null && legacy !== null) {
    text = await readIfPresent(legacy);
    if (text !== null) path = legacy; // so a parse error names the file actually read
  }

  if (text === null) {
    entries = [fallback()];
    fallbackId = entries[0]!.id;
  } else {
    let parsed: { endpoints?: Entry[]; default?: string };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      throw new EndpointsInvalid(path, (err as Error).message);
    }
    if (!Array.isArray(parsed.endpoints) || parsed.endpoints.length === 0) {
      throw new EndpointsInvalid(path, 'expected { "endpoints": [ … ] } with at least one entry');
    }
    for (const entry of parsed.endpoints) {
      if (typeof entry?.id !== 'string' || typeof entry?.baseUrl !== 'string') {
        // Refused rather than skipped: a typo that silently drops an endpoint
        // sends the turn somewhere else instead of failing.
        throw new EndpointsInvalid(path, 'each endpoint needs an "id" and a "baseUrl"');
      }
    }
    entries = parsed.endpoints;
    fallbackId = parsed.default ?? entries[0]!.id;
    if (!entries.some((e) => e.id === fallbackId)) {
      throw new EndpointsInvalid(path, `"default" names ${fallbackId}, which is not in the list`);
    }
  }

  const build = (entry: Entry): ModelEndpoint => ({
    endpointId: entry.id,
    providerId: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl: entry.baseUrl,
    // `ModelEndpoint.auth` says what *kind* of credential this needs; the id is
    // the endpoint's own. `AgentSpec.auth` is the union that names one — two
    // different types that share a word.
    auth: { kind: entry.apiKey === undefined ? 'none' : 'api-key' },
    // `cloud` the moment a credential is involved: a keyed endpoint is one that
    // bills someone and receives code over the network, and calling it
    // `app-local` would be the sort of quiet reclassification §13 forbids.
    locality: entry.apiKey === undefined ? 'target-local' : 'cloud',
    dataHandling: { provider: entry.provider ?? (entry.apiKey === undefined ? 'local' : entry.id) },
  });

  const keys = new Map(entries.map((e) => [e.id, e.apiKey]));

  return {
    list: () =>
      entries.map((entry) => ({
        id: entry.id,
        label: entry.label ?? entry.id,
        provider: entry.provider ?? (entry.apiKey === undefined ? 'local' : entry.id),
        baseUrl: entry.baseUrl,
        authenticated: entry.apiKey !== undefined,
      })),
    resolve: (endpointId) => {
      const wanted = endpointId ?? fallbackId;
      const entry = entries.find((e) => e.id === wanted);
      if (entry === undefined) {
        // Named in full, because the alternative is silently running against the
        // default and billing the wrong account for a turn nobody asked to send
        // there.
        throw new Error(
          `no endpoint "${wanted}" on this host — available: ${entries.map((e) => e.id).join(', ')}`,
        );
      }
      return build(entry);
    },
    keyFor: (endpointId) => keys.get(endpointId),
  };
}

// ------------------------------------------------------------------- writing

/**
 * An endpoint as a client asks for it — the one shape in this program that
 * carries a credential *towards* a host rather than away from one.
 *
 * Everything else in `sessionProtocol.ts` travels the other way and is stripped
 * (`PublicEndpoint` exists for exactly that). So this type is the boundary §6.5
 * describes, seen from the other side: the key stops here, in a file on the
 * machine that will use it, and nothing downstream of `addEndpoint` sees it
 * again.
 */
export interface EndpointInput {
  id: string;
  label?: string;
  provider: string;
  baseUrl: string;
  /** Absent for a server that needs none — a local vLLM, an unauthenticated proxy. */
  apiKey?: string;
}

/** What happened, with nothing in it that could not be shown on a screen. */
export interface EndpointWritten {
  endpointId: string;
  /** Where it landed, so a person can find and edit it by hand afterwards. */
  path: string;
  /** Whether a credential was attached. Never the credential. */
  authenticated: boolean;
}

export class EndpointRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EndpointRejected';
  }
}

/**
 * Ids are constrained, and it is not cosmetic.
 *
 * The id is a map key that appears in `AuthMode`, in agent specs, in the log and
 * in a picker. A value with a newline in it would make `endpoints.json`
 * unreadable to a person and could smuggle a second line past anything that
 * printed the list; a value with a space in it is merely a thing nobody can type
 * twice the same way. Refused rather than sanitised, because silently renaming
 * somebody's endpoint means the agent spec naming it no longer resolves.
 */
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validate(input: EndpointInput): void {
  if (!ID.test(input.id)) {
    throw new EndpointRejected(
      `"${input.id}" is not a usable endpoint id — use lowercase letters, digits, ` +
        `dot, dash or underscore, starting with a letter or digit`,
    );
  }
  if (input.provider.trim() === '') {
    // §13: the provider is what the UI shows before a turn is sent, so an empty
    // one is a recipient nobody can name.
    throw new EndpointRejected('an endpoint needs a provider, so the UI can say where code goes');
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch {
    throw new EndpointRejected(`"${input.baseUrl}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new EndpointRejected(`an endpoint's base URL must be http or https, not ${url.protocol}`);
  }
  /*
   * A key over plain http to another machine is refused, not warned about.
   *
   * §6.5's whole argument for the gateway is that a credential should not be
   * exposed, and putting one in a header over an unencrypted connection is the
   * plainest version of that exposure. Loopback is exempt because there is no
   * network to observe — which is also the ordinary case for a keyed local
   * server.
   */
  const loopback =
    url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (input.apiKey !== undefined && url.protocol === 'http:' && !loopback) {
    throw new EndpointRejected(
      `refusing to store a key for ${url.host} over plain http — it would be sent unencrypted ` +
        `on every request. Use https, or leave the key off.`,
    );
  }
}

/**
 * Add an endpoint to this host's `endpoints.json`, creating the file if needed.
 *
 * ## Why the host writes it and the app does not
 *
 * The app could run `ssh <host> 'cat > endpoints.json'` and be done. It must
 * not, and the reason is narrower than "credentials are host-side": a key
 * interpolated into a command line is visible in `ps` to every account on that
 * machine for the length of the write, and lands in the history of anything that
 * logs commands. Coming through the session channel means the key is bytes on an
 * already-authenticated socket and reaches disk through `fs` — never through a
 * shell, never through a template, never through argv.
 *
 * ## What the file looks like afterwards
 *
 * The whole list is rewritten from what was resolved, which has two consequences
 * worth stating. It **preserves** entries from the legacy
 * `~/.gilmok/endpoints.json`, so a machine predating the rename does not lose
 * its endpoints the first time somebody adds one here. And it **materialises**
 * the implicit default: once a file exists the fallback stops applying, so
 * writing the list without it would take a working local Ollama away from a host
 * as a side effect of adding an unrelated API key.
 *
 * `0600`, under a `0700` directory, plus a Windows ACL. The three together are
 * what makes "the key never leaves the machine that uses it" true rather than
 * intended.
 */
export async function addEndpoint(
  input: EndpointInput,
  path = endpointsPath(),
): Promise<EndpointWritten> {
  validate(input);

  const dir = dirname(path);
  // `recursive` tolerates an existing directory; the explicit `chmod` is because
  // `mode` on `mkdir` is masked by the umask and a directory that already exists
  // keeps whatever it had.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);

  const existing = await readEntries(path);
  if (existing.some((e) => e.id === input.id)) {
    // Refused rather than replaced. An endpoint id is what an agent's `AuthMode`
    // names, so overwriting one silently redirects every agent already pointing
    // at it — possibly to a different provider, which is exactly the quiet
    // change §13 forbids.
    throw new EndpointRejected(
      `this host already has an endpoint called "${input.id}". Pick another name, or edit ` +
        `${path} on that machine.`,
    );
  }

  const entry: Entry = {
    id: input.id,
    baseUrl: input.baseUrl,
    provider: input.provider,
    ...(input.label !== undefined && input.label !== '' ? { label: input.label } : {}),
    ...(input.apiKey !== undefined && input.apiKey !== '' ? { apiKey: input.apiKey } : {}),
  };

  await writeFile(path, `${JSON.stringify({ endpoints: [...existing, entry] }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await restrictToOwner(path, 'model API keys');

  return { endpointId: entry.id, path, authenticated: entry.apiKey !== undefined };
}

/**
 * The entries currently in force, as entries rather than as a registry.
 *
 * Reads through the same legacy fallback `loadEndpoints` does. A malformed file
 * throws, which is right: rewriting a file we could not parse would destroy
 * whatever the user meant by it.
 */
async function readEntries(path: string): Promise<Entry[]> {
  const text =
    (await readIfPresent(path)) ??
    (path === endpointsPath() ? await readIfPresent(legacyEndpointsPath()) : null);
  if (text === null) return [fallback()];

  let parsed: { endpoints?: Entry[] };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch (err) {
    throw new EndpointsInvalid(path, (err as Error).message);
  }
  if (!Array.isArray(parsed.endpoints)) {
    throw new EndpointsInvalid(path, 'expected { "endpoints": [ … ] }');
  }
  return parsed.endpoints;
}
