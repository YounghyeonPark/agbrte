/**
 * Choosing where a session works (DESIGN.md §5.1, §8, §6.2).
 *
 * A session picks a workspace folder when it is created. That sentence used to
 * be untrue in a specific way: the folder was picked when a *host* was attached,
 * so it was a property of the connection, and every session on a machine
 * inherited whichever folder had been named when that machine was first reached.
 * A host is one per machine now and holds the folders its sessions named, so the
 * question moved here — to the moment somebody is deciding what to work on.
 *
 * ## Two questions, in the order a person answers them
 *
 * **Which machine** comes from `machines.ts` — this one, plus any that have been
 * named. **Which folder** is asked differently on each, and the difference is
 * not cosmetic: locally there is a native picker, which knows about drives,
 * network shares and the folder you were last in; remotely there is no picker at
 * all, so the machine is asked what is on it (§6.2) and the answer is offered as
 * a list beside a field that still accepts anything.
 *
 * The list is bounded on purpose — a small set of roots, a shallow depth, a cap,
 * a timeout — so a workspace four levels down is *expected* to be missed, and
 * the field is where it is typed. It is the fallback, not a leftover.
 *
 * ## Opening a folder is the act, and it is separate from starting a session
 *
 * Choosing a folder **opens** it: that starts the machine's host if it is not
 * running, deploys to a remote that has never been used, and makes the folder's
 * sessions readable. Only then can this panel show what is already there — and
 * showing it is the point of the second step. A folder somebody opened last
 * month usually has the session they actually want in it, and a form that went
 * straight from "which folder" to "what shall we call the new one" would make
 * starting a duplicate the easiest thing to do.
 *
 * So the second step lists what is on disk and offers to start something new
 * beside it. Both are one click; neither is a default.
 */

import { useEffect, useState, type JSX } from 'react';
import { useAgbrte } from './store.js';
import { WorkspaceSelect } from './WorkspaceSelect.js';
import { loadMachines, type Machine } from './machines.js';
import { loadLastWorkspace, rememberRemoteWorkspace } from './remoteWorkspaces.js';
import type { HostInfo } from '../shared/ipc/contract.js';

/**
 * The folder's own name, out of a path this process must not parse with `path`.
 *
 * The renderer is sandboxed — no Node built-ins — and even if it were not, the
 * separator belongs to the *host*, not to this window: a workspace reached over
 * ssh is posix while the app runs on Windows. So both separators, and empty
 * segments dropped, because a trailing slash would otherwise name the session
 * after nothing.
 *
 * Used for a session title nobody had to type. A path with no segment at all
 * (`/`) falls back to a generic name rather than to nothing, since this is the
 * text that ends up on a card.
 */
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
  return parts.at(-1) ?? 'New session';
}

export function NewSession({
  onOpened,
  onClose,
}: {
  /** A session was started. The caller opens it. */
  onOpened: () => void;
  onClose: () => void;
}): JSX.Element {
  const store = useAgbrte();
  const { sshHosts, busy, discovery, onDisk, hosts } = store;
  const [machines] = useState<Machine[]>(() => loadMachines());
  const [machineId, setMachineId] = useState<string>(() => machines[0]?.id ?? 'local');
  const [path, setPath] = useState('');
  /**
   * A folder made for this session, under the one browsed to (§8).
   *
   * One session, one folder is the rule, and nothing in the form said so: the
   * field took a path, the list offered every directory a machine had, and the
   * result was sessions sitting on top of `~/Desktop` — a workspace holding
   * somebody's whole desktop, `.agbrte` and all. Reported from a real server.
   *
   * Empty means "open what is in the field", which is still right for a project
   * that already exists. A name here means "make me a folder for this", and the
   * path that gets opened is shown before anything is created — because a folder
   * appearing on a remote machine is a change to it, and the rule is that those
   * are visible before they happen (§6.4).
   */
  const [folder, setFolder] = useState('');
  const [opened, setOpened] = useState<HostInfo | null>(null);
  const [title, setTitle] = useState('');

  const machine = machines.find((m) => m.id === machineId) ?? machines[0]!;

  useEffect(() => {
    if (machine.kind !== 'ssh') return;
    void store.loadSshHosts();
    // The folder used last on *this* machine, which is nearly always the one
    // wanted again. Cleared rather than carried when the machine changes: a path
    // from another computer in this field looks current and is not.
    setPath(loadLastWorkspace(machine.id) ?? '');
    store.clearDiscovery();
    void store.discoverWorkspaces(machine.id);
  }, [machineId]);

  useEffect(() => () => store.clearDiscovery(), []);

  const search = discovery !== null && discovery.alias === machine.id ? discovery : null;
  const found = search?.result ?? null;

  const pickLocalFolder = async (): Promise<void> => {
    const chosen = await store.pickFolder();
    if (chosen !== null) setPath(chosen);
  };

  /**
   * Where this session's work will live.
   *
   * A separator picked from the path rather than from this machine: the field
   * may name a folder on a Linux box while the app runs on Windows, and joining
   * with the *local* separator would produce a path that machine cannot open.
   */
  const target = ((): string => {
    const base = path.trim().replace(/[\\/]+$/, '');
    const name = folder.trim().replace(/^[\\/]+/, '');
    if (name === '') return base;
    return `${base}${base.includes(String.fromCharCode(92)) ? String.fromCharCode(92) : '/'}${name}`;
  })();

  /** Open the folder, which is what makes its sessions readable. */
  const openFolder = async (): Promise<void> => {
    const root = target;
    if (root === '') return;
    const host =
      machine.kind === 'local'
        ? await store.attachLocalHost(root)
        : await store.attachRemoteHost(machine.id, root);
    if (host === null) return;
    // Remembered on success and never on intent, so a path that does not work is
    // not the one offered first next time.
    if (machine.kind === 'ssh') rememberRemoteWorkspace(machine.id, root);
    setOpened(host);
    setTitle(folderName(host.root));
  };

  const start = async (): Promise<void> => {
    if (opened === null) return;
    const name = title.trim() === '' ? folderName(opened.root) : title.trim();
    // Goal and title the same string: §7's `create` requires a goal, and
    // inventing prose for one would put words in the user's mouth.
    await store.createSession(opened.instanceId, name, name);
    onOpened();
  };

  /*
   * Sessions already in the folder that was just opened.
   *
   * From `onDisk` rather than a second fetch: opening a workspace re-reads it,
   * and the store already holds the answer. Filtered to this checkout, because
   * `instanceId` is what says which folder a row came from (§5.1) — a path
   * comparison would be wrong the moment one of them moved.
   */
  const already =
    opened === null ? [] : onDisk.filter((session) => session.instanceId === opened.instanceId);
  const openedHost = opened === null ? null : hosts.find((h) => h.instanceId === opened.instanceId);

  return (
    <div
      className="border-line grid min-h-0 gap-3 overflow-y-auto border-b p-4"
      data-testid="new-session-panel"
    >
      {opened === null ? (
        <>
          <label className="text-muted grid min-w-0 gap-1 text-xs">
            Machine
            <select
              className="field"
              data-testid="new-session-machine"
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
            >
              {machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          {machine.kind === 'local' ? (
            <label className="text-muted grid min-w-0 gap-1 text-xs">
              Folder
              <div className="flex min-w-0 gap-2">
                <input
                  className="field min-w-0 flex-1"
                  data-testid="new-session-path"
                  placeholder="Choose a folder…"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                />
                <button
                  className="btn shrink-0"
                  data-testid="new-session-pick"
                  onClick={() => void pickLocalFolder()}
                >
                  Browse
                </button>
              </div>
              <NewFolderField
                value={folder}
                onChange={setFolder}
                target={target}
                onSubmit={() => void openFolder()}
              />
            </label>
          ) : (
            <>
              {/* The list is the *input* to the decision and the field is the
                  decision, so both are on screen: discovery is bounded and a
                  workspace it missed still has to be reachable (§6.2). */}
              {found !== null && found.candidates.length > 0 && (
                /* `min-w-0` on the wrapper, and it is load-bearing: the trigger
                   is a grid item, whose automatic minimum size is its
                   *max-content* width — a seventy-character path — so its own
                   `truncate-line` cannot save the column. Measured: 557px in a
                   299px sidebar. */
                <div className="grid min-w-0 gap-2" data-testid="new-session-found">
                  <WorkspaceSelect
                    candidates={found.candidates}
                    value={path}
                    onChange={(chosen) => setPath(chosen)}
                  />
                </div>
              )}
              <label className="text-muted grid min-w-0 gap-1 text-xs">
                Folder on {machine.label}
                <input
                  className="field min-w-0"
                  data-testid="new-session-path"
                  placeholder="/home/you/project"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void openFolder();
                  }}
                />
              </label>
              <NewFolderField
                value={folder}
                onChange={setFolder}
                target={target}
                onSubmit={() => void openFolder()}
              />
              {search?.phase === 'looking' && (
                <p className="text-muted text-[11px]" data-testid="new-session-looking">
                  Looking on {machine.label}…
                </p>
              )}
              {found?.unavailable !== undefined && (
                <p className="text-muted wrap-anywhere text-[11px]" data-testid="new-session-note">
                  {found.unavailable}
                </p>
              )}
              {search?.phase === 'failed' && (
                <p className="text-muted wrap-anywhere text-[11px]" data-testid="new-session-note">
                  Could not look on {machine.label} — {search.error ?? 'no reason given'}. Type the
                  path.
                </p>
              )}
              {sshHosts.length === 0 && machines.length === 1 && (
                <p className="text-muted text-[11px]">No machines named yet — attach one first.</p>
              )}
            </>
          )}

          <button
            className="btn"
            data-testid="new-session-open"
            disabled={busy || target === ''}
            onClick={() => void openFolder()}
          >
            {busy ? 'Opening…' : folder.trim() === '' ? 'Open folder' : 'Create and open'}
          </button>
        </>
      ) : (
        <>
          <p className="text-muted truncate-line text-xs" data-testid="new-session-opened">
            {openedHost?.root ?? opened.root}
          </p>

          {/* What is already here, before offering to make another. A folder
              opened last month usually holds the session actually wanted, and a
              form that skipped this would make a duplicate the easiest thing to
              make. */}
          {already.length > 0 && (
            <div className="grid gap-1" data-testid="new-session-existing">
              <span className="text-muted text-[11px]">
                {already.length} session{already.length === 1 ? '' : 's'} already here
              </span>
              {already.slice(0, 6).map((session) => (
                <button
                  key={session.sessionId}
                  className="btn text-left"
                  data-testid="new-session-existing-row"
                  onClick={() => {
                    void store.openSession(session.sessionId, opened.instanceId);
                    onOpened();
                  }}
                >
                  {session.title}
                </button>
              ))}
            </div>
          )}

          <label className="text-muted grid min-w-0 gap-1 text-xs">
            New session
            <input
              className="field"
              data-testid="new-session-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void start();
              }}
            />
          </label>
          <button
            className="btn text-accent"
            data-testid="new-session-start"
            disabled={busy}
            onClick={() => void start()}
          >
            Start
          </button>
          <button className="btn" data-testid="new-session-cancel" onClick={onClose}>
            Close
          </button>
        </>
      )}
    </div>
  );
}

/**
 * A folder of this session's own, under the one browsed to (§8).
 *
 * One session, one folder is the rule this form never stated. What it asked for
 * was *a path*, and the list beside it offered every directory a machine had —
 * so the easy answer was whatever was already there, and a session ended up
 * holding somebody's entire `~/Desktop`, `.agbrte` and all.
 *
 * Optional rather than forced: a project that already exists is a folder you
 * open, not one you make, and that is most of the work anybody does here. What
 * this adds is that starting something *new* no longer means finding a place for
 * it in a file manager first.
 *
 * The resolved path is shown before anything happens, because creating a
 * directory on a machine — especially one across an ssh connection — is a change
 * to it, and a change made on somebody's behalf has to be legible first.
 */
function NewFolderField({
  value,
  onChange,
  target,
  onSubmit,
}: {
  value: string;
  onChange: (name: string) => void;
  target: string;
  onSubmit: () => void;
}): JSX.Element {
  return (
    <label className="text-muted grid min-w-0 gap-1 text-xs">
      New folder for this session <span className="opacity-60">(optional)</span>
      <input
        className="field min-w-0"
        data-testid="new-session-folder"
        placeholder="the-parser-rewrite"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
      />
      {value.trim() !== '' && (
        <span className="wrap-anywhere text-[11px]" data-testid="new-session-target">
          will create {target}
        </span>
      )}
    </label>
  );
}
