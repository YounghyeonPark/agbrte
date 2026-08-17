/**
 * The raw side of a CLI seat (§3.12) — what the subprocess actually printed.
 *
 * Read-only on purpose. An interactive PTY would trade away the properties the
 * structured transcript exists for: the log as truth, the §13 gate seeing every
 * call, resume from history. This pane observes; the chat remains the record.
 *
 * Polled while mounted and only while mounted — the interval dies with the
 * component, so a closed toggle costs nothing (renderer discipline: no timer
 * outlives what it draws).
 */

import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { RawTail } from '../shared/types/index.js';

/**
 * How many lines this seat has ever printed.
 *
 * `dropped` is the absolute index of the first line still held, so this is a
 * monotonic cursor over the whole stream — and comparing it is how the pane
 * tells "nothing new" from "the same tail again". Between turns that is every
 * poll, which is the case worth being cheap in: the pane is open, the CLI has
 * finished, and re-rendering a quarter-megabyte text node once a second to
 * display exactly what is already on screen is pure waste.
 */
function cursor(tail: RawTail | null): number {
  return tail === null ? -1 : tail.dropped + tail.lines.length;
}

/** Within a line of the bottom counts as "following", the way a terminal does. */
const AT_BOTTOM_SLOP_PX = 24;

export function TerminalView({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}): JSX.Element {
  const [tail, setTail] = useState<RawTail | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  /**
   * Whether the view was pinned to the bottom *before* this update.
   *
   * Read at poll time rather than after the render, because by then the new
   * lines have already changed the scroll height and every pane looks scrolled
   * up. Without it a long turn drags the viewport back to the tail once a
   * second while somebody is reading something further up.
   */
  const following = useRef(true);

  useEffect(() => {
    let alive = true;
    const read = (): void =>
      void window.agbrte.sessions.rawLog(sessionId, agentId).then(
        (next) => {
          if (!alive) return;
          const pane = paneRef.current;
          following.current =
            pane === null ||
            pane.scrollHeight - pane.scrollTop - pane.clientHeight <= AT_BOTTOM_SLOP_PX;
          // Identity-compared through the cursor, so an unchanged tail costs one
          // request and no render at all.
          setTail((prev) => (cursor(prev) === cursor(next) ? prev : next));
        },
        () => undefined, // a dropped poll is the next poll's problem
      );
    read();
    const timer = setInterval(read, 1_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, agentId]);

  useEffect(() => {
    if (following.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [tail]);

  return (
    <div
      ref={paneRef}
      data-testid="terminal-view"
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-6 py-4 font-mono text-[11px] leading-relaxed"
    >
      {tail === null || tail.lines.length === 0 ? (
        <p className="text-muted">Nothing printed yet — output appears as the CLI produces it.</p>
      ) : (
        <>
          {tail.dropped > 0 && (
            // Named, not silent: a tail that looks complete when it is not
            // would misread as "the CLI never said that".
            <p className="text-muted">[{tail.dropped.toLocaleString()} earlier lines dropped]</p>
          )}
          <pre className="wrap-anywhere whitespace-pre-wrap">{tail.lines.join('\n')}</pre>
        </>
      )}
      <div ref={endRef} />
    </div>
  );
}
