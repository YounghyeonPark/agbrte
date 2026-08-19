/**
 * Opening the dev server an agent is working on (DESIGN.md §6.8, §12.1).
 *
 * The point is §12.1's *preview-then-capture*: forward the port, open it in your
 * browser, capture that window, annotate, send — you see exactly what the model
 * will see. Without this, an agent on a build box is writing a page nobody can
 * look at, and the only feedback loop left is asking it whether the page looks
 * right.
 *
 * ## Shown for remote sessions only, and only when asked for
 *
 * A local session's dev server is already on `localhost` and the user already
 * knows the port they started it on. Offering to "forward" it would be a button
 * that does nothing visible, which teaches people the feature does nothing.
 *
 * It is also **folded** now, behind `Ports` in the pane row beside `Files`
 * (App.tsx, `portsOpen`). This row used to be permanently expanded above the
 * roster and the transcript on every remote session, listing every port the
 * host could see — on a shared build box, six of them, most belonging to
 * somebody else's services. The feature is right and the placement was not: a
 * session that has nothing to do with a web server should not open with a web
 * server's controls. Nothing is announced while it is folded, for the reason
 * recorded on `portsOpen`: the count would either be the noise itself, or would
 * cost a poll of a machine to render a digit for a panel nobody has opened.
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
import type {
  DetectedPortDto,
  ForwardDto,
  PreviewServerDto,
} from '@shared/ipc/contract.js';

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
  const [servers, setServers] = useState<PreviewServerDto[]>([]);
  const [command, setCommand] = useState('npm run dev');
  const [log, setLog] = useState<{ id: string; lines: string[] } | null>(null);

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

  // Polled rather than pushed: a preview server changes state on its own — it
  // finishes compiling, or it dies — and there is no event for that. Slow,
  // because nothing here is urgent and the alternative is a push channel for a
  // panel that is usually closed.
  useEffect(() => {
    const refresh = (): void => {
      void window.agbrte.preview
        .servers({ instanceId, sessionId })
        .then(setServers, () => setServers([]));
      void window.agbrte.preview.detect(instanceId).then(setFound, () => setFound([]));
    };
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [instanceId, sessionId]);

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
    // `shrink-0`: a fixed row beside the transcript, which is the only child of
    // the session column allowed to give up height (see SessionHeader).
    <div
      className="border-line flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2 text-xs"
      data-testid="ports-row"
    >
      <span className="text-muted">Preview a port on that machine</span>
      <input
        className={FIELD}
        data-testid="forward-port"
        value={port}
        inputMode="numeric"
        aria-label="Remote port to forward"
        onChange={(e) => setPort(e.target.value)}
      />
      <button
        className="border-line hover:border-accent rounded border px-2 py-1"
        data-testid="forward-go"
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
            data-testid="detected-port"
            data-port={f.port}
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
              className="text-muted hover:text-ink"
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
            className="text-muted hover:text-ink"
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

      {error === null ? null : <span className="text-state-fail">{error}</span>}

      {/* §3.12: an agent's background processes are reaped shortly after its run
          returns, so a dev server it starts vanishes under you. This one belongs
          to the host and outlives the turn, the app, and the lid. */}
      <div className="border-line flex w-full flex-wrap items-center gap-2 border-t pt-2">
        <span className="text-muted">Run a dev server there</span>
        <input
          className="bg-panel border-line focus:border-accent min-w-48 flex-1 rounded border px-2 py-1 text-xs outline-none"
          data-testid="server-command"
          value={command}
          aria-label="Command to run on that machine"
          onChange={(e) => setCommand(e.target.value)}
        />
        <button
          className="border-line hover:border-accent rounded border px-2 py-1"
          data-testid="server-start"
          disabled={busy || command.trim() === ''}
          onClick={() => {
            setError(null);
            void window.agbrte.preview
              .start({ instanceId, sessionId, command })
              .then(() => window.agbrte.preview.servers({ instanceId, sessionId }))
              .then(setServers)
              .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
          }}
        >
          Start
        </button>

        {servers.map((s) => (
          <span key={s.id} className="border-line flex items-center gap-1 rounded border px-2 py-1">
            <code className="text-muted">{s.command}</code>
            <span className={s.exit === null ? 'text-ink' : 'text-state-paused'}>
              {s.exit === null ? 'running' : `exited ${s.exit.code ?? s.exit.signal ?? '?'}`}
            </span>
            <button
              className="text-muted hover:text-ink"
              title="What it printed — where a server that never started says why"
              onClick={() => {
                void window.agbrte.preview
                  .serverLog({ instanceId, serverId: s.id })
                  .then((l) => setLog(l === null ? null : { id: l.id, lines: l.lines }));
              }}
            >
              log
            </button>
            {s.exit === null && (
              <button
                className="text-muted hover:text-ink"
                aria-label={`Stop ${s.command}`}
                onClick={() => {
                  void window.agbrte.preview
                    .stopServer({ instanceId, serverId: s.id })
                    .then(() => window.agbrte.preview.servers({ instanceId, sessionId }))
                    .then(setServers);
                }}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>

      {log === null ? null : (
        <pre className="bg-panel border-line max-h-40 w-full overflow-auto rounded border p-2 text-[11px] leading-snug">
          {log.lines.join('\n') || '(nothing yet)'}
        </pre>
      )}
    </div>
  );
}
