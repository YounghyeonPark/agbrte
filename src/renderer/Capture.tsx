/**
 * Pointing at what you are looking at (DESIGN.md §12.1).
 *
 * > Triggered from the composer or a shortcut scoped to the focused session.
 *
 * The picker, and only the picker. Everything that decides anything — whether
 * this client may look at the screen, what is cropped, what is painted, where
 * the bytes go — happens in main, and this file receives the result. That split
 * is not tidiness: a renderer that held the frame would be a renderer that could
 * be asked to store it, and §12.1's guarantee is that only the redacted buffer
 * is ever storable.
 *
 * So what comes back here is an `ImageBlock` — a hash the owning host can
 * already resolve, because for a remote session the transfer (§6.7) finished
 * before `grab` resolved. The renderer never holds a screenshot.
 */

import { useEffect, useState, type JSX } from 'react';
import type { CaptureSourceInfo } from '@shared/ipc/contract.js';
import type { ImageBlock } from '@shared/types/index.js';

const agbrte = (): Window['agbrte'] => window.agbrte;

/**
 * A capture the user has taken and not yet sent.
 *
 * Held as the block plus its label, because once it is stored the block is all
 * that travels and the name is only for the person looking at the chip.
 */
export interface Attachment {
  block: ImageBlock;
  label: string;
  /** Whether the secret sweep ran. Shown, because unscanned is not clean (§12.1). */
  scanned: boolean;
}

export function CapturePicker({
  sessionId,
  onCaptured,
  onClose,
}: {
  sessionId: string;
  onCaptured: (attachment: Attachment) => void;
  onClose: () => void;
}): JSX.Element {
  const [sources, setSources] = useState<CaptureSourceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void agbrte()
      .capture.sources()
      .then((found) => {
        if (live) setSources(found);
      })
      // `sources` resolves empty on a client with no screen, so reaching this
      // means something else went wrong — most likely macOS declining, which
      // arrives with the sentence that says where to go and fix it.
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      live = false;
    };
  }, []);

  const take = async (source: CaptureSourceInfo): Promise<void> => {
    setBusy(source.id);
    setError(null);
    try {
      const result = await agbrte().capture.grab({
        sessionId,
        sourceId: source.id,
        // Recorded in provenance, which is what makes a window grab say which
        // window months later.
        ...(source.kind === 'window' ? { windowTitle: source.name } : {}),
        ...(source.displayId !== undefined ? { displayId: source.displayId } : {}),
      });
      onCaptured({ block: result.block, label: source.name, scanned: result.scanned });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="bg-panel border-line absolute bottom-full left-4 mb-2 w-[30rem] rounded border p-3 shadow-lg"
      data-testid="capture-picker"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">Capture a screen or window</span>
        <button className="btn-quiet text-xs" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>

      {error !== null && (
        <p className="text-state-failed mb-2 text-xs" data-testid="capture-error">
          {error}
        </p>
      )}

      {sources === null && <p className="text-muted text-xs">Looking…</p>}

      {/* Empty is a real answer, not a failure: a browser client has no screen,
          and §12.1's other half — the headless screenshot — is the thing it can
          still use. Saying so beats an empty box. */}
      {sources !== null && sources.length === 0 && (
        <p className="text-muted text-xs" data-testid="capture-none">
          Nothing to capture from this client. Use the desktop app, or ask the agent to
          screenshot a page it is serving.
        </p>
      )}

      <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto">
        {(sources ?? []).map((source) => (
          <button
            key={source.id}
            type="button"
            className="border-line hover:border-accent flex flex-col gap-1 rounded border p-1 text-left disabled:opacity-50"
            data-testid="capture-source"
            disabled={busy !== null}
            onClick={() => void take(source)}
          >
            {source.thumbnailDataUrl !== undefined ? (
              <img src={source.thumbnailDataUrl} alt="" className="h-20 w-full object-cover" />
            ) : (
              <span className="bg-line h-20 w-full" />
            )}
            <span className="truncate text-[11px]" title={source.name}>
              {busy === source.id ? 'Capturing…' : source.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** One taken capture, sitting above the composer until it is sent or dropped. */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}): JSX.Element {
  return (
    <span
      className="border-line flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs"
      data-testid="attachment"
    >
      <span className="truncate max-w-40" title={attachment.label}>
        {attachment.label}
      </span>
      <span className="text-muted">
        {attachment.block.width}×{attachment.block.height}
      </span>
      {/* §12.1: "'Looked and found nothing' is distinct from 'could not look.'"
          OCR is not built, so this is the ordinary case — and showing it is the
          entire reason `scanned` is carried out of the capture. */}
      {!attachment.scanned && (
        <span className="text-muted" title="No secret scan ran on this capture">
          unscanned
        </span>
      )}
      <button type="button" className="text-muted hover:text-fg" onClick={onRemove} title="Remove">
        ×
      </button>
    </span>
  );
}
