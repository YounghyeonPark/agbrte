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
 * A fixture script on disk.
 *
 * **`.cjs`, and the extension is the entire point.** These fixtures live under
 * `os.tmpdir()`, and Node decides whether a `.js` file is CommonJS or ESM by
 * walking *up* from it to the nearest `package.json` — through directories this
 * test does not own, did not create, and cannot see. One stray
 * `{"type": "module"}` anywhere above the temp directory silently turns every
 * fixture here into an ES module, at which point `require` is not defined and
 * the script dies on line 1, before doing the thing the test is about.
 *
 * Not hypothetical. A copy of this project's own `package.json` sat in `%TEMP%`
 * on a developer machine for three days and broke exactly one test in a suite of
 * 1442 — the grandchild test below, the only one whose fixture used `require`.
 * It failed identically on a clean tree, because the cause was not in the tree.
 * `.cjs` states what the file is *in the file*, so nothing above it gets a vote;
 * `mcp.test.ts` reached the same conclusion earlier and this is why.
 *
 * Everything goes through here rather than through a bare `writeFile` so the
 * rule is structural: there is no way to add a fixture and forget.
 */
async function fixture(root: string, name: string, body: string): Promise<string> {
  const path = join(root, `${name}.cjs`);
  await writeFile(path, body, 'utf8');
  return path;
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
  return `node "${await fixture(root, name, body)}"`;
}

const FOREVER = 'setInterval(() => {}, 1000);';

describe('it belongs to the host, not to a turn', () => {
  it('keeps a server running past the call that started it', async () => {
    const { root, servers } = await workspace();
    const cmd = await script(root, 'up', `console.log('listening on 3000');\n${FOREVER}`);
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
    const cmd = await script(root, 'twice', FOREVER);
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
      'crash',
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
    const cmd = await script(root, 'partial', `process.stdout.write('compiling...');\n${FOREVER}`);
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
      'chatty',
      `for (let i = 0; i < ${many}; i++) console.log('line ' + i);\n${FOREVER}`,
    );
    const s = servers.start('s1', cmd);

    // Wait for the *last* line, not for dropping to have started. The first
    // version waited on `dropped > 0`, which becomes true while the process is
    // still writing — so it asserted on a log that was two hundred lines short.
    // It passed on a fast run and failed on a slow one, which is the worst rate.
    await until(
      () => (servers.log(s.id)?.lines ?? []).some((l) => l.includes(`line ${many - 1}`)),
      20_000,
    );
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
    const inner = await fixture(
      root,
      'inner',
      `const fs = require('node:fs');\n` +
        `setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 100);\n`,
    );
    const cmd = await script(
      root,
      'outer',
      `require('node:child_process').spawn(process.execPath, [${JSON.stringify(inner)}], { stdio: 'ignore' });\n` +
        FOREVER,
    );

    const parent = servers.start('s1', cmd);
    const stamp = async (): Promise<string> => {
      try {
        return await readFile(marker, 'utf8');
      } catch {
        return '';
      }
    };

    /**
     * What the parent said, for a wait that runs out.
     *
     * The supervisor has been collecting the parent's output all along — that is
     * its whole job — so a timeout here can quote the reason instead of naming
     * the timer. It cost three days not to: `condition never held within
     * 20000ms` at line 236 was read as "the kill is broken on Windows", when
     * `outer` had died instantly with a `ReferenceError` that was sitting in
     * `servers.log(parent.id)` the entire time, one call away.
     */
    const parentSaid = (): string => {
      const record = servers.list('s1').find((s) => s.id === parent.id);
      const said = servers.log(parent.id)?.lines.join('\n').trim() ?? '';
      return [
        `the grandchild never wrote ${marker}.`,
        `parent pid=${String(record?.pid)} exit=${JSON.stringify(record?.exit)}`,
        said === '' ? 'parent said nothing at all' : `parent said:\n${said}`,
      ].join('\n');
    };

    /**
     * Liveness is established by *waiting for it*, not by sleeping and hoping.
     *
     * The first version read the marker once, slept, read again and asserted it
     * had changed — which on a loaded CI runner meant asserting the grandchild
     * had got going inside a window it had not. The guard caught that rather
     * than passing vacuously, which is the guard working and the wait being
     * wrong. Waiting for the value to *change* proves the writer is running,
     * whatever the machine's mood.
     */
    await until(async () => (await stamp()) !== '', 20_000, parentSaid);
    const first = await stamp();
    await until(async () => (await stamp()) !== first, 20_000, parentSaid);

    expect(servers.stop(parent.id)).toBe(true);

    /**
     * A sleep is right *here* and nowhere else in this test: the claim is that
     * nothing happens for a while, and there is no fact to poll for. An absence
     * only means something if you waited.
     *
     * The marker is **deleted** rather than merely re-read. "The contents
     * stopped changing" is a weaker claim than it looks — a writer that is
     * merely descheduled, or one whose clock has not ticked, satisfies it too,
     * so the test could pass with the grandchild alive and still on the port. A
     * writer that is actually running recreates this file within 100 ms; one
     * that is gone never does. That is the invariant the port cares about: no
     * descendant of the killed process survived, whatever the mechanism that was
     * supposed to reach it.
     */
    await new Promise((r) => setTimeout(r, 1_500));
    await rm(marker, { force: true, maxRetries: 5, retryDelay: 50 });

    await new Promise((r) => setTimeout(r, 1_000));
    expect(await stamp(), 'the grandchild outlived the kill and still holds the port').toBe('');
  }, 60_000);

  it('stops everything a session started', async () => {
    const { root, servers } = await workspace();
    const a = await script(root, 'a', FOREVER);
    const b = await script(root, 'b', FOREVER);
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
    const cmd = await script(root, 'quick', 'process.exit(0);\n');
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
    const cmd = await script(root, 'live', FOREVER);
    const s = servers.start('s1', cmd);
    expect(servers.forget(s.id)).toBe(false);
    expect(servers.list('s1')).toHaveLength(1);
  }, 30_000);
});
