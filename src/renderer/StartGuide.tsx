/**
 * What to do with an empty window (DESIGN.md §10).
 *
 * ## One idea, then its consequences
 *
 * The temptation with an empty state is to list everything the app can do, and
 * the result is a brochure nobody reads because six equal bullets rank nothing.
 * Loom has exactly one unusual property — **a session lives on the host, not in
 * this window** — and closing the app mid-run, driving the same session from a
 * second machine, and resuming after a restart are not three features to learn
 * but three consequences of that one fact. Said that way it is one thing to
 * remember instead of six.
 *
 * So: the idea, two ways to act on it, then the consequences. Ranked, not listed.
 *
 * ## Only what is true today
 *
 * Every claim here is one this build actually delivers. That sounds obvious and
 * is easy to violate: "open it on your phone" belongs to the same idea, reads
 * naturally in the list, and is **not implemented** — there is no web client
 * (§17 Q13 is open). An empty state is the first thing a new user reads and the
 * last thing anyone re-reads, so a promise made here is one nobody comes back to
 * check. The phone is deliberately absent below.
 *
 * ## Reachable after the first five minutes
 *
 * A guide that only appears when the window is empty is unfindable the moment it
 * is useful — you cannot deselect a session to get back to it. Hence the header
 * toggle: the cost is a button, and the alternative is writing something the
 * user sees once.
 */

import type { JSX } from 'react';
import { LABEL } from './App.js';

export interface StartGuideProps {
  /** Shown expanded when nothing is attached; compact once something is. */
  hasHosts: boolean;
  onAttachLocal: () => void;
  onAttachRemote: () => void;
}

/** A consequence of sessions living on the host, and why it is worth knowing. */
const CONSEQUENCES: Array<{ title: string; detail: string }> = [
  {
    title: 'Close this window and the run keeps going',
    detail:
      'The host is a separate process that outlives the app. Reopen later and you are back on the same session, mid-turn if it is still working.',
  },
  {
    title: 'Drive one session from more than one machine',
    detail:
      'Both see the same transcript because there is only one. Commands queue in arrival order, and a client can attach read-only to watch without being able to send.',
  },
  {
    title: 'Nothing is lost to a restart',
    detail:
      'The log is the truth, not a cache of it. A session on disk reopens from its own history — including which agent ran, under which model, and who approved what.',
  },
];

export function StartGuide({ hasHosts, onAttachLocal, onAttachRemote }: StartGuideProps): JSX.Element {
  return (
    <div
      className="m-auto grid w-full max-w-xl gap-6 p-6"
      data-testid="start-guide"
      data-compact={hasHosts ? 'true' : 'false'}
    >
      <div className="grid gap-2">
        <h2 className="text-[15px]">Sessions run on a host, not in this window.</h2>
        <p className="text-muted text-xs leading-relaxed">
          A host is a workspace — a folder on this machine, or one on a server you reach over ssh.
          {hasHosts
            ? ' You have one attached; everything below follows from that.'
            : ' Attach one and everything below follows from it.'}
        </p>
      </div>

      {/*
        What leads depends on what the user can actually do next. With a host
        attached the next move is picking a session, and putting two attach
        buttons above that tells a returning user to do the one thing they have
        already done.
      */}
      {hasHosts ? (
        <p className="text-xs">
          Pick a session on the left, or press <span className="text-accent">+</span> on a host to
          start one.
        </p>
      ) : (
        // Actions before explanation: someone who already knows what this is
        // should not have to read past the paragraph to start.
        <div className="flex flex-wrap gap-2">
          <button className="btn" data-testid="guide-attach-local" onClick={onAttachLocal}>
            Use a folder on this machine
          </button>
          <button className="btn" data-testid="guide-attach-remote" onClick={onAttachRemote}>
            Use a server over ssh
          </button>
        </div>
      )}

      {!hasHosts && (
        <p className="text-muted text-[11px] leading-relaxed">
          A server needs no setup beyond ssh access — an alias from your <code>~/.ssh/config</code>,
          or <code>user@hostname</code>, which works with no config at all. The first attach installs
          a private Node under <code>~/.loom</code> on that machine: nothing system-wide, no sudo.
        </p>
      )}

      <div className="grid gap-3">
        <span className={`${LABEL} text-muted`}>Which is why</span>
        {CONSEQUENCES.map((item) => (
          <div key={item.title} className="grid gap-0.5">
            <span className="text-[13px]">{item.title}</span>
            <span className="text-muted text-xs leading-relaxed">{item.detail}</span>
          </div>
        ))}
      </div>

      {hasHosts && (
        // Kept, but demoted: attaching another host is a real thing to want and
        // a rare one.
        <div className="flex flex-wrap gap-2">
          <button className="btn" data-testid="guide-attach-local" onClick={onAttachLocal}>
            Attach another folder
          </button>
          <button className="btn" data-testid="guide-attach-remote" onClick={onAttachRemote}>
            Attach a server
          </button>
        </div>
      )}
    </div>
  );
}
