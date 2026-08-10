/**
 * How many agent loops one host runs at once (DESIGN.md §8, §16).
 *
 * > Workers are separate processes because loops are long, CPU-bursty, and prone
 * > to hanging on a wedged subprocess. ~30–50 MB each, so concurrency is capped
 * > per host (default `min(8, cores − 2)`) with FIFO queueing above the cap.
 *
 * That was specified with a number and a queueing discipline and implemented
 * nowhere, so concurrency was bounded by nothing at all. Ten sessions ran
 * concurrently in a test not because queueing worked but because there was no
 * queue — which is the shape of "recorded, not enforced" this project keeps
 * finding.
 *
 * ## It is not the quota scheduler, and §8 says so
 *
 * > Three independent limits, and conflating them is a real bug.
 *
 * The `QuotaScheduler` protects a *shared credential's allowance* and spans
 * machines. This protects *one machine's memory*. An agent on a local model
 * draws on nobody's allowance and still costs 30–50 MB, so it waits here and
 * never there; eight agents on one API key share a bucket across two hosts and
 * still get eight slots each. Different scopes, different queues.
 *
 * ## FIFO, and why that is worth saying
 *
 * Turns are served in the order they asked. The alternative — whoever the event
 * loop happens to wake — makes a busy host starve whichever session is unlucky,
 * and "one of my ten sessions never moves" is indistinguishable from a hang.
 */

import { availableParallelism } from 'node:os';

/**
 * The default cap.
 *
 * `cores − 2` leaves the machine something for the app and the host process
 * themselves; the 8 is a ceiling on top of that, because a 64-core box running
 * sixty-four agent loops is not bounded by cores but by RAM and by how many
 * concurrent sessions a person can actually be reading.
 */
export function defaultTurnCap(): number {
  return Math.max(1, Math.min(8, availableParallelism() - 2));
}

/**
 * A fixed number of slots, handed out in the order they were asked for.
 *
 * Deliberately not a general semaphore library: this needs a cap, a queue, and a
 * release that cannot be called twice, and every other affordance is a way for a
 * slot to be leaked.
 */
export class TurnSlots {
  private readonly waiting: Array<() => void> = [];
  private held = 0;

  constructor(private readonly cap: number = defaultTurnCap()) {
    if (cap < 1) throw new RangeError('a cap below 1 would run nothing at all');
  }

  /** Slots in use right now. */
  get running(): number {
    return this.held;
  }

  /** Turns queued behind the cap. Surfaced so a wait can be explained, not guessed at. */
  get queued(): number {
    return this.waiting.length;
  }

  get limit(): number {
    return this.cap;
  }

  /**
   * Take a slot, waiting in line if the host is full.
   *
   * `onWait` fires only when there is actually a wait, so a caller can say
   * "queued behind 3 turns" rather than reporting a queue that never formed.
   *
   * Returns the release. Calling it twice is a no-op rather than an error: a
   * `finally` that runs after an early return is a real shape, and the failure
   * mode of a double release — handing out a slot that does not exist — is far
   * worse than the failure mode of ignoring one.
   */
  async acquire(onWait?: (position: number) => void): Promise<() => void> {
    /**
     * Queue if the host is full **or if anyone is already waiting**.
     *
     * The second clause is what makes this FIFO rather than nearly-FIFO. Without
     * it a turn arriving at the moment a slot frees jumps the line ahead of
     * whoever has been queued longest, and on a busy host that is a session
     * which never moves — indistinguishable from a hang.
     */
    if (this.held >= this.cap || this.waiting.length > 0) {
      onWait?.(this.waiting.length + 1);
      // The slot is *transferred* by the releaser rather than counted again
      // here — see below.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.held += 1;
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;

      /**
       * Hand the slot on rather than decrementing and letting the next one
       * re-take it.
       *
       * Decrementing first opens a window: the woken waiter resumes on a
       * microtask, and anything calling `acquire` in between sees a free slot
       * and takes it, so both proceed and the host runs one over its cap. The
       * count is only ever decremented when nobody is waiting to inherit it.
       */
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.held -= 1;
    };
  }
}
