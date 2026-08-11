/**
 * The transcript, the composer, and the permission prompt.
 *
 * Extracted from `App.tsx` when the shell became host-aware: the sidebar now
 * carries host grouping and badges, and mixing that with per-event rendering in
 * one file made both harder to follow. These components know nothing about hosts
 * — an event reads the same wherever it was produced.
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { AgbrteEvent, ContentBlock, SplitProposal } from '../shared/types/index.js';
import { AttachmentChip, CapturePicker, type Attachment } from './Capture.js';
import { Dictate } from './Dictate.js';

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
      /*
       * A measure, not the window.
       *
       * The transcript is prose — the agent's replies, the user's turns — and it
       * was set across the whole pane, which on a 1440px window runs well past
       * 150 characters a line. Beyond roughly 75 the eye loses the start of the
       * next line on the return sweep, which is why every tradition that has had
       * to be read for hours settles near 65.
       *
       * On the container rather than on each row: the rows differ — a user turn
       * aligns right, a state line centres — and constraining them individually
       * would make every new row re-decide the measure. It stays left rather
       * than centring so the transcript and the composer below it share an edge;
       * a column that floats in the middle of its pane is a second alignment for
       * no reason.
       */
      className="grid min-h-0 w-full max-w-[72ch] flex-1 content-start gap-2.5 overflow-y-auto p-4.5"
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

export function EventRow({
  event,
  by,
}: {
  event: AgbrteEvent;
  /**
   * Which agent produced this, when the roster has more than one (§4.2).
   *
   * `null` for a single-agent session, where every row would carry the same
   * label — noise that teaches people to stop reading labels that do mean
   * something.
   */
  by?: string | null;
}): JSX.Element | null {
  const who =
    by == null ? null : (
      <span data-testid="row-agent-label" className="text-muted shrink-0 text-[10px] uppercase tracking-wider">
        {by}
      </span>
    );

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
          {who}
          <p className="wrap-anywhere">{event.text}</p>
        </div>
      );

    case 'agent.tool_use':
      return (
        <div data-testid="row-tool" className={META_ROW}>
          {who}
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
  sessionId,
  lastAgentText,
}: {
  onSend: (text: string, blocks?: ContentBlock[]) => void;
  disabled: boolean;
  /** Turns waiting behind the running one — possibly sent from another device. */
  queued?: number;
  /** Which session a capture is stored against (§12.1). Absent hides the button. */
  sessionId?: string;
  /** The newest agent reply, for reading aloud when that is switched on (§12.4). */
  lastAgentText?: string;
}): JSX.Element {
  const [text, setText] = useState('');
  const [picking, setPicking] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const submit = (): void => {
    // An attachment on its own is a message. "Look at this" with nothing typed
    // is the most natural way to use a screenshot, and requiring a sentence
    // would be a rule invented by the form rather than by the user.
    if (text.trim() === '' && attachments.length === 0) return;
    onSend(
      text,
      attachments.map((a) => a.block),
    );
    setText('');
    setAttachments([]);
  };

  return (
    <form
      className="border-line relative flex items-end gap-2.5 border-t px-4.5 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {picking && sessionId !== undefined && (
        <CapturePicker
          sessionId={sessionId}
          onCaptured={(a) => setAttachments((prev) => [...prev, a])}
          onClose={() => setPicking(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a, i) => (
              <AttachmentChip
                key={a.block.sha256 + String(i)}
                attachment={a}
                onRemove={() =>
                  // Dropped from the turn, not from the store. The blob stays —
                  // it is content-addressed and already logged as attached, and
                  // deleting it here would mean a client could unmake a record
                  // the host wrote.
                  setAttachments((prev) => prev.filter((_, at) => at !== i))
                }
              />
            ))}
          </div>
        )}
      <textarea
        className="field max-h-44 min-h-[42px] w-full resize-y"
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
      </div>
      {sessionId !== undefined && (
        <Speak {...(lastAgentText !== undefined ? { agentText: lastAgentText } : {})} />
      )}
      {sessionId !== undefined && (
        <Dictate
          sessionId={sessionId}
          // Appended rather than replacing: dictating after typing is adding to
          // a thought, and §12.4 hands the words over for editing regardless.
          onTranscript={(spoken) =>
            setText((prev) => (prev.trim() === '' ? spoken : `${prev.trimEnd()} ${spoken}`))
          }
        />
      )}
      {sessionId !== undefined && (
        <button
          className="btn-quiet shrink-0 self-center"
          data-testid="composer-capture"
          type="button"
          title="Attach a screen capture"
          onClick={() => setPicking((p) => !p)}
        >
          Screen
        </button>
      )}
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
        disabled={disabled || (text.trim() === '' && attachments.length === 0)}
      >
        Send
      </button>
    </form>
  );
}

/**
 * Read replies aloud, off unless you ask (§12.4).
 *
 * The speaker follows the microphone's rule: *never hot by default*. Ten
 * sessions each announcing themselves is not a feature, and a machine that
 * starts talking because you opened an app is a machine people mute once and
 * never unmute.
 *
 * So it is per-session and opt-in, which is the arrangement §12.4 pairs with
 * push-to-talk — you turn it on for the thing you are actually working on, and
 * it stays off everywhere else.
 */
function Speak({ agentText }: { agentText?: string }): JSX.Element | null {
  const [on, setOn] = useState(false);
  const [mute, setMute] = useState(false);
  const spoken = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!on || agentText === undefined || agentText === spoken.current) return;
    spoken.current = agentText;
    void window.agbrte.voice.speak(agentText).then((could) => {
      // A client with no synthesiser says so once, by turning itself off, rather
      // than silently doing nothing every time a reply lands.
      if (!could) {
        setMute(true);
        setOn(false);
      }
    });
  }, [on, agentText]);

  // Stop the moment this goes away — a voice that outlives the pane it was
  // started from is the one failure a user cannot chase down.
  useEffect(() => () => void window.agbrte.voice.stopSpeaking(), []);

  if (mute) {
    return (
      <span className="text-muted shrink-0 self-center text-xs" title="No speech synthesis here">
        no voice
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="speak-replies"
      className={`btn-quiet shrink-0 self-center text-xs ${on ? 'text-accent' : ''}`}
      title="Read replies aloud. Off by default, and only for this session."
      onClick={() => {
        // Turning it off stops mid-sentence rather than finishing: the reason to
        // press it is usually that you want the talking to end now.
        if (on) void window.agbrte.voice.stopSpeaking();
        setOn((was) => !was);
      }}
    >
      {on ? '🔊 reading' : 'Read aloud'}
    </button>
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
