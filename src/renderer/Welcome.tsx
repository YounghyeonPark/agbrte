/**
 * The first screen (DESIGN.md §10).
 *
 * A greeting, not a lecture. This slot used to hold the start guide — the "one
 * idea, then its consequences" explanation — and reading it was homework
 * assigned at the door: the person has just opened the app, and the app's
 * first words were three paragraphs about its architecture. The explanation is
 * still one button away under Guide, where it can be read when it is wanted
 * and re-read when it is needed; what greets is now a greeting.
 *
 * What stays is the one thing an empty window must offer: the way forward. That
 * is now a single button — pick a folder, and the attach, the session and the
 * agent happen behind it (App.tsx `newSessionOneShot`). It used to be a
 * sentence pointing at a `+` in the sidebar, which was honest about the app and
 * wrong about the person: from an empty window, four controls stood between
 * "opened it" and "typing to an agent", and an empty state is the worst place
 * to teach a sequence.
 *
 * The attach buttons stay under it, quieter, for the two cases the fast path
 * cannot serve: a machine over ssh, and attaching a workspace you mean to make
 * several sessions in.
 *
 * The same discipline as the guide about promises: nothing is claimed here
 * that this build does not deliver, which is easy precisely because almost
 * nothing is claimed at all.
 */

import type { JSX } from 'react';

export interface WelcomeProps {
  hasHosts: boolean;
  /**
   * Whether this fleet has any session at all, loaded or on disk.
   *
   * The primary button is for an empty app. Once sessions exist the way in is
   * to open one — they are listed a few inches to the left — and a large
   * accent button offering to make *another* competes with the list for the
   * eye while being the rarer intent. The sidebar keeps `New session`, which
   * is the same act where somebody with sessions would look for it.
   */
  hasSessions: boolean;
  /** The one-shot: folder, session, agent, chat (App.tsx `newSessionOneShot`). */
  onNewSession: () => void;
  /** True while that sequence is running, so the button says so. */
  starting?: boolean;
  onAttachLocal: () => void;
  onAttachRemote: () => void;
}

/**
 * By the clock on this machine, because the greeting is for the person in
 * front of it — a session's host may be in another timezone, and "good
 * morning" from a server in another country is the wrong kind of friendly.
 */
function greeting(hour: number): string {
  if (hour < 5) return 'Up late?';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

export function Welcome({
  hasHosts,
  hasSessions,
  starting = false,
  onNewSession,
  onAttachLocal,
  onAttachRemote,
}: WelcomeProps): JSX.Element {
  return (
    <div
      className="m-auto grid w-full max-w-xl gap-6 p-6"
      data-testid="welcome"
      data-compact={hasHosts ? 'true' : 'false'}
    >
      <div className="grid gap-2">
        <h2 className="text-xl">{greeting(new Date().getHours())}</h2>
        {/*
         * The sentence points at the button under it, and says what the button
         * does rather than what it is called.
         *
         * It used to read "pick a session on the left, or press +", which named
         * a control that is one of four steps — folder, session, agent, model —
         * and left the other three for the person to discover in order. The
         * greeting now describes the whole act, because the button now performs
         * the whole act.
         *
         * Both states get the same sentence for the same reason: with no host
         * attached this button *is* the way in, and with one attached it is
         * still the shortest. The difference between the two states is only how
         * much else is offered underneath.
         */}
        <p className="text-muted text-sm leading-relaxed">
          {hasSessions
            ? 'Ready when you are. Pick a session from the list, or start another with New session.'
            : hasHosts
              ? 'Ready when you are. Start a session in a folder — it brings your usual agent with it.'
              : 'Welcome to Agbrte. Point it at a folder and you are working — it attaches the machine, opens a session and brings your usual agent.'}
        </p>
      </div>

      {!hasSessions && (
      <div className="flex flex-wrap gap-2">
        {/*
         * The primary action, and the reason this screen is not a form.
         *
         * `welcome-new-session` rather than `new-session-oneshot`: the sidebar
         * header carries that id and both are on screen together, which would
         * make a test reaching for it ambiguous rather than convenient. Same
         * action, same handler, two places a person might look.
         */}
        <button
          className="btn text-accent"
          data-testid="welcome-new-session"
          disabled={starting}
          onClick={onNewSession}
        >
          {starting ? 'Starting…' : 'New session in a folder…'}
        </button>
      </div>
      )}

      {!hasHosts && (
        /* The longer way round, kept: a machine over ssh has no folder picker
           on this side, and somebody attaching a workspace to make several
           sessions in wants the host first and the sessions after. */
        <div className="flex flex-wrap gap-2">
          <button className="btn-quiet" data-testid="welcome-attach-local" onClick={onAttachLocal}>
            Attach a folder without starting a session
          </button>
          <button className="btn-quiet" data-testid="welcome-attach-remote" onClick={onAttachRemote}>
            Use a server over ssh
          </button>
        </div>
      )}

      {/* The one pointer worth giving: where the explanation went. */}
      <p className="text-muted text-xs leading-relaxed">
        New here? <span className="text-accent">Guide</span> in the top bar walks through how this
        is used, and <span className="text-accent">About</span> says what you are running.
      </p>
    </div>
  );
}
