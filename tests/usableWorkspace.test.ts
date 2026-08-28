/**
 * Folders that are not workspaces, refused before anything is created (§5.1).
 *
 * `npx agbrte web .` is the shortest way into this program, so the folder it
 * lands in is whatever the terminal happened to open in — and on Windows "Run as
 * administrator" opens PowerShell in `C:\WINDOWS\system32`. A first-time reader
 * pasting the line there got an errno and a path.
 *
 * The worse half is the one these tests exist for. Without write access that
 * paste *fails*; with it, it **succeeds** — a workspace created inside the
 * Windows system directory, a detached host bound to it, and sessions in a folder
 * nobody looks in. Translating the permission error would have let exactly the
 * more privileged case through, so the rule is a name check and these check the
 * names.
 */

import { describe, expect, it } from 'vitest';
import { assertUsableWorkspace, NotAWorkspace } from '../src/main/store/layout.js';

const onWindows = process.platform === 'win32';

describe('a folder that belongs to the operating system', () => {
  it.runIf(onWindows)('refuses the directory somebody actually landed in', () => {
    expect(() => assertUsableWorkspace('C:\\Windows\\System32', { SystemRoot: 'C:\\WINDOWS' })).toThrow(
      /belongs to the operating system/,
    );
  });

  /*
   * The bug the first version of this shipped with, kept as a test because it is
   * invisible: `%SystemRoot%` is spelled `C:\WINDOWS`, `path.resolve` hands back
   * `C:\Windows\System32`, and a case-sensitive `startsWith` matched neither. The
   * filesystem-root branch caught `C:\` and made the check look like it worked,
   * while the one case it was written for went straight through.
   */
  it.runIf(onWindows)('matches whatever case the environment spells it in', () => {
    for (const spelling of ['C:\\WINDOWS', 'C:\\Windows', 'c:\\windows']) {
      expect(() => assertUsableWorkspace('C:\\Windows\\System32', { SystemRoot: spelling })).toThrow(
        /belongs to the operating system/,
      );
    }
  });

  it.runIf(!onWindows)('refuses the directories a unix owns', () => {
    for (const dir of ['/usr', '/etc/agbrte', '/bin', '/sbin/x']) {
      expect(() => assertUsableWorkspace(dir, {})).toThrow(/belongs to the operating system/);
    }
  });

  /*
   * Matched on the separator rather than on the string. `/systemd` is not inside
   * `/sys`, and a prefix comparison that forgets this refuses a folder somebody
   * chose on purpose — which is a worse failure than the one being prevented.
   */
  it.runIf(!onWindows)('does not read a longer name as a directory below', () => {
    expect(() => assertUsableWorkspace('/systemd-work', {})).not.toThrow();
    expect(() => assertUsableWorkspace('/usr-local-project', {})).not.toThrow();
  });
});

describe('the top of a filesystem', () => {
  it('is not a project folder', () => {
    expect(() => assertUsableWorkspace(onWindows ? 'C:\\' : '/', {})).toThrow(
      /top of a filesystem/,
    );
  });
});

describe('everything else', () => {
  it('is allowed, because refusing a folder somebody chose is the worse failure', () => {
    // Named deliberately: `/srv` is where this project's own documentation puts a
    // public demo host, and `/var` and `/opt` are ordinary places to keep work.
    // A denylist that grows past what the OS owns starts costing real users.
    const fine = onWindows
      ? ['C:\\Users\\you\\my-project', 'D:\\work\\repo', 'C:\\ProgramData\\thing']
      : ['/srv/demo', '/var/www/site', '/opt/build', '/home/you/project'];
    for (const dir of fine) {
      expect(() => assertUsableWorkspace(dir, { SystemRoot: 'C:\\WINDOWS' })).not.toThrow();
    }
  });

  /*
   * The reason and the remedy are carried apart, and the split is the behaviour
   * rather than a detail of the type. A terminal is about to ask which project
   * folder to use and prints the reason alone; anything that cannot ask — the
   * app, a host, a script — prints `message`, which is both. Asserting `message`
   * alone would let the halves be re-joined without a test noticing, which is
   * exactly how the redundant advice got above the prompt in the first place.
   */
  it('separates why it refused from what to do about it', () => {
    let thrown: unknown;
    try {
      assertUsableWorkspace(onWindows ? 'C:\\' : '/', {});
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotAWorkspace);
    const err = thrown as NotAWorkspace;

    // The half a prompt does not need: no instruction on how to answer.
    expect(err.reason).toMatch(/top of a filesystem/);
    expect(err.reason).not.toMatch(/agbrte web /);

    // The half that is the whole answer when nothing is going to ask.
    expect(err.remedy).toMatch(/agbrte web /);
    expect(err.message).toContain(err.reason);
    expect(err.message).toContain(err.remedy);
  });
});
