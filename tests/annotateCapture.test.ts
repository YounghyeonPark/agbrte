/**
 * Drawing on a capture before it is stored (DESIGN.md §12.1, §12.3).
 *
 * §12.1 promises the unredacted frame is never written to disk. §12.3 wants the
 * user to draw on it before it is sent. A single grab-and-store cannot do both —
 * the frame lands on disk, the user blacks something out afterwards, and the
 * original is already in a content-addressed index that §6.7 will push on
 * request. §12.3 says so itself: "the annotator must therefore offer redaction
 * at capture; anything later is a second-best."
 *
 * So the API is two steps with the drawing in between, and these are the tests
 * that the seam actually holds: nothing stored before the decision, blackouts
 * painted rather than deferred, and marks landing where they were drawn.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi } from '@main/ipc/api.js';
import { CH } from '@shared/ipc/contract.js';
import { Fleet } from '@main/fleet.js';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import { decodePng, encodePng, type RawImage } from '@main/content/png.js';
import { sizeOf } from '@main/content/pixels.js';
import type { ScreenBackend } from '@main/capture/client.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { Annotation, ImageBlock, Sha256 } from '@shared/types/index.js';
import type { CapturePreviewDto, CaptureResultDto } from '@shared/ipc/contract.js';

/** Wide enough that the preview is genuinely smaller, so scaling is exercised. */
const W = 2200;
const H = 1200;

function solid(): Buffer {
  const rgba = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i += 1) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 200;
    rgba[i * 4 + 2] = 200;
    rgba[i * 4 + 3] = 0xff;
  }
  return encodePng({ width: W, height: H, rgba } satisfies RawImage);
}

const screen = (frame: Buffer): ScreenBackend => ({
  access: async () => 'granted',
  sources: async () => [{ id: 'screen:0', name: 'Display 1', kind: 'screen', displayId: '1' }],
  grab: async () => frame,
});

const pixelAt = (image: RawImage, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4;
  return [image.rgba[at]!, image.rgba[at + 1]!, image.rgba[at + 2]!];
};

describe('take, draw, then store — in that order', () => {
  let root: string;
  const cleanup: Array<() => void> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-draw-'));
  });
  afterEach(async () => {
    for (const c of cleanup.splice(0)) c();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function rig(): Promise<{
    call: (channel: string, ...args: unknown[]) => Promise<unknown>;
    sessionId: string;
    blobs: () => Promise<string[]>;
  }> {
    const identity = await openWorkspace(root);
    const registry = new RuntimeRegistry();
    registry.register(new EchoRuntime({ script: [{ kind: 'stop', stop: { kind: 'end_turn' } }] }), {
      label: 'Echo',
      requiresModel: false,
    });
    const manager = new SessionManager({
      registry,
      workspaceRoot: root,
      instanceId: identity.instanceId,
    });
    const server = new SessionHostServer({
      manager,
      identity: {
        instanceId: identity.instanceId,
        lineageId: identity.lineageId,
        workspaceRoot: root,
        runtimes: ['echo'],
      },
    });

    const fleet = new Fleet({
      runtimes: [{ id: 'echo', label: 'Echo', version: '1', requiresModel: false }],
      connect: async () => {
        const pair = memoryChannelPair<SessionCommand, SessionMessage>();
        server.accept(pair.host);
        return new HostConnection({ channel: pair.main });
      },
    });
    await fleet.attach({ target: { kind: 'local' }, workspaceRoot: root });

    const api = createApi({
      fleet,
      runtimes: [],
      loadConformance: async () => null,
      broadcast: () => undefined,
      screen: screen(solid()),
    });
    cleanup.push(() => {
      api.dispose();
      manager.dispose();
    });

    const session = await fleet.createSession(identity.instanceId, { title: 's', goal: 'g' });
    const call = (channel: string, ...args: unknown[]): Promise<unknown> =>
      api.handlers.get(channel)!(...args);

    const blobs = async (): Promise<string[]> => {
      const { readdir } = await import('node:fs/promises');
      try {
        return await readdir(join(root, '.devagents', 'sessions', session.sessionId, 'attachments'));
      } catch {
        return [];
      }
    };

    return { call, sessionId: session.sessionId, blobs };
  }

  it('stores nothing at preview time', async () => {
    /**
     * The claim the whole two-step exists for. If a byte were on disk here, a
     * blackout drawn a moment later could not unwrite it — and §6.7 would push
     * the original to a remote host on request.
     */
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;

    expect(preview.pendingId).toBeTruthy();
    expect(await r.blobs()).toEqual([]);
  });

  it('shows a preview smaller than what it will store', async () => {
    // Small enough to cross an IPC boundary as a data URL without being felt,
    // which is the reason marks come back in preview pixels at all.
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;

    expect(preview.preview.dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(preview.preview.width).toBeLessThan(preview.stored.width);
    expect(preview.stored.width).toBe(W);
  });

  it('paints a blackout into the bytes it stores, and stores only that', async () => {
    /**
     * §12.3 splits blackouts out of the vector model for exactly this: every
     * other mark stays editable, and this one is applied before the frame is
     * written. Deferring it would leave the secret in the blob store for the
     * whole editable lifetime.
     */
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;
    const black: Annotation = { kind: 'blackout', rect: { x: 0, y: 0, w: 100, h: 100 } };

    const result = (await r.call(CH.captureCommit, {
      pendingId: preview.pendingId,
      sessionId: r.sessionId,
      annotations: [black],
    })) as CaptureResultDto;

    // One blob: the redacted one. No original beside it.
    expect(await r.blobs()).toHaveLength(1);
    expect(result.block.provenance.redactions).toHaveLength(1);
    // And a blackout is never left in the vectors — it is in the pixels now.
    expect(result.block.annotations ?? []).toEqual([]);
  });

  it('scales the blackout to the stored frame, not the preview', async () => {
    /**
     * The coordinate bug that would still produce a picture: marks arrive in
     * preview pixels and the frame is roughly twice that. Painting them
     * unscaled would black out the top-left corner and leave the secret visible
     * — a redaction that looks like it worked.
     */
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;
    const factor = W / preview.preview.width;

    const result = (await r.call(CH.captureCommit, {
      pendingId: preview.pendingId,
      sessionId: r.sessionId,
      // The right-hand half of the preview.
      annotations: [
        {
          kind: 'blackout',
          rect: { x: preview.preview.width / 2, y: 0, w: preview.preview.width / 2, h: 40 },
        },
      ],
    })) as CaptureResultDto;

    const painted = result.block.provenance.redactions![0]!;
    expect(painted.x).toBeGreaterThan(W * 0.45);
    expect(painted.x).toBeLessThan(W * 0.55);
    expect(Math.round(painted.w * (1 / factor))).toBeCloseTo(preview.preview.width / 2, -1);
  });

  it('keeps every other mark as a vector on the block', async () => {
    // §12.3: annotations "stay editable and the original is never destroyed".
    // Only the blackout is irreversible, and only because it must be.
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;

    const result = (await r.call(CH.captureCommit, {
      pendingId: preview.pendingId,
      sessionId: r.sessionId,
      annotations: [
        { kind: 'arrow', colour: 'red', from: { x: 10, y: 10 }, to: { x: 50, y: 50 } },
        { kind: 'blackout', rect: { x: 0, y: 0, w: 20, h: 20 } },
      ],
    })) as CaptureResultDto;

    expect(result.block.annotations).toHaveLength(1);
    expect(result.block.annotations![0]!.kind).toBe('arrow');
  });

  it('scales the editable marks too, so they land where they were drawn', async () => {
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;
    const factor = W / preview.preview.width;

    const result = (await r.call(CH.captureCommit, {
      pendingId: preview.pendingId,
      sessionId: r.sessionId,
      annotations: [{ kind: 'arrow', colour: 'red', from: { x: 0, y: 0 }, to: { x: 100, y: 100 } }],
    })) as CaptureResultDto;

    const arrow = result.block.annotations![0]! as Extract<Annotation, { kind: 'arrow' }>;
    expect(arrow.to.x).toBe(Math.round(100 * factor));
  });

  it('consumes the frame, so a second commit cannot resurrect it', async () => {
    // The unredacted bytes stop existing at the moment the redacted ones start.
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;
    await r.call(CH.captureCommit, { pendingId: preview.pendingId, sessionId: r.sessionId });

    await expect(
      r.call(CH.captureCommit, { pendingId: preview.pendingId, sessionId: r.sessionId }),
    ).rejects.toThrow(/no longer waiting/);
  });

  it('throws the frame away when the annotator is closed', async () => {
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;
    await r.call(CH.captureDiscard, preview.pendingId);

    await expect(
      r.call(CH.captureCommit, { pendingId: preview.pendingId, sessionId: r.sessionId }),
    ).rejects.toThrow(/no longer waiting/);
    expect(await r.blobs()).toEqual([]);
  });

  it('really blacks the pixels out, not just the record of them', async () => {
    /**
     * Checked by decoding the stored blob rather than by trusting
     * `provenance.redactions`. A pipeline that recorded the rectangles and
     * stored the frame unpainted would pass every assertion above and be the
     * exact failure §12.1 spends its length preventing.
     */
    const r = await rig();
    const preview = (await r.call(CH.capturePreview, { sourceId: 'screen:0' })) as CapturePreviewDto;

    const result = (await r.call(CH.captureCommit, {
      pendingId: preview.pendingId,
      sessionId: r.sessionId,
      annotations: [{ kind: 'blackout', rect: { x: 0, y: 0, w: 200, h: 200 } }],
    })) as CaptureResultDto;

    const { readFile } = await import('node:fs/promises');
    const stored = await readFile(
      join(root, '.devagents', 'sessions', r.sessionId, 'attachments', `${result.block.sha256}.png`),
    );
    const image = decodePng(stored);

    expect(pixelAt(image, 50, 50)).toEqual([0, 0, 0]);
    // Outside the blackout, untouched — a redaction and not a wipe.
    expect(pixelAt(image, W - 50, H - 50)).toEqual([200, 200, 200]);
    expect(sizeOf(stored).width).toBe(W);
    void ('' as Sha256);
    void (result.block as ImageBlock);
  });
});
