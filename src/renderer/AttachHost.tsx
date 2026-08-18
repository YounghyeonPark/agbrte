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
 *   * **the kinds are visible.** A folder holding `.devagents/` is a workspace
 *     this app has already run in and probably has sessions in; a git repository
 *     is a good guess; a plain folder is mostly noise. Flattening them would hide
 *     the only distinction anybody is choosing on, so plain folders are folded
 *     away behind a disclosure and the definitive ones are open by default.
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
import type { WorkspaceCandidateDto } from '../shared/ipc/contract.js';

/** How each kind is introduced, in the order they are worth looking at. */
const GROUPS: Array<{ kind: WorkspaceCandidateDto['kind']; title: string; hint: string }> = [
  {
    kind: 'devagents',
    title: 'Used by Agbrte before',
    hint: 'These hold a .devagents folder, so sessions may already be there.',
  },
  { kind: 'git', title: 'Git repositories', hint: '' },
  { kind: 'folder', title: 'Other folders', hint: '' },
];

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
    setPath((current) => (current === '' || current === suggested.current ? remembered : current));
    suggested.current = remembered;
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
    // Counts as a suggestion, not as typing: picking `~/a` on one machine and
    // then switching machines should not carry that path across.
    suggested.current = candidate;
  };

  // Only ever about the machine currently named. `discovery` is one alias at a
  // time, but the field can change under it between the ask and the answer.
  const search = discovery !== null && discovery.alias === alias.trim() ? discovery : null;
  const looking = search?.phase === 'looking';
  const found = search?.result ?? null;

  return (
    /* `min-h-0` + its own scroll as the backstop: the list above is bounded,
       but a short window can still leave this panel taller than the column it
       sits in, and a flex child that cannot shrink overflows silently. */
    <div
      className="border-line grid max-h-[calc(100vh-16rem)] min-h-0 gap-3 overflow-y-auto border-b p-4"
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
          <label className="text-muted grid gap-1 text-xs">
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

          {/* A retry, not the way in. The search has already run by the time this
              is read; what it is for is a machine that was asleep, a key that has
              since been unlocked, or a folder made a minute ago. */}
          <button
            className="btn"
            data-testid="attach-discover"
            disabled={looking || alias.trim() === ''}
            onClick={() => look(alias.trim())}
          >
            {looking ? 'Looking…' : 'Look again'}
          </button>

          {search !== null && (
            <div className="border-line grid gap-2 rounded border p-2" data-testid="attach-found">
              {/* One bounded command can take twenty seconds against a machine
                  over a slow link, and a still panel for twenty seconds reads as
                  a hang. It says which machine, because by then the field may
                  have moved on. */}
              {looking && (
                <p className="text-muted text-[11px]" data-testid="attach-looking">
                  Looking on {search.alias}…
                </p>
              )}

              {/* Inline, never the app's error banner: nobody pressed anything to
                  cause this, and the field below still works. */}
              {search.phase === 'failed' && (
                <p className="text-muted text-[11px]" data-testid="attach-found-note">
                  Could not look on {search.alias} — {search.error}. Type the path below, or try
                  again.
                </p>
              )}

              {found !== null && found.unavailable !== undefined && (
                <p className="text-muted text-[11px]" data-testid="attach-found-note">
                  {found.unavailable}
                </p>
              )}

              {found !== null && (
                /*
                 * The results scroll, the controls do not.
                 *
                 * A machine with a dozen repositories and fourteen ordinary
                 * folders makes this list longer than the sidebar, and the
                 * panel is a flex child of a column that does not scroll — so
                 * the overflow simply ran off the bottom of the window, taking
                 * the Attach button with it and leaving no way to reach either.
                 * Bounding the list keeps the field and the button in view,
                 * which is the pair a person needs to finish the job.
                 */
                <div className="grid gap-3" data-testid="attach-found-list">
                {GROUPS.map(({ kind, title, hint }) => {
                  const rows = found.candidates.filter((c) => c.kind === kind);
                  if (rows.length === 0) return null;
                  const list = (
                    <div className="grid gap-1">
                      {rows.map((c) => (
                        <button
                          key={c.path}
                          className={`btn text-left text-xs ${path === c.path ? 'border-accent' : ''}`}
                          data-testid="attach-candidate"
                          data-kind={c.kind}
                          data-path={c.path}
                          onClick={() => choose(c.path)}
                        >
                          {c.path}
                        </button>
                      ))}
                    </div>
                  );
                  // Plain folders are folded away: they are the noisy two thirds of
                  // any home directory, and putting them on the same footing as a
                  // workspace this app has already used would bury the answer.
                  return kind === 'folder' ? (
                    <details key={kind} data-testid={`attach-group-${kind}`}>
                      <summary className="text-muted cursor-pointer text-xs">
                        {title} ({rows.length})
                      </summary>
                      <div className="pt-1">{list}</div>
                    </details>
                  ) : (
                    <div key={kind} className="grid gap-1" data-testid={`attach-group-${kind}`}>
                      <span className="text-muted text-xs">{title}</span>
                      {hint !== '' && <span className="text-muted text-[11px]">{hint}</span>}
                      {list}
                    </div>
                  );
                })}

                {found.candidates.length === 0 && found.unavailable === undefined && (
                  <p className="text-muted text-[11px]" data-testid="attach-found-note">
                    Nothing found there. Type the path below.
                  </p>
                )}

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

                {/* What was searched, next to the results and not in a log. Without
                    it an empty list is indistinguishable from a broken feature. */}
                {found.roots.length > 0 && (
                  <p className="text-muted text-[11px]" data-testid="attach-searched">
                    Searched {found.roots.join(', ')} — {Math.max(1, found.depth - 1)} level
                    {found.depth - 1 === 1 ? '' : 's'} down.
                  </p>
                )}
                </div>
              )}
            </div>
          )}

          <label className="text-muted grid gap-1 text-xs">
            Workspace path on that machine
            <input
              className="field"
              data-testid="attach-path"
              placeholder="/home/you/project"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void attachRemote();
              }}
            />
            <small className="text-muted text-[11px]">
              Filled in by the list above, or by what you attached here last time — and typed
              directly for anything the search did not reach.
            </small>
          </label>

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
