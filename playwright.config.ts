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
  // A live test waits on a 7B model generating a tool call.
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // The model is loaded once in a `beforeAll`, and a cold start can be minutes
  // of disk read. Without headroom here the hook times out and reports every
  // test in the group as failed, which hides that only the load was slow.
  globalTimeout: 20 * 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  // Retrying would mask exactly the flakiness worth knowing about here.
  retries: 0,

  /*
   * Two specs write files into the repository, and neither is a test result.
   *
   * `shots.spec.ts` produces the README screenshots and `recording.spec.ts`
   * produces `docs/app/recording.json`, which is *published* — it is the demo
   * `agbrte.dev/app/` serves. Both say in their own headers that they are kept
   * out of the default run by their tag, and until now that was simply untrue:
   * nothing implemented it. `npm run e2e` ran them, spent six real model turns
   * on the recording, and left a tracked artifact modified. It was found the way
   * it would always be found — a `git status` after a green run, showing a
   * change nobody made.
   *
   * `grepInvert` rather than `testIgnore`, because `testIgnore` would make even
   * an explicit path unrunnable and the point is to keep them runnable on
   * purpose. And gated on an environment variable rather than on the presence of
   * `--grep`, because a config that reads `process.argv` to guess at intent is a
   * config that behaves differently depending on how somebody spelled a command.
   *
   *   AGBRTE_WRITE_FIXTURES=1 npx playwright test recording --grep @recording
   */
  ...(process.env['AGBRTE_WRITE_FIXTURES'] === '1'
    ? {}
    : { grepInvert: /@shots|@recording/u }),
});
