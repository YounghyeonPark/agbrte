/**
 * Which models this host can reach, and what it may use to reach them
 * (DESIGN.md §3.8, §6.5, §13).
 *
 * ## Why a registry rather than one endpoint
 *
 * The first version read a single `GILMOK_MODEL_BASE_URL` and built one endpoint
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
 * `~/.gilmok/` and not `.devagents/`, because `.devagents/` lives inside the
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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  return join(homedir(), '.gilmok', 'endpoints.json');
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
    baseUrl: process.env['GILMOK_MODEL_BASE_URL'] ?? 'http://127.0.0.1:11434/v1',
  };
}

export async function loadEndpoints(path = endpointsPath()): Promise<EndpointRegistry> {
  let entries: Entry[];
  let fallbackId: string;

  let text: string | null;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new EndpointsInvalid(path, (err as Error).message);
    text = null;
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
