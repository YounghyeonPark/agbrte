/**
 * Opening the dev server an agent is working on (DESIGN.md §6.8, §12.1).
 *
 * The point is §12.1's *preview-then-capture*: forward the port, open it in your
 * browser, capture that window, annotate, send — you see exactly what the model
 * will see. Without this, an agent on a build box is writing a page nobody can
 * look at, and the only feedback loop left is asking it whether the page looks
 * right.
 *
 * ## Shown for remote sessions only
 *
 * A local session's dev server is already on `localhost` and the user already
 * knows the port they started it on. Offering to "forward" it would be a button
 * that does nothing visible, which teaches people the feature does nothing.
 *
 * ## "Nothing is answering" is a state, not an error
 *
 * A forward opens whether or not anything is listening at the far end, because
 * `ssh -L` binds the local side immediately. A dev server that is still
 * compiling is indistinguishable from a port that will never answer, so the
 * tunnel is kept and labelled rather than torn down — and there is a way to look
 * again that keeps the same local port, so a browser tab already open on it
 * starts working instead of needing a new URL.
 */

import { useEffect, useState, type JSX } from 'react';
import type { DetectedPortDto, ForwardDto } from '@shared/ipc/contract.js';

const FIELD =
  'bg-panel border-line focus:border-accent w-20 rounded border px-2 py-1 text-xs outline-none';

export function Preview({
  sessionId,
  instanceId,
  remote,
}: {
  sessionId: string;
  instanceId: string;
  remote: boolean;
}): JSX.Element | null {
  const [forwards, setForwards] = useState<ForwardDto[]>([]);
  const [found, setFound] = useState<DetectedPortDto[]>([]);
  const [port, setPort] = useState('3000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void window.agbrte.preview.list(sessionId).then(setForwards, () => setForwards([]));
  }, [sessionId]);

  // Asked of the host, which is where the answer is. Empty is ordinary — nothing
  // is running there, or the host predates the command — so the typed field
  // stays rather than being replaced by a picker that might have nothing in it.
  useEffect(() => {
    void window.agbrte.preview.detect(instanceId).then(setFound, () => setFound([]));
  }, [instanceId]);

  if (!remote) return null;

  const open = async (): Promise<void> => {
    const n = Number(port);
    setBusy(true);
    setError(null);
    try {
      await window.agbrte.preview.open({ instanceId, sessionId, port: n });
      setForwards(await window.agbrte.preview.list(sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-line flex flex-wrap items-center gap-2 border-t px-3 py-2 text-xs">
      <span className="text-muted">Preview a port on that machine</span>
      <input
        className={FIELD}
        value={port}
        inputMode="numeric"
        aria-label="Remote port to forward"
        onChange={(e) => setPort(e.target.value)}
      />
      <button
        className="border-line hover:border-accent rounded border px-2 py-1"
        disabled={busy || port.trim() === ''}
        onClick={() => void open()}
      >
        Forward
      </button>

      {found
        .filter((f) => !forwards.some((open) => open.remotePort === f.port))
        .map((f) => (
          <button
            key={f.port}
            className="border-line hover:border-accent text-muted rounded border border-dashed px-2 py-1"
            title={
              f.loopbackOnly
                ? `Listening on ${f.address} over there — only reachable through a tunnel`
                : `Listening on ${f.address} over there — already reachable from off that machine`
            }
            onClick={() => {
              setPort(String(f.port));
              void (async () => {
                setBusy(true);
                try {
                  await window.agbrte.preview.open({ instanceId, sessionId, port: f.port });
                  setForwards(await window.agbrte.preview.list(sessionId));
                } catch (err) {
                  setError(err instanceof Error ? err.message : String(err));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {f.loopbackOnly ? '' : '⚠ '}
            :{f.port}
          </button>
        ))}

      {forwards.map((f) => (
        <span key={f.remotePort} className="border-line flex items-center gap-1 rounded border px-2 py-1">
          <a
            className="text-accent underline"
            href={f.url}
            target="_blank"
            rel="noreferrer"
            title={`${f.url} → port ${f.remotePort} on that machine`}
          >
            :{f.remotePort}
          </a>
          {f.reachable ? null : (
            <button
              className="text-muted hover:text-fg"
              title="Nothing answered there yet — a dev server that is still starting looks the same. Look again."
              onClick={() => {
                void window.agbrte.preview
                  .recheck({ sessionId, port: f.remotePort })
                  .then(() => window.agbrte.preview.list(sessionId))
                  .then(setForwards);
              }}
            >
              nothing there yet ↻
            </button>
          )}
          <button
            className="text-muted hover:text-fg"
            aria-label={`Close the preview of port ${f.remotePort}`}
            onClick={() => {
              void window.agbrte.preview
                .close({ sessionId, port: f.remotePort })
                .then(() => window.agbrte.preview.list(sessionId))
                .then(setForwards);
            }}
          >
            ×
          </button>
        </span>
      ))}

      {error === null ? null : <span className="text-warn">{error}</span>}
    </div>
  );
}
