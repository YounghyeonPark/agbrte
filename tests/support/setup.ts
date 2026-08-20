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
 * Give the suite its own machine directory.
 *
 * `~/.agbrte` holds what is true of a *machine*: its host record, its machine
 * id, and the list of workspaces its host has been asked to serve (§8). All
 * three are global by design, which makes them global to the suite too — a host
 * started by one test would find, and reopen, every temporary workspace every
 * other test had ever created, and would spend §5.3 relocation signals in the
 * developer's own projects on the way past.
 *
 * `AGBRTE_HOME` is the variable the installer script already reads, so this is
 * the existing seam rather than one invented for tests — and it is set here, in
 * `process.env`, for the same reason the linger is: the mechanism is
 * inheritance. `connectOrSpawnHost` copies this process's environment into the
 * detached host it spawns, so one assignment reaches every host any test starts
 * by any route.
 *
 * `??=` so a developer chasing a machine-directory bug can pin it from the
 * shell, and one directory per run rather than per file because a machine host
 * is shared by construction — that is the thing under test.
 */
process.env['AGBRTE_HOME'] ??= join(
  tmpdir(),
  `agbrte-suite-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
);
