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
