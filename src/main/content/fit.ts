/**
 * Fitting what you attached to what the agent can actually take (§12.2, §3.5).
 *
 * > **Downscaling is driven by the receiving agent's capabilities**, not a
 * > constant: `imageMaxLongEdge` and `imageMaxCount` come from §3.3, and a model
 * > with `input.image: false` gets the declared text-plus-`file_ref` downgrade.
 *
 * The types for this have existed since Phase 1 — `ImageBlock`, `ContentSupport`,
 * `DowngradeNote` — and nothing used them. Attaching an image to an agent that
 * cannot see one produced a request the provider rejected, or worse, quietly
 * ignored: §3.5's stated failure, where "this model keeps ignoring my
 * screenshots" becomes folklore instead of a reported capability gap.
 *
 * ## Every loss is named, and named to the agent as well as to the log
 *
 * A downgrade that only reaches a `DowngradeNote` tells the *user* something was
 * dropped and leaves the *model* looking at a turn with a hole in it. So a
 * dropped image is replaced by text saying what it was and where it is, not
 * removed. A model told "there was a screenshot here, 2560×1440, and you cannot
 * see it" can ask for a description; a model handed nothing cannot.
 *
 * ## Resizing lives at the edge
 *
 * Actually rescaling pixels needs a decoder, and the only one guaranteed present
 * is Electron's `nativeImage` — which is not present in the agent host, on a
 * remote machine, or in a test. So it is injected. Everything here is the
 * decision, which is the part that has to be right and the part worth testing;
 * an absent resizer degrades to a named text downgrade rather than to an
 * oversized image nobody checked.
 */

import type {
  Annotation,
  AudioBlock,
  ContentBlock,
  DowngradeNote,
  ImageBlock,
  RuntimeCapabilities,
} from '@shared/types/index.js';
import { describeAnnotations, scaleAnnotations } from './annotate.js';

/** Rescale an encoded image. Injected, because a decoder is not always present. */
export type Resizer = (
  image: ImageBlock,
  maxLongEdge: number,
) => Promise<{ sha256: ImageBlock['sha256']; width: number; height: number } | null>;

/**
 * Burn annotations into an encoded image (§12.3). Injected for the same reason
 * `Resizer` is: it needs a decoder and it needs somewhere to put the result,
 * and neither belongs to whoever is fitting.
 */
export type Flattener = (
  image: ImageBlock,
  annotations: readonly Annotation[],
) => Promise<{ sha256: ImageBlock['sha256'] } | null>;

export interface FitResult {
  content: ContentBlock[];
  /** What was given up, so a capability gap is visible rather than folklore. */
  downgrades: DowngradeNote[];
  /**
   * Rough tokens the images will cost this agent.
   *
   * §12.2 wants attaching four 4K screenshots to be *visible* rather than
   * mysterious. Approximate on purpose — every provider counts image tokens
   * differently and a precise-looking number from the wrong formula is worse
   * than an obviously rounded one.
   */
  estimatedImageTokens: number;
}

/**
 * Most providers bill vision in fixed-size tiles. 512px is the common one, and
 * the constant is documented rather than tuned: this exists to make a cost
 * visible, not to predict an invoice.
 */
const TILE = 512;
const TOKENS_PER_TILE = 170;

export function estimateImageTokens(width: number, height: number): number {
  const tiles = Math.ceil(width / TILE) * Math.ceil(height / TILE);
  return tiles * TOKENS_PER_TILE;
}

/**
 * Adapt one turn's content to an agent's declared capabilities.
 *
 * Order matters and is deliberate: **count first, then size**. Dropping the
 * fifth image is cheaper than rescaling it and then dropping it, and a user who
 * attached ten screenshots to an agent that takes two should be told about the
 * eight before anything is spent on them.
 */
export async function fitContent(
  content: readonly ContentBlock[],
  caps: RuntimeCapabilities,
  resize?: Resizer,
  flatten?: Flattener,
): Promise<FitResult> {
  const downgrades: DowngradeNote[] = [];
  const out: ContentBlock[] = [];
  let kept = 0;
  let estimatedImageTokens = 0;

  for (const block of content) {
    if (block.type === 'audio') {
      const spoken = transcribed(block);
      if (spoken.note !== null) downgrades.push(spoken.note);
      out.push(spoken.block);
      continue;
    }

    if (block.type !== 'image') {
      out.push(block);
      continue;
    }

    if (!caps.input.image) {
      // The declared downgrade. Described rather than deleted: a model told what
      // it cannot see can ask about it, and one handed nothing cannot.
      downgrades.push({
        reason: 'no_image_support',
        detail: `${describe(block)} — this agent has input.image: false`,
      });
      out.push(...instead(block, 'this agent cannot see images'));
      continue;
    }

    if (caps.imageMaxCount !== undefined && kept >= caps.imageMaxCount) {
      downgrades.push({
        reason: 'over_max_count',
        detail: `${describe(block)} — this agent takes at most ${caps.imageMaxCount} images per turn`,
      });
      out.push(...instead(block, `over this agent's limit of ${caps.imageMaxCount} images`));
      continue;
    }

    const longEdge = Math.max(block.width, block.height);
    const limit = caps.imageMaxLongEdge;
    if (limit !== undefined && longEdge > limit) {
      const resized = resize === undefined ? null : await resize(block, limit);
      if (resized === null) {
        // No decoder here, or the decode failed. Sending it anyway would hand
        // the provider something it will reject or silently crop — a loss with
        // nobody's name on it.
        downgrades.push({
          reason: 'over_max_long_edge',
          detail: `${describe(block)} — over this agent's ${limit}px limit and it could not be resized here`,
        });
        out.push(...instead(block, `too large for this agent (limit ${limit}px)`));
        continue;
      }

      downgrades.push({
        reason: 'over_max_long_edge',
        detail: `${describe(block)} — scaled down to ${resized.width}×${resized.height} for this agent`,
      });
      const scaled: ImageBlock = {
        ...block,
        sha256: resized.sha256,
        width: resized.width,
        height: resized.height,
        // The original is never destroyed (§12.3's rule for annotations, and the
        // same reasoning): the scaled copy points back at what it came from —
        // and now also at how big it was, so a coordinate expressed in this
        // frame can be mapped back to the one a display uses (§16).
        provenance: {
          ...block.provenance,
          annotatedFrom: block.sha256,
          scaledFrom: { width: block.width, height: block.height },
        },
      };
      const marked = await burnIn(scaled, block.annotations, resized.width / block.width, flatten);
      out.push(...marked.blocks);
      if (marked.note !== null) downgrades.push(marked.note);
      estimatedImageTokens += estimateImageTokens(resized.width, resized.height);
      kept += 1;
      continue;
    }

    const marked = await burnIn(block, block.annotations, 1, flatten);
    out.push(...marked.blocks);
    if (marked.note !== null) downgrades.push(marked.note);
    estimatedImageTokens += estimateImageTokens(block.width, block.height);
    kept += 1;
  }

  return { content: out, downgrades, estimatedImageTokens };
}

/**
 * A voice clip becomes its transcript, and the audio goes no further (§12.4).
 *
 * > STT runs locally, always … Audio never traverses the transport and never
 * > reaches a model provider; dictating about proprietary code doesn't ship
 * > your voice to a third party.
 *
 * So this is **not** a capability downgrade and does not consult
 * `caps.input.audio`. A provider that accepts audio is exactly the case the
 * sentence above is about: the guarantee is that the clip does not leave, not
 * that it leaves only where it would be understood. Branching on the capability
 * would make "your voice reached a third party" depend on which model you
 * happened to pick, which is not a property anybody can reason about.
 *
 * Before this, `fitContent` had no audio branch at all — an `AudioBlock` fell
 * through to the adapter untouched. The guarantee held because nothing produced
 * one yet, which is the same shape as redaction holding by not working, and it
 * would have stopped holding the moment §12.4 got a microphone.
 *
 * A clip with no transcript is named rather than dropped. STT can fail — no
 * engine on this machine, a model that will not load — and an agent told "there
 * was a voice message here that could not be transcribed" can ask; one handed
 * silence cannot.
 */
function transcribed(block: AudioBlock): { block: ContentBlock; note: DowngradeNote | null } {
  const seconds = Math.round(block.durationMs / 100) / 10;

  if (block.transcript === undefined || block.transcript.trim() === '') {
    return {
      block: {
        type: 'text',
        text:
          `[voice message, ${seconds}s, not transcribed. ` +
          `stored as ${block.sha256.slice(0, 12)}]`,
      },
      note: {
        reason: 'not_transcribed',
        detail: `a ${seconds}s voice message could not be transcribed; the audio was not sent`,
      },
    };
  }

  // The transcript alone, with no "[voice]" decoration around it. §12.4 says the
  // user edits the text before sending, so by the time it arrives it is simply
  // what they meant to say — labelling it would tell a model how the words were
  // typed, which is not information about the request.
  return { block: { type: 'text', text: block.transcript }, note: null };
}

/**
 * A picture that is not being sent, and what the user pointed at in it.
 *
 * The description has to survive here, and this is where it was being dropped.
 * An agent with `input.image: false` got "[image not sent]" and **nothing about
 * the arrow** — which inverts §12.3's whole argument: the sentence "is often the
 * only part a weaker vision model reads", so the agent that cannot see the
 * picture is the one that needs it most, and it was the only one not getting it.
 *
 * Found by running a capture against a real remote session rather than by
 * reading the code: the turn arrived as two text blocks, the second of them a
 * placeholder, and the annotations nowhere.
 *
 * Described at the block's own size, because no resizing happened on this path —
 * there is no "as sent" to describe when nothing is being sent.
 */
function instead(block: ImageBlock, why: string): ContentBlock[] {
  const sentence =
    block.annotations === undefined || block.annotations.length === 0
      ? null
      : describeAnnotations(block.annotations, { width: block.width, height: block.height });

  return sentence === null
    ? [placeholder(block, why)]
    : [placeholder(block, why), { type: 'text', text: sentence }];
}

/**
 * Draw the marks and say what they are (§12.3).
 *
 * Runs **after** scaling, and both halves depend on that:
 *
 *  - Flattening onto the already-scaled frame keeps the strokes crisp. Drawing
 *    first and scaling after would thin a 3px line towards nothing at exactly
 *    the ratios §12.2 uses, which is what the 3px was chosen to survive.
 *  - Describing from the scaled geometry is what §12.3 requires in as many
 *    words: "coordinates are described as sent, not as drawn". A sentence built
 *    from the original numbers points a model at the wrong part of the picture
 *    it is looking at — a confidently wrong answer about an image it can see.
 *
 * The description is emitted whether or not the flattening worked. §12.3 says it
 * "is often the only part a weaker vision model reads", so it is the half worth
 * keeping when the other is unavailable — and a missing decoder here costs the
 * marks, not the meaning.
 */
async function burnIn(
  block: ImageBlock,
  annotations: readonly Annotation[] | undefined,
  factor: number,
  flatten?: Flattener,
): Promise<{ blocks: ContentBlock[]; note: DowngradeNote | null }> {
  // Nothing drawn means nothing said (§12.3). An "the user annotated this image"
  // line on every ordinary paste is noise in the one place that section depends
  // on being read.
  if (annotations === undefined || annotations.length === 0) {
    return { blocks: [block], note: null };
  }

  const scaled = factor === 1 ? [...annotations] : scaleAnnotations(annotations, factor);
  const sentence = describeAnnotations(scaled, { width: block.width, height: block.height });
  const said: ContentBlock[] = sentence === null ? [] : [{ type: 'text', text: sentence }];

  const burned = flatten === undefined ? null : await flatten(block, scaled);
  if (burned === null) {
    return {
      blocks: [block, ...said],
      note: {
        reason: 'annotations_not_flattened',
        detail: `${describe(block)} — annotations could not be drawn here; the description was sent instead`,
      },
    };
  }

  // Destructured away rather than set to `undefined`: the marks are in the
  // pixels now, and a block that still carried them would be drawn on twice by
  // anything that fitted the same content again.
  const { annotations: _burnedIn, ...rest } = block;

  return {
    blocks: [
      {
        ...rest,
        sha256: burned.sha256,
        // The original is never destroyed (§12.3). The flattened copy is a
        // derivative and says which frame it was drawn on.
        provenance: { ...block.provenance, kind: 'annotated_capture', annotatedFrom: block.sha256 },
      },
      ...said,
    ],
    note: null,
  };
}

/**
 * What an image was, for a model that will not be shown it.
 *
 * The hash is included because it is the only durable handle: the blob is on
 * disk, a human can open it, and a later turn can refer to it.
 */
function placeholder(block: ImageBlock, why: string): ContentBlock {
  return {
    type: 'text',
    text: `[image not sent: ${why}. ${describe(block)}, stored as ${block.sha256.slice(0, 12)}]`,
  };
}

const describe = (block: ImageBlock): string =>
  `${block.width}×${block.height} ${block.mime.replace('image/', '')}`;
