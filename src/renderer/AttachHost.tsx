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
 */

import { useEffect, useState, type JSX } from 'react';
import { useLoom } from './store.js';

export function AttachHost({ onDone }: { onDone: () => void }): JSX.Element {
  const store = useLoom();
  const { sshHosts, busy } = store;
  const [mode, setMode] = useState<'local' | 'remote'>('local');
  const [alias, setAlias] = useState('');
  const [path, setPath] = useState('');

  useEffect(() => {
    if (mode === 'remote') void store.loadSshHosts();
  }, [mode]);

  useEffect(() => {
    if (alias === '' && sshHosts.length > 0) setAlias(sshHosts[0]!.alias);
  }, [sshHosts, alias]);

  const attachLocal = async (): Promise<void> => {
    await store.addHost();
    onDone();
  };

  const attachRemote = async (): Promise<void> => {
    if (alias === '' || path.trim() === '') return;
    // Only dismissed on success: a failure leaves the panel open with the error
    // above it, so the user can fix a path rather than start again.
    if (await store.addRemoteHost(alias, path.trim())) onDone();
  };

  return (
    <div className="border-line grid gap-3 border-b p-3.5" data-testid="attach-panel">
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
              />
            ) : (
              <>
                {/* A list *and* a field: a configured machine is the common case,
                    but a one-off `user@host` must not require editing a config
                    file first. */}
                <input
                  className="field"
                  data-testid="attach-alias"
                  list="loom-ssh-hosts"
                  placeholder="alias, or user@hostname"
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                />
                <datalist id="loom-ssh-hosts">
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
            First time on a machine installs a private Node under <code>~/.loom</code> — nothing
            system-wide, no sudo.
          </small>
        </>
      )}
    </div>
  );
}
