/**
 * Fitting attachments to the agent receiving them (DESIGN.md §12.2, §3.5).
 *
 * > **Downscaling is driven by the receiving agent's capabilities**, not a
 * > constant … a model with `input.image: false` gets the declared
 * > text-plus-`file_ref` downgrade.
 *
 * The types for this existed since Phase 1 and nothing used them, so attaching
 * an image to an agent that cannot see one produced a request the provider
 * rejected — or worse, quietly ignored. That is §3.5's named failure: "this
 * model keeps ignoring my screenshots" becoming folklore instead of a reported
 * capability gap.
 *
 * So most of what is asserted here is that a loss is **visible**, and visible to
 * the model as well as to the log.
 */

import { describe, expect, it } from 'vitest';
import { estimateImageTokens, fitContent, type Resizer } from '@main/content/fit.js';
import { DEFAULT_ECHO_CAPABILITIES } from '@main/runtime/runtimes/echo.js';
import type { ContentBlock, ImageBlock, RuntimeCapabilities } from '@shared/types/index.js';

function image(over: Partial<ImageBlock> = {}): ImageBlock {
  return {
    type: 'image',
    sha256: 'a'.repeat(64),
    mime: 'image/png',
    width: 800,
    height: 600,
    provenance: { origin: 'client' },
    ...over,
  } as ImageBlock;
}

function caps(over: Partial<RuntimeCapabilities> = {}): RuntimeCapabilities {
  return {
    ...DEFAULT_ECHO_CAPABILITIES,
    input: { image: true, audio: false, pdf: false, video: false },
    ...over,
  };
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('an agent that cannot see images', () => {
  it('is told what it is not being shown', async () => {
    const result = await fitContent(
      [text('what is wrong here?'), image({ width: 2560, height: 1440 })],
      caps({ input: { image: false, audio: false, pdf: false, video: false } }),
    );

    // Described, not deleted. A model told there was a screenshot can ask about
    // it; one handed a turn with a hole in it cannot.
    expect(result.content).toHaveLength(2);
    expect(JSON.stringify(result.content)).toContain('2560×1440');
    expect(result.content.every((b) => b.type === 'text')).toBe(true);
  });

  it('records the reason, so the gap is not folklore', async () => {
    const result = await fitContent(
      [image()],
      caps({ input: { image: false, audio: false, pdf: false, video: false } }),
    );
    expect(result.downgrades).toEqual([
      { reason: 'no_image_support', detail: expect.stringContaining('input.image: false') },
    ]);
  });

  it('costs nothing, because nothing was sent', async () => {
    const result = await fitContent(
      [image()],
      caps({ input: { image: false, audio: false, pdf: false, video: false } }),
    );
    expect(result.estimatedImageTokens).toBe(0);
  });
});

describe('more images than the agent takes', () => {
  it('keeps the first and names the rest', async () => {
    const result = await fitContent([image(), image(), image()], caps({ imageMaxCount: 2 }));

    expect(result.content.filter((b) => b.type === 'image')).toHaveLength(2);
    expect(result.downgrades).toEqual([
      { reason: 'over_max_count', detail: expect.stringContaining('at most 2 images') },
    ]);
  });

  it('counts before it resizes', async () => {
    // Dropping the third image is cheaper than rescaling it and then dropping
    // it, and a user who over-attached should hear about it before anything is
    // spent on the ones that will not be sent.
    const resized: number[] = [];
    const resize: Resizer = async (block, max) => {
      resized.push(block.width);
      return { sha256: 'b'.repeat(64) as never, width: max, height: max / 2 };
    };
    await fitContent(
      [image({ width: 4000 }), image({ width: 4000 }), image({ width: 4000 })],
      caps({ imageMaxCount: 1, imageMaxLongEdge: 1000 }),
      resize,
    );
    expect(resized).toHaveLength(1);
  });
});

describe('an image larger than the agent takes', () => {
  it('is scaled, and says so', async () => {
    const resize: Resizer = async () => ({
      sha256: 'b'.repeat(64) as never,
      width: 1024,
      height: 576,
    });
    const result = await fitContent(
      [image({ width: 3840, height: 2160 })],
      caps({ imageMaxLongEdge: 1024 }),
      resize,
    );

    const [block] = result.content;
    expect(block).toMatchObject({ type: 'image', width: 1024, height: 576 });
    expect(result.downgrades[0]?.reason).toBe('over_max_long_edge');
  });

  it('keeps a link back to what it came from', async () => {
    const resize: Resizer = async () => ({
      sha256: 'b'.repeat(64) as never,
      width: 1024,
      height: 576,
    });
    const result = await fitContent(
      [image({ width: 3840, height: 2160, sha256: 'c'.repeat(64) as never })],
      caps({ imageMaxLongEdge: 1024 }),
      resize,
    );

    // The original is never destroyed. §12.3 says so for annotations, and a
    // scaled copy is the same bargain: what was sent has to be traceable to what
    // was attached.
    const [block] = result.content;
    expect((block as ImageBlock).provenance.annotatedFrom).toBe('c'.repeat(64));
  });

  it('becomes a named downgrade when nothing here can resize it', async () => {
    // No decoder in the agent host, on a remote machine, or in a test. Sending
    // it anyway hands the provider something it will reject or silently crop —
    // a loss with nobody's name on it.
    const result = await fitContent([image({ width: 3840 })], caps({ imageMaxLongEdge: 1024 }));

    expect(result.content.every((b) => b.type === 'text')).toBe(true);
    expect(result.downgrades[0]?.detail).toMatch(/could not be resized/);
  });

  it('does the same when the decoder fails', async () => {
    const result = await fitContent(
      [image({ width: 3840 })],
      caps({ imageMaxLongEdge: 1024 }),
      async () => null,
    );
    expect(result.downgrades[0]?.reason).toBe('over_max_long_edge');
  });
});

describe('what it leaves alone', () => {
  it('passes an image within every limit straight through', async () => {
    const block = image({ width: 800, height: 600 });
    const result = await fitContent([block], caps({ imageMaxLongEdge: 2048, imageMaxCount: 4 }));

    expect(result.content).toEqual([block]);
    expect(result.downgrades).toEqual([]);
  });

  it('does not invent limits an agent did not declare', async () => {
    // Absent means unlimited, not zero. A default ceiling would shrink images
    // for agents that never asked for it.
    const huge = image({ width: 8000, height: 8000 });
    const result = await fitContent([huge, huge, huge], caps());
    expect(result.content.filter((b) => b.type === 'image')).toHaveLength(3);
  });

  it('leaves everything that is not an image alone', async () => {
    const blocks: ContentBlock[] = [
      text('one'),
      { type: 'file_ref', path: 'src/a.ts' as never },
      text('two'),
    ];
    const result = await fitContent(blocks, caps());
    expect(result.content).toEqual(blocks);
  });
});

describe('showing the cost', () => {
  it('grows with area, so four 4K screenshots are visible rather than mysterious', () => {
    const small = estimateImageTokens(512, 512);
    const large = estimateImageTokens(3840, 2160);
    expect(large).toBeGreaterThan(small * 20);
  });

  it('is reported for what is actually sent', async () => {
    const resize: Resizer = async () => ({
      sha256: 'b'.repeat(64) as never,
      width: 1024,
      height: 512,
    });
    const result = await fitContent(
      [image({ width: 3840, height: 2160 })],
      caps({ imageMaxLongEdge: 1024 }),
      resize,
    );
    // The scaled size, not the attached one: a cost quoted for an image nobody
    // sent would be a confident wrong number.
    expect(result.estimatedImageTokens).toBe(estimateImageTokens(1024, 512));
  });
});
