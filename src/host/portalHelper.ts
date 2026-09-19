/**
 * The ScreenCast portal, driven by a helper this spawns (DESIGN.md §12.1).
 *
 * A string rather than a file, and that is deliberate. It is spawned with
 * `python3 -c`, so there is nothing to ship to the far machine, nothing to
 * resolve a path to, and nothing that can go missing from a bundle — the same
 * property that makes `xwd` the right tool next door. It lives beside the code
 * that runs it, which is where the reasoning for it lives too.
 *
 * ## Why a helper at all
 *
 * The portal answers a request by sending a **directed** D-Bus signal back to
 * the connection that made it. That is not a detail: it means the caller has to
 * subscribe, call, and wait on one connection. `gdbus call` returns as soon as
 * the method hands back a request handle and then exits, taking the connection
 * with it — measured on a real machine, where the reply never arrived and a
 * separate `gdbus monitor` never saw it either, because a directed signal is not
 * broadcast.
 *
 * Node cannot speak D-Bus without a dependency this project will not add, so the
 * helper is Python driving GLib, which is what a GNOME desktop already has.
 * Detected by running it, never assumed.
 *
 * ## What it does, and the one thing it cannot do unattended
 *
 * `CreateSession` → `SelectSources` → `Start`. The first two are silent; all of
 * this was verified against a real portal, where both returned success and every
 * option below was accepted. **`Start` puts a dialog on the far machine's
 * screen** — confirmed by name, `"Share Screen"` at 782x622, owned by
 * `xdg-desktop-portal-gnome`.
 *
 * That is Wayland working as designed rather than an obstacle to route around:
 * the whole point of the portal is that nothing reads a screen without the
 * person at it agreeing once. So `persist_mode: 2` asks for that agreement to be
 * remembered, and the `restore_token` it returns is what makes every later grab
 * silent.
 */

/**
 * The helper, verbatim.
 *
 * Prints exactly one line of JSON on stdout and nothing else, so the caller
 * parses one thing and a stray warning from a library cannot become a field.
 */
export const PORTAL_HELPER = String.raw`
import json, os, sys, threading

try:
    import gi
    gi.require_version("Gio", "2.0")
    from gi.repository import Gio, GLib
except Exception as err:
    print(json.dumps({"ok": False, "reason": "no-gi", "detail": str(err)}))
    sys.exit(0)

PORTAL = "org.freedesktop.portal.Desktop"
PATH = "/org/freedesktop/portal/desktop"
IFACE = "org.freedesktop.portal.ScreenCast"

# argv[1] is a restore token from a previous approval, or empty on the first run.
restore = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else None
# argv[2] is how long to wait at the consent dialog. A silent restore needs
# seconds; a first approval needs however long somebody takes to walk to the
# machine, and the caller decides which of those it is asking for.
wait = int(sys.argv[2]) if len(sys.argv) > 2 else 20

try:
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
except Exception as err:
    print(json.dumps({"ok": False, "reason": "no-session-bus", "detail": str(err)}))
    sys.exit(0)

unique = bus.get_unique_name()[1:].replace(".", "_")
counter = [0]

def token(kind):
    counter[0] += 1
    return "agbrte_%s_%d_%d" % (kind, os.getpid(), counter[0])

def ask(method, build, seconds):
    handle = token("req")
    path = "/org/freedesktop/portal/desktop/request/%s/%s" % (unique, handle)
    loop = GLib.MainLoop()
    out = {}

    def on_response(_c, _s, _p, _i, _sig, params):
        out["code"] = params[0]
        out["results"] = dict(params[1])
        loop.quit()

    sub = bus.signal_subscribe(
        PORTAL, "org.freedesktop.portal.Request", "Response", path, None,
        Gio.DBusSignalFlags.NONE, on_response,
    )
    bus.call_sync(PORTAL, PATH, IFACE, method, build(handle),
                  GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, 30000, None)
    GLib.timeout_add_seconds(seconds, lambda: (out.setdefault("code", -1), loop.quit())[1])
    loop.run()
    bus.signal_unsubscribe(sub)
    return out

try:
    session_token = token("sess")
    created = ask("CreateSession", lambda t: GLib.Variant("(a{sv})", ({
        "handle_token": GLib.Variant("s", t),
        "session_handle_token": GLib.Variant("s", session_token),
    },)), 15)
    if created.get("code") != 0:
        print(json.dumps({"ok": False, "reason": "create", "code": created.get("code")}))
        sys.exit(0)
    session = created["results"]["session_handle"]

    def sources(t):
        opts = {
            "handle_token": GLib.Variant("s", t),
            # 1 = monitor. A whole screen is the question this feature answers; a
            # window picker asks the person at the machine to choose every time.
            "types": GLib.Variant("u", 1),
            "multiple": GLib.Variant("b", False),
            # 2 = embedded, so the pointer is in the picture rather than absent.
            "cursor_mode": GLib.Variant("u", 2),
            # 2 = persistent until revoked. The whole reason ScreenCast can work
            # unattended where Screenshot cannot.
            "persist_mode": GLib.Variant("u", 2),
        }
        if restore:
            opts["restore_token"] = GLib.Variant("s", restore)
        return GLib.Variant("(oa{sv})", (session, opts))

    picked = ask("SelectSources", sources, 20)
    if picked.get("code") != 0:
        print(json.dumps({"ok": False, "reason": "select", "code": picked.get("code")}))
        sys.exit(0)

    started = ask("Start", lambda t: GLib.Variant("(osa{sv})", (
        session, "", {"handle_token": GLib.Variant("s", t)})), wait)
    if started.get("code") != 0:
        print(json.dumps({"ok": False, "reason": "start", "code": started.get("code")}))
        sys.exit(0)

    results = started.get("results", {})
    streams = results.get("streams") or []
    if not streams:
        print(json.dumps({"ok": False, "reason": "no-stream"}))
        sys.exit(0)

    answer = {
        "ok": True,
        "node": int(streams[0][0]),
        "restoreToken": results.get("restore_token"),
        "session": session,
    }
    # The session has to stay alive while somebody reads the stream, and this
    # process owns it: closing the connection closes the session and the node
    # disappears. So the answer goes out and then it waits.
    print(json.dumps(answer), flush=True)

    # Waits to be killed, or for whoever spawned it to stop existing.
    #
    # The second half is the one that matters, and it is not tidiness. An orphan
    # here is not a stray process: it is holding a portal session open, so the
    # compositor keeps a screen-sharing indicator lit on somebody's desktop with
    # nothing left in the world that knows how to turn it off. A host killed with
    # -9, a crash, a machine powered down mid-session - none of them run any
    # cleanup, and all of them close this pipe.
    #
    # Reading stdin is how that is noticed. The host never writes to it, so the
    # read blocks until the write end is gone and then returns empty. A thread
    # rather than a GLib fd watch because the condition wanted is plainly "the
    # pipe ended", and GLib.idle_add is the documented way back onto the loop's
    # own thread.
    loop = GLib.MainLoop()

    def parent_gone():
        try:
            sys.stdin.buffer.read()
        except Exception:
            pass
        GLib.idle_add(loop.quit)

    threading.Thread(target=parent_gone, daemon=True).start()
    loop.run()
except Exception as err:
    print(json.dumps({"ok": False, "reason": "threw", "detail": "%s: %s" % (type(err).__name__, err)}))
`;
