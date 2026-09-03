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
 * The machine's `~/.agbrte/` and not the *workspace's* `.agbrte/`. The two
 * spell their name the same way and are different things (§5.1): a workspace's
 * directory lives inside the user's git repository, and a credential put there
 * is a credential that gets committed.
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
import { machineRoot } from './machine.js';
import { restrictToOwner } from './ownerOnly.js';
import type { ModelEndpoint } from '@shared/types/index.js';
import { OPENAI_COMPATIBLE_PROVIDER_ID } from '@main/runtime/providers/openaiCompatible.js';
import { ANTHROPIC_PROVIDER_ID } from '@main/runtime/providers/anthropic.js';

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
  /**
   * Where a turn goes when this endpoint will not take it (§3.9, §6.5).
   *
   * `undefined` at the end of the chain, and for an endpoint the chain does not
   * mention — which is the ordinary case and not a misconfiguration. A machine
   * with one model server has nowhere to fall back to, and saying so by
   * answering nothing is better than inventing an order nobody wrote.
   *
   * **Declared here rather than per session**, beside `default`, because it is
   * the same kind of fact: which of this machine's endpoints to use is a
   * property of the machine, not a choice a person makes per turn. A GPU box
   * being down is true for every session on that host at once.
   */
  nextAfter(endpointId: string): string | undefined;
  /**
   * The order in force, most preferred first — for showing, not for routing.
   *
   * `nextAfter` is what a turn asks; this is what a person is shown. Answered by
   * the same object for a reason: the app used to display nothing about the
   * order at all, so somebody whose turns had moved to a second provider could
   * not see the configuration that sent them there. Deriving it in a second
   * place would let the picture and the routing disagree, which is a worse
   * version of showing nothing.
   *
   * Empty when the file names no order. That is the ordinary state of a machine
   * with one endpoint and not a misconfiguration, so it renders as "no fallback"
   * rather than as a warning.
   */
  chain(): string[];
}

export class EndpointsInvalid extends Error {
  constructor(path: string, detail: string) {
    super(`${path} is not a usable endpoint list: ${detail}`);
    this.name = 'EndpointsInvalid';
  }
}

interface Entry {
  id: string;
  /**
   * Optional when `api` names a provider that has a default.
   *
   * `ModelEndpoint.baseUrl` has always documented "omitted uses the provider's
   * default", and this file was stricter than the type for no stated reason —
   * harmless while every endpoint was a local server that must be named, and
   * pure friction for a single hosted API whose URL is a constant.
   */
  baseUrl?: string;
  label?: string;
  /**
   * Who receives the code, for the disclosure §13 requires. **Free text, and not
   * routing** — see `api`.
   */
  provider?: string;
  /**
   * Which adapter speaks to this endpoint (§3.8).
   *
   * Absent means `openai-compatible`, which is what every endpoint got when
   * `providerId` was hardcoded here and nothing read it. So an existing file
   * keeps behaving exactly as it did.
   *
   * **Deliberately not called `provider`,** which is the obvious name and is
   * taken by the field above. Those two would differ by three characters and
   * mean unrelated things: one is a sentence shown to a person about where their
   * source code goes, free text and possibly `"Anthropic (EU)"`; this one must
   * match an adapter id exactly or nothing routes. A config where the routing
   * field looks like a label is a config where somebody writes the label and
   * wonders why their turns went to the wrong API.
   */
  api?: string;
  apiKey?: string;
}

/**
 * The adapters an endpoint may name, checked when the file is read.
 *
 * Refused rather than tolerated, which is the opposite of what `ProviderRouter`
 * does with the same value, and the two are consistent because they know
 * different things. Here the whole set is in hand and a typo can be answered
 * with the list — the same reasoning the `id`/`baseUrl` check above states, that
 * "a typo that silently drops an endpoint sends the turn somewhere else instead
 * of failing", and sending source code to the wrong vendor is the worst version
 * of somewhere else (§13). The router receives endpoints from anywhere, including
 * files written by an older build, and must not turn an unknown id into a
 * session that cannot start. Refuse where the remedy can be named; tolerate
 * where it cannot.
 */
const KNOWN_APIS = new Set([OPENAI_COMPATIBLE_PROVIDER_ID, ANTHROPIC_PROVIDER_ID]);

export function endpointsPath(): string {
  // Through `machineRoot` rather than joined here, so the machine's install area
  // has one definition and nothing can drift into computing a workspace path by
  // accident now that the two names are the same (§5.1).
  return join(machineRoot(), 'endpoints.json');
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
/**
 * The URL a provider uses when the file names none.
 *
 * Only for adapters where there is one right answer. `openai-compatible` has
 * none by design — the whole point of that adapter is that it is pointed at
 * whatever is running — so an entry using it still has to say where.
 */
function defaultBaseUrlFor(api: string | undefined): string | undefined {
  return api === ANTHROPIC_PROVIDER_ID ? 'https://api.anthropic.com/v1' : undefined;
}

function baseUrlFor(entry: Entry): string | undefined {
  return entry.baseUrl ?? defaultBaseUrlFor(entry.api);
}

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
  /** The order to try, in order. Empty on a machine that declared none. */
  let chain: string[] = [];

  let text = await readIfPresent(path);
  if (text === null && legacy !== null) {
    text = await readIfPresent(legacy);
    if (text !== null) path = legacy; // so a parse error names the file actually read
  }

  if (text === null) {
    entries = [fallback()];
    fallbackId = entries[0]!.id;
  } else {
    let parsed: { endpoints?: Entry[]; default?: string; fallback?: string[] };
    try {
      parsed = JSON.parse(text) as typeof parsed;
    } catch (err) {
      throw new EndpointsInvalid(path, (err as Error).message);
    }
    if (!Array.isArray(parsed.endpoints) || parsed.endpoints.length === 0) {
      throw new EndpointsInvalid(path, 'expected { "endpoints": [ … ] } with at least one entry');
    }
    for (const entry of parsed.endpoints) {
      if (typeof entry?.id !== 'string') {
        // Refused rather than skipped: a typo that silently drops an endpoint
        // sends the turn somewhere else instead of failing.
        throw new EndpointsInvalid(path, 'each endpoint needs an "id"');
      }
      if (entry.api !== undefined && !KNOWN_APIS.has(entry.api)) {
        throw new EndpointsInvalid(
          path,
          `endpoint "${entry.id}" names api "${entry.api}", which nothing here speaks — ` +
            `known: ${[...KNOWN_APIS].join(', ')}`,
        );
      }
      if (typeof entry.baseUrl !== 'string' && defaultBaseUrlFor(entry.api) === undefined) {
        // Only the endpoints with nowhere to default to. A hosted API's URL is a
        // constant and making somebody retype it is how a typo gets introduced.
        throw new EndpointsInvalid(path, `endpoint "${entry.id}" needs a "baseUrl"`);
      }
    }
    entries = parsed.endpoints;
    fallbackId = parsed.default ?? entries[0]!.id;
    if (!entries.some((e) => e.id === fallbackId)) {
      throw new EndpointsInvalid(path, `"default" names ${fallbackId}, which is not in the list`);
    }
    /*
     * Every name in the chain has to be an endpoint, checked here for the same
     * reason `default` is: a chain that names a typo silently ends one step
     * early, so a turn that should have moved to the local server stops instead
     * — and the failure looks like the fallback not working rather than like a
     * misspelled id.
     */
    for (const id of parsed.fallback ?? []) {
      if (!entries.some((e) => e.id === id)) {
        throw new EndpointsInvalid(
          path,
          `"fallback" names ${id}, which is not in the list — available: ${entries.map((e) => e.id).join(', ')}`,
        );
      }
    }
    chain = parsed.fallback ?? [];
  }

  const build = (entry: Entry): ModelEndpoint => ({
    endpointId: entry.id,
    /*
     * Read from the file at last (§3.8, §15 Phase 3).
     *
     * This was the constant `OPENAI_COMPATIBLE_PROVIDER_ID`, which was true of
     * every endpoint and hid a hole: a second adapter and a router that
     * dispatches on `providerId` are both useless while nothing can produce an
     * endpoint that names one. The abstraction was validated and unreachable.
     */
    providerId: entry.api ?? OPENAI_COMPATIBLE_PROVIDER_ID,
    ...(baseUrlFor(entry) !== undefined ? { baseUrl: baseUrlFor(entry)! } : {}),
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
        // The resolved one, not the written one. A picker showing an empty URL
        // for an endpoint that has a perfectly good default would read as
        // misconfigured, and §13's requirement is that a client can *say* where
        // a turn went.
        baseUrl: baseUrlFor(entry) ?? '',
        authenticated: entry.apiKey !== undefined,
      })),
    /**
     * The next endpoint in the declared order, or nothing.
     *
     * Three answers, and the two that are `undefined` mean different things to a
     * reader even though the caller treats them the same: an endpoint the chain
     * does not name has no successor because nobody said what should follow it,
     * and the last entry has none because there is nothing after it. Neither is
     * an error — a machine with one model server is the ordinary case, and
     * inventing an order nobody wrote is how a turn ends up at a vendor the
     * person did not choose (§13).
     *
     * Not filtered by reachability. Whether the next one answers is a fact about
     * this minute, and finding out means a request; this returns where to look
     * and the caller finds out by asking.
     */
    nextAfter: (endpointId) => {
      const at = chain.indexOf(endpointId);
      if (at === -1) return undefined;
      return chain[at + 1];
    },
    // A copy, because the caller sends this over a wire and a returned
    // reference to the array `nextAfter` indexes is one splice away from a
    // routing table edited by a display.
    chain: () => [...chain],
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
  /**
   * Which adapter speaks to it. Absent means `openai-compatible`.
   *
   * Validated here rather than trusted: this is the one route that writes an
   * endpoint without anybody reading the file afterwards, so an unknown value
   * would sit there until a turn was sent to it.
   */
  api?: string;
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
  if (input.api !== undefined && input.api !== '' && !KNOWN_APIS.has(input.api)) {
    /*
     * The same refusal `loadEndpoints` makes, at the other door.
     *
     * This route writes an endpoint that nobody reads back first, so an unknown
     * adapter would sit in the file until a turn was sent to it — and then fall
     * through the router to `openai-compatible`, which means source code going
     * to an API the person did not name (§13). Refused here for the same reason
     * it is refused there: the whole set is in hand, so the remedy can be named.
     */
    throw new EndpointRejected(
      `"${input.api}" is not an API this host speaks — known: ${[...KNOWN_APIS].join(', ')}`,
    );
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
  // Read before the write, so `default` and `fallback` survive it. See
  // `readSettings` for what happened when they did not.
  const settings = await readSettings(path);
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
    // Absent stays absent, so an entry written by the app reads the same as one
    // typed by hand with no `api` — both mean `openai-compatible`.
    ...(input.api !== undefined && input.api !== '' ? { api: input.api } : {}),
  };

  await writeFile(
    path,
    `${JSON.stringify({ ...settings, endpoints: [...existing, entry] }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await restrictToOwner(path, 'model API keys');

  return { endpointId: entry.id, path, authenticated: entry.apiKey !== undefined };
}

/**
 * Set the order this machine tries its endpoints in (§3.8, §3.9, §13).
 *
 * ## Why this needed a command at all
 *
 * The order has been enforced end to end for some time — `nextAfter` answers it,
 * `askWithFailover` walks it, and a move writes `model.endpoint_switched` into
 * the transcript with the reason it moved. What there was no way to do was *set*
 * it. `endpoints.add` was the only endpoint write on the wire, so the order
 * every turn on a machine follows could be changed in exactly one way: by
 * editing `endpoints.json` on the machine itself, which for the remote GPU box
 * this feature exists for means opening an ssh session to hand-edit JSON.
 *
 * A mechanism that works and cannot be reached is §16's shape, and this one had
 * the extra sting of being invisible: nothing in the app said which endpoint was
 * first, so somebody whose turns had moved to a second provider could not see
 * the order that sent them there.
 *
 * ## One list, where the file has two fields
 *
 * The file carries `default` — where a turn starts when nothing names an
 * endpoint — and `fallback`, which is the **whole order to try** with the
 * default as its first name. A file may legally set a `default` that is absent
 * from `fallback`, and that combination is a trap: `nextAfter` finds the
 * starting endpoint nowhere in the chain and answers `undefined`, so the one
 * endpoint every turn begins on is the one endpoint failover never leaves.
 *
 * So this command takes the order and derives both, which makes that state
 * unreachable through the app. Hand-editing the file still reaches everything it
 * always did; what the app offers is the coherent subset, and a `default` that
 * cannot fall back is not something anybody is choosing on purpose.
 *
 * A single name is meaningful and is not a mistake: start here, and stay here.
 * That is the ordinary shape of a machine with one model server.
 *
 * ## Every name is checked against the list
 *
 * The same rule `loadEndpoints` applies on read, applied where somebody can
 * still fix it rather than at the next session start. A chain naming a typo does
 * not fail loudly — it ends one step early, so a turn that should have moved to
 * the local server stops instead, and the failure looks like the fallback not
 * working rather than like a misspelling.
 *
 * ## What this deliberately cannot do
 *
 * It writes ids and nothing else. No credential, no `baseUrl`, no provider — so
 * ordering endpoints can never be a route to changing what one of them *is*,
 * which is the quiet change of recipient §13 forbids. Adding and reordering stay
 * separate commands for that reason.
 */
export async function setChain(
  /** The order to try, most preferred first. Never empty. */
  order: string[],
  path = endpointsPath(),
): Promise<{ path: string; default: string; fallback: string[] }> {
  const existing = await readEntries(path);
  const known = new Set(existing.map((e) => e.id));
  const names = existing.map((e) => e.id).join(', ');

  if (order.length === 0) {
    // Refused rather than treated as "clear it". An empty order would leave
    // `default` naming nothing, and `loadEndpoints` would then fall back to
    // `entries[0]` — a different endpoint, chosen by file position rather than
    // by anybody, which is §13's quiet change of recipient.
    throw new EndpointRejected('an endpoint order needs at least one endpoint in it');
  }

  const seen = new Set<string>();
  for (const id of order) {
    if (!known.has(id)) {
      throw new EndpointRejected(`"${id}" is not an endpoint on this machine — available: ${names}`);
    }
    if (seen.has(id)) {
      // Either a mistake or a request to ask a refusing endpoint twice. Not
      // worth guessing between, and cheap to say.
      throw new EndpointRejected(`"${id}" appears twice in the order`);
    }
    seen.add(id);
  }

  /*
   * The same read-then-merge `addEndpoint` does, and for the same recorded
   * reason: a write of only the fields this command owns deletes whatever else
   * is in the file. There it was `default` being lost by an add; here it would
   * be the entries themselves.
   */
  const settings = await readSettings(path);
  const chosen = { default: order[0]!, fallback: order };
  await writeFile(
    path,
    `${JSON.stringify({ ...settings, endpoints: existing, ...chosen }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await restrictToOwner(path, 'model API keys');

  return { path, ...chosen };
}

/**
 * Everything in the file except the entries, so a write does not discard it.
 *
 * **`addEndpoint` used to write `{ endpoints: [...] }` and nothing else**, so
 * adding an endpoint through the app silently deleted `default` — and then
 * `loadEndpoints` fell back to `entries[0]`, which is a *different endpoint*.
 * Every turn afterwards went somewhere the person had not chosen, with nothing
 * anywhere saying the default had moved. That is precisely the quiet change of
 * recipient §13 forbids, produced by the one command written to avoid making
 * people edit this file by hand.
 *
 * It survived because the test asserting "the endpoints that were already in
 * force survive the write" checked the *entries*, and the fields beside them are
 * what decide which entry is used.
 *
 * Returned as a whole object rather than field by field: the next thing added to
 * this file should be preserved by having been written, not by somebody
 * remembering to add it here too.
 */
async function readSettings(path: string): Promise<Record<string, unknown>> {
  const text =
    (await readIfPresent(path)) ??
    (path === endpointsPath() ? await readIfPresent(legacyEndpointsPath()) : null);
  if (text === null) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const { endpoints: _entries, ...rest } = parsed;
    return rest;
  } catch {
    // A malformed file is reported by `readEntries` below, which parses it too.
    return {};
  }
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
