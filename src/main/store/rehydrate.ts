/**
 * Context rehydration (DESIGN.md §5.4).
 *
 * > `resumeToken` is a **cache**. `events.jsonl` is **truth**.
 *
 * This function rebuilds an agent's working context from the durable log. It is
 * the answer to four requirements at once — workspace moved (R3), work migrated
 * to another machine (R7), agent switched to another provider mid-session (R8),
 * and agent resumed after a quota window reset hours later (R9) — because none
 * of them may depend on runtime-owned state.
 *
 * It is also the in-session compactor (§3.7): `AgbrteHarness` compacts by calling
 * the same function. Keeping it one code path is what stops the durable path
 * from rotting, since every ordinary turn exercises it.
 *
 * ## What a seed is, and is not
 *
 * A seed is not a transcript. Replaying a transcript back into a model would
 * reproduce the context problem it was meant to solve. A seed carries: the goal,
 * curated project memory, checklist state, a bounded narrative of what happened,
 * the most recent turns verbatim, and *pointers* to artifacts and attachments
 * rather than their contents.
 */

import type {
  ContentBlock,
  AgbrteEvent,
  NormalizedTurn,
  SessionProjection,
} from '@shared/types/index.js';
import type { SessionStore, SessionMeta } from './sessionStore.js';

export interface RehydrateOptions {
  /** Ceiling for the assembled seed. Callers pass `contextWindow * 0.5`. */
  budgetTokens: number;
  /**
   * A **ceiling** on how many recent turns are carried word for word, for a
   * caller that wants a small seed for its own reasons — `buildBrief` passes
   * `0`, because a brief is a statement of scope and not a transcript (§4.3).
   *
   * Absent means *no ceiling*, and `budgetTokens` alone decides. That is the
   * important default and it used to be `6`. A fixed turn count applied before
   * the budget cannot help but win: six short turns are a few hundred tokens
   * against a budget of twenty thousand, so `budgetTokens` never bound
   * anything, and every session — however large its window — was cut back to
   * the last three exchanges on every single turn. The seed is bounded by the
   * budget, which is what the caller measured the window with; a second,
   * unrelated bound underneath it is not conservatism, it is amnesia.
   */
  verbatimTurns?: number;
  /**
   * Set when seeding a *different* runtime or provider than produced the log.
   * Provider-specific reasoning blocks cannot cross that boundary, so they are
   * dropped — and the drop is reported so the transcript can explain any
   * discontinuity rather than mystifying it (§3.9).
   */
  dropOpaqueReasoning?: boolean;
  /** Curated project memory, keyed by lineage and therefore provider-portable. */
  memory?: string[];
}

export interface RehydrateResult {
  seed: NormalizedTurn[];
  /** Highest `seq` the seed accounts for. */
  seededThroughSeq: number;
  /**
   * Turns the seed does **not** carry, because they did not fit.
   *
   * The name is older than the behaviour and is left alone deliberately — it is
   * part of a signature `buildBrief` and the compaction path both read, and
   * renaming it is a change to coordinate rather than to slip in. What it
   * counts is turns dropped, and `narrate()` now says so in those words instead
   * of promising a summary nothing wrote.
   */
  summarizedTurns: number;
  droppedOpaque: number;
  /** Conservative estimate — see `estimateTokens`. */
  estimatedTokens: number;
  /** True when the log held nothing to carry, so a fresh start is honest. */
  isEmpty: boolean;
}

/**
 * No turn-count ceiling by default. See `RehydrateOptions.verbatimTurns`.
 *
 * Named rather than inlined so the *absence* of a limit is a deliberate value
 * at the one place that reads it, not a `??` that looks like an oversight.
 */
const NO_TURN_CEILING = Number.POSITIVE_INFINITY;

/**
 * Deliberately crude and deliberately *over*-estimating.
 *
 * §3.6 forbids a foreign tokenizer for pre-flight counting, because a 20%-wrong
 * estimate causes a context overflow deep into a long run. This is not counting
 * for billing or for a request ceiling — it only decides how much history to
 * carry — so a pessimistic character heuristic is the safe choice: overshooting
 * carries less history than it could, which is recoverable, while undershooting
 * overflows the window, which is not.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'image':
      return `[image ${block.sha256.slice(0, 12)} ${block.width}x${block.height}]`;
    case 'audio':
      return block.transcript ?? `[audio ${block.durationMs}ms]`;
    case 'file_ref':
      return `[file ${block.path.$ws}]`;
    case 'artifact_ref':
      return `[artifact ${block.artifactId}]`;
  }
}

/** Reconstruct conversational turns from the durable log. */
function turnsFrom(events: readonly AgbrteEvent[]): NormalizedTurn[] {
  const turns: NormalizedTurn[] = [];
  for (const ev of events) {
    if (ev.type === 'user.turn') {
      turns.push({ role: 'user', content: ev.content });
    } else if (ev.type === 'agent.text') {
      const last = turns.at(-1);
      // Consecutive agent text is one turn, matching how it was produced.
      if (last?.role === 'assistant') {
        last.content.push({ type: 'text', text: ev.text });
      } else {
        turns.push({ role: 'assistant', content: [{ type: 'text', text: ev.text }] });
      }
    }
  }
  return turns;
}

/** A bounded narrative of what happened, for turns not carried verbatim. */
function narrate(projection: SessionProjection, summarized: number): string[] {
  const lines: string[] = [];
  if (summarized > 0) {
    /*
     * Says dropped, because dropped is what happened.
     *
     * This read "are summarized rather than quoted. Ask if you need detail."
     * Nothing summarizes them — `rehydrate` carries turns or leaves them out —
     * and there is nobody to ask: the agent has no route to the log, which is
     * the whole premise of §17.18. So the line described a capability that did
     * not exist, to a reader that would act on it, about the one subject it
     * must not be wrong on: what it can and cannot still see.
     */
    lines.push(
      `${summarized} earlier turn(s) did not fit the context budget and are not ` +
        `included here. Treat anything older than the conversation below as unseen.`,
    );
  }
  const { stats } = projection;
  if (stats.toolCalls > 0) {
    lines.push(
      `Tool activity so far: ${stats.toolCalls} call(s), ${stats.toolErrors} error(s), ` +
        `${stats.permissionDenials} denied by policy.`,
    );
  }
  if (projection.artifacts.length > 0) {
    lines.push(
      `Artifacts produced: ${projection.artifacts
        .map((a) => `${a.kind}:${a.artifactId}`)
        .join(', ')}. Read them if you need their contents.`,
    );
  }
  if (stats.compactions > 0) {
    // Surfaced because §4.3 makes repeated compaction the signal that the task
    // should be decomposed rather than compacted again.
    lines.push(`This session has been compacted ${stats.compactions} time(s).`);
  }
  return lines;
}

function checklistLines(projection: SessionProjection): string[] {
  if (projection.checklist.length === 0) return [];
  return [
    'Checklist:',
    ...projection.checklist.map((i) => `  [${i.state}] ${i.text}`),
  ];
}

/**
 * Build a seed for an agent from the session's durable log.
 *
 * The seed always leads with a system turn stating the goal and current state,
 * so an agent resumed weeks later knows what it is doing before it reads any
 * conversation.
 */
export async function rehydrate(
  store: SessionStore,
  opts: RehydrateOptions,
): Promise<RehydrateResult> {
  const [meta, { projection }, events] = await Promise.all([
    store.readMeta(),
    store.load(),
    store.readEvents(),
  ]);

  const allTurns = turnsFrom(events);
  const keep = Math.max(0, opts.verbatimTurns ?? NO_TURN_CEILING);

  // `slice(-Infinity)` is the whole array — the ceiling is off unless a caller
  // asked for one, and the budget below is then the only thing that decides.
  let verbatim = allTurns.slice(-keep);
  let summarized = allTurns.length - verbatim.length;

  /*
   * A real count now that `agent.reasoning` exists.
   *
   * `turnsFrom` carries user turns and agent text and nothing else, so the
   * model's working-out is left behind either way — this flag does not choose
   * the behaviour, it asks for the boundary to be *reported*. A seed that
   * silently lost the reasoning would leave a rehydrated agent unable to explain
   * a conclusion it can still see itself having reached.
   *
   * Not carried even within one runtime, deliberately: a scratchpad replayed as
   * conversation is a model reading its own thinking back as though someone had
   * said it, and §3.9 calls this opaque precisely because its shape belongs to
   * the provider rather than to the transcript.
   */
  const droppedOpaque = opts.dropOpaqueReasoning
    ? events.filter((e) => e.type === 'agent.reasoning').length
    : 0;

  const brief = (): NormalizedTurn => ({
    role: 'system',
    content: [
      {
        type: 'text',
        text: [
          `You are resuming work on: ${meta.title}`,
          `Goal: ${meta.goal}`,
          '',
          ...checklistLines(projection),
          ...(opts.memory && opts.memory.length > 0
            ? ['', 'Project memory:', ...opts.memory.map((m) => `  - ${m}`)]
            : []),
          ...(narrate(projection, summarized).length > 0
            ? ['', ...narrate(projection, summarized)]
            : []),
          '',
          'This context was rebuilt from the session log, not carried over from a',
          'previous process. Prior conversation below may be abridged.',
        ].join('\n'),
      },
    ],
  });

  const turnSize = (t: NormalizedTurn): number =>
    t.content.reduce((s, b) => s + estimateTokens(blockText(b)), 0);

  const sizeOf = (turns: NormalizedTurn[]): number =>
    turns.reduce((sum, t) => sum + turnSize(t), 0);

  /*
   * Drop the oldest verbatim turns until the whole seed fits. The brief is never
   * dropped: an agent with conversation but no goal is worse off than one with a
   * goal and no conversation.
   *
   * Sizes are measured once and carried in a running total. That was a detail
   * while a hard six-turn ceiling ran first — the loop could only ever run a
   * handful of times — and it stops being one the moment the budget is the only
   * bound: re-summing the whole conversation on every drop is quadratic in the
   * length of a session, which is the shape that turns a week-old transcript
   * into a stall at the start of every turn.
   */
  const sizes = verbatim.map(turnSize);
  let carried = sizes.reduce((sum, n) => sum + n, 0);
  // Recomputed each pass rather than hoisted: `summarized` is what `narrate`
  // reports, so the brief genuinely does change size as turns are dropped.
  while (verbatim.length > 0 && sizeOf([brief()]) + carried > opts.budgetTokens) {
    carried -= sizes.shift() as number;
    verbatim = verbatim.slice(1);
    summarized += 1;
  }

  const seed = allTurns.length === 0 && projection.checklist.length === 0
    ? []
    : [brief(), ...verbatim];

  return {
    seed,
    seededThroughSeq: projection.lastSeq,
    summarizedTurns: summarized,
    droppedOpaque,
    estimatedTokens: sizeOf(seed),
    isEmpty: seed.length === 0,
  };
}

/** Convenience for the compaction path, which needs the before/after sizes. */
export async function compactionSizes(
  store: SessionStore,
  result: RehydrateResult,
): Promise<{ beforeTokens: number; afterTokens: number }> {
  const events = await store.readEvents();
  const before = turnsFrom(events).reduce(
    (sum, t) => sum + t.content.reduce((s, b) => s + estimateTokens(blockText(b)), 0),
    0,
  );
  return { beforeTokens: before, afterTokens: result.estimatedTokens };
}

export type { SessionMeta };
