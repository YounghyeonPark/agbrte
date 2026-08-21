/**
 * The group this session is in, and what it has said (DESIGN.md §17 Q22).
 *
 * ## Why a panel rather than a second transcript
 *
 * A cross-session exchange is a handful of lines in a session that may run for
 * days, and it is read for a different reason than the transcript is: not *what
 * did this session do*, but *what did it ask of, or owe to, the work beside it*.
 * The same argument that put artifacts in a panel rather than inline puts this
 * one there — with the difference that the messages **are** in the transcript
 * too, because they are events in the log like everything else. This is a view
 * over them, not a second copy.
 *
 * ## Folded by default
 *
 * `<details>`, closed, so it costs one line in a column whose only child allowed
 * to give up height is the transcript. A session in no group still shows the
 * control, because that is where you go to make one — but it says so in a line
 * rather than taking a section for a feature nobody has used yet.
 *
 * ## Only sessions on this machine are offered
 *
 * A group is same-host in this version, and the honest place to say so is the
 * picker: offering a session on another machine and then refusing it would be
 * teaching people a control that does not work. The refusal still exists one
 * layer down — `Fleet.group` names the machines — because a UI filter is not an
 * enforcement boundary.
 */

import { useState, type JSX } from 'react';
import type { AgbrteEvent, PeerMessage, Session } from '../shared/types/index.js';
import { LABEL } from './App.js';

export interface GroupProps {
  session: Session;
  /** Every session the app knows about, for members and for the picker. */
  sessions: Session[];
  /** The window the renderer already holds; no fetch of its own (§7). */
  events: readonly AgbrteEvent[];
  /** Group `sessionId` with the open session, under `name` when starting one. */
  onGroup: (sessionId: string, name: string) => void;
  onLeave: () => void;
  onOpen: (sessionId: string) => void;
}

/** A peer message pulled out of the event window, with its direction. */
interface Line {
  seq: number;
  direction: 'sent' | 'received';
  message: PeerMessage;
  /** Set on an attempt that was refused — recorded, never hidden (§4.2). */
  refusedBecause?: string;
}

function exchange(events: readonly AgbrteEvent[]): Line[] {
  const lines: Line[] = [];
  for (const event of events) {
    if (event.type === 'session.peer_message_sent') {
      lines.push({
        seq: event.seq,
        direction: 'sent',
        message: event.message,
        // A refused message is shown, not dropped. §4.2 keeps refusals in the
        // log because what a roster *tried* to say is usually the interesting
        // part when it misbehaves, and a panel that showed only what landed
        // would put that back out of reach.
        ...(event.delivered ? {} : { refusedBecause: event.refusedBecause ?? 'not delivered' }),
      });
    } else if (event.type === 'session.peer_message_received') {
      lines.push({ seq: event.seq, direction: 'received', message: event.message });
    }
  }
  return lines;
}

export function Group({
  session,
  sessions,
  events,
  onGroup,
  onLeave,
  onOpen,
}: GroupProps): JSX.Element {
  const [name, setName] = useState('');
  const [pick, setPick] = useState('');

  const group = session.group;
  /*
   * Guarded on `group` rather than comparing through it.
   *
   * `s.group?.groupId === group?.groupId` reads as "same group" and is not: with
   * no group open, both sides are `undefined` and every ungrouped session in the
   * fleet matches, so a session in no group would list the whole app as its
   * members. It is unreachable today only because the caller below renders this
   * behind `group !== undefined` — which makes the list correct by the accident
   * of who reads it, and the next reader would not know that.
   */
  const members =
    group === undefined
      ? []
      : sessions.filter((s) => s.sessionId !== session.sessionId && s.group?.groupId === group.groupId);
  /*
   * Same host, and not already in *this* group. A session in another group is
   * offered: moving one is a legitimate thing to do, and the log records it.
   *
   * The `group === undefined` arm is the load-bearing half, not a tidy-up. The
   * comparison alone was `s.group?.groupId !== group?.groupId`, and with no
   * group open that is `undefined !== undefined` — false for every ungrouped
   * session, which is all of them. The picker was therefore always empty in the
   * one case the feature exists for (two fresh sessions, neither grouped) and
   * the panel said "no other session on this machine" beside a sidebar showing
   * two. Nothing below this could be reached, so `Fleet.group` was never called
   * from the UI at all.
   */
  const candidates = sessions.filter(
    (s) =>
      s.sessionId !== session.sessionId &&
      s.instanceId === session.instanceId &&
      (group === undefined || s.group?.groupId !== group.groupId),
  );
  const lines = exchange(events);

  return (
    <details className="shrink-0 px-1 py-1" data-testid="group">
      <summary className={`${LABEL} text-muted cursor-pointer`}>
        {group === undefined ? 'group — none' : `group — ${group.name}`}
        {lines.length > 0 ? ` · ${lines.length} message${lines.length === 1 ? '' : 's'}` : ''}
      </summary>

      <div className="grid gap-2 pt-2">
        {group !== undefined && (
          <div className="grid gap-1" data-testid="group-members">
            <span className={`${LABEL} text-muted`}>members</span>
            {members.length === 0 ? (
              /* Said out loud. A group of one is a real state — the others were
                 removed, or are on a host that is not attached right now — and
                 an empty list reads as a panel that failed to load. */
              <span className="text-muted text-[11px]" data-testid="group-alone">
                nobody else here yet
              </span>
            ) : (
              members.map((m) => (
                <button
                  key={m.sessionId}
                  className="btn text-left text-[11px]"
                  data-testid="group-member"
                  onClick={() => onOpen(m.sessionId)}
                >
                  {m.title}
                </button>
              ))
            )}
            <button className="btn text-[11px]" data-testid="group-leave" onClick={onLeave}>
              Leave this group
            </button>
          </div>
        )}

        <div className="grid gap-1">
          <span className={`${LABEL} text-muted`}>
            {group === undefined ? 'start a group with' : 'add a session'}
          </span>
          {candidates.length === 0 ? (
            <span className="text-muted text-[11px]" data-testid="group-no-candidates">
              no other session on this machine
            </span>
          ) : (
            <>
              <select
                className="btn text-[11px]"
                data-testid="group-pick"
                value={pick}
                onChange={(e) => setPick(e.target.value)}
              >
                <option value="">choose a session…</option>
                {candidates.map((c) => (
                  <option key={c.sessionId} value={c.sessionId}>
                    {c.title}
                  </option>
                ))}
              </select>
              {group === undefined && (
                <input
                  className="btn text-[11px]"
                  data-testid="group-name"
                  placeholder="name this group"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              )}
              <button
                className="btn text-[11px]"
                data-testid="group-add"
                /* A name is required to start one, because "Group 4" is a label
                   nobody chose and nobody can find again. Adding to an existing
                   group needs none — it already has one. */
                disabled={pick === '' || (group === undefined && name.trim() === '')}
                onClick={() => {
                  onGroup(pick, name.trim());
                  setPick('');
                  setName('');
                }}
              >
                {group === undefined ? 'Create group' : 'Add to group'}
              </button>
            </>
          )}
        </div>

        {lines.length > 0 && (
          <div className="grid gap-1" data-testid="group-exchange">
            <span className={`${LABEL} text-muted`}>exchange</span>
            {lines.map((line) => (
              <Row key={`${line.direction}-${line.seq}`} line={line} sessions={sessions} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function Row({ line, sessions }: { line: Line; sessions: Session[] }): JSX.Element {
  const otherId =
    line.direction === 'sent' ? line.message.toSessionId : line.message.fromSessionId;
  // The title if this client can see that session, the id if it cannot. An id is
  // ugly and it is also the truth; inventing a name for a session on a host
  // nobody has attached would be worse.
  const other = sessions.find((s) => s.sessionId === otherId)?.title ?? otherId;

  return (
    <div
      className="text-[11px]"
      data-testid="group-message"
      data-direction={line.direction}
      data-refused={line.refusedBecause !== undefined}
    >
      <span className={`${LABEL} ${line.refusedBecause !== undefined ? 'text-state-fail' : 'text-muted'}`}>
        {line.direction === 'sent' ? '→' : '←'} {other} · {line.message.kind}
      </span>
      <p className="m-0 whitespace-pre-wrap">{line.message.text}</p>
      {line.refusedBecause !== undefined && (
        <p className="text-state-fail m-0" data-testid="group-message-refused">
          not delivered — {line.refusedBecause}
        </p>
      )}
    </div>
  );
}
