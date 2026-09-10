import { defineConfig } from '@playwright/test';

/**
 * Electron end-to-end tests (DESIGN.md §14).
 *
 * Separate from Vitest rather than folded into it: these drive a real Electron
 * process with a real renderer and a real agent host, so they cannot share
 * Vitest's node environment, and they are slow enough that mixing them into
 * `npm test` would discourage running the unit suite.
 *
 * `workers: 1` because each test launches an app that spawns a utilityProcess
 * and, in the live test, talks to a single local model server. Parallel workers
 * would contend for the model and make timing failures look like logic failures.
 */
export default defineConfig({
  testDir: './tests/e2e',
  // These launch `dist/`, so a stale build is a silent wrong answer rather than
  // a failure. The check costs a directory walk; see the file for what it cost
  // not to have it.
  globalSetup: './tests/e2e/globalSetup.ts',
  // Removes the temp directories the run made, on a green run. It reads the
  // pass/fail answer out of `test-results/.last-run.json`; see the file for the
  // two places that looked like better homes and were not.
  globalTeardown: './tests/e2e/globalTeardown.ts',
  // A live test waits on a 7B model generating a tool call.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  /*
   * Headroom for a cold model load, and **not** a budget for the run.
   *
   * It was twenty minutes, chosen because "the model is loaded once in a
   * `beforeAll`, and a cold start can be minutes of disk read" — without
   * headroom the hook times out and reports every test in the group as failed,
   * hiding that only the load was slow.
   *
   * Twenty stopped being headroom once the suite reached eighty-odd tests beside
   * a group that talks to a 7B model. A run in this session spent it: one live
   * test exceeded its own 180s ceiling, the cap arrived, and **seventeen tests
   * did not run** — which is the worst failure a test budget has, because the
   * report is about the slow test and says nothing about the coverage that
   * silently went missing.
   *
   * So the number is large enough that normal variance cannot reach it. A run
   * that genuinely hangs still stops; the difference is that a slow live test
   * now costs time rather than coverage. The `live` project below is the other
   * half of that: it runs last, so even reaching this cap truncates the group
   * that was slow rather than the deterministic ones.
   */
  globalTimeout: 45 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],

  /*
   * Two projects, in this order, because one group of tests is not like the
   * others.
   *
   * Everything tagged `@live` talks to a **real local model server**: it is the
   * only part of the suite whose duration depends on a GPU, a cold weight load
   * and whatever else the machine is doing. Every unexplained failure in this
   * session came from that group or from contention around it, and separating
   * them buys two things.
   *
   * **Order.** Deterministic tests finish before the live ones begin, so the
   * live group cannot take coverage down with it — not through `globalTimeout`
   * above, and not by competing with eighty Electron launches for the same GPU.
   *
   * **A name.** `npm run e2e:fast` is the deterministic suite, which is what you
   * want while iterating on the renderer or the IPC surface. It existed before
   * as `--grep-invert` typed by hand, which is the shape of a missing seam.
   *
   * Deliberately **not** `dependencies`, although that is the obvious tool: it
   * makes a dependent project *skip* when its dependency fails, so one flaky
   * deterministic test would silently drop the live group — the same class of
   * hidden coverage loss the paragraph above is about. Declaration order with
   * `workers: 1` is enough for the ordering and has no such cliff.
   */
  projects: [
    { name: 'deterministic', grepInvert: /@live/u },
    { name: 'live', grep: /@live/u },
  ],
  // Retrying would mask exactly the flakiness worth knowing about here.
  retries: 0,

  /*
   * `shots.spec.ts` writes files into the repository, and that is not a test
   * result.
   *
   * It says in its own header that its tag keeps it out of the default run, and
   * that was simply untrue until this existed: nothing implemented it, so
   * `npm run e2e` ran it and left tracked files modified. Found the way it would
   * always be found — a `git status` after a green run showing a change nobody
   * made. (A second spec, which recorded a published demo, was worse about this
   * and has since been deleted along with the demo.)
   *
   * `grepInvert` rather than `testIgnore`, because `testIgnore` would make even
   * an explicit path unrunnable and the point is to keep them runnable on
   * purpose. And gated on an environment variable rather than on the presence of
   * `--grep`, because a config that reads `process.argv` to guess at intent is a
   * config that behaves differently depending on how somebody spelled a command.
   *
   *   AGBRTE_WRITE_FIXTURES=1 npx playwright test shots --grep @shots
   */
  ...(process.env['AGBRTE_WRITE_FIXTURES'] === '1'
    ? {}
    : { grepInvert: /@shots/u }),
});
