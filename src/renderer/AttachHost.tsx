/**
 * Attaching a host (DESIGN.md §6.2, §10).
 *
 * Two ways in, and the remote one is deliberately not a connection form. When the
 * user has an `~/.ssh/config`, their machines are already described in it —
 * hostname, user, port, key, jump host, proxy command — and every one of those
 * answers is better than what a form would collect, because it is the same answer
 * their terminal uses.
 *
 * **A config is not required.** `ssh user@host` works with none at all, so the
 * field accepts that too and says so. Treating a config as a prerequisite would
 * invent one: there is nothing to "set up" before a first connection, only things
 * that can fail on it — and those are diagnosed where they happen, with the
 * command that settles each one.
 *
 * A first attach to a machine installs a private Node and deploys the host, which
 * takes seconds rather than milliseconds, so progress is shown rather than left
 * to a spinner that says nothing.
 *
 * ## The path was the half that had no picker
 *
 * "This machine" opens a folder picker. "Remote" asked for a machine and then an
 * absolute path, typed from memory, against a placeholder reading
 * `/home/you/project` — so a machine you had not used in a month could not be
 * attached at all without opening a terminal to go and look. The two halves of
 * the same panel disagreed about whether you were expected to know where your own
 * work lives.
 *
 * So the machine is asked. Three things make that answer usable rather than a
 * wall of directories:
 *
 *   * **it is one control, not a list.** A working machine answers with eight
 *     directories that have held sessions, a dozen repositories and whatever
 *     else is one level below a root, and as rows that filled the sidebar and
 *     pushed the path field and **Attach** below the fold — the results are the
 *     input to the decision, and the decision has to stay on screen. See
 *     `WorkspaceSelect.tsx`, which keeps the kinds as labelled groups inside the
 *     dropdown, because a folder holding `.agbrte/` is a different claim from
 *     a git repository and from a folder that merely exists.
 *   * **what was searched is shown.** An empty list has to read as "nothing under
 *     these five directories" and never as "this is broken" — the difference is
 *     the roots, so the roots are on screen.
 *   * **the field stays.** Discovery is bounded on purpose (§6.2: a small set of
 *     roots, a shallow depth, a cap, a timeout), so a workspace four levels down
 *     is *expected* to be missed, and the manual field is where it is typed. It
 *     is the fallback, not a leftover.
 *
 * ## Asking is not a step the user takes
 *
 * It fires when a machine is chosen, because somebody who has just named a
 * machine needs exactly one thing next and it is not another button. What that
 * costs is handled rather than avoided: `attachTrigger.ts` decides *when* (at
 * once for a name from the user's own config, after the typing stops for one
 * they are spelling out, never for a name that could not be a destination), the
 * store drops a superseded answer so a slow machine cannot land its list under
 * the next machine's name, and a failure stays **inside this panel** instead of
 * raising the app's error banner — an alarm about an action nobody took, over a
 * field that still works. The button survives as a retry, for a machine that was
 * asleep or a folder made a minute ago.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { useAgbrte } from './store.js';
import { loadLastAlias, loadLastWorkspace, rememberRemoteWorkspace } from './remoteWorkspaces.js';
import { autoDiscoverDelay } from './attachTrigger.js';
import { WorkspaceSelect } from './WorkspaceSelect.js';

export function AttachHost({
  onDone,
  initialMode = 'local',
}: {
  onDone: () => void;
  /** Set when the start guide opened this for one particular way in. */
  initialMode?: 'local' | 'remote';
}): JSX.Element {
  const store = useAgbrte();
  const { sshHosts, busy, discovery } = store;
  const [mode, setMode] = useState<'local' | 'remote'>(initialMode);
  /*
   * The machine attached last, as *initial state* rather than as an effect.
   *
   * It has to be in place before anything else can fill the field, and an
   * end-to-end test showed why an effect cannot do that: the panel mounts on the
   * "This machine" tab, the ssh-config list is already in the store from a
   * previous open, and its default therefore lands in the field while nothing is
   * even looking at it. By the time "Remote" is pressed the field is no longer
   * empty and the remembered machine has already lost to whichever name happens
   * to be first in the user's config.
   */
  const [alias, setAlias] = useState(() => loadLastAlias() ?? '');
  const [path, setPath] = useState('');
  /**
   * Whether the picker is on screen.
   *
   * Closed by default, and that is the shape of the panel rather than a
   * preference: the resting state is a machine, a path and **Attach**, which is
   * everything somebody who knows where they are going needs. The dropdown and
   * its Refresh are for the person who does not, and they arrive when asked for.
   *
   * The *search* is not behind this. It still runs the moment a machine is
   * chosen (see below), so pressing Browse shows an answer that is already there
   * instead of starting a wait — the reason to fold the control away is that it
   * is noise until it is wanted, not that it is expensive.
   */
  const [browsing, setBrowsing] = useState(false);
  /**
   * The last value this panel put in the path field on the user's behalf.
   *
   * The field is filled from memory when a machine is chosen and from the list
   * when a row is clicked, and both must give way to typing: a path the user
   * edited is theirs and changing machines must not silently discard it. So a
   * suggestion is only ever replaced by another suggestion, and anything else in
   * the field is left alone.
   */
  const suggested = useRef('');

  useEffect(() => {
    if (mode === 'remote') void store.loadSshHosts();
  }, [mode]);

  /*
   * The config's first entry, and only where nothing better is known.
   *
   * The functional form is not a style choice, and an end-to-end test found out
   * why: both effects run in the same commit on a *reopened* panel, where the
   * machine list is already loaded, and this one closes over the `alias` from the
   * render it was scheduled in — which is still `''` even though the effect above
   * has just set it. Written as `if (alias === '')` it therefore overwrote the
   * machine the user attached last with whichever name happens to be first in
   * their ssh config, on every open but the first.
   */
  useEffect(() => {
    if (sshHosts.length > 0) setAlias((current) => (current === '' ? sshHosts[0]!.alias : current));
  }, [sshHosts, alias]);

  useEffect(() => {
    const remembered = loadLastWorkspace(alias.trim()) ?? '';
    /*
     * Read the old suggestion *before* recording the new one.
     *
     * `setPath` with a function defers that function to the render; the line
     * after it runs immediately. Written the obvious way round — assign the ref,
     * then call `setPath` — the updater sees the value it is about to be
     * compared against, so `current === suggested.current` is never true and a
     * path this panel had filled in was treated as something the user typed.
     * The effect: choosing a workspace on one machine and then switching
     * machines carried that path across, still in the field, now pointing at a
     * directory on a different computer. Found end to end, not by reading.
     */
    const previous = suggested.current;
    suggested.current = remembered;
    setPath((current) => (current === '' || current === previous ? remembered : current));
    // A list of folders on one machine beside a field naming another is worse
    // than no list: it looks current. This also cancels a search still in flight
    // for the machine being left.
    store.clearDiscovery();
  }, [alias]);

  /**
   * The machine this panel has already gone and looked at.
   *
   * Not state: nothing renders it, and it exists only so that the effect below
   * does not open a second connection when it re-runs for a reason that is not
   * the alias — the ssh-config list arriving a moment after mount being the one
   * that actually happens.
   */
  const asked = useRef<string | null>(null);

  const look = (target: string): void => {
    asked.current = target;
    void store.discoverWorkspaces(target);
  };

  /*
   * Go and look, on our own, once there is a machine to look at.
   *
   * The delay is the whole decision and it lives in `attachTrigger.ts`: `0` for a
   * name the user's config knows — they chose it, there is nothing to wait for —
   * and a debounce for one being typed, because `user@10.0.0.9` passes through
   * nine prefixes that are not machines. `null` means this could not be a
   * destination at all, and nothing is attempted.
   */
  useEffect(() => {
    if (mode !== 'remote') return;
    const target = alias.trim();
    if (asked.current === target) return;
    const delay = autoDiscoverDelay(
      target,
      sshHosts.map((h) => h.alias),
    );
    if (delay === null) return;
    // Guarded rather than merely cleared: leaving the field starts the same
    // search early (see `askNow`), and the timer for that keystroke is still
    // scheduled. Asking twice for one machine is the cost of not checking.
    const timer = setTimeout(() => {
      if (asked.current !== target) look(target);
    }, delay);
    return () => clearTimeout(timer);
  }, [alias, mode, sshHosts]);

  /** Leaving the field is a person saying they have finished naming a machine. */
  const askNow = (): void => {
    const target = alias.trim();
    if (asked.current === target) return;
    if (
      autoDiscoverDelay(
        target,
        sshHosts.map((h) => h.alias),
      ) === null
    ) {
      return;
    }
    look(target);
  };

  /*
   * Closing the panel abandons the search.
   *
   * There is no cancel to send: this is one bounded, read-only command with its
   * own kill on the far side. What is cancelled is the *answer* — nothing lands
   * in a store the panel is no longer reading, and nothing is left half-shown if
   * it is reopened.
   */
  useEffect(() => () => store.clearDiscovery(), []);

  const attachLocal = async (): Promise<void> => {
    await store.addHost();
    onDone();
  };

  const attachRemote = async (): Promise<void> => {
    if (alias === '' || path.trim() === '') return;
    // Only dismissed on success: a failure leaves the panel open with the error
    // above it, so the user can fix a path rather than start again.
    if (await store.addRemoteHost(alias, path.trim())) {
      // Remembered on success and never on intent, so a path that does not work
      // is not the one offered first next time.
      rememberRemoteWorkspace(alias.trim(), path.trim());
      onDone();
    }
  };

  const choose = (candidate: string): void => {
    setPath(candidate);
    // Folded away again, because it has done its job: the path is in the field,
    // the next thing to press is Attach, and leaving the picker open would keep
    // a control on screen whose only purpose was to fill a box that is now full.
    // Browse reopens it, with the same answer, at no cost.
    setBrowsing(false);
    // Counts as a suggestion, not as typing: picking `~/a` on one machine and
    // then switching machines should not carry that path across.
    suggested.current = candidate;
  };

  // Only ever about the machine currently named. `discovery` is one alias at a
  // time, but the field can change under it between the ask and the answer.
  const search = discovery !== null && discovery.alias === alias.trim() ? discovery : null;
  const looking = search?.phase === 'looking';
  const found = search?.result ?? null;

  /**
   * The single sentence worth showing when there is nothing to choose from.
   *
   * `null` while a search is running or when it produced a list — those speak
   * for themselves — and otherwise the one thing a person needs to know: this
   * machine could not be reached, or answered and cannot be listed, or has
   * nothing under the roots that were searched.
   */
  const quietNote: string | null =
    search === null || looking
      ? null
      : search.phase === 'failed'
        ? `Could not look on ${search.alias} — ${search.error ?? 'no reason given'}. Type the path, or try again.`
        : found !== null && found.unavailable !== undefined
          ? found.unavailable
          : found !== null && found.candidates.length === 0
            ? `Nothing found on ${search.alias} under ${found.roots.join(', ')}. Type the path.`
            : null;

  return (
    /*
     * A short panel that scrolls only if a window is genuinely too short for it.
     *
     * Two structures came and went here, and both were answers to a list that no
     * longer exists. First `max-h-[calc(100vh-16rem)]`, a number picked to stop
     * thirty result rows carrying the Attach button off the bottom of the
     * window; then a scroll region above a pinned action row, when the dropdown
     * had shrunk the panel to about thirty pixels more than the column would
     * give it. Folding the picker behind **Browse** removes the pressure rather
     * than routing around it, and it was re-measured rather than assumed: 333px
     * of content in 333px at rest and 412px in 412px with the picker open and
     * twenty-seven results, so nothing scrolls at the ordinary window size in
     * either state and Attach sits 63px above this element's own bottom edge.
     *
     * What is left is one `min-h-0` and one `overflow-y-auto` — the ordinary way
     * a flex child yields — and it earns its place at a window genuinely too
     * short for the panel: at 481px the same 412px of content gets a 180px box
     * and *scrolls*, which is reachable rather than clipped, and clipped with no
     * scroll is the failure both earlier structures existed to prevent. The
     * end-to-end test measures all three states against this element's box, so a
     * regression fails rather than being scrolled past.
     */
    <div
      className="border-line grid min-h-0 gap-3 overflow-y-auto border-b p-4"
      data-testid="attach-panel"
    >
      <div className="flex gap-2">
        {(['local', 'remote'] as const).map((m) => (
          <button
            key={m}
            className={`btn flex-1 ${mode === m ? 'border-accent' : ''}`}
            data-testid={`attach-${m}`}
            onClick={() => setMode(m)}
          >
            {m === 'local' ? 'This machine' : 'Remote'}
          </button>
        ))}
      </div>

      {mode === 'local' ? (
        <button className="btn" data-testid="attach-pick-folder" onClick={() => void attachLocal()}>
          Choose a folder…
        </button>
      ) : (
        <>
          <label className="text-muted grid min-w-0 gap-1 text-xs">
            Machine
            {sshHosts.length === 0 ? (
              <input
                className="field"
                data-testid="attach-alias"
                placeholder="user@hostname"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                onBlur={askNow}
              />
            ) : (
              <>
                {/* A list *and* a field: a configured machine is the common case,
                    but a one-off `user@host` must not require editing a config
                    file first. */}
                <input
                  className="field"
                  data-testid="attach-alias"
                  list="agbrte-ssh-hosts"
                  placeholder="alias, or user@hostname"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  onBlur={askNow}
                />
                <datalist id="agbrte-ssh-hosts">
                  {sshHosts.map((h) => (
                    <option key={h.alias} value={h.alias}>
                      {h.user !== undefined ? `${h.user}@${h.hostName ?? h.alias}` : ''}
                    </option>
                  ))}
                </datalist>
              </>
            )}
            <small className="text-muted text-[11px]">
              {sshHosts.length === 0
                ? 'No ~/.ssh/config here — user@hostname works without one.'
                : 'From your ~/.ssh/config. Keys, ports and jump hosts come with it.'}
            </small>
          </label>

          {/*
            * `min-w-0` on every row that holds a field, and it is not decoration.
            *
            * A text input has an intrinsic width of about twenty characters and,
            * as a flex or grid item, will not go below it — so `[input][Browse]`
            * sets its own minimum, the grid track grows to match, and a 300px
            * sidebar answers with a *horizontal* scrollbar next to the vertical
            * one. `App.tsx`'s nav carries `overflow-x-hidden` because a 1px
            * rounding at 150% Windows scaling paints a phantom one; a real one is
            * worse.
            *
            * The margin is thin enough to be worth spending a class on: measured
            * at the default window, Browse ends at 283px of 299, and at 20px text
            * — where the panel scrolls and the scrollbar takes 15px of width —
            * 264 of 284. The end-to-end test asserts `scrollWidth <= clientWidth`
            * in every state, including one squeezed short enough to have that
            * scrollbar.
            */}
          <label className="text-muted grid min-w-0 gap-1 text-xs">
            Workspace path on that machine
            {/* Browse beside the field rather than above it: what it opens is a
                way of filling *this* box, and a control that names its target is
                worth more than a row of its own. */}
            <div className="flex min-w-0 gap-2">
              <input
                className="field min-w-0 flex-1"
                data-testid="attach-path"
                placeholder="/home/you/project"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void attachRemote();
                }}
              />
              <button
                className={`btn shrink-0 ${browsing ? 'border-accent' : ''}`}
                data-testid="attach-browse"
                aria-expanded={browsing}
                onClick={() => {
                  // Asking again costs nothing when the machine has already
                  // answered — `askNow` returns early — and it covers the case
                  // the automatic search skipped, so Browse always has either
                  // something to show or something to say.
                  if (!browsing) askNow();
                  setBrowsing((open) => !open);
                }}
              >
                Browse
              </button>
            </div>
          </label>

          {/*
           * One quiet line when the machine could not be listed, whether or not
           * anybody has pressed Browse.
           *
           * The alternative was to keep it inside the picker, and it is the worse
           * one: this feature exists for the person who does *not* know the path,
           * and if the search quietly failed they would sit in front of a Browse
           * button that opens an empty box for a reason nothing on screen gives.
           * A failure is not the resting state, so this costs a line only when
           * something actually went wrong — and it names the machine, because by
           * the time it arrives the field may say something else.
           */}
          {!browsing && quietNote !== null && (
            <p className="text-muted wrap-anywhere text-[11px]" data-testid="attach-found-note">
              {quietNote}
            </p>
          )}

          {browsing && (
            <div
              className="border-line grid min-w-0 gap-2 rounded border p-2"
              data-testid="attach-found"
            >
              {/* Pressing Browse mid-search must not open an empty box: one
                  bounded command can take twenty seconds against a machine over a
                  slow link, and this is where its answer will appear. */}
              {looking && (
                <p className="text-muted text-[11px]" data-testid="attach-looking">
                  Looking on {search?.alias ?? alias.trim()}…
                </p>
              )}

              {/* `wrap-anywhere` because this is the one string here with no
                  slashes to break after — ssh puts key fingerprints and base64 in
                  its refusals. Proven rather than assumed: without it the panel
                  measured 486px of content in a 299px column. */}
              {quietNote !== null && (
                <p className="text-muted wrap-anywhere text-[11px]" data-testid="attach-found-note">
                  {quietNote}
                </p>
              )}

              {found !== null && found.candidates.length > 0 && (
                <div className="grid min-w-0 gap-2" data-testid="attach-found-list">
                  {/* Refresh beside the thing it refreshes. It is not the way in
                      — the search has already run by the time this is on screen —
                      it is for a machine that was asleep, a key since unlocked,
                      or a folder made a minute ago. */}
                  <div className="flex min-w-0 gap-2">
                    <div className="min-w-0 flex-1">
                      <WorkspaceSelect candidates={found.candidates} value={path} onChange={choose} />
                    </div>
                    <button
                      className="btn shrink-0"
                      data-testid="attach-discover"
                      disabled={looking || alias.trim() === ''}
                      onClick={() => look(alias.trim())}
                    >
                      {looking ? 'Looking…' : 'Refresh'}
                    </button>
                  </div>

                  {found.truncated && (
                    <p className="text-muted text-[11px]">
                      There are more than these — showing the first {found.candidates.length}.
                    </p>
                  )}
                  {found.partial && (
                    <p className="text-muted text-[11px]">
                      The search was cut short, so this list may be missing things.
                    </p>
                  )}

                  {/* What was searched, next to the results and not in a log. One
                      line, and it is what makes a short or empty list legible:
                      without it an empty dropdown is indistinguishable from a
                      broken feature. */}
                  {found.roots.length > 0 && (
                    <p className="text-muted text-[11px]" data-testid="attach-searched">
                      Searched {found.roots.join(', ')} — {Math.max(1, found.depth - 1)} level
                      {found.depth - 1 === 1 ? '' : 's'} down.
                    </p>
                  )}
                </div>
              )}

              {/* Nothing to choose from, so Refresh is the only control in here
                  and has to be reachable on its own. */}
              {(found === null || found.candidates.length === 0) && !looking && (
                <button
                  className="btn"
                  data-testid="attach-discover"
                  disabled={alias.trim() === ''}
                  onClick={() => look(alias.trim())}
                >
                  Refresh
                </button>
              )}
            </div>
          )}

          <button
            className="btn"
            data-testid="attach-remote-go"
            disabled={busy || alias === '' || path.trim() === ''}
            onClick={() => void attachRemote()}
          >
            {busy ? 'Attaching…' : 'Attach'}
          </button>
          <small className="text-muted text-[11px]">
            {/* Said up front because it is true and slow, and a silent wait reads
                as a hang. */}
            First time on a machine installs a private Node under <code>~/.agbrte</code> — nothing
            system-wide, no sudo.
          </small>
        </>
      )}
    </div>
  );
}
