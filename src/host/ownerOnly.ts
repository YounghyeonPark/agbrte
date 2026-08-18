/**
 * Making a file readable by its owner and nobody else (DESIGN.md §13).
 *
 * `writeFile(..., { mode: 0o600 })` is the whole answer on POSIX and close to a
 * no-op on Windows, where a file inherits its parent directory's ACL. That was
 * measured rather than assumed when the host record began carrying a bearer
 * token: a file written by Node with `mode: 0o600` under a directory granting
 * `Users:(OI)(CI)R` comes out `BUILTIN\Users:(I)(R)`, and an ordinary
 * `C:\dev`-style checkout grants exactly that. Whether the code protected
 * anything depended on where the user happened to put their files.
 *
 * Extracted from `discovery.ts` when `endpoints.json` became the second file
 * here that is a credential. Two copies of a security rule is one copy that gets
 * fixed and one that does not — and the difference would be invisible, because
 * both files look fine until somebody else on the machine reads one.
 */

import { spawn } from 'node:child_process';

/**
 * Restrict a path to the current user, throwing if it cannot be done.
 *
 * **Throws, deliberately.** The caller knows whether the file is a secret; when
 * it is, continuing would mean running with the credential readable while
 * everything else looked fine. Callers holding a non-secret simply do not call
 * this.
 *
 * `icacls` because Node has no API for a DACL — `chmod` cannot express one.
 * Inheritance is removed and a single grant issued, so the result does not
 * depend on the parent directory at all.
 *
 * A no-op off Windows: `mode` already did the work there, and running `chmod`
 * again would be a second answer to a settled question.
 */
export async function restrictToOwner(path: string, what: string): Promise<void> {
  if (process.platform !== 'win32') return;

  const user = process.env['USERNAME'];
  if (user === undefined || user === '') {
    throw new Error(`cannot secure ${path}: USERNAME is unset, so the grant has no subject`);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn('icacls', [path, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `could not restrict ${path} to ${user}: it holds ${what} and would be readable ` +
                `by other accounts on this machine. ${stderr.trim()}`,
            ),
          ),
    );
  });
}
