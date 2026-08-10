/**
 * A socket left by a host that died is not a host (DESIGN.md §6.4, §6.6, §17 Q9).
 *
 * `discovery.ts` states the rule for `host.json` and gives the reason: trusting a
 * file left by a dead process "would mean an app that refuses to start a host
 * because a record of a dead one exists — the classic stale-pidfile deadlock".
 * The record was made a hint. **The socket was not**, and it is a file too.
 *
 * A unix socket is unlinked only on a clean close. Kill the host, lose power, run
 * out of memory, and the path stays — after which every future host fails to bind
 * and the workspace cannot be opened again. What the user saw was "host did not
 * start listening", fifteen seconds later, naming the host rather than the
 * leftover. It had never been hit here because Windows named pipes leave no
 * filesystem entry: a bug that existed only on the machines the feature is for.
 *
 * ## Skipped on Windows, and run somewhere else instead
 *
 * There is nothing to leave behind on Windows, so these would pass by being
 * impossible rather than by being right. They were therefore also run against the
 * real module on a real Linux host — `esbuild`'d and executed there — and that
 * run is what the fixture below is shaped by.
 *
 * ## The first fixture passed while testing nothing
 *
 * It closed a server's handle in-process and assumed the path survived. It does
 * not: Node unlinks on close, so there was no stale socket, `listen` succeeded
 * for the ordinary reason, and three assertions went green over an empty
 * directory. Only the one line checking *that the fixture worked* caught it.
 * Hence a child process, killed with `SIGKILL` — the thing being modelled.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { connect, listen } from '@shared/host/socketChannel.js';

const posix = process.platform === 'win32' ? describe.skip : describe;

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) s.close();
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-stale-'));
  roots.push(root);
  return root;
}

/** Leave a socket with nothing behind it, the way a `SIGKILL` does. */
async function leaveStale(dir: string, path: string): Promise<void> {
  const runner = join(dir, 'hold.mjs');
  await writeFile(
    runner,
    `import { createServer } from 'node:net';\n` +
      `createServer(() => {}).listen(${JSON.stringify(path)}, () => console.log('ready'));\n`,
    'utf8',
  );
  const child = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((r) => child.stdout.once('data', () => r()));
  child.kill('SIGKILL');
  // The kernel does not remove the inode; only a clean close does. Waiting is
  // for the process to be reaped, not for the file to appear.
  await new Promise((r) => setTimeout(r, 200));
  if (!existsSync(path)) throw new Error('the fixture failed to leave a socket behind');
}

posix('a leftover socket is debris, not an owner', () => {
  it('clears one nothing is listening on, and serves', async () => {
    const dir = await scratch();
    const path = join(dir, 'host.sock');
    await leaveStale(dir, path);

    const server = await listen(path, () => undefined);
    servers.push(server);

    // Not merely that `listen` resolved: that a client can reach the host which
    // took over. A bind that succeeded onto a broken path would look identical.
    const channel = await connect<{ hi: true }, unknown>(path, 2_000);
    channel.close();
  }, 20_000);

  it('refuses when something is actually there, and says why', async () => {
    /**
     * §6.6's single writer, which is also §17 Q9's answer: two users sharing a
     * checkout are two writers, and this design has no merge anywhere. What was
     * missing was never the rule — it was the sentence. The second host used to
     * fail with a bind error fifteen seconds downstream of the cause.
     */
    const dir = await scratch();
    const path = join(dir, 'host.sock');
    const holder = await listen(path, () => undefined);
    servers.push(holder);

    await expect(listen(path, () => undefined)).rejects.toThrow(
      /already serving this workspace/i,
    );

    // The incumbent is untouched. A refusal that took the running host down
    // would be far worse than the deadlock it replaced.
    const channel = await connect<{ hi: true }, unknown>(path, 2_000);
    channel.close();
  }, 20_000);

  it('names a leftover it cannot remove', async () => {
    /**
     * The case this branch exists for is a *shared* machine: `/tmp` is `1777`, so
     * the directory is writable and the sticky bit still stops you unlinking
     * somebody else's socket. That needs a second uid to reproduce honestly, so
     * what is exercised here is the same code path reached the other way — a
     * directory that is not writable, with a real socket already in it.
     *
     * Order matters and is why the fixture has to work: with no socket present,
     * `listen` fails `EACCES` trying to *create* one and never reaches the unlink
     * at all. That is what the first version of this test measured.
     */
    if (process.getuid?.() === 0) return; // root defeats the permission

    const dir = await scratch();
    const path = join(dir, 'host.sock');
    await leaveStale(dir, path);
    await chmod(dir, 0o500);

    await expect(listen(path, () => undefined)).rejects.toThrow(/could not be removed/);
  }, 20_000);
});
