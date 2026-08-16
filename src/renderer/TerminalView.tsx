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

export function TerminalView({
  sessionId,
  agentId,
}: {
  sessionId: string;
  agentId: string;
}): JSX.Element {
  const [tail, setTail] = useState<RawTail | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const read = (): void =>
      void window.agbrte.sessions.rawLog(sessionId, agentId).then(
        (t) => {
          if (alive) setTail(t);
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
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [tail]);

  return (
    <div
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
