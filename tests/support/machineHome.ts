/**
 * A machine directory of one's own (DESIGN.md §8).
 *
 * `~/.agbrte` holds what is true of a *machine*: its id, its host record, its
 * workspace registry, its credentials. A host is one per machine and its socket
 * is named from the id in that directory — so two processes sharing the
 * directory share the host, by design and correctly.
 *
 * That design is what makes it unusable as a default in a test suite. Every file
 * that starts a real host would be starting *the same* host, and worse, every
 * test that asserts a **refusal** — a stale socket with nothing behind it, a
 * replacement that cannot come up — would be handed a perfectly good host that
 * another file left lingering. Which is exactly what happened: a release build
 * failed on all three platforms while the developer's machine, which had a host
 * up from ordinary use, passed. CI starts clean and runs them together.
 *
 * So: one machine directory per **test**, for the suites that need one. Per test
 * because the contention is between tests as much as between files — a host from
 * the case above lingers for `AGBRTE_HOST_LINGER_MS` after the case that started
 * it has finished, and that is longer than the next case takes to begin.
 *
 * **Only where a test asserts an absence**, which is the whole of what needs it:
 * a stale socket with nothing behind it, a second host refused, a replacement
 * that cannot come up. A suite that merely *wants* a host is happy sharing the
 * one its file already has — which is what happens on a real machine, and which
 * matters here for a reason that showed up the first time this was applied
 * everywhere: one host per test is one **process** per test, each with a forked
 * agent host and each lingering afterwards, and a suite that spawns dozens more
 * processes than it needs starts failing tests that were only ever near a
 * timeout. Isolation where it is load-bearing, sharing where it is honest.
 *
 * `AGBRTE_HOME` is the lever, and it is a real capability rather than a test
 * affordance: the installer script has always read it, and two builds side by
 * side on one laptop need exactly this. See `machine.ts`.
 *
 * **Set in `process.env` because the mechanism is inheritance.** A detached host
 * is spawned with a copy of this process's environment, and the CLI copies it
 * again for a host *it* starts — so one assignment reaches every host a test
 * begins by any route, including one written next year by somebody who never
 * reads this file.
 */

import { afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Give every test in this file its own machine, and take it away afterwards.
 *
 * Call at the top level of a suite that starts a real host. The directory is
 * removed after each test; a host still lingering in it is stopped by the
 * suite's own teardown, and one that outlives that finds its own directory gone,
 * which it survives — every record it writes is a hint (§6.4).
 */
export function useOwnMachine(): void {
  let previous: string | undefined;
  let home: string | null = null;

  beforeEach(async () => {
    previous = process.env['AGBRTE_HOME'];
    home = await mkdtemp(join(tmpdir(), 'agbrte-machine-'));
    process.env['AGBRTE_HOME'] = home;
  });

  afterEach(async () => {
    // Restored rather than deleted: the file-wide default from `setup.ts` is
    // what anything outside this suite's tests should see, and leaving the
    // variable pointing at a directory that has just been removed is how a
    // stray host ends up minting a machine id nobody can find.
    if (previous === undefined) delete process.env['AGBRTE_HOME'];
    else process.env['AGBRTE_HOME'] = previous;
    if (home !== null) {
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      home = null;
    }
  });
}
