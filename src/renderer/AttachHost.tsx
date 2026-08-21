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
 * The folder half did not disappear, and putting it *only* in `NewSession.tsx`
 * was a mistake this panel paid for. A machine with no folder open has no host,
 * so pressing a button called **Attach** left the sidebar reading "No hosts
 * attached yet" — which is exactly what a connection that failed looks like.
 * The panel now carries on: the machine answers with the folders on it, opening
 * one starts the host, and the sidebar shows it with the sessions already in
 * that folder. `NewSession.tsx` asks the same questions for a second project on
 * a machine already attached.
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
 * what workspaces are on it, which needs nothing but a POSIX shell (§6.2). A
 * machine that answers is remembered. One that cannot be reached fails here,
 * with the diagnosis, rather than at the moment somebody was trying to start
 * work. The installation — a private Node under `~/.agbrte` — happens on the
 * step after it, when a folder is opened, which is the step that has always
 * been allowed to change the far side and the one the note names.
 */

import { useEffect, useState, type JSX } from 'react';
import { useAgbrte } from './store.js';
import { loadLastAlias, loadLastWorkspace, rememberRemoteWorkspace } from './remoteWorkspaces.js';
import { WorkspaceSelect } from './WorkspaceSelect.js';
import { isPlausibleAlias } from './attachTrigger.js';
import { loadMachines, rememberMachine, type Machine } from './machines.js';
import type { RestoringMachine } from '../shared/ipc/contract.js';

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
  /**
   * The folder to open on that machine, once it has answered.
   *
   * The panel used to end at the machine: it asked what was on it, wrote the
   * name down, and closed — which is correct about the *design* (naming a
   * machine installs nothing, and a host starts because of a workspace) and a
   * dead end on screen. Nothing appeared in the sidebar, because there was no
   * host to appear; pressing a button called **Attach** and getting an empty
   * sidebar is indistinguishable from a connection that failed.
   *
   * So the second half of the act lives here now. The machine answers with the
   * folders it has, one of them is opened, and *that* is what starts the host
   * and puts it in the sidebar with the sessions already in it.
   */
  const [path, setPath] = useState('');

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

    /*
     * One press, all the way to a host.
     *
     * The panel used to stop at the machine, which left the sidebar empty and
     * read as a failed connection; then it stopped at a *folder field*, which
     * was honest and still two presses for the one thing anybody wants. So the
     * folder is resolved here and opened in the same act: the folder this person
     * opened on this machine last, or the first one discovery found.
     *
     * The choice is still on screen and still editable — the folder list and the
     * field stay below, so a machine with several projects can be re-opened
     * somewhere else without starting over. What changes is only that the common
     * case, where the answer is the folder you used last, no longer asks.
     */
    const resolved = loadLastWorkspace(target) ?? answer.result?.candidates[0]?.path ?? '';
    setPath(resolved);
    if (resolved !== '') {
      await open(target, resolved);
      return;
    }
    /*
     * Nothing to resolve, which is not a failure: a machine that answered and
     * cannot be *listed* — a Windows remote, a shell that is not POSIX — is
     * reachable and its path has to be typed. The panel stays open on the field
     * with the reason beside it.
     */
  };

  /**
   * Open the folder, which is the half that produces a host.
   *
   * `attachRemoteHost` deploys if it has to, starts the host, and re-lists what
   * is on it — so by the time this returns the sidebar has the machine and the
   * sessions already in that folder, which is the whole point of pressing
   * Attach.
   */
  const open = async (target: string, root: string): Promise<void> => {
    const host = await store.attachRemoteHost(target, root);
    if (host === null) return;
    // Remembered on success and never on intent, so a path that does not work
    // is not the one offered first next time.
    rememberRemoteWorkspace(target, root);
    onDone(machines.find((m) => m.id === target));
  };

  /** The same act from the field below, for a folder the resolution missed. */
  const openFolder = async (): Promise<void> => {
    const target = alias.trim();
    const root = path.trim();
    if (target === '' || root === '') return;
    await open(target, root);
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
          <Restoring />
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

          {search !== null && search.phase === 'done' && (
            /* The second half, on screen only once the machine has answered:
               there is nothing to choose from before that, and a folder field
               above a machine that may not exist invites typing a path nobody
               can reach. */
            <div className="grid min-w-0 gap-2" data-testid="attach-folder">
              {search.result !== null && search.result.candidates.length > 0 && (
                /* The list is the *input* to the decision and the field is the
                   decision, so both are on screen: discovery is bounded and a
                   workspace it missed still has to be reachable (§6.2). */
                <WorkspaceSelect
                  candidates={search.result.candidates}
                  value={path}
                  onChange={(chosen) => setPath(chosen)}
                />
              )}
              <label className="text-muted grid min-w-0 gap-1 text-xs">
                Folder on {search.alias}
                <input
                  className="field min-w-0"
                  data-testid="attach-path"
                  placeholder="/home/you/project"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void openFolder();
                  }}
                />
              </label>
              {search.result?.unavailable !== undefined && (
                <p className="text-muted wrap-anywhere text-[11px]" data-testid="attach-note">
                  {search.result.unavailable}
                </p>
              )}
              <button
                className="btn"
                data-testid="attach-open"
                disabled={busy || path.trim() === ''}
                onClick={() => void openFolder()}
              >
                {busy ? 'Opening…' : 'Open folder'}
              </button>
            </div>
          )}

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

/**
 * What the app is doing about the machines it was attached to last time.
 *
 * Shown here because this is where somebody comes to attach one: if the app is
 * already dialling it, the useful thing is to say so rather than to have them
 * press a button that starts a second dial. An entry that reaches its host
 * disappears from this list and appears in the sidebar, so what is left is only
 * what still needs a person.
 *
 * Polled while mounted and only while mounted, the way the CLI pane is: the
 * panel is open for seconds at a time and the states change on a backoff
 * measured in tens of them.
 */
function Restoring(): JSX.Element | null {
  const [machines, setMachines] = useState<RestoringMachine[]>([]);

  useEffect(() => {
    let alive = true;
    const read = (): void =>
      void window.agbrte.hosts
        .restoring()
        .then((next) => {
          if (alive) setMachines(next.filter((m) => m.state !== 'attached'));
        })
        .catch(() => undefined);
    read();
    const timer = setInterval(read, 2_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (machines.length === 0) return null;
  return (
    <ul className="text-muted grid gap-1 text-xs" data-testid="attach-restoring">
      {machines.map((m) => (
        <li key={`${m.alias} ${m.workspaceRoot}`}>
          {m.state === 'trying'
            ? `Reconnecting to ${m.alias} (attempt ${String(m.attempts)})…`
            : `Could not reach ${m.alias}: ${m.detail ?? 'no reason given'}`}
        </li>
      ))}
    </ul>
  );
}
