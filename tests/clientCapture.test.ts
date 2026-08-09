/**
 * Capturing the screen in front of you (DESIGN.md §12.1, §15 Phase 7).
 *
 * The half of §12 that has a person in it. `headless.ts` lets an agent see its
 * own output with nobody in the loop; this is the loop.
 *
 * These run against real bytes, decoded and inspected, for the same reason
 * `pixels.test.ts` does: the question is whether the secret is actually gone,
 * and a test over a mocked codec asserts that arguments were passed along and
 * assumes the part that matters.
 *
 * The `ScreenBackend` is faked, because `desktopCapturer` needs a compositor.
 * That is exactly the seam the design puts it behind — and note what is *not*
 * faked: cropping, scanning, painting, scaling, hashing and storing all run for
 * real here, because all of them run on plain Node.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionHostServer } from '../src/host/sessionServer.js';
import { HostConnection } from '@main/host/hostConnection.js';
import { SessionManager } from '@main/sessionManager.js';
import { RuntimeRegistry } from '@main/runtime/registry.js';
import { EchoRuntime } from '@main/runtime/runtimes/echo.js';
import { openWorkspace } from '@main/store/identity.js';
import { memoryChannelPair } from '@shared/host/memoryChannel.js';
import type { SessionCommand, SessionMessage } from '@shared/host/sessionProtocol.js';
import type { ContentBlock, ImageBlock, InstanceId } from '@shared/types/index.js';
import { decodePng, encodePng, type RawImage } from '@main/content/png.js';
import { cropFrame } from '@main/content/pixels.js';
import {
  captureScreen,
  CaptureUnavailable,
  listSources,
  ScreenAccessDenied,
  type ScreenAccess,
  type ScreenBackend,
} from '@main/capture/client.js';
import { sha256Of } from '@main/store/blobs.js';
import type { Sha256 } from '@shared/types/index.js';

/** A solid image of a known colour, so a changed pixel is unambiguous. */
function solid(width: number, height: number, rgb: [number, number, number]): RawImage {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = rgb[0];
    rgba[i * 4 + 1] = rgb[1];
    rgba[i * 4 + 2] = rgb[2];
    rgba[i * 4 + 3] = 0xff;
  }
  return { width, height, rgba };
}

const pixelAt = (image: RawImage, x: number, y: number): number[] => {
  const at = (y * image.width + x) * 4;
  return [image.rgba[at]!, image.rgba[at + 1]!, image.rgba[at + 2]!, image.rgba[at + 3]!];
};

/** A frame with a distinguishable quadrant, so a crop can be checked by colour. */
function quartered(): Buffer {
  const image = solid(40, 40, [10, 10, 10]);
  for (let y = 0; y < 20; y += 1) {
    for (let x = 20; x < 40; x += 1) {
      const at = (y * 40 + x) * 4;
      image.rgba[at] = 250;
      image.rgba[at + 1] = 0;
      image.rgba[at + 2] = 0;
    }
  }
  return encodePng(image);
}

function backend(
  frame: Buffer,
  access: ScreenAccess = 'granted',
): ScreenBackend & { grabs: string[] } {
  const grabs: string[] = [];
  return {
    grabs,
    access: async () => access,
    sources: async () => [
      { id: 'screen:0', name: 'Display 1', kind: 'screen', displayId: '1' },
      { id: 'window:9', name: 'Terminal', kind: 'window' },
    ],
    grab: async (id) => {
      grabs.push(id);
      return frame;
    },
  };
}

/** Collects what was stored, so a test can look at the bytes that were kept. */
function sink(): { store: (b: Buffer, m: string) => Promise<Sha256>; written: Buffer[] } {
  const written: Buffer[] = [];
  return {
    written,
    store: async (b) => {
      written.push(b);
      return sha256Of(b) as Sha256;
    },
  };
}

describe('cutting out a region', () => {
  it('keeps the chosen pixels and drops the rest', async () => {
    const out = decodePng(await cropFrame(quartered(), { x: 20, y: 0, w: 20, h: 20 }));

    expect([out.width, out.height]).toEqual([20, 20]);
    // Every pixel is the red quadrant, so nothing outside came along.
    expect(pixelAt(out, 0, 0)).toEqual([250, 0, 0, 255]);
    expect(pixelAt(out, 19, 19)).toEqual([250, 0, 0, 255]);
  });

  it('clamps a rectangle dragged past the edge rather than reading past the buffer', async () => {
    // Completely ordinary: a selection that runs off the side of a display. An
    // out-of-bounds read here would splice in whatever followed the buffer.
    const out = decodePng(await cropFrame(quartered(), { x: 30, y: 30, w: 100, h: 100 }));
    expect([out.width, out.height]).toEqual([10, 10]);
  });

  it('refuses a rectangle that lies entirely outside', async () => {
    // Not clamped to a pixel. A fully-outside region means the rectangle and the
    // frame disagree about coordinate space, and a 1×1 capture would carry that
    // bug forward as a picture of nothing.
    await expect(cropFrame(quartered(), { x: 500, y: 500, w: 10, h: 10 })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('what gets stored is what the user chose to send', () => {
  it('stores the cropped region, not the whole screen with a viewport', async () => {
    /**
     * §12.1 treats the region as part of the capture rather than part of the
     * view, and this is why: what lies outside the rectangle is what the user
     * decided *not* to send. On a desk covered in windows that is most of the
     * sensitive content on the screen — so cropping is a redaction that nobody
     * calls one, and doing it in the renderer would store the whole screen and
     * merely show a slice of it.
     */
    const s = sink();
    const result = await captureScreen(
      backend(quartered()),
      { sourceId: 'screen:0', region: { x: 20, y: 0, w: 20, h: 20 } },
      s.store,
    );

    expect([result.block.width, result.block.height]).toEqual([20, 20]);
    const kept = decodePng(s.written[0]!);
    expect([kept.width, kept.height]).toEqual([20, 20]);
    expect(pixelAt(kept, 10, 10)).toEqual([250, 0, 0, 255]);
  });

  it('paints blackouts before anything reaches the sink', async () => {
    // The ordering §12.1 spends its length on. The unredacted frame is a
    // parameter and a local; the only buffer that leaves this call is painted.
    const s = sink();
    await captureScreen(
      backend(quartered()),
      { sourceId: 'screen:0', redactions: [{ x: 20, y: 0, w: 20, h: 20 }] },
      s.store,
    );

    expect(s.written).toHaveLength(1);
    const stored = decodePng(s.written[0]!);
    expect(pixelAt(stored, 30, 10)).toEqual([0, 0, 0, 255]);
    // And the rest of the frame survived, so this is a blackout and not a wipe.
    expect(pixelAt(stored, 5, 30)).toEqual([10, 10, 10, 255]);
  });

  it('paints in the cropped frame’s coordinates, because the crop came first', async () => {
    // Which is the reason the order is crop-then-paint and not the reverse: the
    // rectangle a user drew is in the coordinates they were looking at, and
    // those are the cropped ones.
    const s = sink();
    await captureScreen(
      backend(quartered()),
      {
        sourceId: 'screen:0',
        region: { x: 20, y: 0, w: 20, h: 20 },
        redactions: [{ x: 0, y: 0, w: 10, h: 10 }],
      },
      s.store,
    );

    const stored = decodePng(s.written[0]!);
    expect(pixelAt(stored, 5, 5)).toEqual([0, 0, 0, 255]);
    // Still inside the crop, outside the blackout: red, not black.
    expect(pixelAt(stored, 15, 15)).toEqual([250, 0, 0, 255]);
  });

  it('scales an oversized frame once, here, rather than on every send', async () => {
    // §12.2 downscales at send time anyway. Doing it once means the blob that is
    // transferred (§6.7) and kept forever is the useful size.
    const s = sink();
    const huge = encodePng(solid(4000, 100, [1, 2, 3]));
    const result = await captureScreen(backend(huge), { sourceId: 'screen:0' }, s.store, {
      maxEdge: 500,
    });

    expect(result.block.width).toBe(500);
    expect(decodePng(s.written[0]!).width).toBe(500);
  });

  it('records where the pixels came from', async () => {
    // §12.1 tags client capture `origin: 'client'`, and for a remote session
    // that field is the only thing in the transcript that says the screenshot
    // was not taken by the machine doing the work.
    const s = sink();
    const result = await captureScreen(
      backend(quartered()),
      { sourceId: 'window:9', windowTitle: 'Terminal', displayId: '1' },
      s.store,
      { now: () => new Date('2026-01-02T03:04:05.000Z') },
    );

    expect(result.block.provenance).toMatchObject({
      kind: 'screen_capture',
      origin: 'client',
      capturedAt: '2026-01-02T03:04:05.000Z',
      windowTitle: 'Terminal',
      displayId: '1',
    });
  });

  it('records the rectangles it painted, for audit', async () => {
    const s = sink();
    const result = await captureScreen(
      backend(quartered()),
      { sourceId: 'screen:0', redactions: [{ x: 1, y: 2, w: 3, h: 4 }] },
      s.store,
    );

    expect(result.block.provenance.redactions).toEqual([{ x: 1, y: 2, w: 3, h: 4 }]);
  });

  it('reports an unscanned frame as unscanned rather than as clean', async () => {
    // §12.1: "'Looked and found nothing' is distinct from 'could not look.'"
    // OCR is a native model and stays injected, so the ordinary case here is
    // that no sweep ran at all.
    const s = sink();
    const result = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, s.store);

    expect(result.scanned).toBe(false);
  });

  it('paints what the scan found, on top of what the user drew', async () => {
    const s = sink();
    const result = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, s.store, {
      ocr: async () => [{ x: 0, y: 0, w: 10, h: 10, text: 'sk-live-not-a-real-key' }],
    });

    expect(result.scanned).toBe(true);
    expect(pixelAt(decodePng(s.written[0]!), 5, 5)).toEqual([0, 0, 0, 255]);
  });
});

describe('a black frame is not an answer (§12.1)', () => {
  it('refuses before grabbing when the platform said no', async () => {
    /**
     * The check has to come first, and macOS is why: a denied grab there does
     * not fail. It succeeds and returns an empty desktop, which is
     * indistinguishable from a screenshot of a tidy one — so the difference
     * between checking before and checking after is the difference between an
     * error and a mystery.
     */
    const b = backend(quartered(), 'denied');
    const s = sink();

    await expect(captureScreen(b, { sourceId: 'screen:0' }, s.store)).rejects.toThrow(
      ScreenAccessDenied,
    );
    expect(b.grabs).toEqual([]);
    expect(s.written).toEqual([]);
  });

  it('routes the user to the setting rather than reporting a failure', async () => {
    // §12.1 asks for this by name: "route the user to System Settings rather
    // than producing a black frame."
    const s = sink();
    await expect(
      captureScreen(backend(quartered(), 'denied'), { sourceId: 'screen:0' }, s.store),
    ).rejects.toThrow(/Screen Recording/);
  });

  it('refuses on not-determined, which is also not a yes', async () => {
    const s = sink();
    await expect(
      captureScreen(backend(quartered(), 'not-determined'), { sourceId: 'screen:0' }, s.store),
    ).rejects.toThrow(ScreenAccessDenied);
  });

  it('proceeds on unknown, because Windows has no such concept to report', async () => {
    // §12.1: "Windows needs none." A platform with nothing to say must not be
    // read as a platform that said no.
    const s = sink();
    await expect(
      captureScreen(backend(quartered(), 'unknown'), { sourceId: 'screen:0' }, s.store),
    ).resolves.toBeDefined();
  });

  it('will not list sources it is not allowed to see', async () => {
    await expect(listSources(backend(quartered(), 'denied'))).rejects.toThrow(ScreenAccessDenied);
  });
});

describe('a client with no screen says so', () => {
  it('explains rather than failing opaquely', async () => {
    /**
     * The `pickFolder` precedent: a browser client has no native folder picker
     * and `hosts.add` says so instead of throwing something shaped like a bug.
     * A browser has no screen to enumerate either, and the honest answer names
     * both the reason and the remedy — including the one capability a browser
     * client *does* have, which is the headless screenshot tool.
     */
    await expect(captureScreen(null, { sourceId: 'x' }, sink().store)).rejects.toThrow(
      CaptureUnavailable,
    );
    await expect(captureScreen(null, { sourceId: 'x' }, sink().store)).rejects.toThrow(
      /desktop app|screenshot tool/,
    );
  });

  it('lists nothing rather than throwing, so a picker can render empty', async () => {
    // Asymmetric on purpose. Asking what is capturable is a question a UI asks
    // on open; capturing is a thing a user did. The first should not need a
    // try/catch to draw an empty list.
    expect(await listSources(null)).toEqual([]);
  });
});

describe('the picker asks for small thumbnails', () => {
  it('does not request native-resolution previews for a grid of postage stamps', async () => {
    // §12.1 notes a thumbnail at native resolution *is* a full-quality frame,
    // which is how `grab` works. A picker doing that for nine displays would
    // move a hundred megabytes to draw a grid.
    const b = backend(quartered());
    const spy = vi.spyOn(b, 'sources');
    await listSources(b);

    const size = spy.mock.calls[0]![0].thumbnailSize!;
    expect(size.width).toBeLessThanOrEqual(640);
  });
});

describe('end to end: point at something, and the agent sees it', () => {
  /**
   * The seam the two halves meet at, and the one worth an integration test —
   * everything above is a unit. What is checked here is that a capture taken on
   * *this* machine ends up in the session's turn, resolvable by the host that
   * owns the log.
   *
   * A local host, because the interesting difference for a remote one is which
   * `putBlob` runs, and `blobTransfer.test.ts` covers that over the wire.
   */
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-capwire-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** A host whose agent may or may not be able to look at pictures. */
  function connect(seesImages: boolean): HostConnection {
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [{ kind: 'stop', stop: { kind: 'end_turn' } }],
        capabilities: { input: { image: seesImages, audio: false, pdf: false, video: false } },
      }),
      { label: 'Echo', requiresModel: false },
    );
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    managers.push(manager);

    const server = new SessionHostServer({
      manager,
      identity: { instanceId, lineageId: 'lin' as never, workspaceRoot: root, runtimes: ['echo'] },
    });
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    return new HostConnection({ channel: pair.main });
  }

  const types = (turn: unknown): string[] =>
    (turn as { content: Array<{ type: string }> }).content.map((b) => b.type);

  it('stores the capture on the host and sends a reference, never pixels', async () => {
    const c = connect(true);
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const { block } = await captureScreen(
      backend(quartered()),
      { sourceId: 'screen:0', region: { x: 20, y: 0, w: 20, h: 20 } },
      (redacted, mime) => c.putBlob(session.sessionId, redacted, mime),
    );

    await c.send(session.sessionId, agent.agentId, 'this bit is wrong', [block]);

    const turn = (await c.events(session.sessionId)).find((e) => e.type === 'user.turn');
    // Text first, then the image: the sentence is what the person wrote and the
    // picture is what they were pointing at.
    expect(types(turn)).toEqual(['text', 'image']);

    // A reference, not bytes — and one the owning host can already resolve,
    // because the transfer finished before the send did.
    expect(await c.hasBlob(session.sessionId, block.sha256, 'image/png')).toBe(true);
    expect(JSON.stringify(turn).length).toBeLessThan(1000);
  });

  it('sends an attachment with no sentence, because that is a message too', async () => {
    // "Look at this" with nothing typed is the most natural way to use a
    // screenshot; requiring a sentence would be a rule invented by the form.
    // No empty text block padding it out either — an empty string is not
    // something the user said, and a model reading one has to decide what it
    // meant.
    const c = connect(true);
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const { block } = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, (b, m) =>
      c.putBlob(session.sessionId, b, m),
    );

    await c.send(session.sessionId, agent.agentId, '', [block]);

    const turn = (await c.events(session.sessionId)).find((e) => e.type === 'user.turn');
    expect(types(turn)).toEqual(['image']);
  });

  it('degrades to a described note for an agent that cannot see images (§12.2)', async () => {
    /**
     * This test is here because I got it wrong first: I asserted the image
     * survived, against the default echo runtime, which declares
     * `input.image: false`. §12.2's fitting turned it into text and the
     * assertion failed — which is the pipeline behaving exactly as designed, on
     * a path I had not thought to connect it to.
     *
     * Worth keeping as its own case: client capture inherits fitting for free
     * because it produces an ordinary `ImageBlock`, and the alternative — a
     * capture that bypassed fitting because it came from the user rather than
     * from a tool — would send an image to a model that rejects the request.
     */
    const c = connect(false);
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const { block } = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, (b, m) =>
      c.putBlob(session.sessionId, b, m),
    );

    await c.send(session.sessionId, agent.agentId, '', [block]);

    const turn = (await c.events(session.sessionId)).find((e) => e.type === 'user.turn');
    expect(types(turn)).toEqual(['text']);
    // Described rather than dropped: the agent is told a picture was here and
    // that it could not be shown, which is a diagnosable answer rather than a
    // silent absence.
    expect(JSON.stringify(turn)).toMatch(/image/i);
  });
});

describe('what you drew reaches the model (§12.3, end to end)', () => {
  /**
   * Through a real host with a real blob store, because the interesting claim is
   * about *bytes on disk*: the annotated image is a new blob, the original still
   * exists, and the link between them survives into the transcript.
   *
   * §12.3's machinery had been built for some time and nothing called it — this
   * is the test that would have caught that, and did not exist.
   */
  let root: string;
  let instanceId: InstanceId;
  const managers: SessionManager[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agbrte-annot-'));
    instanceId = (await openWorkspace(root)).instanceId;
  });
  afterEach(async () => {
    for (const m of managers.splice(0)) m.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function connect(): HostConnection {
    const registry = new RuntimeRegistry();
    registry.register(
      new EchoRuntime({
        script: [{ kind: 'stop', stop: { kind: 'end_turn' } }],
        capabilities: { input: { image: true, audio: false, pdf: false, video: false } },
      }),
      { label: 'Echo', requiresModel: false },
    );
    const manager = new SessionManager({ registry, workspaceRoot: root, instanceId });
    managers.push(manager);
    const server = new SessionHostServer({
      manager,
      identity: { instanceId, lineageId: 'lin' as never, workspaceRoot: root, runtimes: ['echo'] },
    });
    const pair = memoryChannelPair<SessionCommand, SessionMessage>();
    server.accept(pair.host);
    return new HostConnection({ channel: pair.main });
  }

  it('burns the marks into a new blob and keeps the original', async () => {
    const c = connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });

    const { block } = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, (b, m) =>
      c.putBlob(session.sessionId, b, m),
    );

    await c.send(session.sessionId, agent.agentId, 'look here', [
      {
        ...block,
        annotations: [
          { kind: 'arrow', colour: 'red', from: { x: 2, y: 2 }, to: { x: 30, y: 30 } },
        ],
      },
    ]);

    const events = await c.events(session.sessionId);
    const turn = events.find((e) => e.type === 'user.turn') as { content: ContentBlock[] };
    const sent = turn.content.find((b) => b.type === 'image') as ImageBlock;

    // A different blob, and one that names what it was drawn on. §12.3: the
    // original is never destroyed.
    expect(sent.sha256).not.toBe(block.sha256);
    expect(sent.provenance.annotatedFrom).toBe(block.sha256);
    expect(await c.hasBlob(session.sessionId, block.sha256, 'image/png')).toBe(true);
    expect(await c.hasBlob(session.sessionId, sent.sha256, 'image/png')).toBe(true);

    // And the sentence travels with it, because §12.3 says always send both.
    expect(turn.content.some((b) => b.type === 'text' && /arrow/i.test(b.text))).toBe(true);
  });

  it('leaves an unannotated capture exactly as it was', async () => {
    // No second blob, no sentence. The ordinary paste must cost nothing.
    const c = connect();
    const session = await c.createSession({ title: 's', goal: 'g' });
    const agent = await c.addAgent(session.sessionId, { role: 'worker', runtimeId: 'echo' });
    const { block } = await captureScreen(backend(quartered()), { sourceId: 'screen:0' }, (b, m) =>
      c.putBlob(session.sessionId, b, m),
    );

    await c.send(session.sessionId, agent.agentId, 'and this', [block]);

    const turn = (await c.events(session.sessionId)).find((e) => e.type === 'user.turn') as {
      content: ContentBlock[];
    };
    expect(turn.content.map((b) => b.type)).toEqual(['text', 'image']);
    expect((turn.content[1] as ImageBlock).sha256).toBe(block.sha256);
  });
});
