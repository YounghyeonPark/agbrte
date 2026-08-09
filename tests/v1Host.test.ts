/**
 * Today's client against a host built before any of this existed.
 *
 * The synthetic tests in `sessionHost.test.ts` fake the old host's `welcome`.
 * This one spawns the real thing: `agbrteHost.js` compiled from c1448e0, the
 * commit before §6.7 added a command — a genuine v1 host that has never heard of
 * `blob.put`, `minProtocol`, or a `protocol` field in `hello`.
 *
 * The claim under test is the one that makes the fix deployable rather than a
 * plan: **the old host needs no change.** If that holds, the negotiation works
 * against every host already running in the field.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectOrSpawnHost } from '@main/host/connectOrSpawn.js';
import { CommandUnavailable, type HostConnection } from '@main/host/hostConnection.js';
import { openWorkspace } from '@main/store/identity.js';
import type { SessionId } from '@shared/types/index.js';

/**
 * A host bundle built from before §6.7, produced by hand:
 *
 *   git worktree add <dir>/v1 c1448e0
 *   (cd <dir>/v1 && node scripts/build.mjs)
 *   AGBRTE_V1_HOST=<dir>/v1/dist/main/agbrteHost.js npm run test
 *
 * Skipped when it is absent, and **loudly** — the suite must not read as having
 * checked this when it has not. Kept rather than run once and deleted because
 * the claim it proves is the one that makes the fix deployable, and the next
 * protocol change should be able to re-run it against a real old host rather
 * than against a `welcome` a test wrote itself.
 */
const V1_HOST = process.env['AGBRTE_V1_HOST'] ?? '';
const HAVE_V1 = V1_HOST !== '' && existsSync(V1_HOST);

if (!HAVE_V1) {
  // eslint-disable-next-line no-console
  console.warn(
    'v1Host.test.ts: skipped — no AGBRTE_V1_HOST bundle. See the comment above ' +
      'to build one; the synthetic version of these checks lives in sessionHost.test.ts.',
  );
}

let root: string;
const open: HostConnection[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agbrte-v1-'));
  await openWorkspace(root);
});
afterEach(async () => {
  for (const c of open.splice(0)) c.disconnect();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

async function connectV1(): Promise<HostConnection> {
  const c = await connectOrSpawnHost({
    workspaceRoot: root,
    hostEntry: V1_HOST,
    execPath: process.execPath,
  });
  open.push(c);
  return c;
}

describe.skipIf(!HAVE_V1)('a v1 host, spawned for real', () => {
  it('accepts a client that speaks v2 and says it is v1', async () => {
    // Under the old equality check this threw `HostProtocolMismatch` and the
    // connection closed. It is the case that stranded every running host.
    const c = await connectV1();
    const identity = await c.ready;

    expect(identity.protocol).toBe(1);
    // It has never heard of the field, so it does not send it — and the client
    // reads that silence as 1, which is true of it.
    expect(identity.minProtocol).toBeUndefined();
  }, 30_000);

  it('does everything it always did', async () => {
    // The point of not refusing: an older host is missing one command, not
    // broken. A session created and listed here is the whole ordinary path.
    const c = await connectV1();
    await c.ready;

    await c.createSession({ title: 'across versions', goal: 'g' });
    expect((await c.list()).map((s) => s.title)).toContain('across versions');
  }, 30_000);

  it('declines the one command it does not have, naming the remedy', async () => {
    const c = await connectV1();
    await c.ready;

    expect(c.supports('blob.put')).toBe(false);
    expect(c.supports('session.send')).toBe(true);

    const session = await c.createSession({ title: 's', goal: 'g' });
    await expect(
      c.putBlob(session.sessionId as SessionId, Buffer.from('a screenshot'), 'image/png'),
    ).rejects.toThrow(CommandUnavailable);
  }, 30_000);

  it('can be asked to shut down politely, which is the whole point', async () => {
    /**
     * The failure that turned this from a tidiness question into a real one.
     * On the server, `agbrte stop` spoke v2 at a v1 host and was refused at the
     * handshake — so the polite shutdown could not reach the host it existed to
     * retire, and upgrading meant `kill`.
     */
    const c = await connectV1();
    await c.ready;

    await expect(c.requestShutdown()).resolves.toMatchObject({ stopped: true });
  }, 30_000);
});
