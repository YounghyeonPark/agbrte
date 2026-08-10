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
import {
  estimateImageTokens,
  fitContent,
  type Flattener,
  type Resizer,
} from '@main/content/fit.js';
import { DEFAULT_ECHO_CAPABILITIES } from '@main/runtime/runtimes/echo.js';
import type {
  Annotation,
  ContentBlock,
  ImageBlock,
  RuntimeCapabilities,
  Sha256,
} from '@shared/types/index.js';

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

describe('annotations reach the model, in pixels and in words (§12.3)', () => {
  /**
   * The vector model, the describer and the flattener were all built and
   * **nothing called any of them** — every one was reachable only from inside
   * `content/`. §12.3 read as done because its pieces existed, which is a
   * different claim from a user being able to point at something.
   */
  const annotated = (annotations: Annotation[], size = { w: 800, h: 600 }): ImageBlock => ({
    type: 'image',
    sha256: 'abc123' as Sha256,
    mime: 'image/png',
    width: size.w,
    height: size.h,
    provenance: { kind: 'screen_capture', origin: 'client' },
    annotations,
  });

  const ARROW: Annotation = {
    kind: 'arrow',
    colour: 'red',
    from: { x: 100, y: 100 },
    to: { x: 400, y: 300 },
    label: 'this button does nothing',
  };

  /** A flattener that reports what it was asked to draw. */
  function painter(): { flatten: Flattener; calls: Array<readonly Annotation[]> } {
    const calls: Array<readonly Annotation[]> = [];
    return {
      calls,
      flatten: async (_image, annotations) => {
        calls.push(annotations);
        return { sha256: 'burned' as Sha256 };
      },
    };
  }

  it('sends the flattened image and a sentence about it', async () => {
    const p = painter();
    const result = await fitContent([annotated([ARROW])], caps({}), undefined, p.flatten);

    expect(result.content.map((b) => b.type)).toEqual(['image', 'text']);
    expect((result.content[0] as ImageBlock).sha256).toBe('burned');
    // §12.3: "always send both" — for a weaker vision model the sentence is
    // often the only part that lands.
    expect((result.content[1] as { text: string }).text).toMatch(/arrow/i);
  });

  it('points the flattened copy back at the frame it was drawn on', async () => {
    // §12.3's rule: annotations stay editable and the original is never
    // destroyed. Overwriting the original would break `annotatedFrom` and the
    // promise in the same move.
    const p = painter();
    const result = await fitContent([annotated([ARROW])], caps({}), undefined, p.flatten);

    const out = result.content[0] as ImageBlock;
    expect(out.provenance.annotatedFrom).toBe('abc123');
    expect(out.provenance.kind).toBe('annotated_capture');
  });

  it('drops the vectors from the block it burned them into', async () => {
    // Otherwise anything that fits the same content again draws them twice.
    const p = painter();
    const result = await fitContent([annotated([ARROW])], caps({}), undefined, p.flatten);

    expect((result.content[0] as ImageBlock).annotations).toBeUndefined();
  });

  it('says nothing when nothing was drawn', async () => {
    // §12.3: an "the user annotated this image" line on every ordinary paste is
    // noise in the one place that section depends on being read.
    const p = painter();
    const plain = annotated([]);
    const result = await fitContent([plain], caps({}), undefined, p.flatten);

    expect(result.content.map((b) => b.type)).toEqual(['image']);
    expect(p.calls).toEqual([]);
  });

  it('draws and describes at the size the model will see', async () => {
    /**
     * The ordering §12.3 states outright: "coordinates are described as sent,
     * not as drawn". A sentence built from the original numbers points a model
     * at the wrong part of a picture it can also see — a confidently wrong
     * answer, which is worse than a vague right one.
     *
     * Flattening after scaling matters for a second reason: a 3px stroke drawn
     * first and scaled after thins towards nothing at exactly these ratios, and
     * 3px was chosen to survive them.
     */
    const p = painter();
    const resize: Resizer = async () => ({ sha256: 'small' as Sha256, width: 400, height: 300 });
    await fitContent(
      [annotated([ARROW])],
      caps({ imageMaxLongEdge: 400 }),
      resize,
      p.flatten,
    );

    const drawn = p.calls[0]![0] as Extract<Annotation, { kind: 'arrow' }>;
    expect(drawn.to).toEqual({ x: 200, y: 150 });
  });

  it('keeps the words when the marks cannot be drawn', async () => {
    /**
     * §12.2's asymmetry applied to §12.3. A missing decoder costs the marks, not
     * the meaning — and the description is the half worth keeping, since it is
     * the part a weaker model reads anyway. Reported rather than silent, so
     * "why is my arrow missing" has an answer.
     */
    const result = await fitContent([annotated([ARROW])], caps({}), undefined, undefined);

    expect(result.content.map((b) => b.type)).toEqual(['image', 'text']);
    // The unannotated original, not a pretend flattened one.
    expect((result.content[0] as ImageBlock).sha256).toBe('abc123');
    expect(result.downgrades.map((d) => d.reason)).toContain('annotations_not_flattened');
  });

  it('tells an agent that cannot see images what was pointed at anyway', async () => {
    /**
     * The bug this replaced, and it inverted §12.3's own argument. The
     * description "is often the only part a weaker vision model reads" — so the
     * agent that cannot see the picture is the one that needs the sentence most,
     * and it was the only one not getting it: placeholder, no annotations, no
     * mention that anything had been drawn.
     *
     * Found by running a capture against a real remote session, where the turn
     * came back as two text blocks and the arrow was nowhere.
     */
    const result = await fitContent(
      [annotated([ARROW])],
      caps({ input: { image: false, audio: false, pdf: false, video: false } }),
      undefined,
      painter().flatten,
    );

    expect(result.content.every((b) => b.type === 'text')).toBe(true);
    const text = result.content.map((b) => (b as { text: string }).text).join(' ');
    expect(text).toMatch(/image not sent/i);
    expect(text).toMatch(/arrow/i);
  });

  it('says it for an image dropped over the count limit too', async () => {
    // Same reasoning, different branch. Every path that declines to send the
    // picture still has to say what the user was pointing at.
    const result = await fitContent(
      [annotated([ARROW]), annotated([ARROW])],
      caps({ imageMaxCount: 1 }),
      undefined,
      painter().flatten,
    );

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join(' ');
    expect(text).toMatch(/at most 1 image|limit of 1 image/i);
    expect(text).toMatch(/arrow/i);
  });

  it('says it for an image too large to resize here', async () => {
    const result = await fitContent(
      [annotated([ARROW], { w: 4000, h: 3000 })],
      caps({ imageMaxLongEdge: 500 }),
      // No resizer: the branch where the image cannot be made to fit.
      undefined,
      painter().flatten,
    );

    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join(' ');
    expect(text).toMatch(/too large/i);
    expect(text).toMatch(/arrow/i);
  });

  it('adds nothing for an unannotated image that is not sent', async () => {
    // The placeholder alone. An empty "Annotations on this image:" line would be
    // the noise §12.3 rules out.
    const plain = annotated([]);
    const result = await fitContent(
      [plain],
      caps({ input: { image: false, audio: false, pdf: false, video: false } }),
      undefined,
      painter().flatten,
    );

    expect(result.content).toHaveLength(1);
  });
});

describe('a scaled frame remembers how big it was (§16)', () => {
  /**
   * §16 predicted this failure and said it was cheapest to fix *before* capture
   * existed: a model returns coordinates in the frame it was shown, an actuator
   * clicks in display space, every click lands slightly wrong and worse toward
   * the edges, and it reads as a bad model rather than a scaling bug.
   *
   * Capture then got built and the number was not recorded. Nothing consumes it
   * yet — computer use is in no phase — but recording it now is five lines and
   * reconstructing it later is impossible, which is the entire point that row
   * was making.
   */
  it('records the source size when it downscales', async () => {
    const resize: Resizer = async () => ({ sha256: 'small' as Sha256, width: 400, height: 300 });
    const result = await fitContent(
      [image({ width: 2000, height: 1500 })],
      caps({ imageMaxLongEdge: 400 }),
      resize,
    );

    const out = result.content[0] as ImageBlock;
    expect(out.provenance.scaledFrom).toEqual({ width: 2000, height: 1500 });
    // Enough to map a point back: the sent size is on the block itself.
    expect([out.width, out.height]).toEqual([400, 300]);
  });

  it('says nothing about scaling for an image that was not scaled', async () => {
    // An absent field means "this is the size it was taken at". A `scaledFrom`
    // equal to the current size would be indistinguishable from a 1:1 downscale
    // and would invite a factor of one being computed from a coincidence.
    const result = await fitContent([image({ width: 100, height: 80 })], caps());
    expect((result.content[0] as ImageBlock).provenance.scaledFrom).toBeUndefined();
  });
});
