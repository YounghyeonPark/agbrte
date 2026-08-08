/**
 * The support matrix (DESIGN.md §3.13).
 *
 * > The matrix must distinguish *verified*, *declared*, and *not run*: a green
 * > cell earned by a scripted fixture is not the same claim as one earned
 * > against a live endpoint, and collapsing them would reintroduce exactly the
 * > confidence this table exists to remove.
 *
 * So the cell states are not pass/fail. A runtime that *says* it can resume and
 * a runtime that has been *watched* resuming are different facts, and a matrix
 * that paints both green is worse than no matrix — it converts an unchecked
 * declaration into apparent evidence.
 *
 * Three sources feed a cell, and they are kept apart all the way to the screen:
 *
 *  - the **report** — what the conformance suite actually ran, with how;
 *  - the **declaration** — `RuntimeCapabilities`, which is the adapter's own
 *    claim and nothing more;
 *  - the **catalogue** below — every scenario the design says should be run,
 *    including the ones nobody has written yet, so the gaps are visible rather
 *    than absent.
 */

import type { RuntimeCapabilities } from './runtime.js';

/**
 * How a passing scenario was proven. Ordered weakest to strongest.
 *
 * A green cell is not a claim about the world unless it says what was on the
 * other end. `scripted-fixture` means our code was exercised against a response
 * we wrote; `live-endpoint` means a model actually behaved this way. Both are
 * worth having and they are not the same sentence.
 */
export type Evidence =
  /** Real adapter code against responses the test authored. */
  | 'scripted-fixture'
  /** Real code on both sides, transport in memory. */
  | 'in-process'
  /** A real OS process, real pipes, real exit codes. */
  | 'real-subprocess'
  /** A model or service actually answered. */
  | 'live-endpoint';

export const EVIDENCE_RANK: Readonly<Record<Evidence, number>> = {
  'scripted-fixture': 1,
  'in-process': 2,
  'real-subprocess': 3,
  'live-endpoint': 4,
};

export type CellStatus =
  /** A scenario ran and passed. `evidence` says against what. */
  | 'verified'
  /** A scenario ran and failed. Louder than not-run, deliberately. */
  | 'failed'
  /** The adapter claims the capability; nothing has checked it. */
  | 'declared'
  /** The adapter says it cannot. Not a gap — an answer. */
  | 'unsupported'
  /** No scenario exists, or none has been run for this runtime. */
  | 'not-run'
  /**
   * A result exists, but for a different build of this adapter.
   *
   * Shown apart from `verified` because a report is a record of one moment: an
   * adapter edited after the suite last ran is exactly the case where a stale
   * green cell would assert something nobody checked.
   */
  | 'stale';

export interface MatrixCell {
  runtimeId: string;
  scenarioId: string;
  status: CellStatus;
  evidence?: Evidence;
  detail?: string;
}

/** One row of the matrix — a thing an adapter may or may not be able to do. */
export interface ConformanceScenario {
  id: string;
  title: string;
  /** Why it is in the set: what a failure here would actually cost. */
  why: string;
  /**
   * What the adapter's own declaration says, when no scenario has run.
   *
   * A predicate rather than a field name, because the capability that answers a
   * scenario is rarely one boolean: images live under `input`, and "parks on a
   * spent window" is `quotaModel === 'windowed-allowance'`. Encoding it as a
   * field plus a truthiness rule would have needed a special case per row
   * anyway, spelled less clearly.
   *
   * Absent for the contract obligations every adapter owes regardless of
   * capability — a stream you can subscribe to before the first `send()` is not
   * a feature anyone may decline.
   */
  declaredBy?: (caps: RuntimeCapabilities) => boolean;
}

/**
 * Every scenario §3.13 names, including the ones not written yet.
 *
 * The unwritten ones are the point. A matrix built only from tests that exist
 * shows a wall of green and answers the wrong question; one that carries the
 * whole intended set shows how much of it is actually covered, which is the
 * question anyone choosing a runtime is really asking.
 */
export const CONFORMANCE_SCENARIOS: readonly ConformanceScenario[] = [
  {
    id: 'stream-before-send',
    title: 'events subscribable before the first send',
    why: 'a lazily-built stream yields nothing, and its turns look like transport failures',
  },
  {
    id: 'stream-once',
    title: 'stream consumable once',
    why: 'a second consumer races the first and both see half a turn',
  },
  {
    id: 'explicit-stop',
    title: 'ends with an explicit stop, never an implicit finish',
    why: 'a truncated turn reported as success is the worst outcome available',
  },
  {
    id: 'usage-reported',
    title: 'usage reported for the turn',
    why: 'without it a budget cannot be enforced, only estimated',
  },
  {
    id: 'gate-before-execute',
    title: 'tool call reaches the permission gate before executing',
    why: '§13: a gate claimed and not held is worse than no gate',
  },
  {
    id: 'resume-token-consistent',
    title: 'resume token consistent with the declared capability',
    why: 'an adapter claiming native resume and supplying nothing loses the session',
    declaredBy: (c) => c.nativeResume,
  },
  {
    id: 'capabilities-per-spec',
    title: 'capabilities answered as a function of the spec',
    why: 'capabilities belong to adapter + model + installed version, not to the adapter',
  },
  {
    id: 'denial-then-grant',
    title: 'denial surfaced, granted, and resumed without losing the turn',
    why: 'the whole §3.12 flow; without it a coarse-gated agent stops at its first refusal',
  },
  {
    id: 'chunked-framing',
    title: 'a protocol record split across pipe chunks is reassembled',
    why: 'naive per-chunk parsing passes every short test and loses the middle of real output',
  },
  {
    id: 'non-protocol-output',
    title: 'output that is not the protocol is ignored',
    why: 'an update notice on stdout must not read as a failed turn',
  },
  {
    id: 'truncated-run',
    title: 'a run that dies mid-turn is retryable, not finished',
    why: 'mapping it to end_turn moves the session on as though the work were done',
  },
  {
    id: 'missing-binary',
    title: 'an uninstalled tool is not retried',
    why: 'retrying cannot install anything; it just spends the attempt budget',
  },
  // ---- §3.13's "not yet run" set. Present so the gaps are visible. ----
  {
    id: 'parallel-tool-calls',
    title: 'two tool calls in one message',
    why: 'a clock-based call id collides here and a decision is recorded against the wrong call',
    declaredBy: (c) => c.parallelToolCalls !== 'none',
  },
  {
    id: 'tool-error-recovered',
    title: 'a failing tool is recovered from rather than fatal',
    why: 'one bad path should not end a turn that could have adapted',
  },
  {
    id: 'nested-schema-degraded',
    title: 'a nested tool schema survives degradation',
    why: '§3.5: schemas that work on frontier models break smaller ones',
    declaredBy: (c) => c.schemaProfile !== 'text-protocol',
  },
  {
    id: 'image-input',
    title: 'image input',
    why: 'declared per model; unverified declarations are how a turn fails at the worst moment',
    declaredBy: (c) => c.input.image,
  },
  {
    id: 'long-context-compaction',
    title: '200-message context with compaction',
    why: 'where a long session actually breaks, and it breaks quietly',
    declaredBy: (c) => c.serverSideCompaction,
  },
  {
    id: 'interrupt-mid-stream',
    title: 'interrupt mid-stream',
    why: 'an interrupt that does not arrive leaves a runaway agent billing someone',
    declaredBy: (c) => c.interruptible,
  },
  {
    id: 'refusal',
    title: 'a refusal is a stop reason, not a crash',
    why: 'the session must stay usable after the model declines something',
  },
  {
    id: 'rate-limit-backoff',
    title: 'rate limit backed off and retried',
    why: 'a retryable stop treated as failure throws away a turn for a few seconds of waiting',
  },
  {
    id: 'quota-park-resume',
    title: 'quota exhaustion parks and resumes at reset',
    why: '§4.1: a spent window is a wait, and calling it a failure discards the work',
    declaredBy: (c) => c.quotaModel === 'windowed-allowance',
  },
  {
    id: 'context-overflow-recovered',
    title: 'context overflow recovered rather than fatal',
    why: 'the failure a long session reaches first',
  },
  {
    id: 'malformed-args-repaired',
    title: 'malformed tool arguments repaired within a bounded number of tries',
    why: 'unbounded repair is an infinite loop with a bill attached',
  },
  {
    id: 'cost-accuracy',
    title: 'reported cost matches what was actually billed',
    why: 'every budget in §4.4 rests on this number being real',
    declaredBy: (c) => c.costReporting !== 'none',
  },
];

/** What the conformance suite writes out when it runs. */
export interface ConformanceReport {
  ranAt: string;
  results: ConformanceResult[];
}

export interface ConformanceResult {
  runtimeId: string;
  scenarioId: string;
  ok: boolean;
  evidence: Evidence;
  /**
   * The adapter build this result was obtained against.
   *
   * The whole reason a stale cell can be told from a verified one: a result is a
   * record of one moment, and an adapter edited since then has not been checked
   * no matter how green the file looks.
   */
  adapterVersion: string;
  detail?: string;
}
