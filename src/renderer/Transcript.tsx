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
const CODE = 'text-accent rounded-mark bg-raised px-2 py-px font-mono text-[11px]';

/**
 * Three dots that light up in sequence: the mark that a turn is in flight.
 *
 * All motion is in the stylesheet (`working-dot` in styles.css) — an
 * `animation-delay` per dot, no timer per row, because a React interval for
 * every working session is exactly the leak the renderer discipline forbids.
 * Under `prefers-reduced-motion` the same markup rests as a static ellipsis.
 *
 * `aria-hidden`, because the word beside it already says "working" and a
 * screen reader spelling out three periods helps nobody.
 */
export function WorkingDots(): JSX.Element {
  return (
    <span className="working-dots" aria-hidden="true">
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  );
}

export function Transcript({
  events,
  renderRow,
  working = false,
}: {
  events: AgbrteEvent[];
  renderRow: (event: AgbrteEvent) => ReactNode;
  /**
   * True while the session's turn is in flight, so the tail shows motion where
   * the next event will land. Session state, not an event: it is the one thing
   * here that is *about* the log rather than in it.
   */
  working?: boolean;
}): JSX.Element {
  const endRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);

  // Follow the tail only when already at the bottom. Scrolling unconditionally
  // yanks the view away the moment you scroll up to read something.
  // `working` is a dependency because the indicator row appearing moves the
  // bottom just as a new event does.
  useEffect(() => {
    if (atBottomRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [events, working]);

  return (
    <div
      data-testid="transcript"
      /*
       * Fluid, where a 72ch cap used to be.
       *
       * The cap bought a readable measure and paid for it with the window: on a
       * maximised screen the right half of the pane was empty dark space, and
       * the state rows, prompts and composer around the transcript all ran
       * full-width past the column they were meant to frame. Line length is the
       * rows' business now — the bubbles cap themselves as fractions of the
       * pane, so they track a resize instead of ignoring it.
       *
       * The explicit `minmax(0,1fr)` track is what keeps the horizontal
       * scrollbar off the pane. A grid track will not shrink below its
       * content's minimum by default, so one unbroken line — a long path in a
       * tool summary, a rule of box-drawing characters — widened the track past
       * the container and gave the transcript its own scrollbar. Wide content
       * wraps or scrolls inside its own row; the pane never scrolls sideways.
       */
      className="min-h-0 w-full flex-1 overflow-y-auto overflow-x-hidden px-6 py-4"
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {/*
        One column, centred, and the same width as the box below it.

        The cap came back, and not as the 72ch measure that was removed: what
        made that one wrong was that only the *transcript* obeyed it while the
        state rows, the prompts and the composer ran full width past the column
        they were meant to frame. All of them share this width now, so the
        session reads as one conversation rather than as text stretched across a
        monitor with controls scattered around its edges.

        The scroll lives on the parent and the cap on this child, so the
        scrollbar stays at the pane's edge instead of appearing halfway across
        it.
      */}
      <div className="mx-auto grid w-full max-w-3xl [grid-template-columns:minmax(0,1fr)] content-start gap-3">
        {events.map((event) => renderRow(event))}
      {working && (
        /* A whisper at the tail, in the meta-row voice: mid-turn the place the
           next event will appear shows life rather than a frozen last line. */
        <div data-testid="row-working" className={META_ROW}>
          <span>
            working
            <WorkingDots />
          </span>
        </div>
      )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export function EventRow({
  event,
  by,
  live = false,
}: {
  event: AgbrteEvent;
  /**
   * This row is the thing currently happening.
   *
   * Only ever true for a tool call whose result has not arrived, and only while
   * the session is working — a transcript being read back later has no live
   * row, and a call left unfinished by a crashed turn must not sweep forever.
   * A process indicator that outlives its process is the standard way this
   * pattern goes wrong: it stops meaning "running" and becomes decoration.
   */
  live?: boolean;
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
          className="bg-user-bubble border-user-edge max-w-[78%] justify-self-end rounded-surface border px-3 py-2"
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
          className="bg-panel border-line max-w-[82%] rounded-surface border px-3 py-2"
        >
          {who}
          <p className="wrap-anywhere">{event.text}</p>
        </div>
      );

    case 'agent.tool_use':
      return (
        <div
          data-testid="row-tool"
          /* The sweep sits on the row rather than on the tool name, because what
             is running is the call — reading a file, waiting on a shell — and
             the argument beside it is part of what you are waiting on. */
          className={`${META_ROW} ${live ? 'live-sweep rounded-mark' : ''}`}
          {...(live ? { 'data-live': 'true' } : {})}
        >
          {who}
          <code className={CODE}>{event.tool}</code>
          {/* `min-w-0`, because a flex item will not shrink below its content —
              without it the ellipsis never engages and the untruncated line is
              what used to widen the whole pane. */}
          <span className="truncate-line min-w-0 font-mono text-[11px]">{summarize(event.args)}</span>
        </div>
      );

    case 'agent.tool_result':
      return (
        <div
          data-testid={event.ok ? 'row-result' : 'row-result-failed'}
          className={`${META_ROW} ${event.ok ? '' : 'text-state-fail'}`}
        >
          <span className="truncate-line min-w-0">{event.summary}</span>
        </div>
      );

    case 'agent.reasoning':
      /*
       * Folded by default, because it is evidence rather than an answer.
       *
       * Open by default would bury every reply under the working-out that
       * produced it — often several times its length — and a transcript is read
       * for what was decided first and how second. `<details>` rather than a
       * custom toggle: it is keyboard-reachable, findable by the browser's own
       * text search when open, and needs no state of its own.
       */
      return (
        <details data-testid="row-reasoning" className={META_ROW}>
          <summary className="cursor-pointer">
            thought for {event.text.length.toLocaleString()} characters
          </summary>
          {/* `overflow-x-auto`: pre-wrap wraps at break points and an ASCII
              diagram has none, so an unbroken run scrolls inside this box
              rather than putting a scrollbar on the pane. */}
          <div className="text-muted mt-1 overflow-x-auto whitespace-pre-wrap font-mono text-[11px]">
            {event.text}
          </div>
        </details>
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

    case 'permission.standing_grant':
      // The line every later `via standing-grant` refers back to (§17 Q19):
      // where the questions stopped, and on whose say-so. Bookkeeping would be
      // the wrong bucket for a change in who is answerable.
      return (
        <div
          data-testid="row-standing-grant"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          <span>
            ⚖ standing grant{event.actor?.label !== undefined ? ` · ${event.actor.label}` : ''} —
            every ask from here on is allowed without a prompt
          </span>
        </div>
      );

    case 'agent.stopped':
      return (
        <div
          data-testid="row-stopped"
          className={`${META_ROW} border-line justify-center border-t pt-2 text-[11px]`}
        >
          {/* The kind is a taxonomy label, and for most stops it is also the
              whole story. `auth` is the one where it is not: "auth" tells a
              person that something is wrong with a credential and nothing about
              what to do, which is how a turn that ended with the CLI asking to
              be logged in read as ordinary output with no way forward. */}
          <span>
            {event.stop.kind.replace(/_/g, ' ')}
            {event.stop.kind === 'auth' && event.stop.detail !== undefined
              ? ` — ${event.stop.detail}`
              : ''}
          </span>
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

    /*
     * A session talking to another session (§17 Q22).
     *
     * In the conversation rather than in the bookkeeping bucket, because it is
     * the reason the turn beside it exists: a session woken by a sibling shows a
     * `user.turn` nobody typed, and without this line above it that turn reads
     * as a person's. The panel is a filtered view of these; this is the row in
     * the timeline they came from.
     *
     * A refusal keeps its line, and says so. §4.2 records what a roster tried to
     * say because that is the interesting part when it misbehaves, and a
     * transcript showing only the messages that landed would answer the wrong
     * question one boundary further out.
     */
    case 'session.peer_message_sent':
      return (
        <div
          data-testid={event.delivered ? 'row-peer-sent' : 'row-peer-refused'}
          className={`${META_ROW} ${event.delivered ? '' : 'text-state-fail'}`}
        >
          {who}
          <span className="truncate-line min-w-0">
            → {event.message.toSessionId} · {event.message.kind}
            {event.delivered ? '' : ` — not delivered: ${event.refusedBecause ?? 'refused'}`}
          </span>
        </div>
      );

    case 'session.peer_message_received':
      return (
        <div data-testid="row-peer-received" className={META_ROW}>
          <span className="truncate-line min-w-0">
            ← {event.message.fromSessionId} · {event.message.kind}
          </span>
        </div>
      );

    /*
     * What this session was given, at the point it was given it (§17 Q20).
     *
     * In the conversation rather than filed under bookkeeping because the row
     * above it is the provenance of every `mcp__…` call below it: which command,
     * offering which tools. The env *names* are shown and the values are not
     * present in the event to show — §13's rule, which is also why a restart
     * leaves these lines as the only record that the tools were ever here.
     */
    case 'mcp.attached':
      return (
        <div data-testid="row-mcp-attached" className={META_ROW}>
          <code className={CODE}>mcp · {event.serverId}</code>
          <span className="truncate-line min-w-0">
            {event.toolNames.length === 0
              ? 'attached, but offered no tools'
              : event.toolNames.join(', ')}
            {event.envKeys !== undefined && event.envKeys.length > 0
              ? ` · env ${event.envKeys.join(', ')}`
              : ''}
          </span>
        </div>
      );

    case 'mcp.failed':
      // §3.5, in the log's own order: the failure sits where the tool names
      // would have been, so a later "the model never used my tool" has an
      // answer in the transcript rather than in a support thread.
      return (
        <div data-testid="row-mcp-failed" className={`${META_ROW} text-state-fail`}>
          <code className={CODE}>mcp · {event.serverId}</code>
          <span className="truncate-line min-w-0">did not start — {event.reason}</span>
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
      className="border-state-paused mx-4 flex shrink-0 items-center justify-between gap-4 rounded-surface border bg-panel px-4 py-3"
    >
      <div className="grid min-w-0 gap-1">
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
  budgeted,
  onDecide,
}: {
  proposal: SplitProposal;
  /**
   * Whether this session holds a ceiling for the child to be reserved from.
   *
   * Passed rather than assumed because §4.3 now lets an unbudgeted session
   * split — the absence carries down — and the row below said "reserved from
   * this session" unconditionally. On a session with no ceiling that sentence
   * described an accounting entry nobody was going to make, in the one prompt
   * the design puts the number on screen to be judged by.
   */
  budgeted: boolean;
  onDecide: (approved: boolean) => void;
}): JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-label={`Split proposed: ${proposal.title}`}
      data-testid="split-prompt"
      data-proposal={proposal.proposalId}
      className="border-accent mx-4 grid shrink-0 gap-2 rounded-surface border bg-panel px-4 py-3"
    >
      <div className="grid gap-1">
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
              session gives up rather than what the child might use — when there
              is anything to give up. On an unbudgeted session the absence
              carries down instead (§4.3) and the proposed figure is not applied
              anywhere, which is a materially different thing to be approving
              and so is said rather than left to be inferred from a number. */}
          <dd data-testid="split-budget">
            {budgeted
              ? `${proposal.tokenCeiling.toLocaleString()} tokens, reserved from this session`
              : `asked for ${proposal.tokenCeiling.toLocaleString()} tokens; this session has no ceiling, so the child runs unbudgeted too`}
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
  meta,
  tools,
}: {
  onSend: (text: string, blocks?: ContentBlock[]) => void;
  disabled: boolean;
  /**
   * What this seat is, above the message being written to it.
   *
   * Passed in rather than imported so this file keeps owning the *box* and
   * nothing about what a session contains — and rendered inside the border
   * because that is the point of the border: the model that will answer, the
   * effort it will spend and the group it can talk to are all facts about the
   * turn about to be sent, not about the window.
   */
  meta?: JSX.Element | null;
  /** Controls that belong to the turn's surroundings — the pane, its files. */
  tools?: JSX.Element | null;
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
      /*
       * One box, with everything that acts on it inside it.
       *
       * This was a full-width strip: a textarea stretched across the monitor
       * with `Read aloud`, the microphone, `Screen` and `Send` trailing off to
       * the right of it, and the session's own controls in separate strips
       * above. Nothing said which of those belonged to the message being
       * written. Now the border is the answer — what is inside it is part of
       * writing a turn, and what is outside is not.
       *
       * `shrink-0` for the same reason as every fixed row around the transcript
       * (see SessionHeader): it must not be the row the column crushes.
       */
      className="border-line focus-within:border-accent/60 relative flex shrink-0 flex-col gap-2 rounded-surface border px-3 py-2 transition-colors"
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
      {meta !== undefined && meta !== null && (
        <div className="text-muted border-line/60 min-w-0 border-b pb-2">{meta}</div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2">
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
      {/* Borderless inside the box: the box is the field now, and a second
          outline around the text would draw a frame inside a frame. */}
      <textarea
        className="text-ink placeholder:text-muted max-h-44 min-h-[44px] w-full resize-none bg-transparent px-1 py-1 outline-none"
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
      {/* The row inside the box, which is what makes it one thing: everything
          here acts on the message above it, and `Send` sits at the end of the
          line the eye already finishes on. */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {tools}
        {sessionId !== undefined && (
          <Speak {...(lastAgentText !== undefined ? { agentText: lastAgentText } : {})} />
        )}
        {sessionId !== undefined && (
          <Dictate
            sessionId={sessionId}
            // Appended rather than replacing: dictating after typing is adding
            // to a thought, and §12.4 hands the words over for editing anyway.
            onTranscript={(spoken) =>
              setText((prev) => (prev.trim() === '' ? spoken : `${prev.trimEnd()} ${spoken}`))
            }
          />
        )}
        {sessionId !== undefined && (
          <button
            className="btn-quiet shrink-0"
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
          <span data-testid="queued" className="text-state-paused shrink-0 text-xs">
            {queued} waiting
          </span>
        )}
        <button
          className="btn ml-auto shrink-0"
          data-testid="composer-send"
          type="submit"
          disabled={disabled || (text.trim() === '' && attachments.length === 0)}
        >
          Send
        </button>
      </div>
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
      <span className="control-note shrink-0" title="No speech synthesis here">
        no voice
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid="speak-replies"
      className={`btn-quiet shrink-0 ${on ? 'text-accent border-accent/50' : ''}`}
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
