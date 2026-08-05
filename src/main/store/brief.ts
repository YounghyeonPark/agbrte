/**
 * Building a child's brief (DESIGN.md §4.3).
 *
 * A parent hands a child a `SessionBrief`, not a transcript. That distinction is
 * the whole reason hierarchy exists: if a child inherited the parent's context,
 * splitting would cost what it was meant to save. So the brief is built by
 * *narrowing* — `rehydrate()` produces the parent's context, and this discards
 * almost all of it, keeping pointers instead of prose.
 *
 * ## Why `outOfScope` is load-bearing
 *
 * §4.3 says it plainly, and it is worth restating because it looks like
 * politeness: without an explicit exclusion list a child reads widely to
 * re-derive context it was never given, which is exactly the cost the split was
 * meant to avoid. An empty `outOfScope` is therefore a smell, not a default, and
 * `buildBrief` refuses to invent one.
 *
 * ## Direction of flow
 *
 * Down: goal, scope, exclusions, acceptance criteria, pointers, and a reserved
 * budget. Up (elsewhere): a bounded summary plus artifact refs. Neither
 * direction is a channel — there is no session-to-session bus, because a free
 * channel between sessions reintroduces the context blow-up by hand. §4.2's
 * `bus.message` is *within* one session, agent to agent.
 */

import type {
  NormalizedTurn,
  ResultContract,
  SessionBrief,
  SessionBudget,
} from '@shared/types/index.js';
import { availableTokens } from '@shared/types/index.js';
import type { SessionStore } from './sessionStore.js';
import { estimateTokens, rehydrate } from './rehydrate.js';

export interface BuildBriefOptions {
  /** The child's narrow goal. */
  scope: string;
  /**
   * What this child must *not* do. Required, and rejected when empty — see the
   * note above; this is the field that keeps a child from re-deriving the
   * parent's context.
   */
  outOfScope: string[];
  /** How the child's result gets back, and its ceiling. */
  contract: ResultContract;
  acceptance: string[];
  /** Reserved from the parent's remaining budget by the caller (§4.3). */
  budget: SessionBudget;
  /** Lineage-keyed memory slugs; free to pass, since they follow the repo. */
  memoryRefs?: string[];
  /**
   * Turns to carry word for word. **Zero by default**, and that is the point:
   * §4.3 calls verbatim history "a small, deliberate set — by exception, not
   * default". Every turn here is parent context entering a child.
   */
  verbatimTurns?: number;
  /** Ceiling on the brief itself, so a "narrowing" cannot quietly widen. */
  maxBriefTokens?: number;
}

export class BriefRefused extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BriefRefused';
  }
}

/** Default ceiling for the brief. Generous for pointers, hostile to prose. */
const DEFAULT_MAX_BRIEF_TOKENS = 2_000;

export interface BuiltBrief {
  brief: SessionBrief;
  /** Conservative estimate of what the child will actually be seeded with. */
  estimatedTokens: number;
  /** Parent turns deliberately left behind. Reported so the cost is visible. */
  omittedTurns: number;
}

/**
 * Build a brief from the parent's log.
 *
 * Refuses rather than degrades in two cases, both because a silently weak brief
 * produces a subtly mis-scoped child — §4.3's stated reason for keeping splits
 * user-approved, and the failure mode that is hardest to salvage.
 */
export async function buildBrief(
  parent: SessionStore,
  opts: BuildBriefOptions,
): Promise<BuiltBrief> {
  if (opts.scope.trim() === '') {
    throw new BriefRefused('a child needs a scope; an empty one produces an aimless session');
  }
  if (opts.outOfScope.length === 0) {
    // Not a default we can invent: only the parent knows what it is keeping.
    throw new BriefRefused(
      'outOfScope is required — without it the child reads widely to re-derive ' +
        'context, which is the cost the split was meant to avoid (§4.3)',
    );
  }
  if (opts.contract.summaryMaxTokens <= 0) {
    throw new BriefRefused('the result contract needs a positive summaryMaxTokens ceiling');
  }

  const meta = await parent.readMeta();
  const { projection } = await parent.load();

  // The parent's context, then almost all of it thrown away. Rehydrate is reused
  // rather than reimplemented so the summarizing and drop-reporting behaviour is
  // the one already exercised on every turn (§5.4).
  const verbatimTurns = opts.verbatimTurns ?? 0;
  const rehydrated = await rehydrate(parent, {
    budgetTokens: opts.maxBriefTokens ?? DEFAULT_MAX_BRIEF_TOKENS,
    verbatimTurns,
    ...(opts.memoryRefs !== undefined ? { memory: opts.memoryRefs } : {}),
  });

  const verbatim = verbatimTurns === 0 ? [] : tailTurns(rehydrated.seed, verbatimTurns);

  const brief: SessionBrief = {
    parentGoal: meta.goal,
    scope: opts.scope,
    outOfScope: [...opts.outOfScope],
    contract: opts.contract,
    acceptance: [...opts.acceptance],
    memoryRefs: [...(opts.memoryRefs ?? [])],
    // Artifacts the parent already produced are the cheapest possible context: a
    // reference costs nothing until the child chooses to read it.
    pointers: projection.artifacts.map((a) => ({
      kind: 'artifact' as const,
      ref: a.artifactId,
      why: `produced by the parent session (${a.kind})`,
    })),
    budget: opts.budget,
    ...(verbatim.length > 0 ? { verbatim } : {}),
  };

  const estimatedTokens = estimateBriefTokens(brief);
  const ceiling = opts.maxBriefTokens ?? DEFAULT_MAX_BRIEF_TOKENS;
  if (estimatedTokens > ceiling) {
    // A brief over its own ceiling is a split that is not narrowing anything.
    throw new BriefRefused(
      `brief is ~${estimatedTokens} tokens against a ${ceiling} ceiling; ` +
        `narrow the scope or carry fewer verbatim turns`,
    );
  }

  return {
    brief,
    estimatedTokens,
    omittedTurns: Math.max(0, projection.stats.turns - verbatim.length),
  };
}

/**
 * Whether a child's result fits its contract.
 *
 * Returns the verdict rather than throwing so the caller can do what §4.3
 * requires — write an artifact and return a pointer — instead of failing the
 * child. The child does not get to negotiate a larger injection.
 */
export function checkResult(
  contract: ResultContract,
  summary: string,
  artifacts: ReadonlyArray<{ kind: string }>,
): { fits: boolean; estimatedTokens: number; missing: string[] } {
  const missing = contract.artifacts
    .filter((required) => required.required)
    .filter((required) => !artifacts.some((a) => a.kind === required.kind))
    .map((required) => required.kind);

  const estimatedTokens = estimateTokens(summary);
  return { fits: estimatedTokens <= contract.summaryMaxTokens && missing.length === 0, estimatedTokens, missing };
}

/** Budget a parent can reserve for a child right now, per §4.3. */
export function reservableForChild(parent: SessionBudget): number {
  return availableTokens(parent);
}

/**
 * Reserve a child's ceiling from the parent's remainder.
 *
 * Mutating the parent is the point: §4.3 requires a tree not outspend what its
 * root was granted, and that only holds if the reservation is taken at spawn
 * rather than checked at spend time.
 */
export function reserveForChild(
  parent: SessionBudget,
  tokenCeiling: number,
): { parent: SessionBudget; child: SessionBudget } {
  const available = availableTokens(parent);
  if (tokenCeiling > available) {
    throw new BriefRefused(
      `cannot reserve ${tokenCeiling} tokens: only ${available} remain unreserved`,
    );
  }
  return {
    parent: { ...parent, reservedForChildren: parent.reservedForChildren + tokenCeiling },
    child: {
      tokenCeiling,
      spent: 0,
      reservedForChildren: 0,
      ...(parent.inheritedFrom !== undefined ? { inheritedFrom: parent.inheritedFrom } : {}),
    },
  };
}

function tailTurns(turns: NormalizedTurn[], count: number): NormalizedTurn[] {
  return count <= 0 ? [] : turns.slice(-count);
}

/** Conservative, matching `rehydrate`'s pessimistic character heuristic (§3.6). */
function estimateBriefTokens(brief: SessionBrief): number {
  const text = [
    brief.parentGoal,
    brief.scope,
    ...brief.outOfScope,
    ...brief.acceptance,
    ...brief.memoryRefs,
    ...brief.pointers.map((p) => `${p.kind} ${p.ref} ${p.why}`),
  ].join(' ');

  const verbatim = (brief.verbatim ?? [])
    .flatMap((turn) => turn.content)
    .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`))
    .join(' ');

  return estimateTokens(`${text} ${verbatim}`);
}
