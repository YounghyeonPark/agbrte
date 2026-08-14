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
 * What stays is the one thing an empty window must offer: the way forward.
 * With no host attached that is the two attach buttons, because nothing else
 * in the app can happen before one of them. With a host attached it is a
 * sentence pointing at the session list, because the next move lives there.
 *
 * The same discipline as the guide about promises: nothing is claimed here
 * that this build does not deliver, which is easy precisely because almost
 * nothing is claimed at all.
 */

import type { JSX } from 'react';

export interface WelcomeProps {
  hasHosts: boolean;
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

export function Welcome({ hasHosts, onAttachLocal, onAttachRemote }: WelcomeProps): JSX.Element {
  return (
    <div
      className="m-auto grid w-full max-w-xl gap-6 p-6"
      data-testid="welcome"
      data-compact={hasHosts ? 'true' : 'false'}
    >
      <div className="grid gap-2">
        <h2 className="text-xl">{greeting(new Date().getHours())}</h2>
        <p className="text-muted text-sm leading-relaxed">
          {hasHosts
            ? 'Ready when you are — pick a session on the left, or press '
            : 'Welcome to Agbrte. Point it at a place to work and you are off — '}
          {hasHosts ? (
            <>
              <span className="text-accent">+</span> on a host to start a new one.
            </>
          ) : (
            'a folder on this machine, or one on a server you reach over ssh.'
          )}
        </p>
      </div>

      {!hasHosts && (
        <div className="flex flex-wrap gap-2">
          <button className="btn" data-testid="welcome-attach-local" onClick={onAttachLocal}>
            Use a folder on this machine
          </button>
          <button className="btn" data-testid="welcome-attach-remote" onClick={onAttachRemote}>
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
