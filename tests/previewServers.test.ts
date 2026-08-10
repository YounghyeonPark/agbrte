/**
 * Running the dev server ourselves (DESIGN.md §6.8, §3.12).
 *
 * §3.12 records somebody else's constraint: a CLI harness reaps what its run
 * started, shortly after the run returns. An agent that helpfully backgrounds
 * `npm run dev` therefore produces a server that lasts until you switch windows,
 * and the failure looks like the port dying on its own. So §6.8 says preview
 * servers are started by *us*.
 *
 * Real child processes here rather than fakes, because the properties worth
 * asserting — that a grandchild dies, that a crash leaves its output behind —
 * are properties of process trees and not of a mock. That is also what caught
 * the Windows kill being wrong.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { until } from './support/until.js';
import { LOG_LINES, PreviewServerRefused, PreviewServers } from '@main/preview/servers.js';

const roots: string[] = [];
const fleets: PreviewServers[] = [];

afterEach(async () => {
  for (const servers of fleets.splice(0)) servers.stopAll();
  // A moment for the kills to land before the directory goes, or Windows
  // refuses to remove a folder a dying process still has open.
  await new Promise((r) => setTimeout(r, 300));
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

async function workspace(): Promise<{ root: string; servers: PreviewServers }> {
  const root = await mkdtemp(join(tmpdir(), 'agbrte-preview-srv-'));
  roots.push(root);
  const servers = new PreviewServers(root);
  fleets.push(servers);
  return { root, servers };
}

/**
 * A script on disk, run as `node <path>`.
 *
 * Not `node -e '…'`: a one-liner has to survive `cmd.exe` on Windows and `sh`
 * elsewhere, and the escaping differs enough that the first version of these
 * tests was measuring my quoting rather than the supervisor. A file is also
 * closer to what a real preview command is.
 */
async function script(root: string, name: string, body: string): Promise<string> {
  const path = join(root, name);
  await writeFile(path, body, 'utf8');
  return `node "${path}"`;
}

const FOREVER = 'setInterval(() => {}, 1000);';

describe('it belongs to the host, not to a turn', () => {
  it('keeps a server running past the call that started it', async () => {
    const { root, servers } = await workspace();
    const cmd = await script(root, 'up.js', `console.log('listening on 3000');\n${FOREVER}`);
    const started = servers.start('s1', cmd);

    expect(started.pid).toBeGreaterThan(0);
    await until(() => (servers.log(started.id)?.lines ?? []).some((l) => l.includes('listening')));
    // Still running, with nothing holding it open but the supervisor.
    expect(servers.list('s1')[0]?.exit).toBeNull();
  }, 30_000);

  it('refuses an empty command rather than spawning a shell', async () => {
    const { servers } = await workspace();
    expect(() => servers.start('s1', '   ')).toThrow(PreviewServerRefused);
  });

  it('does not start the same command twice in one session', async () => {
    // Two servers racing for one port produce `EADDRINUSE`, which points at
    // neither of them.
    const { root, servers } = await workspace();
    const cmd = await script(root, 'twice.js', FOREVER);
    const first = servers.start('s1', cmd);
    const second = servers.start('s1', cmd);
    expect(second.id).toBe(first.id);
    expect(servers.list('s1')).toHaveLength(1);
  }, 30_000);
});

describe('the log is the answer to “nothing is listening”', () => {
  it('keeps what a server said before it died', async () => {
    /**
     * §6.8 reports an unreachable forward rather than refusing it, because a
     * server still compiling looks identical to one that will never answer. That
     * is only humane if the difference is findable, and it is findable in the
     * output — a dev server that died on a syntax error said so, and nobody was
     * reading.
     */
    const { root, servers } = await workspace();
    const cmd = await script(
      root,
      'crash.js',
      `console.error('Error: listen EADDRINUSE 0.0.0.0:3000');\nprocess.exit(1);\n`,
    );
    const dead = servers.start('s1', cmd);

    await until(() => servers.list('s1')[0]?.exit !== null, 15_000);
    expect(servers.log(dead.id)?.lines.join('\n')).toContain('EADDRINUSE');
    // The record survives the exit: two seconds after a crash is exactly when
    // the last lines matter most.
    expect(servers.list('s1')[0]?.exit?.code).toBe(1);
  }, 30_000);

  it('shows a line that has not been finished yet', async () => {
    // Most dev servers print progress without a trailing newline while starting,
    // which is the moment there is most to see.
    const { root, servers } = await workspace();
    const cmd = await script(root, 'partial.js', `process.stdout.write('compiling...');\n${FOREVER}`);
    const s = servers.start('s1', cmd);
    await until(() => (servers.log(s.id)?.lines ?? []).some((l) => l.includes('compiling')));
  }, 30_000);

  it('keeps the end rather than the beginning, and says how much it dropped', async () => {
    // A dev server left up for a day produces a great deal of nothing in
    // particular, and the interesting part is always the end.
    const { root, servers } = await workspace();
    const many = LOG_LINES + 50;
    const cmd = await script(
      root,
      'chatty.js',
      `for (let i = 0; i < ${many}; i++) console.log('line ' + i);\n${FOREVER}`,
    );
    const s = servers.start('s1', cmd);

    await until(() => (servers.log(s.id)?.dropped ?? 0) > 0, 20_000);
    const log = servers.log(s.id)!;
    expect(log.lines.length).toBeLessThanOrEqual(LOG_LINES + 1);
    expect(log.lines.join('\n')).toContain(`line ${many - 1}`);
    expect(log.lines).not.toContain('line 0');
    expect(log.dropped).toBeGreaterThan(0);
  }, 40_000);

  it('reports a command that could not start at all', async () => {
    const { servers } = await workspace();
    const s = servers.start('s1', 'definitely-not-a-real-binary-xyz');
    await until(() => servers.list('s1')[0]?.exit !== null, 15_000);
    // Whether it arrives as an `error` event or as the shell's stderr depends on
    // the platform; what matters is that the user gets *something* rather than a
    // server that silently never existed.
    expect(servers.log(s.id)?.lines.join('\n').trim()).not.toBe('');
  }, 30_000);
});

describe('stopping reaches the process that holds the port', () => {
  it('kills a grandchild, not just the child', async () => {
    /**
     * The failure this exists for, and the one that made the first
     * implementation wrong on Windows.
     *
     * `npm run dev` is npm, which spawns node, which holds the port. Killing npm
     * leaves node running and the port bound, and the next start fails with
     * `EADDRINUSE` for a server the user believes they stopped. On POSIX the
     * answer is signalling the process group; on Windows `detached` creates a
     * console rather than a group, `child.kill()` reaches only the `cmd.exe` that
     * `shell: true` started, and the grandchild survives — which is exactly what
     * this test reported before `taskkill /T` replaced it.
     *
     * The grandchild writes a file every 100 ms, so "did it die" is answerable
     * from outside the process tree rather than by asking the tree.
     */
    const { root, servers } = await workspace();
    const marker = join(root, 'alive.txt');
    await writeFile(
      join(root, 'inner.js'),
      `const fs = require('node:fs');\n` +
        `setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 100);\n`,
      'utf8',
    );
    const cmd = await script(
      root,
      'outer.js',
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(join(root, 'inner.js'))}], { stdio: 'ignore' });\n` +
        FOREVER,
    );

    const parent = servers.start('s1', cmd);
    await until(
      async () => {
        try {
          return (await readFile(marker, 'utf8')) !== '';
        } catch {
          return false;
        }
      }, 20_000,
    );

    const before = await readFile(marker, 'utf8');
    expect(servers.stop(parent.id)).toBe(true);

    // Long enough for the kill to land and for several writes to have happened
    // if it did not.
    await new Promise((r) => setTimeout(r, 1_500));
    const after = await readFile(marker, 'utf8');
    expect(after, 'the grandchild was never alive, so this proves nothing').not.toBe(before);

    await new Promise((r) => setTimeout(r, 800));
    const later = await readFile(marker, 'utf8');
    expect(later, 'the grandchild outlived the kill and still holds the port').toBe(after);
  }, 60_000);

  it('stops everything a session started', async () => {
    const { root, servers } = await workspace();
    const a = await script(root, 'a.js', FOREVER);
    const b = await script(root, 'b.js', FOREVER);
    servers.start('s1', a);
    servers.start('s1', b);
    servers.start('s2', a);

    expect(servers.stopSession('s1')).toBe(2);
    await until(() => servers.list('s1').every((s) => s.exit !== null), 20_000);
    // And not the neighbour's.
    expect(servers.list('s2')[0]?.exit).toBeNull();
  }, 40_000);

  it('is a no-op for something already gone', async () => {
    const { root, servers } = await workspace();
    const cmd = await script(root, 'quick.js', 'process.exit(0);\n');
    const s = servers.start('s1', cmd);
    await until(() => servers.list('s1')[0]?.exit !== null, 15_000);
    expect(servers.stop(s.id)).toBe(true); // found, already dead
    expect(servers.stop('preview-999')).toBe(false);
    expect(servers.forget(s.id)).toBe(true);
    expect(servers.list('s1')).toHaveLength(0);
  }, 30_000);

  it('will not forget something still running', async () => {
    // Dropping the record of a live process would leave it running with nothing
    // holding its handle — unkillable through this API, and invisible.
    const { root, servers } = await workspace();
    const cmd = await script(root, 'live.js', FOREVER);
    const s = servers.start('s1', cmd);
    expect(servers.forget(s.id)).toBe(false);
    expect(servers.list('s1')).toHaveLength(1);
  }, 30_000);
});
