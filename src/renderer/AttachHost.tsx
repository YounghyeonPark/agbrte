/**
 * Attaching a host (DESIGN.md §6.2, §10).
 *
 * Two ways in, and the remote one is deliberately not a connection form. The
 * user's machines are already described in `~/.ssh/config` — hostname, user,
 * port, key, jump host, proxy command — and every one of those answers is better
 * than what a form would collect, because it is the same answer their terminal
 * uses. So remote attach is: pick a name, say where the workspace is.
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
                placeholder="ssh alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              />
            ) : (
              <select
                className="field"
                data-testid="attach-alias"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
              >
                {sshHosts.map((h) => (
                  <option key={h.alias} value={h.alias}>
                    {h.alias}
                    {h.user !== undefined ? ` — ${h.user}@${h.hostName ?? h.alias}` : ''}
                  </option>
                ))}
              </select>
            )}
            <small className="text-muted text-[11px]">
              {sshHosts.length === 0
                ? 'No ~/.ssh/config found — type a name ssh already knows.'
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
