/**
 * What a session produced, beside the transcript rather than inside it (§12).
 *
 * ## Why a panel and not inline pictures
 *
 * A transcript is read for what was decided; the working-out and the evidence
 * are read second, and only sometimes. That is the same argument that folds
 * `agent.reasoning` away, and it is where the tools that went furthest ended up
 * — VS Code surfaces screenshots and documents in a panel alongside the chat
 * rather than expanding them in it. Cursor, which renders agent-produced images
 * as links in the conversation, has open reports asking for something else.
 *
 * ## Why the pixels are not here until you ask
 *
 * A week-long session's blobs are unbounded, and this list is derived from the
 * event window the renderer already holds — so building it costs nothing, and
 * loading every image would cost everything. Each row fetches on first open,
 * once, and keeps what it got.
 *
 * ## Where the entries come from
 *
 * Two shapes, because the log records them differently. `capture.attached`
 * carries a hash *and* a mime, being something a person attached. A tool's
 * output carries `resultSha256` and no type at all, so the type is sniffed from
 * the bytes on arrival — which is also why a row cannot say what it holds until
 * it has been opened.
 */

import { useState, type JSX } from 'react';
import type { AgbrteEvent } from '../shared/types/index.js';
import { LABEL } from './App.js';

interface Entry {
  sha256: string;
  mime?: string;
  /** Which part of the session produced it — the panel groups on this. */
  origin: 'attached' | 'produced';
  at: string;
}

/** Everything in the held window that has bytes behind it, newest last. */
export function artifactsIn(events: readonly AgbrteEvent[]): Entry[] {
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const event of events) {
    const entry: Entry | null =
      event.type === 'capture.attached'
        ? { sha256: event.sha256, mime: event.mime, origin: 'attached', at: event.at }
        : event.type === 'agent.tool_result' && event.resultSha256 !== undefined
          ? { sha256: event.resultSha256, origin: 'produced', at: event.at }
          : null;
    // One row per blob: the same screenshot attached to three turns is one
    // picture, and a panel that repeats it buries the others.
    if (entry !== null && !seen.has(entry.sha256)) {
      seen.add(entry.sha256);
      out.push(entry);
    }
  }
  return out;
}

const GROUPS: Array<{ origin: Entry['origin']; label: string }> = [
  { origin: 'produced', label: 'produced by a tool' },
  { origin: 'attached', label: 'attached by a person' },
];

export function Artifacts({
  events,
  load,
}: {
  events: readonly AgbrteEvent[];
  /** Returns a `data:` URL, or null when the bytes are no longer there. */
  load: (sha256: string, mime?: string) => Promise<string | null>;
}): JSX.Element | null {
  const entries = artifactsIn(events);
  if (entries.length === 0) return null;

  return (
    <section data-testid="artifacts" className="grid gap-2">
      <h2 className={LABEL}>artifacts</h2>
      {GROUPS.map(({ origin, label }) => {
        const group = entries.filter((e) => e.origin === origin);
        if (group.length === 0) return null;
        return (
          <div key={origin} className="grid gap-1">
            <span className={`${LABEL} text-muted`}>{label}</span>
            {group.map((entry) => (
              <Row key={entry.sha256} entry={entry} load={load} />
            ))}
          </div>
        );
      })}
    </section>
  );
}

function Row({
  entry,
  load,
}: {
  entry: Entry;
  load: (sha256: string, mime?: string) => Promise<string | null>;
}): JSX.Element {
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'closed' | 'loading' | 'shown' | 'gone'>('closed');

  const open = async (): Promise<void> => {
    // Fetched once. A row reopened after being collapsed keeps what it got,
    // because the bytes cannot have changed — they are addressed by their hash.
    if (url !== null || state === 'loading') return;
    setState('loading');
    const got = await load(entry.sha256, entry.mime);
    setUrl(got);
    setState(got === null ? 'gone' : 'shown');
  };

  return (
    <details
      data-testid="artifact"
      data-sha={entry.sha256}
      className="btn"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) void open();
      }}
    >
      <summary className="cursor-pointer text-[11px]">
        <code>{entry.sha256.slice(0, 12)}</code>
        <span className="text-muted"> · {entry.mime ?? 'type unknown until opened'}</span>
      </summary>

      {state === 'loading' && <span className={`${LABEL} text-muted`}>loading…</span>}
      {/*
        * Said rather than left blank. A log outlives the bytes it references —
        * an old session on a machine whose attachments were cleared is the
        * ordinary case — and an empty box reads as a bug in the panel.
        */}
      {state === 'gone' && (
        <span className={`${LABEL} text-muted`} data-testid="artifact-gone">
          these bytes are no longer stored
        </span>
      )}
      {url !== null &&
        (url.startsWith('data:image/') ? (
          <img src={url} alt="" className="mt-1 block max-w-full" />
        ) : (
          /*
           * Not an image, so not drawn. The type was sniffed from the bytes and
           * came back as something a browser will not render; saying which is
           * more use than an empty frame.
           */
          <span className={`${LABEL} text-muted`} data-testid="artifact-not-image">
            {url.slice(5, url.indexOf(';'))} — not shown here
          </span>
        ))}
    </details>
  );
}
