/**
 * Every session, everywhere, ranked by who needs a human (DESIGN.md §10, §15 Phase 4).
 *
 * ## Why this replaces "pick something from the sidebar"
 *
 * Several hosts and several sessions is the designed shape, not an edge case —
 * §8's caps are per host and every card carries a target badge for exactly that
 * reason. But the app could only ever show one session at a time, so "what is
 * running and what is stuck" was a question you answered by clicking through a
 * list. On a phone, where the sidebar is the whole screen, it was worse.
 *
 * ## Ranked, not sorted
 *
 * Attention first, then recency — `byAttentionThenRecency`, the same ordering
 * the session manager already defines, so the dashboard cannot disagree with the
 * rest of the app about what matters. A paused session is **not** a failed one
 * (§4.1): the four `awaiting_*` states mean *holding all state, will resume*, and
 * showing them in a colour that reads as breakage would tell the user to
 * intervene where nothing is wrong.
 *
 * ## Only what is true
 *
 * No progress bars. `checklist` exists on the session and nothing writes to it
 * yet — no tool emits `checklist.updated` — so a bar here would read 0/0 on every
 * card forever, which is worse than no bar: it looks like nothing is happening.
 * Cost *was* in that category and no longer is: a price list reaches the
 * capability model, the harness prices every turn, and `'unknown'` says so out
 * loud where a subscription hides the figure (§10). So it is shown — including
 * the sentence for the case nobody can price, because `$0.00` there would be a
 * lie and a blank would look like a bug.
 */

import type { JSX } from 'react';
import type { HostInfo } from '../shared/ipc/contract.js';
import { byAttentionThenRecency } from '../shared/types/index.js';
import { formatCost, sumCost } from '../shared/cost.js';
import type { AttentionReason, Session } from '../shared/types/index.js';
import { LABEL, LiveDot, quietTone } from './App.js';

/** What each `awaiting_*` reason is actually asking of the person reading it. */
const ASKS: Record<AttentionReason, string> = {
  needs_input: 'waiting for you',
  needs_permission: 'asking permission',
  needs_credentials: 'needs credentials',
  quota_exhausted: 'out of quota',
  split_proposed: 'proposing a split',
  failed: 'failed',
  // Not "stalled" flat: the state is still `working` and the agent may simply
  // be slow. The card should prompt a look, not report a diagnosis it has not
  // made.
  stalled: 'quiet — may be stuck',
};

function tokens(session: Session): number {
  return session.agents.reduce((n, a) => n + a.usage.inputTokens + a.usage.outputTokens, 0);
}

/**
 * What a session has spent, across its agents.
 *
 * `sumCost` rather than a reduce with `+`, because one agent nobody can price
 * makes the whole total unknowable — and a figure that quietly drops it is
 * smaller than the truth, which is the one direction this must not be wrong in.
 */
function spend(session: Session): ReturnType<typeof sumCost> {
  return sumCost(session.agents.map((a) => a.usage.cost));
}

/** `1.2k` rather than `1234`: the magnitude is the information on a card. */
function format(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Coarse on purpose: "2m" is the answer, "2m 14s" is noise on a card. */
function ago(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export interface DashboardProps {
  sessions: Session[];
  hosts: HostInfo[];
  onOpen: (sessionId: string, instanceId: string) => void;
  /** Injectable so a test is not at the mercy of the clock. */
  now?: number;
}

export function Dashboard({ sessions, hosts, onOpen, now }: DashboardProps): JSX.Element {
  const at = now ?? Date.now();
  // Re-ranked here rather than trusted. They arrive ordered, and then drift:
  // pushes replace sessions in place as their state changes, so a session that
  // starts needing you keeps whatever position it had when it did not.
  const ranked = [...sessions].sort(byAttentionThenRecency);
  const needing = ranked.filter((s) => s.needsAttention !== null);
  const rest = ranked.filter((s) => s.needsAttention === null);

  return (
    <div className="min-h-0 grid content-start gap-6 overflow-y-auto p-4" data-testid="dashboard">

      {needing.length > 0 && (
        <section className="grid gap-2" data-testid="needs-you">
          {/* First and separated, because the whole reason to look at this screen
              is to find the sessions that cannot continue without you. Mixed
              into a list sorted by time they are just the ones nearer the top. */}
          <span className={`${LABEL} text-state-paused`}>Needs you</span>
          <Grid sessions={needing} hosts={hosts} onOpen={onOpen} at={at} />
        </section>
      )}

      {rest.length > 0 && (
        <section className="grid gap-2" data-testid="everything-else">
          <span className={`${LABEL} text-muted`}>
            {needing.length > 0 ? 'Everything else' : 'Sessions'}
          </span>
          <Grid sessions={rest} hosts={hosts} onOpen={onOpen} at={at} />
        </section>
      )}
    </div>
  );
}

function Grid({
  sessions,
  hosts,
  onOpen,
  at,
}: {
  sessions: Session[];
  hosts: HostInfo[];
  onOpen: (sessionId: string, instanceId: string) => void;
  at: number;
}): JSX.Element {
  return (
    // One column on a phone, filling out as the window allows. `auto-fill` with
    // a minimum rather than a fixed count, so the layout follows the window
    // instead of a guess about it.
    <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(15rem,1fr))]">
      {sessions.map((session) => (
        <Card
          key={session.sessionId}
          session={session}
          // Only when there is more than one. With a single host the badge is
          // the same string on every card — §10 wants "where is this running"
          // answerable at a glance, and a label that never varies answers
          // nothing while taking the width that the title needs.
          host={hosts.length > 1 ? (hosts.find((h) => h.instanceId === session.instanceId) ?? null) : null}
          onOpen={onOpen}
          at={at}
        />
      ))}
    </div>
  );
}

function Card({
  session,
  host,
  onOpen,
  at,
}: {
  session: Session;
  host: HostInfo | null;
  onOpen: (sessionId: string, instanceId: string) => void;
  at: number;
}): JSX.Element {
  const attention = session.needsAttention;
  return (
    <button
      data-testid="session-card"
      data-title={session.title}
      data-state={session.state}
      /*
       * One border, the same on every card.
       *
       * It was amber whenever the session needed a person — under a heading that
       * already says "Needs you", above a line that already says "waiting for
       * you", on a card sitting in the section built to hold exactly these. Four
       * such sessions drew four glowing outlines, so the most emphatic thing on
       * the screen was the property they all shared, and nothing was left to
       * pick out the one that mattered.
       *
       * The state word keeps the colour: one statement of the fact, where the
       * reader is already looking, still distinguishing an amber pause from a
       * red failure as §4.1 requires.
       */
      className="bg-panel border-line hover:border-accent grid gap-2 rounded-surface border p-3 text-left"
      onClick={() => onOpen(session.sessionId, session.instanceId)}
    >
      {/* `min-w-0` on the row, not on the title.

          The title already truncates, and it still tore the card open: a long
          one ran past the border, off the viewport on a phone, and pushed the
          timestamp out of existence entirely. The clipping was never reached
          because this row is a **grid item**, and a grid item's `min-width:
          auto` resolves to its content's minimum — which, for an unbreakable
          `whitespace-nowrap` title, is the whole title. So the row grew wider
          than the card and carried the truncating span out with it.

          Worth stating plainly because the instinct is to add `truncate` to the
          span that is already truncating. The overflow is one level up from the
          element that looks responsible for it. */}
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <span className="truncate-line text-[13px]">{session.title}</span>
        <span className={`${LABEL} shrink-0 text-muted`}>{ago(session.updatedAt, at)}</span>
      </div>

      <div className="flex min-w-0 items-baseline gap-2">
        {/* Which machine, on every card. With several hosts attached, "where is
            this running" has to be answerable without opening it (§10). */}
        {host !== null && (
          <span
            data-testid="card-host"
            className={`${LABEL} shrink-0 ${
              host.targetKind === 'local' ? 'text-muted' : 'text-accent'
            }`}
          >
            {host.label}
          </span>
        )}
        {/* Quiet: this card is inside the section whose heading is the amber
            one. `failed` still shows red — see `quietTone`. */}
        <LiveDot state={session.state} />
        <span className={`${LABEL} truncate-line ${quietTone(session.state)}`}>
          {attention !== null ? ASKS[attention.reason] : session.state.replace(/_/g, ' ')}
        </span>
      </div>

      {/* Where it actually is (§4.3).

          A blockage that bubbled up from a descendant is shown with the path to
          it, because "something below this needs you" is not something you can
          act on — a child three levels down is the easiest thing in the system
          to lose, and telling you only that it exists loses it differently. */}
      {attention?.from !== undefined && (
        <span
          data-testid="card-attention-path"
          className={`${LABEL} truncate-line text-state-paused`}
        >
          in {attention.from.path.join(' › ')}
        </span>
      )}

      {session.agents.length > 0 && (
        <span className="text-muted truncate-line text-[11px]">
          {/* Live seats only. A card is a one-line answer to "what is this and
              what is it costing"; listing a model the session stopped using
              would say it runs two (§4.2). The change itself is in the
              transcript, which is where a history belongs. */}
          {session.agents
            .filter((a) => a.status !== 'retired')
            .map((a) => a.spec.runtimeId)
            .join(', ')}
          {tokens(session) > 0 ? ` · ${format(tokens(session))} tokens` : ''}
          {/* §10's three fidelities, and the third is why this is a function
              rather than a `toFixed`: an unobservable cost has to say so. */}
          {spend(session) !== 0 ? ` · ${formatCost(spend(session))}` : ''}
        </span>
      )}
    </button>
  );
}
