/**
 * `windowsHide`, for every child a test starts.
 *
 * Windows gives a child process its own console when the parent has none and
 * the spawn does not say otherwise, and on Windows 11 that console is a
 * **Windows Terminal window**. A test run launched from a terminal is therefore
 * quiet — the children inherit that console — and the same run launched from
 * anything without one (an editor task, a CI agent, a background job) papers the
 * desktop: 36 windows across one full suite, measured, appearing and vanishing
 * over whatever the developer was doing instead of watching tests.
 *
 * Named rather than repeated so the reason lives in one place, and spread into
 * the options object at each call:
 *
 * ```ts
 * spawnSync(sh, ['-c', script], { encoding: 'utf8', ...noConsoleWindow })
 * ```
 *
 * The flag is ignored off Windows, so there is nothing to guard.
 */
export const noConsoleWindow = { windowsHide: true } as const;
