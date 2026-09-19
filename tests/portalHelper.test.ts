/**
 * The portal helper is a Python program held in a string, so nothing else checks
 * it (DESIGN.md §12.1).
 *
 * `typecheck` sees a template literal. The linters see a template literal. Every
 * other test in the tree injects `spawn` and therefore never runs it. So a
 * mistyped name or a bad indent in there is invisible to this whole repository —
 * and it would stay invisible, because the only path that executes it needs a
 * live desktop portal and somebody standing at the machine to approve a dialog.
 * That is the longest gap between a defect and its discovery anywhere in the
 * project, which is what this file is for.
 *
 * It needs a `python3` and says so loudly when there is none, rather than
 * passing. A syntax check that silently does not run is the same shape as the
 * `@live` tests reporting a timeout instead of missing coverage.
 */

import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PORTAL_HELPER } from '../src/host/portalHelper.js';

/** Whichever Python this machine has, or `null`. */
function findPython(): string | null {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  return null;
}

const python = findPython();

describe('the portal helper', () => {
  it('is a syntactically valid Python 3 program', () => {
    if (python === null) {
      console.warn(
        '\n  ⚠ The portal helper was NOT syntax-checked — no python3 on this machine.\n' +
          '    Nothing else in this repository parses it, so it is unverified in this run.\n',
      );
      return;
    }

    /*
     * Compiled rather than run. Running it would try to reach a session bus and
     * a portal, which is the half this project cannot verify; compiling asks the
     * one question that can be answered anywhere — does Python accept it.
     *
     * Through stdin rather than `-c`, because the program is 140 lines and a
     * command line is not where that belongs on every platform this runs on.
     */
    const compiled = spawnSync(
      python,
      ['-c', 'import sys, ast; ast.parse(sys.stdin.read()); print("ok")'],
      { input: PORTAL_HELPER, encoding: 'utf8', windowsHide: true },
    );

    expect(compiled.stderr).toBe('');
    expect(compiled.stdout.trim()).toBe('ok');
  });

  it('ends itself when whoever spawned it goes away', () => {
    /*
     * Asserted on the text, which is weaker than running it and is the strongest
     * thing available here — and it guards something whose absence is expensive
     * rather than merely wrong.
     *
     * The helper holds a portal session open, and the compositor keeps a
     * screen-sharing indicator lit for as long as it lives. A host killed with
     * -9 runs no cleanup, so without this the session outlives everything that
     * knows about it: an indicator on somebody's desktop until they reboot, and
     * this app apparently recording a machine nobody is looking at.
     *
     * It reads stdin to notice, which couples it to the `stdio` spelled out in
     * `openCast`. Both halves are named here so that removing either one has
     * something pointing at the other.
     */
    expect(PORTAL_HELPER).toContain('sys.stdin.buffer.read()');
    expect(PORTAL_HELPER).toContain('loop.quit');
  });
});
