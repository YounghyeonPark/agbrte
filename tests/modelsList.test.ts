/**
 * Asking a host what its endpoints serve (DESIGN.md §3.8).
 *
 * The provider could always answer this — `listModels` has existed on
 * `ModelProvider` and been implemented against `/v1/models` — and nothing ever
 * called it. So the model field was free text: you typed a name and found out
 * whether it existed when the turn failed.
 *
 * These drive a real host process over a real socket, because the value of the
 * feature is entirely in the wiring between four layers, and an in-memory double
 * of any one of them would test the double.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import type { HostConnection } from '@main/host/hostConnection.js';


const HOST_BUNDLE = resolve(import.meta.dirname, '../dist/main/agbrteHost.js');

let root: string;
const open: HostConnection[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-models-'));
});

afterEach(async () => {
  for (const c of open.splice(0)) {
    try {
      await c.requestShutdown();
    } catch {
      // already gone
    }
    c.disconnect();
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function built(): Promise<boolean> {
  try {
    await access(HOST_BUNDLE);
    return true;
  } catch {
    return false;
  }
}

describe('a host answers what its endpoints serve', () => {
  it('returns one entry per endpoint, and says which failed', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);

    const connection = await connectOrSpawnHost({
      workspaceRoot: root,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(connection);
    const identity = await connection.ready;

    // The command exists at this protocol version, which is the thing a client
    // checks before offering the control at all.
    expect(connection.supports('models.list')).toBe(true);

    const answers = await connection.models();

    // One answer per endpoint the host reported at handshake — including the
    // ones that could not be reached, which is the whole reason the result
    // carries an `error` instead of the call rejecting.
    expect(answers.map((a) => a.endpointId).sort()).toEqual(
      (identity.endpoints ?? []).map((e) => e.id).sort(),
    );

    for (const answer of answers) {
      expect(Array.isArray(answer.models)).toBe(true);
      // Either it listed models or it said why it could not. Never both empty
      // and silent, which is the shape that reads as "this machine has none".
      expect(
        answer.models.length > 0 || answer.error !== undefined,
        `${answer.endpointId} returned nothing and gave no reason`,
      ).toBe(true);

      // The v14 field. Absent is a legitimate answer — nothing here
      // self-describes, or a model was past the host's describe limit — and
      // every hint that *is* present belongs to a model that was listed.
      for (const hint of answer.capabilities ?? []) {
        expect(answer.models).toContain(hint.modelId);
        expect(hint.endpointId).toBe(answer.endpointId);
      }
    }
  }, 60_000);

  /**
   * The expensive half, across the same four layers (§3.3).
   *
   * The point of running it here rather than against the provider directly is
   * the wiring: a hint has to survive `models.capabilities` → session host →
   * agent host → provider and come back with its confidence labels intact, and
   * an in-memory double of any of those would be testing the double.
   *
   * The model is one nobody has: an unreachable or unknown model must come back
   * as **unknown with a reason**, never as a model that cannot call tools. That
   * distinction is the whole feature — one sends you to pull a model, the other
   * sends you to pick a different one.
   */
  it('answers per model, and says unknown rather than no when it cannot tell', async () => {
    if (!(await built())) throw new Error(`run \`npm run build\` first — ${HOST_BUNDLE} is missing`);

    const connection = await connectOrSpawnHost({
      workspaceRoot: root,
      hostEntry: HOST_BUNDLE,
      execPath: process.execPath,
      startupTimeoutMs: 20_000,
    });
    open.push(connection);
    const identity = await connection.ready;

    expect(connection.supports('models.capabilities')).toBe(true);

    const endpointId = (identity.endpoints ?? [])[0]?.id;
    expect(endpointId, 'a host reports at least one endpoint').toBeDefined();
    if (endpointId === undefined) return;

    const hint = await connection.modelCapabilities(endpointId, 'agbrte-no-such-model');

    expect(hint.endpointId).toBe(endpointId);
    expect(hint.modelId).toBe('agbrte-no-such-model');
    // Nothing could be established about a model that is not there.
    expect(hint.tools).toBeUndefined();
    expect(hint.error, 'a hint that establishes nothing must say why').toBeDefined();
    // What is knowable without asking anything stays knowable: this adapter
    // flattens an image whatever the model could do (§3.13).
    expect(hint.imageInput).toEqual({ value: false, from: 'configured' });
  }, 60_000);
});
