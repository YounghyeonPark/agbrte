import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(here, 'src/shared'),
      '@main': resolve(here, 'src/main'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    /*
     * Longer than vitest's 5s default, for two reasons that compound.
     *
     * **This suite runs its files in parallel on purpose**, which CLAUDE.md
     * states and which has caught a real bug — two hosts sharing one socket.
     * The cost is that any one test may be sharing a machine with a dozen
     * others, and 5s is sized for a test that touches nothing. Several here
     * start real subprocesses, open real sockets and build real workspaces; on
     * a loaded developer machine a *different one* timed out on each of three
     * consecutive runs, every one of them passing alone in under a second.
     * Chasing that per test is chasing the machine's mood.
     *
     * **And 5s was exactly `until`'s own default**, which made the helper
     * useless at the moment it was most needed: a condition that never becomes
     * true would have `until` report what it was waiting for, but the test
     * timeout fired first and every such failure arrived as a bare "Test timed
     * out" instead. That is how a wait for a condition that could never hold —
     * `JSON.stringify` of a `Map`, which is always `{}` — read as a slow test
     * rather than as a bug in the test. The gap between the two has to be wide
     * enough that the diagnosis wins the race.
     *
     * Not so long that a genuine hang is slow to find: a hung test fails at 20s
     * instead of 5s, and it was going to be a rerun either way.
     */
    testTimeout: 20_000,
    /*
     * The same argument for hooks, whose default is 10s.
     *
     * Several `afterEach`es here stop real servers and real hosts and then wait
     * for the kills to land, because Windows will not remove a directory a dying
     * process still holds open. That is teardown for work the test did, on the
     * same loaded machine, and a hook that times out fails a test whose
     * assertions all passed — which is the most misleading red there is.
     */
    hookTimeout: 20_000,
    // Suite-wide defaults for the processes tests start but do not own — see the
    // file, which is one assignment and a long explanation of why it is there.
    setupFiles: [resolve(here, 'tests/support/setup.ts')],
  },
});
