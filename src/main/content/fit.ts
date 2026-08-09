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
  ContentBlock,
  DowngradeNote,
  ImageBlock,
  RuntimeCapabilities,
} from '@shared/types/index.js';

/** Rescale an encoded image. Injected, because a decoder is not always present. */
export type Resizer = (
  image: ImageBlock,
  maxLongEdge: number,
) => Promise<{ sha256: ImageBlock['sha256']; width: number; height: number } | null>;

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
): Promise<FitResult> {
  const downgrades: DowngradeNote[] = [];
  const out: ContentBlock[] = [];
  let kept = 0;
  let estimatedImageTokens = 0;

  for (const block of content) {
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
      out.push(placeholder(block, 'this agent cannot see images'));
      continue;
    }

    if (caps.imageMaxCount !== undefined && kept >= caps.imageMaxCount) {
      downgrades.push({
        reason: 'over_max_count',
        detail: `${describe(block)} — this agent takes at most ${caps.imageMaxCount} images per turn`,
      });
      out.push(placeholder(block, `over this agent's limit of ${caps.imageMaxCount} images`));
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
        out.push(placeholder(block, `too large for this agent (limit ${limit}px)`));
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
        // same reasoning): the scaled copy points back at what it came from.
        provenance: { ...block.provenance, annotatedFrom: block.sha256 },
      };
      out.push(scaled);
      estimatedImageTokens += estimateImageTokens(resized.width, resized.height);
      kept += 1;
      continue;
    }

    out.push(block);
    estimatedImageTokens += estimateImageTokens(block.width, block.height);
    kept += 1;
  }

  return { content: out, downgrades, estimatedImageTokens };
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
