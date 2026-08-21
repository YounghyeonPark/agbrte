import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Defaults that apply to the whole suite, set before any test runs.
 *
 * There is one thing in here, and it is about processes this suite starts that
 * it does not own.
 */

/**
 * Park a test-spawned host in seconds rather than in five minutes.
 *
 * Nine test files start a **real, detached** session host — through
 * `connectOrSpawnHost`, or by running the built CLI, which does it for them.
 * That host is detached on purpose (§6.4: it outlives the app), so finishing the
 * test does not end it; what ends it is §8's linger, and the production default
 * is `5 * 60_000` because that is the right number for a person who closed a
 * window and will be back.
 *
 * It is the wrong number for a suite that runs in 70 seconds. Every full run left
 * around three `agbrteHost.js` processes, each with an `agentHost.js` child,
 * alive for the next five minutes — so a second run inherited six, a third
 * nine, and the pile only ever drained if you stopped working for five minutes.
 * They were visible in the process table and nowhere else, and the slowdown they
 * caused got diagnosed twice as flakiness in whatever test happened to be slow
 * when the machine ran out of patience.
 *
 * Set here rather than at the nine call sites because the mechanism is
 * inheritance: `connectOrSpawnHost` copies `process.env` into the child, and the
 * CLI does the same again for a host it starts, so one assignment in this
 * process reaches every host any test starts by any route — including a test
 * written next year that nobody remembers to annotate. The e2e harness already
 * does this for the same reason and says so; this is the vitest half, which was
 * missing.
 *
 * `??=` so a developer chasing a linger bug can still pin it from the shell.
 */
process.env['AGBRTE_HOST_LINGER_MS'] ??= '2000';

/**
 * Give every test **file** its own machine directory.
 *
 * `~/.agbrte` holds what is true of a *machine*: its id, its host record, its
 * workspace registry (§8). A host is one per machine and its socket is named
 * from the id in that directory, so two processes sharing the directory share
 * the host — which is the design, and which makes the real one unusable here.
 *
 * **This was per *run*, and that was the bug.** With `--no-file-parallelism`
 * vitest still reuses a worker process, so `??=` kept the first value for every
 * file after it: one machine directory, one host, shared by the whole suite. A
 * test asserting that nothing is listening was handed a host another file had
 * left lingering, and three tests failed on all three CI platforms while the
 * developer's machine — which had a host up from ordinary use, so the same
 * contention was invisible — passed 1620 of 1620.
 *
 * So it is assigned rather than defaulted, once per file, and the ownership flag
 * is what keeps that from trampling a developer who pinned one from the shell to
 * chase a bug. A suite that starts *several* hosts wants finer than this and
 * says so: `useOwnMachine()` gives one per test.
 *
 * Set in `process.env` for the same reason the linger is: the mechanism is
 * inheritance. `connectOrSpawnHost` copies this process's environment into the
 * detached host it spawns, and the CLI copies it again for a host it starts.
 */
const OWNED = 'AGBRTE_HOME_FROM_SUITE';
if (process.env['AGBRTE_HOME'] === undefined || process.env[OWNED] === '1') {
  process.env['AGBRTE_HOME'] = join(
    tmpdir(),
    `agbrte-file-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  process.env[OWNED] = '1';
}
