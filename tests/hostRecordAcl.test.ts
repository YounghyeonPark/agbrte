/**
 * The host record is a credential on Windows too, and `mode` does not say so.
 *
 * `writeHostRecord` passes `mode: 0o600`, and the comment beside it used to add
 * "ignored on Windows, where the pipe path it carries is not secret". That was
 * true of the host it was written for and stopped being true when Windows became
 * a target: a Windows host cannot listen on a unix socket, so it listens on
 * loopback and this file carries the bearer token that is the entire
 * authentication for it. A premise falsified by a change three files away, with
 * nothing to recheck it.
 *
 * On Windows the mode is close to a no-op — the file inherits its parent
 * directory's ACL — so whether anything was protected depended on where the user
 * kept their checkout. `C:\dev` on the machine this was found on grants
 * `BUILTIN\Users: ReadAndExecute` and `Authenticated Users: Modify`, which any
 * ordinary shared location does too.
 *
 * The directory here is deliberately opened up first, so inheritance would hand
 * the record a permissive ACL if nothing intervened. Without that the test would
 * pass under a private `%TEMP%` whatever the code did, which is the shape of a
 * security test that reassures and checks nothing.
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeHostRecord } from '../src/host/discovery.js';

/** Run `icacls` and return its stdout, with the exit code checked. */
function icacls(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('icacls', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`icacls exited ${code}: ${err.trim()}`)),
    );
  });
}

const onWindows = process.platform === 'win32' ? describe : describe.skip;

onWindows('a host record carrying a token', () => {
  it('is not readable by other accounts, even under an open directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agbrte-acl-'));
    try {
      const devagents = join(root, '.devagents');
      await mkdir(devagents, { recursive: true });
      await icacls([devagents, '/grant', 'Users:(OI)(CI)R']);

      // Proves the setup is doing what it claims: without the code under test,
      // a file created here inherits the open grant. If this ever stops being
      // true the test below would pass for the wrong reason.
      const control = join(devagents, 'control.json');
      await writeHostRecord(root, {
        pid: process.pid,
        socket: '127.0.0.1:1',
        startedAt: new Date().toISOString(),
        instanceId: 'i',
      });
      await rm(control, { force: true });
      expect(await icacls([join(devagents, 'host.json')])).toMatch(/Users:/);

      // Now with a token, which is what makes the file a credential.
      await writeHostRecord(root, {
        pid: process.pid,
        socket: '127.0.0.1:1',
        startedAt: new Date().toISOString(),
        instanceId: 'i',
        port: 1,
        token: 'a-secret-that-authenticates-everything',
      });

      const acl = await icacls([join(devagents, 'host.json')]);
      expect(acl, `the token is readable by others:\n${acl}`).not.toMatch(/BUILTIN\\Users:/);
      expect(acl).not.toMatch(/Everyone:/);
      expect(acl).not.toMatch(/Authenticated Users:/);
      // And the owner keeps it, or the host cannot read its own record.
      expect(acl).toContain(process.env['USERNAME'] ?? 'no-username-in-env');
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 30_000);
});
