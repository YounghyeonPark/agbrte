/**
 * Removing a temp directory a process may still be standing in.
 *
 * Windows will not remove a directory that is any process's working directory,
 * and several suites here put one there on purpose: a preview server is started
 * with `cwd` inside its workspace, and a detached host runs in the folder it
 * serves. Both are asked to stop before the directory is removed, and both take
 * a moment longer than that under load — so `rm` gets `EBUSY`, in `afterEach`,
 * *after* every assertion in the test has already passed.
 *
 * That failure is not evidence about the code. It is litter in `%TEMP%`, which
 * the operating system reclaims, reported as a red test that says nothing about
 * what it was testing — and it took out two whole files on a loaded machine
 * while the behaviour under test was fine.
 *
 * **What is not softened is the claim.** A suite that asserts nothing was left
 * running says so with an assertion — the port is released, the pid is gone —
 * rather than by a directory removal happening to succeed. Those still fail. If
 * removal is the only thing that fails, this reports it and moves on.
 */

import { rm } from 'node:fs/promises';

/** Remove a temp directory, patiently, and never fail a test over it. */
export async function removeTemp(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (err) {
    // Named rather than swallowed: a directory that could never be removed is
    // worth knowing about while chasing something else, and invisible cleanup
    // failures are how a leaked process stays leaked.
    process.stderr.write(
      `could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}
