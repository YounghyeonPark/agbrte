/**
 * Turning a recorded session log back into the thing the app talks to (§7).
 *
 * ## The problem this exists for
 *
 * A published copy of the client opens on a screen asking for a host address and
 * a token. Somebody who has a host pastes one line and is in. Everybody else —
 * which is nearly everybody who ever arrives from a link — is looking at a login
 * form for a program they have not seen, and leaves. The landing page can
 * describe a transcript in a paragraph; only the program can show one, and the
 * program will not start without a machine to run on.
 *
 * So this is the third state, between "no host" and "a host": the **real**
 * renderer, the real dashboard, the real transcripts, answering from a file.
 *
 * ## Why the swap is at the transport and not at the API
 *
 * `AgbrteApi` is eighty-three methods. Implementing a demo of it means writing
 * eighty-three stubs, keeping them in step with a contract that moves, and being
 * wrong in eighty-three places when it does. But every one of those methods is
 * the same two lines in `bridge.ts` — a channel name and `link.call` — so the
 * whole surface is downstream of one object with three functions on it.
 *
 * Replacing that object replaces the API for free, and nothing here has to know
 * what `sessions.attachMcp` is. A new method on the contract arrives working: it
 * is a channel like the others, it finds no recording, and it says so.
 *
 * ## Nothing here can reach anything
 *
 * No socket is opened, no address is read, no permission is requested. That is
 * not a limitation of the demo, it is the reason the demo can be handed to a
 * stranger at all: the honest objection to a published page that offers to drive
 * your computer is answered by a mode that provably cannot.
 */

/** One answer a host actually gave, recorded at the socket by `recording.spec`. */
type Call = { channel: string; args: unknown[]; value: unknown };

export type Recording = { model: string; calls: Call[] };

export type Link = {
  call: (channel: string, args: unknown[]) => Promise<unknown>;
  fire: (channel: string, args: unknown[]) => void;
  on: (push: string, cb: (payload: unknown) => void) => () => void;
};

/**
 * Built from a recording, keyed twice.
 *
 * Exact arguments first, because `sessions.snapshot` is a different answer per
 * session id and collapsing those would give every card the same transcript.
 * Channel alone second, because an argument the renderer computes at runtime —
 * a window, a cursor, a timestamp — will not match what it computed during the
 * recording, and an unrecognised cursor is a worse answer than a slightly stale
 * one. The reply is the same data either way; only the freshness differs, and
 * nothing here is fresh by construction.
 */
export function replay(recording: Recording): Link {
  const exact = new Map<string, unknown>();
  const byChannel = new Map<string, unknown>();
  for (const call of recording.calls) {
    exact.set(`${call.channel} ${JSON.stringify(call.args)}`, call.value);
    if (!byChannel.has(call.channel)) byChannel.set(call.channel, call.value);
  }

  return {
    call: (channel, args) => {
      const key = `${channel} ${JSON.stringify(args)}`;
      if (exact.has(key)) return Promise.resolve(exact.get(key));
      if (byChannel.has(channel)) return Promise.resolve(byChannel.get(channel));
      /*
       * A refusal that names itself, rather than a silent empty value.
       *
       * Everything that *changes* something lands here — sending a turn,
       * creating a session, answering a permission — because a recording has no
       * answer for a question nobody asked during it. Resolving those with
       * `undefined` would let the UI proceed as though the send had worked and
       * then show a session that never replies, which reads as a broken program
       * rather than as a demo. Rejecting puts the sentence where the renderer
       * already shows failures.
       */
      return Promise.reject(
        new Error(
          'This is a recorded session — nothing is running. Connect a host to do this for real.',
        ),
      );
    },
    // One-way and unanswerable: `ack` tells a host how far a client has read,
    // and there is no host. Dropping it is the whole behaviour.
    fire: () => undefined,
    /*
     * Subscribed and never called, which is correct rather than incomplete.
     *
     * These are pushes — a turn producing output, a host appearing, a permission
     * being asked. A recording is a past tense: the transcript in it is already
     * whole, so there is nothing left to arrive. Returning a working unsubscribe
     * keeps the renderer's cleanup identical to the live path.
     */
    on: () => () => undefined,
  };
}
