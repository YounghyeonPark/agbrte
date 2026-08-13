/**
 * What the artifacts panel lists (§12).
 *
 * The listing is pure — it is derived from the event window the renderer
 * already holds — so it is tested here rather than through a browser. What a
 * browser test would add is that the bytes arrive, and that is covered where the
 * blob round trip is.
 */

import { describe, expect, it } from 'vitest';
import { artifactsIn } from '../src/renderer/artifactList.js';
import type { AgbrteEvent } from '@shared/types/index.js';

const ev = (n: number, body: Record<string, unknown>): AgbrteEvent =>
  ({ id: `id${n}`, seq: n, at: `2026-08-13T00:00:0${n}Z`, ...body }) as never;

describe('artifactsIn', () => {
  it('finds what a person attached and what a tool produced, and says which', () => {
    const found = artifactsIn([
      ev(1, { type: 'capture.attached', sha256: 'aaa', mime: 'image/png' }),
      ev(2, { type: 'agent.tool_result', toolUseId: 't1', ok: true, summary: 's', resultBlobs: ['bbb'] }),
    ]);
    expect(found).toEqual([
      { sha256: 'aaa', mime: 'image/png', origin: 'attached', at: '2026-08-13T00:00:01Z' },
      { sha256: 'bbb', origin: 'produced', at: '2026-08-13T00:00:02Z' },
    ]);
  });

  it('lists one row per blob, however many turns referenced it', () => {
    // The same screenshot attached to three turns is one picture, and a panel
    // that repeats it buries the others.
    const found = artifactsIn([
      ev(1, { type: 'capture.attached', sha256: 'aaa', mime: 'image/png' }),
      ev(2, { type: 'capture.attached', sha256: 'aaa', mime: 'image/png' }),
    ]);
    expect(found).toHaveLength(1);
  });

  it('lists every hash a tool handed back, not the first', () => {
    // Showing one of several would put the reader and the model in front of
    // different evidence, which is the gap this panel exists to close.
    const found = artifactsIn([
      ev(1, {
        type: 'agent.tool_result',
        toolUseId: 't1',
        ok: true,
        summary: 's',
        resultBlobs: ['aaa', 'bbb'],
      }),
    ]);
    expect(found.map((e) => e.sha256)).toEqual(['aaa', 'bbb']);
  });

  it('ignores a tool result that produced no bytes', () => {
    // Most of them. A panel listing every successful `read` would be noise
    // wearing the shape of evidence.
    expect(
      artifactsIn([ev(1, { type: 'agent.tool_result', toolUseId: 't', ok: true, summary: 'ok' })]),
    ).toEqual([]);
  });

  it('is empty for a session that produced nothing', () => {
    // The panel renders nothing at all in that case, rather than an empty box.
    expect(artifactsIn([ev(1, { type: 'agent.text', text: 'hello' })])).toEqual([]);
  });
});
