/**
 * Wait for a fact rather than for a duration.
 *
 * There were three copies of this in the suite and about twenty places that
 * should have used one and slept instead. The sleeps did not fail often — one
 * full run in five, a different test each time — which is the worst rate for
 * noticing: too rare to investigate, frequent enough to teach everyone that a
 * red run means "try again".
 *
 * Two of them were traced today. `stall.test.ts` slept 50ms for a turn to reach
 * `working`, and `messageBus.test.ts` slept 50ms for a delivered message to be
 * appended. Both are facts the test can observe directly, and observing them is
 * both faster and correct — a condition wait finishes in milliseconds on an idle
 * machine and still holds on a loaded one, which a fixed sleep cannot do in
 * either direction.
 *
 * ## When a duration is right
 *
 * For a **negative** assertion. "No duplicate arrived" and "it is still parked"
 * are claims about a period of time, and there is no fact to poll for — the
 * absence only means something if you waited. Those keep their sleeps and say
 * why at the call site, so the next person does not convert them by rote.
 */

/** Poll until `what` holds, or fail saying so. */
export async function until(
  what: () => boolean | Promise<boolean>,
  ms = 5_000,
  /**
   * What to say when it never held, gathered only on failure.
   *
   * `condition never held within 20000ms` names the wait and nothing else, and
   * a wait for another process to do something has an answer sitting right
   * there — its output, its exit code — that the bare message throws away. One
   * test spent three days failing with that line while the process it was
   * waiting for had been printing a `ReferenceError` the whole time. Optional,
   * because most conditions are about this process and need no explaining.
   */
  diagnose?: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) {
      const because = diagnose === undefined ? '' : `\n${await diagnose()}`;
      throw new Error(`condition never held within ${ms}ms${because}`);
    }
    // Short, because the point is to finish as soon as the fact is true. The
    // cost of polling briskly is nothing; the cost of a long interval is that
    // every wait rounds up to it.
    await new Promise((r) => setTimeout(r, 5));
  }
}
