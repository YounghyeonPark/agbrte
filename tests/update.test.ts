/**
 * Updating the app in place (DESIGN.md §13, §14).
 *
 * ## What these tests can and cannot say
 *
 * They cover the decision — who may update, what happens when they may not, and
 * what the app does with each event — because that is the part with rules in it
 * and every branch is a sentence a user may read.
 *
 * They do **not** prove that an update installs. That needs two published
 * releases and a machine willing to replace a running application, and no test
 * that stays offline can stand in for it. Saying so here rather than letting a
 * green suite imply otherwise: the untested half is the half that touches the
 * user's filesystem.
 */

import { describe, expect, it, vi } from 'vitest';
import { startUpdates, updateSupport, type UpdateState, type UpdaterLike } from '@main/update.js';

const build = {
  packaged: true,
  platform: 'win32' as NodeJS.Platform,
  signed: false,
  appImage: false,
};

describe('who may update themselves', () => {
  it('lets a packaged Windows build, signed or not', () => {
    // NSIS replaces the installation directory; nothing checks a signature on
    // the way in, which is why Windows works where macOS cannot.
    expect(updateSupport(build).supported).toBe(true);
  });

  it('refuses a development build, and says that is what it is', () => {
    const support = updateSupport({ ...build, packaged: false });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/development build/i);
  });

  /**
   * The one that matters most, because it is a limit rather than a bug and will
   * be read as a bug if it is not named.
   *
   * macOS installs through Squirrel.Mac, which requires the incoming bundle's
   * signature to match the running one. An unsigned app has nothing to match, so
   * an update would download and then fail at the last step — the worst place to
   * discover it. These builds are unsigned today, deliberately (there is no
   * Apple account), so the answer must be given before the download, not after.
   */
  it('refuses unsigned macOS, and names the signature as the reason', () => {
    const support = updateSupport({ ...build, platform: 'darwin', signed: false });
    expect(support.supported).toBe(false);
    expect(support.supported === false && support.reason).toMatch(/signed/i);
    // And says what to do instead, since the app cannot do it for them.
    expect(support.supported === false && support.reason).toMatch(/releases page/i);
  });

  it('allows signed macOS', () => {
    expect(updateSupport({ ...build, platform: 'darwin', signed: true }).supported).toBe(true);
  });

  it('allows a Linux AppImage and refuses the other Linux artifacts', () => {
    expect(updateSupport({ ...build, platform: 'linux', appImage: true }).supported).toBe(true);
    const deb = updateSupport({ ...build, platform: 'linux', appImage: false });
    expect(deb.supported).toBe(false);
    expect(deb.supported === false && deb.reason).toMatch(/AppImage/);
  });
});

/** An updater that records what was done to it and never touches a network. */
function fakeUpdater(): UpdaterLike & {
  fire: (event: string, payload?: unknown) => void;
  checks: number;
  installs: number;
} {
  const listeners = new Map<string, (payload?: unknown) => void>();
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checks: 0,
    installs: 0,
    checkForUpdates(this: { checks: number }) {
      this.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall(this: { installs: number }) {
      this.installs += 1;
    },
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, listener as (payload?: unknown) => void);
      return this;
    },
    fire(event: string, payload?: unknown) {
      listeners.get(event)?.(payload);
    },
  };
}

describe('what the app does about an update', () => {
  it('downloads without asking and installs only when the person quits', () => {
    const updater = fakeUpdater();
    startUpdates({ build, updater, onState: () => undefined, setInterval: vi.fn() as never });

    // The distinction this whole feature turns on. §6.4 puts sessions in
    // detached hosts that outlive the app, so restarting the shell interrupts a
    // view rather than a run — which makes downloading in the background fine,
    // and still does not make quitting on someone's behalf fine.
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.installs).toBe(0);
  });

  it('reports each stage, ending with a version a person can be told', () => {
    const seen: UpdateState[] = [];
    const updater = fakeUpdater();
    startUpdates({ build, updater, onState: (s) => seen.push(s), setInterval: vi.fn() as never });

    updater.fire('checking-for-update');
    updater.fire('download-progress', { percent: 41.6 });
    updater.fire('update-downloaded', { version: '0.0.4' });

    expect(seen.map((s) => s.phase)).toEqual(['idle', 'checking', 'downloading', 'ready']);
    // Rounded, because a card showing `41.60000000000001%` is a bug report.
    expect(seen[2]).toEqual({ phase: 'downloading', percent: 42 });
    expect(seen[3]).toEqual({ phase: 'ready', version: '0.0.4' });
  });

  it('survives an error instead of raising one', () => {
    const seen: UpdateState[] = [];
    const updater = fakeUpdater();
    const handle = startUpdates({
      build,
      updater,
      onState: (s) => seen.push(s),
      setInterval: vi.fn() as never,
    });

    // Being offline is a normal state for a laptop, and a completely fine state
    // for this program — its hosts may be on another machine entirely.
    updater.fire('error', new Error('getaddrinfo ENOTFOUND github.com'));

    expect(handle.state()).toEqual({
      phase: 'failed',
      reason: 'getaddrinfo ENOTFOUND github.com',
    });
  });

  /**
   * An unsupported build must be inert, not merely quiet.
   *
   * The tempting shape is to wire everything up and let the check fail every six
   * hours, which reads the same from the outside and is not: it is a request per
   * interval, forever, to be told the thing the app already knew at startup.
   */
  it('does not check, listen or schedule anything when it cannot update', () => {
    const seen: UpdateState[] = [];
    const updater = fakeUpdater();
    const timer = vi.fn();
    const handle = startUpdates({
      build: { ...build, packaged: false },
      updater,
      onState: (s) => seen.push(s),
      setInterval: timer as never,
    });

    expect(updater.checks).toBe(0);
    expect(timer).not.toHaveBeenCalled();
    expect(handle.state().phase).toBe('unsupported');
    // And the reason travels, because the UI has nothing else to say.
    expect(seen[0]?.phase === 'unsupported' && seen[0].reason).toMatch(/development build/i);

    // Asking anyway is harmless rather than an error.
    expect(() => handle.installNow()).not.toThrow();
    expect(updater.installs).toBe(0);
  });
});
