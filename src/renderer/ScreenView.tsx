/**
 * Watching the screen of the machine a session runs on (DESIGN.md §12.1, §3.3).
 *
 * §12.1 names three kinds of capture and shipped two: your screen, and a headless
 * browser shot of a URL. The third — "remote display grab where a real or virtual
 * display exists" — is the one that reaches a **window**. An agent on a remote
 * machine that opens an installer, runs a GUI test, or starts the app it just
 * built has put something on a desktop that a forwarded port (§6.8) and a URL
 * screenshot both walk straight past.
 *
 * ## It is a live view, not video, and it says so out loud
 *
 * Measured on the machine this was built for — Ubuntu 24.04, 2944×1080, 24bpp:
 * `xwd` takes 0.13s and hands back 12.7MB, and encoding a PNG of it is another
 * 0.16s. `xwd` also has **no damage tracking**, so every frame is the whole
 * screen whether or not anything moved. That is three to five frames a second at
 * the absolute best, and no amount of work on this side changes it.
 *
 * So the honest thing is to show the number. `tookMs` comes back with every frame
 * and the rate is on screen beside the picture, because a viewer that silently
 * ran at 3fps would read as broken — somebody would go looking for the bug that
 * is actually a measurement. The alternatives were considered and are worse:
 * H.264 needs an encoder this project does not have, `ffmpeg` was not on the
 * machine, and a codec of our own is a great deal of subtle code to raise a
 * ceiling set by `xwd`.
 *
 * **VNC is still the better answer for anything interactive**, and the app
 * already points there: forward `5900` and `shared/preview/protocols.ts` names it
 * as remote desktop rather than offering a browser link that cannot work. This is
 * for the case where you want to *see* what happened without installing a server
 * on somebody's machine to find out.
 *
 * ## One request per frame, which is the whole of the backpressure
 *
 * Nothing is pushed. The next frame is asked for when the last one arrives, so a
 * slow link produces a slow view rather than a queue of 430KB payloads on a
 * connection that also carries the transcript. A `setInterval` would have been
 * fewer lines and would have kept firing into a link that had stopped keeping up.
 *
 * The loop also stops when this component unmounts, and that matters on the far
 * side rather than here: a timer left running would keep pulling whole frames off
 * somebody's desktop after the pane showing them was closed.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import type { DisplayFrame, Displays } from '@shared/types/index.js';

/**
 * A floor between frames.
 *
 * A grab is about 0.3s on a real desktop, so this almost never bites — it is
 * there for the small display, the 1024×768 virtual one, where the loop would
 * otherwise spin as fast as the link allows and put a load on a machine somebody
 * is working on to redraw a picture nobody can follow at that rate.
 */
const FLOOR_MS = 120;

/** What the viewer may ask for, smallest first. */
const SIZES: readonly { label: string; maxEdge: number }[] = [
  { label: 'small', maxEdge: 800 },
  { label: 'medium', maxEdge: 1280 },
  { label: 'large', maxEdge: 1920 },
  // Above any real desktop's long edge, and the host only ever scales *down* —
  // so this means "as it is" rather than an upscale of it.
  { label: 'full', maxEdge: 8192 },
];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function ScreenView({
  instanceId,
  onClose,
}: {
  instanceId: string;
  onClose: () => void;
}): JSX.Element {
  const [found, setFound] = useState<Displays | null>(null);
  const [display, setDisplay] = useState<string | null>(null);
  const [frame, setFrame] = useState<DisplayFrame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [maxEdge, setMaxEdge] = useState(SIZES[1]?.maxEdge ?? 1280);

  /*
   * What displays exist, re-asked when the host changes.
   *
   * `found: null` is "still asking", which is a different thing on screen from a
   * machine with no X on it — and the distinction is the reason this is not a
   * boolean (§3.3). Everything else is dropped with it: a display name from one
   * machine names nothing on another.
   */
  useEffect(() => {
    setFound(null);
    setDisplay(null);
    setFrame(null);
    setError(null);
    let stale = false;
    void window.agbrte.display.list(instanceId).then(
      (answer) => {
        if (stale) return;
        setFound(answer);
        // The first one that can actually be read, which is usually the only one.
        // Picking a display that is listed-but-refused would open the pane on an
        // error somebody did not ask for.
        setDisplay(answer.displays.find((d) => d.unreachable === undefined)?.display ?? null);
      },
      (err: unknown) => {
        if (stale) return;
        /*
         * `found` stays `null`, and that is the whole point of this branch.
         *
         * It used to be set to `{ tool: null, displays: [] }`, which rendered as
         * *that machine has no X display* — so a host too old for the command, a
         * connection that dropped, or a bug in the wiring all came out as a
         * confident statement about somebody's hardware. §3.3 is usually quoted
         * about not rendering an unknown as a `no`; this was rendering a *failure*
         * as a no, which is worse, because it sends the reader somewhere else
         * entirely.
         *
         * It also made the end-to-end test meaningless: the assertion that the
         * pane says "no X display" would have passed on an IPC that threw.
         */
        setError(message(err));
      },
    );
    return () => {
      stale = true;
    };
  }, [instanceId]);

  /*
   * The loop. Pull, one frame at a time, paced by how long the far machine takes.
   *
   * `stopped` is a local rather than state on purpose: a `useState` flag read
   * after an `await` is the stale-closure version of the same bug, and this needs
   * to be the *current* answer at the moment the frame lands, not the answer that
   * was true when the effect ran.
   */
  const size = useRef(maxEdge);
  size.current = maxEdge;
  useEffect(() => {
    if (!live || display === null) return undefined;
    let stopped = false;

    void (async () => {
      while (!stopped) {
        const began = Date.now();
        try {
          const next = await window.agbrte.display.grab({
            instanceId,
            display,
            // Through a ref, so changing the size does not restart the loop and
            // lose the frame that is already in flight.
            maxEdge: size.current,
          });
          if (stopped) return;
          setFrame(next);
          setError(null);
        } catch (err) {
          if (stopped) return;
          /*
           * Stop rather than retry. A grab that failed once — a cookie the host
           * does not hold, an X server that went away with the session somebody
           * logged out of — fails the same way every time, and a loop retrying it
           * three times a second is a machine under load producing an error
           * message over and over.
           */
          setError(message(err));
          setLive(false);
          return;
        }
        const spent = Date.now() - began;
        if (spent < FLOOR_MS) await new Promise((done) => setTimeout(done, FLOOR_MS - spent));
      }
    })();

    return () => {
      stopped = true;
    };
  }, [live, display, instanceId]);

  const chosen = found?.displays.find((d) => d.display === display);
  const fps = frame === null ? null : Math.round((1000 / Math.max(frame.tookMs, 1)) * 10) / 10;

  return (
    // A fixed row under the transcript, like `Preview`: the transcript is the only
    // child of the session column allowed to give up height (see SessionHeader).
    <div
      className="border-line flex shrink-0 flex-col gap-2 border-t px-3 py-2 text-xs"
      data-testid="screen-row"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Screen on that machine</span>

        {found === null && error !== null ? (
          // The question could not be asked. Distinct from both "still asking" and
          // "that machine has none", because only one of the three is about X.
          <span className="text-state-fail" data-testid="screen-failed">
            could not ask that machine
          </span>
        ) : found === null ? (
          <span className="text-muted" data-testid="screen-asking">
            looking for a display…
          </span>
        ) : found.displays.length === 0 ? (
          /*
           * No X at all, which is the ordinary state of a headless server and not
           * a fault. Said as a fact about the machine, with the thing that does
           * work — because "no display" with nothing after it reads as a dead end.
           */
          <span className="text-muted" data-testid="screen-none">
            that machine has no X display. Forward 5900 under Ports if it runs a VNC
            server.
          </span>
        ) : (
          <>
            <select
              className="bg-panel border-line focus:border-accent rounded border px-2 py-1 text-xs outline-none"
              data-testid="screen-pick"
              aria-label="Which display to watch"
              value={display ?? ''}
              onChange={(e) => {
                setDisplay(e.target.value === '' ? null : e.target.value);
                setFrame(null);
                setError(null);
              }}
            >
              {found.displays.map((d) => (
                <option
                  key={d.display}
                  value={d.display}
                  /* Listed and refused, rather than dropped: a display whose
                     cookie the host does not hold is a real screen with a fixable
                     problem, and hiding it would say the machine has one fewer
                     (§3.3). Disabled so it is not a control that fails on press
                     (§3.5) — the reason is below. */
                  disabled={d.unreachable !== undefined}
                >
                  {d.display}
                  {d.width !== undefined ? ` · ${d.width}×${d.height}` : ''}
                  {d.unreachable !== undefined ? ' · cannot be read' : ''}
                </option>
              ))}
            </select>

            {found.wayland !== undefined && (
              /*
               * A caution, not a refusal.
               *
               * `xwd` reads an X display, and under Wayland that is XWayland —
               * whose root is not the compositor's output, so a grab comes back
               * black or stale while the desktop is plainly there on the monitor.
               * Said *before* the frame arrives, because a picture of nothing
               * with nothing explaining it is the one failure this whole pane is
               * arranged to avoid.
               *
               * The button stays enabled: some compositors do put something on
               * the XWayland root, this host cannot know which, and refusing on a
               * guess would withhold a view that might have worked (§3.3).
               */
              <span className="text-state-paused" data-testid="screen-wayland">
                that machine runs Wayland — xwd sees only XWayland, so this may be
                black
              </span>
            )}

            {found.tool === null && (
              /* The informative case §3.3 is about: there *is* a screen and this
                 host cannot read it yet. An empty list would have sent somebody
                 to look at their X server instead of at one package. */
              <span className="text-state-paused" data-testid="screen-no-tool">
                that host has no xwd — install x11-apps on it
              </span>
            )}

            {chosen?.unreachable !== undefined && (
              <span className="text-state-paused" data-testid="screen-unreachable">
                {chosen.unreachable}
              </span>
            )}

            <button
              className="btn text-[11px]"
              data-testid="screen-live"
              aria-pressed={live}
              disabled={display === null || found.tool === null}
              onClick={() => setLive((on) => !on)}
            >
              {live ? 'Pause' : 'Watch'}
            </button>

            <select
              className="bg-panel border-line focus:border-accent rounded border px-2 py-1 text-xs outline-none"
              data-testid="screen-size"
              aria-label="How much detail to send"
              value={String(maxEdge)}
              onChange={(e) => setMaxEdge(Number(e.target.value))}
            >
              {SIZES.map((s) => (
                <option key={s.label} value={String(s.maxEdge)}>
                  {s.label}
                </option>
              ))}
            </select>

            {frame !== null && (
              /*
               * The measurement, on screen. A view running at three frames a
               * second with nothing saying so reads as broken, and somebody goes
               * looking for a bug that is a property of `xwd` — no damage
               * tracking, so every frame is the whole screen.
               *
               * The source size is here too because the picture is scaled: a
               * 1280px frame of a 2944px desktop otherwise looks like a small
               * monitor.
               */
              <span className="text-muted" data-testid="screen-rate">
                {frame.sourceWidth}×{frame.sourceHeight} · {frame.tookMs}ms · ~{fps}/s
              </span>
            )}
          </>
        )}

        <button
          className="btn-quiet ml-auto text-[11px]"
          data-testid="screen-close"
          title="Stop watching and hide this"
          onClick={onClose}
        >
          Hide
        </button>
      </div>

      {error !== null && (
        <span className="text-state-fail" data-testid="screen-error">
          {error}
        </span>
      )}

      {frame !== null && (
        /*
         * `max-h-[45vh]` with `object-contain`: a desktop is wider than this pane
         * and taller than it should be allowed to become. Capped here rather than
         * by asking for a smaller frame, because the size control is about
         * *bytes over the link* and this is about how much of the window a screen
         * is allowed to take — two decisions that happen to both be about size.
         */
        <img
          data-testid="screen-frame"
          data-display={frame.display}
          className="border-line max-h-[45vh] w-full rounded border object-contain"
          src={`data:image/png;base64,${frame.png}`}
          alt={`The screen on ${frame.display}, ${frame.sourceWidth} by ${frame.sourceHeight}`}
        />
      )}
    </div>
  );
}
