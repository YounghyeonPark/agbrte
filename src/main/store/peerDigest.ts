/**
 * What one session did, in a form another session can read (DESIGN.md §17 Q22).
 *
 * A group exists so sessions can divide work, and dividing work is only useful
 * if each half can find out what the other half did. `message_peer` carries a
 * sentence; this carries the record.
 *
 * ## Why this is a fold and not a copy
 *
 * The obvious reading of "share the history" is to put every peer's log into
 * every peer's context. That fails three ways at once, and the third is the one
 * that matters. It does not fit — a live session's log is thousands of events
 * and a group has several. It duplicates the record, so the same claim exists in
 * two places and §5.1's promise that a log is readable *alone* stops being the
 * only copy anybody consults. And it answers the wrong question: an agent
 * checking on its group almost never wants the transcript, it wants *what
 * happened since I last looked* — which is a fold over a window, keyed by a
 * cursor.
 *
 * So this reduces a log to lines. A turn asked for, a tool run, a conclusion
 * reached, a state changed. The things a colleague would tell you, in the order
 * they happened.
 *
 * ## What is deliberately dropped
 *
 * Tool *results* are not here, only the calls. A result is where the bulk is —
 * a file read is the file — and a peer reading a peer's log is the one caller
 * that can always go and look for itself: it is the same machine, the same
 * workspace, and the tools to read it are already in its hand. Summaries of
 * results would be a second, worse copy of the thing itself.
 *
 * Reasoning is dropped for a different reason: it is the model's working-out,
 * not its work, and handing another model a colleague's private thinking as
 * fact is how one agent's discarded hypothesis becomes another's premise.
 */

import type { AgbrteEvent, SessionState } from '@shared/types/index.js';

/** One line of what a peer did. */
export interface PeerHistoryLine {
  /** The event's own sequence, so a reader can resume from just after it. */
  seq: number;
  at: string;
  /** `turn`, `did`, `said`, `state` — enough to skim by. */
  kind: 'turn' | 'did' | 'said' | 'state';
  text: string;
}

/**
 * How much of one line survives.
 *
 * Generous enough to carry a command or a sentence, short enough that a hundred
 * of them are still a page. A log line is not a document; anything longer is a
 * pointer to something the reader can open.
 */
const LINE_MAX = 240;

/** The most lines one read returns, before the oldest are dropped. */
export const PEER_HISTORY_MAX_LINES = 80;

/**
 * The state changes worth telling a colleague about.
 *
 * Listed rather than derived, because the interesting ones are not a category —
 * they are the ones that mean *this session has stopped and will not continue
 * on its own*, plus the two ends of the story. `working` and `awaiting_input`
 * are excluded on purpose: every turn passes through both, so reporting them
 * would fill a digest with the fact that turns happen.
 */
const REPORTED_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'awaiting_permission',
  'awaiting_credentials',
  'awaiting_quota',
  'awaiting_children',
  'verifying',
  'done',
  'failed',
  'cancelled',
]);

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= LINE_MAX ? flat : `${flat.slice(0, LINE_MAX - 1)}…`;
}

/** The first text in a turn's content, which is what a person actually said. */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts = content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text ?? '');
  return parts.join(' ');
}

/**
 * Name a tool call by what it *did*, not by its arguments.
 *
 * `write hello.js` rather than the file's contents, `bash: node test.js` rather
 * than a JSON blob. The argument that names the object is the one worth having;
 * the rest is the payload, and the payload is the thing this whole module exists
 * not to copy.
 */
function describeCall(tool: string, args: unknown): string {
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>;
  const named = ['file_path', 'path', 'command', 'pattern', 'query', 'to'].find(
    (key) => typeof a[key] === 'string',
  );
  return named === undefined ? tool : `${tool}: ${String(a[named])}`;
}

/**
 * Fold a peer's events into readable lines.
 *
 * Pure, and takes the events rather than a store, so the shape of the answer can
 * be tested from literals — the part most likely to drift is what counts as
 * worth reporting, and that is decided entirely here.
 */
export function digestPeerLog(events: readonly AgbrteEvent[]): {
  lines: PeerHistoryLine[];
  /** The seq to ask from next time, whether or not anything was kept. */
  nextSince: number;
  /** Whether older lines were dropped to fit. */
  truncated: boolean;
} {
  const lines: PeerHistoryLine[] = [];
  let highest = 0;

  for (const event of events) {
    highest = Math.max(highest, event.seq);
    const at = event.at;
    const seq = event.seq;

    switch (event.type) {
      case 'user.turn': {
        const text = clip(textOf(event.content));
        if (text !== '') lines.push({ seq, at, kind: 'turn', text });
        break;
      }
      case 'agent.text': {
        const text = clip(event.text);
        if (text !== '') lines.push({ seq, at, kind: 'said', text });
        break;
      }
      case 'agent.tool_use':
        lines.push({ seq, at, kind: 'did', text: clip(describeCall(event.tool, event.args)) });
        break;
      case 'agent.stopped':
        // Only the ones that are not the ordinary end of a turn. `end_turn` on
        // every turn would be half the digest and would say nothing.
        if (event.stop.kind !== 'end_turn' && event.stop.kind !== 'tool_calls') {
          lines.push({ seq, at, kind: 'state', text: `stopped: ${event.stop.kind}` });
        }
        break;
      case 'session.state':
        if (REPORTED_STATES.has(event.to)) {
          lines.push({ seq, at, kind: 'state', text: `→ ${event.to}` });
        }
        break;
      default:
        break;
    }
  }

  const truncated = lines.length > PEER_HISTORY_MAX_LINES;
  return {
    // The *newest* are kept when it will not all fit. A peer checking in wants
    // the end of the story; the beginning is what it already read last time.
    lines: truncated ? lines.slice(-PEER_HISTORY_MAX_LINES) : lines,
    nextSince: highest,
    truncated,
  };
}

/**
 * One line saying what a peer is doing now, for the roster every turn carries.
 *
 * The always-on half of this feature, and deliberately tiny. A group member does
 * not need its colleagues' work in front of it at all times — it needs to know
 * *whether there is anything to go and read*, which is one state and one recent
 * action. The reading itself is a tool call it makes when the answer is yes.
 */
export function summarisePeer(events: readonly AgbrteEvent[]): string | undefined {
  const { lines } = digestPeerLog(events);
  const last = [...lines].reverse().find((l) => l.kind === 'did' || l.kind === 'said');
  return last === undefined ? undefined : clip(last.text);
}
