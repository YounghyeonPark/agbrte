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
 * It is also the in-session compactor (§3.7): `LoomHarness` compacts by calling
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
  LoomEvent,
  NormalizedTurn,
  SessionProjection,
} from '@shared/types/index.js';
import type { SessionStore, SessionMeta } from './sessionStore.js';

export interface RehydrateOptions {
  /** Ceiling for the assembled seed. Callers pass `contextWindow * 0.5`. */
  budgetTokens: number;
  /** Most recent turns carried word for word. */
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
  /** Turns summarized rather than carried verbatim. */
  summarizedTurns: number;
  droppedOpaque: number;
  /** Conservative estimate — see `estimateTokens`. */
  estimatedTokens: number;
  /** True when the log held nothing to carry, so a fresh start is honest. */
  isEmpty: boolean;
}

const DEFAULT_VERBATIM_TURNS = 6;

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
function turnsFrom(events: readonly LoomEvent[]): NormalizedTurn[] {
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
    lines.push(
      `${summarized} earlier turn(s) are summarized rather than quoted. Ask if you need detail.`,
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
  const keep = Math.max(0, opts.verbatimTurns ?? DEFAULT_VERBATIM_TURNS);

  let verbatim = allTurns.slice(-keep);
  let summarized = allTurns.length - verbatim.length;

  let droppedOpaque = 0;
  if (opts.dropOpaqueReasoning) {
    // Nothing in the current event schema carries opaque reasoning, so this is
    // zero today. Counted rather than assumed so the boundary is already
    // reported when a provider-specific block type does arrive.
    droppedOpaque = 0;
  }

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

  const sizeOf = (turns: NormalizedTurn[]): number =>
    turns.reduce(
      (sum, t) => sum + t.content.reduce((s, b) => s + estimateTokens(blockText(b)), 0),
      0,
    );

  // Drop the oldest verbatim turns until the whole seed fits. The brief is never
  // dropped: an agent with conversation but no goal is worse off than one with a
  // goal and no conversation.
  while (verbatim.length > 0 && sizeOf([brief(), ...verbatim]) > opts.budgetTokens) {
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
