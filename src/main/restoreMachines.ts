/**
 * Reach for the remote machines this app was attached to when it last quit.
 *
 * The host is still there - quitting disconnects and does not stop (§8) - so
 * this is a *reattach*, which §6.4 makes the cheap path: the sessions come back
 * from the log, nothing restarts, and a turn that was running kept running while
 * the window was closed.
 *
 * ## Three rules, and each one is a failure this avoids
 *
 * **It never blocks the window.** An `ssh` dial can hang for as long as a
 * network lets it, and a build box that is switched off must not be able to keep
 * somebody from opening their local sessions. So this is started after the
 * window exists and is never awaited by anything the UI needs.
 *
 * **It retries, but not forever, and not against a refusal.** A machine that is
 * booting is worth waiting for; one that says "this workspace is held by another
 * host" or "your client is too old" is stating a fact that will be just as true
 * in thirty seconds, and re-dialling it is noise in somebody else's `sshd` log.
 * So a refusal stops the attempts and is reported as it arrived.
 *
 * **A failure is a state, not a dialog.** Nothing modal, nothing that steals
 * focus at startup: what happened is readable (`restoring()`), and the machine
 * stays in the list so the next launch tries again. The one thing that forgets a
 * machine is a person removing the host.
 */

import type { Fleet } from './fleet.js';
import { readAttachedMachines, type RememberedMachine } from './attachedMachines.js';

/** How this app is getting on with one remembered machine. */
export interface RestoreState {
  alias: string;
  workspaceRoot: string;
  /** `trying` while dials are still scheduled; the other three are settled. */
  state: 'trying' | 'attached' | 'unreachable' | 'refused';
  attempts: number;
  /** Why the last attempt failed, for a person reading rather than for a retry. */
  detail?: string;
}

/**
 * Waits between dials, in milliseconds.
 *
 * Four more attempts over about a minute: long enough to cover a laptop finding
 * its wifi or a box finishing its boot, short enough to be over before anybody
 * wonders. Past that the honest answer is "that machine is not there", and the
 * button is one click away.
 */
const BACKOFF_MS = [2_000, 8_000, 20_000, 30_000];

/** Failures that will not be different next time. */
function isRefusal(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'ClientTooOld' ||
    err.name === 'WorkspaceUnavailable' ||
    err.name === 'HostProtocolMismatch' ||
    /speaks session protocol|already serving|is held by/i.test(err.message)
  );
}

export class MachineRestorer {
  private readonly states = new Map<string, RestoreState>();
  private stopped = false;

  constructor(
    private readonly fleet: Pick<Fleet, 'attach'>,
    /** Injected so a test does not wait out a real backoff. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => {
        const timer = setTimeout(r, ms);
        // A pending retry must never be the reason a process cannot exit.
        timer.unref?.();
      }),
  ) {}

  /** What is being reached for, and how it went. In the order remembered. */
  restoring(): RestoreState[] {
    return [...this.states.values()];
  }

  /** Give up on anything still scheduled. Attached hosts are untouched. */
  dispose(): void {
    this.stopped = true;
  }

  /**
   * Start reaching for every remembered machine, in parallel.
   *
   * Parallel because they are independent computers, and one that is off must
   * not delay one that is on: done in sequence, the second machine's first dial
   * waits out the first machine's entire backoff.
   */
  async start(home?: string): Promise<void> {
    const machines = await readAttachedMachines(home);
    await Promise.all(machines.map((machine) => this.restore(machine)));
  }

  private async restore(machine: RememberedMachine): Promise<void> {
    const key = `${machine.alias} ${machine.workspaceRoot}`;
    const state: RestoreState = {
      alias: machine.alias,
      workspaceRoot: machine.workspaceRoot,
      state: 'trying',
      attempts: 0,
    };
    this.states.set(key, state);

    for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
      if (this.stopped) return;
      state.attempts = attempt + 1;
      try {
        await this.fleet.attach({
          // The target `hosts.addRemote` builds, built the same way: the alias
          // goes to `ssh` unchanged, so the user's own config decides everything
          // about the connection (§6.2).
          target: {
            kind: 'ssh',
            alias: machine.alias,
            host: machine.alias,
            useSystemConfig: true,
          },
          workspaceRoot: machine.workspaceRoot,
        });
        state.state = 'attached';
        delete state.detail;
        return;
      } catch (err) {
        state.detail = err instanceof Error ? err.message : String(err);
        if (isRefusal(err)) {
          state.state = 'refused';
          return;
        }
      }
      const wait = BACKOFF_MS[attempt];
      if (wait === undefined) break;
      await this.sleep(wait);
    }
    if (!this.stopped) state.state = 'unreachable';
  }
}
