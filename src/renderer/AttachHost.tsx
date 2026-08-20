/**
 * Naming a machine (DESIGN.md §6.2, §8, §8.3).
 *
 * This panel used to attach a *workspace*: a machine **and** a folder, in one
 * form, because a host was one per folder and there was nothing else an attach
 * could mean. A host is one per machine now, and a session picks its folder when
 * it is created (§8) — so the form split, and this is the half that is about the
 * machine.
 *
 * What that buys is not tidiness. A machine and a folder are answered by
 * different people at different times: the machine is a fact about your setup
 * that changes twice a year, and the folder is the piece of work you are about
 * to start. Asking for both at once made naming a build box a thing you could
 * only do while also deciding what to do on it — and, worse, made a second
 * project on a machine you had already attached look like attaching it again.
 *
 * The workspace path field and the folder browser moved to `NewSession.tsx`,
 * where the question is asked.
 *
 * ## The remote half is deliberately not a connection form
 *
 * When the user has an `~/.ssh/config`, their machines are already described in
 * it — hostname, user, port, key, jump host, proxy command — and every one of
 * those answers is better than what a form would collect, because it is the same
 * answer their terminal uses.
 *
 * **A config is not required.** `ssh user@host` works with none at all, so the
 * field accepts that too and says so. Treating a config as a prerequisite would
 * invent one: there is nothing to "set up" before a first connection, only things
 * that can fail on it — and those are diagnosed where they happen, with the
 * command that settles each one (§8.3).
 *
 * ## Naming a machine installs nothing, and checking it is why
 *
 * Adding a machine produces no host, no private Node, no `.agbrte` on the far
 * side — §6.4's bootstrap starts a host *because of* a workspace, and installing
 * one on a box somebody was only looking at would be exactly the "we changed your
 * machine" the private runtime exists to avoid.
 *
 * So **Attach** is a question rather than an installation: it asks the machine
 * what workspaces are on it, which needs nothing but a POSIX shell (§6.2) and
 * which is the same call the folder browser will make later. A machine that
 * answers is remembered. One that cannot be reached fails here, with the
 * diagnosis, rather than at the moment somebody was trying to start work.
 */

import { useEffect, useState, type JSX } from 'react';
import { useAgbrte } from './store.js';
import { loadLastAlias } from './remoteWorkspaces.js';
import { isPlausibleAlias } from './attachTrigger.js';
import { loadMachines, rememberMachine, type Machine } from './machines.js';

export function AttachHost({
  onDone,
  initialMode = 'local',
}: {
  onDone: (machine?: Machine) => void;
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
  const [machines, setMachines] = useState<Machine[]>(() => loadMachines());

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

  /*
   * A list of folders on one machine beside a field naming another is worse than
   * no list: it looks current. This also cancels a search still in flight for
   * the machine being left.
   */
  useEffect(() => {
    store.clearDiscovery();
  }, [alias]);

  useEffect(() => () => store.clearDiscovery(), []);

  /**
   * Ask the machine what is on it, and remember it if it answers.
   *
   * The check *is* the attach. There is nothing else to do at this point — no
   * host to start, nothing to install — so a panel that merely wrote the name
   * down would report success for a machine nobody had spoken to, and the first
   * time anyone found out would be halfway through starting a session. This is
   * one bounded read-only command over the user's own ssh, with its own kill on
   * the far side (§6.2).
   *
   * A machine that answers *and cannot be listed* — a Windows remote, a shell
   * that is not POSIX — still counts as reached, because it is: the failure it
   * reports is about listing, and typing a path there works.
   */
  const attachRemote = async (): Promise<void> => {
    const target = alias.trim();
    // Refused here as well as in main, and the copy is deliberate: the renderer
    // cannot reach `assertSafeAlias`, and a leading `-` is `ssh` running a
    // command on *this* machine. Main still refuses; what this saves is a
    // rejected promise the user never asked for (see `attachTrigger.ts`).
    if (!isPlausibleAlias(target)) return;
    await store.discoverWorkspaces(target);
    /*
     * Read from the store rather than from `store`, which is a *render's*
     * snapshot: after an `await` its `discovery` is the value this component
     * last rendered with, which is `null`. The panel therefore never closed, and
     * every attach looked like a failure. Found end to end — nothing about the
     * code says which of the two is live.
     */
    const answer = useAgbrte.getState().discovery;
    if (answer === null || answer.alias !== target || answer.phase === 'failed') return;
    const updated = rememberMachine(target);
    setMachines(updated);
    onDone(updated.find((m) => m.id === target));
  };

  const search = discovery !== null && discovery.alias === alias.trim() ? discovery : null;
  const looking = search?.phase === 'looking';

  return (
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
        <>
          {/* Not a button, because there is nothing to press. The machine the app
              is running on is present by construction, and offering to "add" it
              would be offering to agree with a fact (see `machines.ts`). */}
          <p className="text-muted text-xs" data-testid="attach-local-note">
            This machine is always available. Choose a folder to work in when you start a
            session.
          </p>
          <button className="btn" data-testid="attach-local-done" onClick={() => onDone()}>
            Done
          </button>
        </>
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
              />
            ) : (
              <>
                {/* A list *and* a field: a configured machine is the common case,
                    but a one-off `user@host` must not require editing a config
                    file first. */}
                <select
                  className="field"
                  data-testid="attach-alias-list"
                  value={sshHosts.some((h) => h.alias === alias) ? alias : ''}
                  onChange={(e) => setAlias(e.target.value)}
                >
                  <option value="">Type one below…</option>
                  {sshHosts.map((h) => (
                    <option key={h.alias} value={h.alias}>
                      {h.alias}
                    </option>
                  ))}
                </select>
                <input
                  className="field"
                  data-testid="attach-alias"
                  placeholder="user@hostname"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                />
              </>
            )}
          </label>

          {search !== null && search.phase === 'failed' && (
            <p className="text-muted wrap-anywhere text-[11px]" data-testid="attach-error">
              Could not reach {search.alias} — {search.error ?? 'no reason given'}.
            </p>
          )}

          <button
            className="btn"
            data-testid="attach-remote-go"
            disabled={busy || looking || alias.trim() === ''}
            onClick={() => void attachRemote()}
          >
            {looking ? 'Checking…' : 'Attach'}
          </button>

          {machines.length > 1 && (
            <div className="grid gap-1" data-testid="attach-machines">
              <span className="text-muted text-[11px]">Machines you have named</span>
              {machines
                .filter((m) => m.kind === 'ssh')
                .map((m) => (
                  <span key={m.id} className="text-xs" data-testid="attach-machine">
                    {m.label}
                  </span>
                ))}
            </div>
          )}

          <small className="text-muted text-[11px]">
            {/* Said up front because it is true, slow, and happens *later*: naming
                a machine installs nothing. The first time a folder is opened on
                one, a private Node lands under `~/.agbrte` — nothing
                system-wide, no sudo. */}
            Naming a machine installs nothing. Opening the first folder on it installs a private
            Node under <code>~/.agbrte</code> — nothing system-wide, no sudo.
          </small>
        </>
      )}
    </div>
  );
}
