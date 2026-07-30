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
});
