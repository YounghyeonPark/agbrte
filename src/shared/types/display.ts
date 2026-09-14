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

/** One X display, and what is known about it. */
export interface DisplayInfo {
  /** As `DISPLAY` carries it: `:1`. */
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
