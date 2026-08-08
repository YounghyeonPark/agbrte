/**
 * The transcript, the composer, and the permission prompt.
 *
 * Extracted from `App.tsx` when the shell became host-aware: the sidebar now
 * carries host grouping and badges, and mixing that with per-event rendering in
 * one file made both harder to follow. These components know nothing about hosts
 * — an event reads the same wherever it was produced.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { AgbrteEvent, SplitProposal } from '../shared/types/index.js';

const META_ROW = 'text-muted flex items-baseline gap-2 text-xs';
const CODE = 'text-accent rounded bg-[#202029] px-1.5 py-px font-mono text-[11px]';

export function Transcript({
  events,
  renderRow,
}: {
  events: AgbrteEvent[];
  renderRow: (event: AgbrteEvent) => ReactNode;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Follow the tail only when already at the bottom. Scrolling unconditionally
  // yanks the view away the moment you scroll up to read something.
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [events]);

  return (
    <div
      data-testid="transcript"
      className="grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto p-4.5"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {events.map((event) => renderRow(event))}
      <div ref={endRef} />
    </div>
  );
}

export function EventRow({ event }: { event: AgbrteEvent }): JSX.Element | null {
  switch (event.type) {
    case 'user.turn':
      return (
        <div
          data-testid="row-user"
          className="bg-user-bubble border-user-edge max-w-[78%] justify-self-end rounded-[10px_10px_2px_10px] border px-3 py-2"
        >
          {event.content.map((block, i) =>
            block.type === 'text' ? (
              <p key={i} className="wrap-anywhere">
                {block.text}
              </p>
            ) : (
              <p key={i}>[{block.type}]</p>
            ),
          )}
        </div>
      );

    case 'agent.text':
      return (
        <div
          data-testid="row-agent"
          className="bg-panel border-line max-w-[82%] rounded-[10px_10px_10px_2px] border px-3 py-2"
        >
          <p className="wrap-anywhere">{event.text}</p>
        </div>
      );

    case 'agent.tool_use':
      return (
        <div data-testid="row-tool" className={META_ROW}>
          <code className={CODE}>{event.tool}</code>
          <span className="truncate-line font-mono text-[11px]">{summarize(event.args)}</span>
        </div>
      );

    case 'agent.tool_result':
      return (
        <div
          data-testid={event.ok ? 'row-result' : 'row-result-failed'}
          className={`${META_ROW} ${event.ok ? '' : 'text-state-fail'}`}
        >
          <span className="truncate-line">{event.summary}</span>
        </div>
      );

    case 'permission.decided':
      // Shown because §13 requires every decision be recorded; a transcript that
      // hides the allows reads as though the gate was never consulted.
      return (
        <div data-testid="row-decision" className={META_ROW}>
          <code className={CODE}>{event.tool}</code>
          <span>
            {event.decision.result} via {event.via}
          </span>
        </div>
      );

    case 'agent.stopped':
      return (
        <div
          data-testid="row-stopped"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          <span>{event.stop.kind.replace(/_/g, ' ')}</span>
        </div>
      );

    case 'session.state':
      return (
        <div
          data-testid="row-state"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          <span>
            {event.from} → {event.to}
            {event.reason !== undefined ? ` (${event.reason})` : ''}
          </span>
        </div>
      );

    // Everything else is bookkeeping — usage, checkpoints, agent lifecycle. It is
    // in the log and reachable, just not worth a line in the conversation.
    default:
      return null;
  }
}

export function PermissionPrompt({
  tool,
  args,
  onDecide,
}: {
  tool: string;
  args: string;
  onDecide: (allow: boolean) => void;
}): JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={`Permission requested for ${tool}`}
      data-testid="prompt"
      className="border-state-paused mx-4.5 flex items-center justify-between gap-4 rounded-lg border bg-[#2a2418] px-3.5 py-3"
    >
      <div className="grid min-w-0 gap-0.5">
        <strong data-testid="prompt-tool">{tool}</strong>
        <span className="text-muted truncate-line font-mono text-[11px]">{args}</span>
      </div>
      <div className="flex shrink-0 gap-2">
        <button className="btn" data-testid="prompt-allow" onClick={() => onDecide(true)}>
          Allow once
        </button>
        <button
          className="btn border-state-fail hover:border-state-fail"
          data-testid="prompt-deny"
          onClick={() => onDecide(false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}

/**
 * A split an agent wants, waiting for a person (DESIGN.md §4.3).
 *
 * Deliberately not shaped like the permission prompt above, although both are
 * "an agent is asking". A permission decision is a reflex — you recognise the
 * command or you do not. Approving a split is a **judgement**: it creates a
 * session, reserves budget out of this one, and commits to a seam. §4.3 keeps
 * it user-approved precisely because getting it wrong produces a tree that is
 * harder to salvage than one overlong session, so everything needed to judge it
 * is on screen rather than a click away.
 *
 * `outOfScope` is shown as prominently as the scope. It is the field that stops
 * the child re-deriving this session's context, and a reviewer who cannot see
 * the exclusions is approving half a proposal.
 */
export function SplitPrompt({
  proposal,
  onDecide,
}: {
  proposal: SplitProposal;
  onDecide: (approved: boolean) => void;
}): JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={`Split proposed: ${proposal.title}`}
      data-testid="split-prompt"
      data-proposal={proposal.proposalId}
      className="border-accent mx-4.5 grid gap-2 rounded-lg border bg-[#16202a] px-3.5 py-3"
    >
      <div className="grid gap-0.5">
        <strong data-testid="split-title">Split off: {proposal.title}</strong>
        {/* The reason, because someone asked to approve with no stated why can
            only say yes. */}
        <span className="text-muted text-[11px]">{proposal.why}</span>
      </div>

      <dl className="grid gap-1 text-[11px]">
        <div className="flex gap-2">
          <dt className="text-muted w-20 shrink-0">Scope</dt>
          <dd data-testid="split-scope">{proposal.scope}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted w-20 shrink-0">Not this</dt>
          <dd data-testid="split-out-of-scope">{proposal.outOfScope.join(' · ')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-muted w-20 shrink-0">Budget</dt>
          {/* Reserved out of this session at spawn, so the number is what this
              session gives up rather than what the child might use. */}
          <dd data-testid="split-budget">
            {proposal.tokenCeiling.toLocaleString()} tokens, reserved from this session
          </dd>
        </div>
      </dl>

      <div className="flex shrink-0 justify-end gap-2">
        <button className="btn" data-testid="split-approve" onClick={() => onDecide(true)}>
          Split it off
        </button>
        <button className="btn" data-testid="split-decline" onClick={() => onDecide(false)}>
          Keep it here
        </button>
      </div>
    </div>
  );
}

export function Composer({
  onSend,
  disabled,
  queued = 0,
}: {
  onSend: (text: string) => void;
  disabled: boolean;
  /** Turns waiting behind the running one — possibly sent from another device. */
  queued?: number;
}): JSX.Element {
  const [text, setText] = useState('');

  const submit = (): void => {
    if (text.trim() === '') return;
    onSend(text);
    setText('');
  };

  return (
    <form
      className="border-line flex items-end gap-2.5 border-t px-4.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <textarea
        className="field max-h-44 min-h-[42px] resize-y"
        data-testid="composer-input"
        value={text}
        placeholder={disabled ? 'Working…' : 'Ask the agent to do something'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter newlines — the convention for this shape of
          // input, and worth matching so muscle memory works.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      {/* Sending into a silent queue reads as a broken app, and with several
          clients the backlog may not be yours. */}
      {queued > 0 && (
        <span data-testid="queued" className="text-state-paused shrink-0 self-center text-xs">
          {queued} waiting
        </span>
      )}
      <button
        className="btn"
        data-testid="composer-send"
        type="submit"
        disabled={disabled || text.trim() === ''}
      >
        Send
      </button>
    </form>
  );
}

/** A one-line rendering of tool arguments. Never the whole object. */
export function summarize(args: unknown): string {
  if (args === null || typeof args !== 'object') return String(args);
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
  });
  const joined = parts.join(' ');
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}
