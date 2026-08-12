/**
 * Updating the desktop app in place (DESIGN.md §13, §14).
 *
 * ## Why this is safer here than in most apps, and why it is still not automatic
 *
 * The usual objection to an updater is that installing means restarting, and
 * restarting means losing what the user was in the middle of. That is not true
 * of this program: §6.4 puts sessions in **detached hosts** that outlive the app
 * entirely — closing the window is already a non-event, and an update that
 * restarts the shell interrupts a *view*, not a run. The agent keeps working
 * while the app is gone and the transcript keeps being written.
 *
 * So the download is automatic and the **install is not**. `autoInstallOnAppQuit`
 * applies it the next time the person closes the app themselves, and there is an
 * explicit restart for anyone who would rather have it now. Nothing here ever
 * quits the app on its own: a workbench that vanishes mid-sentence to improve
 * itself has misunderstood whose time it is.
 *
 * ## What is checked, and what nobody should pretend is checked
 *
 * `electron-updater` fetches `latest*.yml` over HTTPS from the GitHub release
 * and verifies the artifact's **SHA512** against it before installing. That is
 * integrity, and it is real: a corrupted or truncated download is refused.
 *
 * It is *not* authenticity. These builds are unsigned (`electron-builder.yml`
 * says so, and the release workflow says why), so nothing proves the release was
 * made by this project rather than by whoever could serve that URL. HTTPS and
 * GitHub's own account security are the whole trust story, and that is a smaller
 * story than a signature. `verifyUpdateCodeSignature` is therefore left off
 * rather than switched on to fail: a signature check that cannot pass is not
 * security, it is an error message.
 *
 * When signing exists, this comment is the thing to come back to.
 */

import type { BrowserWindow } from 'electron';

/** Whether this build can update itself, and the reason when it cannot. */
export type UpdateSupport = { supported: true } | { supported: false; reason: string };

export interface BuildFacts {
  platform: NodeJS.Platform;
  /** False when running from a checkout — `npm start`, the e2e suite, a dev run. */
  packaged: boolean;
  /** Whether the build carries a valid code signature. */
  signed: boolean;
  /**
   * Whether the process is running from an AppImage.
   *
   * Set by the AppImage runtime itself as `$APPIMAGE`, which is the only
   * reliable way to know: the same `linux-x64` build is shipped as an AppImage,
   * a `.deb` and a tarball, and only the first can replace itself.
   */
  appImage: boolean;
}

/**
 * The decision, as a pure function.
 *
 * Separated from the wiring because it is the part with rules in it, and because
 * every one of these branches is a sentence a user may read. The alternative —
 * asking `electron-updater` and reporting whatever it says — produces "Error:
 * ENOENT app-update.yml" for a developer running from source, which describes
 * the mechanism rather than the situation.
 */
export function updateSupport(build: BuildFacts): UpdateSupport {
  if (!build.packaged) {
    return {
      supported: false,
      reason: 'this is a development build running from a checkout, so there is nothing to replace',
    };
  }

  if (build.platform === 'darwin' && !build.signed) {
    /*
     * Not a policy choice. macOS applies updates through Squirrel.Mac, which
     * requires the new bundle's signature to match the running one; an unsigned
     * app has nothing to match, so the download would succeed and the install
     * would fail. Saying so up front is the difference between a limit and a bug.
     */
    return {
      supported: false,
      reason:
        'macOS installs updates only for signed applications, and this build is unsigned — ' +
        'download a new version from the releases page instead',
    };
  }

  if (build.platform === 'linux' && !build.appImage) {
    return {
      supported: false,
      reason:
        'only the AppImage can replace itself; a .deb or a tarball is updated the way it was installed',
    };
  }

  return { supported: true };
}

/** What the app knows about an update, as the renderer sees it. */
export type UpdateState =
  | { phase: 'unsupported'; reason: string }
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; reason: string };

export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface UpdateOptions {
  build: BuildFacts;
  updater: UpdaterLike;
  /** Called on every state change, so a window can show it. */
  onState: (state: UpdateState) => void;
  /** How often to look again. Six hours: this app is left running for days. */
  everyMs?: number;
  setInterval?: typeof setInterval;
}

/**
 * Wire the updater, or explain why there is none.
 *
 * Returns a handle rather than reaching for a module-level singleton, so a test
 * can drive it and so two windows cannot each start their own timer.
 */
export function startUpdates(opts: UpdateOptions): {
  state: () => UpdateState;
  check: () => Promise<void>;
  installNow: () => void;
  stop: () => void;
} {
  const support = updateSupport(opts.build);
  let state: UpdateState =
    support.supported ? { phase: 'idle' } : { phase: 'unsupported', reason: support.reason };

  const emit = (next: UpdateState): void => {
    state = next;
    opts.onState(next);
  };
  emit(state);

  if (!support.supported) {
    // No timer, no listeners, no network. An unsupported build must not spend a
    // request every six hours discovering the same thing.
    return {
      state: () => state,
      check: () => Promise.resolve(),
      installNow: () => undefined,
      stop: () => undefined,
    };
  }

  const { updater } = opts;
  updater.autoDownload = true;
  // The install waits for a quit the person chose. See the header.
  updater.autoInstallOnAppQuit = true;

  updater.on('checking-for-update', () => emit({ phase: 'checking' }));
  updater.on('update-not-available', () => emit({ phase: 'idle' }));
  updater.on('download-progress', ((p: { percent?: number }) =>
    emit({ phase: 'downloading', percent: Math.round(p.percent ?? 0) })) as never);
  updater.on('update-downloaded', ((info: { version?: string }) =>
    emit({ phase: 'ready', version: info.version ?? 'a new version' })) as never);
  updater.on('error', ((err: Error) =>
    /*
     * Reported, never thrown. An update failing is not a reason for the app to
     * be unusable — the most likely cause is that the machine is offline, which
     * is a normal state for a laptop and a completely fine state for this
     * program, whose hosts may be somewhere else entirely.
     */
    emit({ phase: 'failed', reason: err.message })) as never);

  const check = async (): Promise<void> => {
    try {
      await updater.checkForUpdates();
    } catch (err) {
      emit({ phase: 'failed', reason: err instanceof Error ? err.message : String(err) });
    }
  };

  void check();
  const every = opts.everyMs ?? 6 * 60 * 60 * 1000;
  const timer = (opts.setInterval ?? setInterval)(() => void check(), every);
  /*
   * Node keeps the process alive for a pending timer, and an updater must never
   * be the reason an app refuses to exit.
   *
   * Optional at both steps because a timer handle is not one shape: Node returns
   * a `Timeout` object with `unref`, a browser returns a number, and an injected
   * one may return nothing at all. Written as `(timer).unref?.()` it read as
   * defensive and threw on the first fake that returned `undefined`.
   */
  (timer as { unref?: () => void } | undefined)?.unref?.();

  return {
    state: () => state,
    check,
    /*
     * Silent, and relaunch afterwards.
     *
     * The first argument is `isSilent`, and it was `false` — which for this
     * project's assisted installer (`nsis.oneClick: false`) meant pressing
     * "Restart to update" opened a setup wizard asking where to install an
     * application that is already installed. The label promised a restart and
     * delivered a form.
     *
     * `true` runs the same installer with `/S`. No UAC prompt goes with it
     * because `nsis.perMachine: false` puts the install under the user's own
     * profile, so nothing here needs a privilege the app does not have.
     *
     * The assisted installer is kept for the *first* install, where choosing a
     * directory is a reasonable thing to be asked once. An update is not that
     * moment: the answer was given already, and asking again is a form standing
     * between a person and the thing they pressed a button for.
     */
    installNow: () => updater.quitAndInstall(true, true),
    stop: () => clearInterval(timer as ReturnType<typeof setInterval>),
  };
}

/** The facts about this build, read from the running process. */
export async function buildFacts(): Promise<BuildFacts> {
  const { app } = await import('electron');
  return {
    platform: process.platform,
    packaged: app.isPackaged,
    // `isPackaged` is not enough on macOS: an unsigned packaged app is exactly
    // the case that fails at install time.
    signed: process.platform === 'darwin' ? isMacSigned() : false,
    appImage: process.env['APPIMAGE'] !== undefined,
  };
}

/**
 * Whether the running macOS bundle is signed.
 *
 * Deliberately conservative: anything other than a clean `codesign` verdict is
 * treated as unsigned, because the cost of being wrong in that direction is a
 * sentence telling the user to download the app themselves, and the cost of
 * being wrong in the other is an update that downloads and then cannot install.
 */
function isMacSigned(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    execFileSync('codesign', ['--verify', '--no-strict', process.execPath], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export type { BrowserWindow };
