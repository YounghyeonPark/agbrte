/**
 * Looking at the screen of the machine a session runs on (DESIGN.md §12.1, §3.3).
 *
 * A **view**, exactly like `files.ts` next door and for the same reasons: nothing
 * here is written to the event log, nothing is a `ContentBlock`, and nothing
 * survives the pane that asked for it. A frame is rendered and dropped.
 *
 * §12.1 named this and did not build it — "remote display grab where a real or
 * virtual display exists" — and it is the one kind of capture that reaches a
 * *window*. §6.8 forwards a port, which reaches a listener; §12.1's browser
 * capture reaches a URL. An agent that opens an installer, a GUI test or the app
 * it just built put something on a desktop that neither of those can see.
 *
 * ## Sizes travel because the frame rate is the honest part
 *
 * `xwd` has no damage tracking, so every frame is the whole screen whether or not
 * anything moved: measured on the machine this was built for, 0.13s to grab
 * 12.7MB plus 0.16s to encode 430KB of PNG, at 2944×1080. That is a few frames a
 * second, not video, and a viewer that cannot say so invites the reading that
 * something is broken. So `tookMs` and both sizes are part of every frame rather
 * than something a client has to infer.
 */

/**
 * The reserved name of the Wayland screen, which is not an X display at all.
 *
 * One list rather than two, because the question a person asks is "show me that
 * machine's screen" and they should not have to know which display server
 * answered it. The name is not a `DISPLAY` value and cannot collide with one:
 * every real display name starts with a colon.
 */
export const WAYLAND_DISPLAY = 'wayland';

/** One screen, and what is known about it. */
export interface DisplayInfo {
  /** As `DISPLAY` carries it: `:1` — or `wayland` for the compositor itself. */
  display: string;
  width?: number;
  height?: number;
  /**
   * Why this one cannot be grabbed, where it cannot.
   *
   * The field that decides whether this list is honest. A display whose X cookie
   * the host does not hold is a real screen on that machine with a fixable
   * problem: dropping it from the list would answer "there is no screen" (§3.3),
   * and listing it as ready would be a control that fails on press (§3.5).
   */
  unreachable?: string;
  /**
   * What pressing this will ask the far machine's owner, where it must ask.
   *
   * The Wayland row, before anybody has approved it. It is neither ready nor
   * unreachable, and collapsing it into either would be wrong in a way somebody
   * pays for: as ready it is a control that fails on press (§3.5), because a
   * grab would raise a dialog on a screen nobody is sitting at and time out; as
   * unreachable it is a `no` about a machine that is one click from working
   * (§3.3). So it is a third state with the sentence in it.
   */
  needsApproval?: string;
}

export interface Displays {
  /**
   * The `xwd` the host found, or `null`.
   *
   * `null` beside a non-empty `displays` is the informative case rather than a
   * contradiction: there is a screen over there and this host cannot read it yet,
   * which is one `apt install x11-apps` away. Collapsing that into an empty list
   * would send somebody to look at their X server instead of at the host.
   */
  tool: string | null;
  displays: DisplayInfo[];
  /**
   * A compositor this capture cannot see, where one is running.
   *
   * `xwd` reads an **X** display. Under a Wayland session the X server a client
   * meets is XWayland, whose root window is not the compositor's output — so a
   * grab comes back black or stale while the desktop is plainly there on the
   * monitor. A picture of nothing, with nothing saying why, is the worst shape a
   * failure takes in a viewer, and it is the one thing every other field here is
   * arranged to avoid.
   *
   * Present means a compositor was found and this list is probably XWayland.
   * Absent means none was found, which on a machine whose `/run/user` cannot be
   * read is "no answer" rather than "no Wayland" — so it is said as a caution
   * beside the displays and never as a refusal to show them (§3.3).
   */
  wayland?: string[];
}

/** One frame, on the wire. */
export interface DisplayFrame {
  display: string;
  /**
   * A PNG, base64'd — the same form `blob.get` uses, for the same reason: this
   * protocol is JSON and bytes have to be spelled somehow.
   */
  png: string;
  /** After scaling: the size of the picture in `png`. */
  width: number;
  height: number;
  /** Before scaling, so a viewer can say what the far screen actually is. */
  sourceWidth: number;
  sourceHeight: number;
  /** Wall clock on the host for the whole grab. */
  tookMs: number;
}
