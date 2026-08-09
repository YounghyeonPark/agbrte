/**
 * Annotations as vector operations (DESIGN.md §12.3).
 *
 * > Annotations are stored as **vector operations** alongside the original hash
 * > and flattened to PNG at send time (`provenance.annotatedFrom` links back),
 * > so they stay editable and the original is never destroyed.
 *
 * > The flattened image is sent with a generated text block describing the
 * > annotations … This materially improves how reliably a model attends to what
 * > you pointed at — and for weaker vision models it's often the only part that
 * > lands, which is a good reason to always send both.
 *
 * That last clause is why the description is not a nicety. A 7B vision model
 * given an arrow and a caption frequently answers the caption and ignores the
 * arrow; given only the arrow it answers something else entirely. Sending both
 * is not redundancy, it is the difference between pointing at something and
 * hoping.
 *
 * ## Blackout is not an annotation, and this is where the two rules meet
 *
 * §12.3 lists blackout among the drawing tools; §12.1 says the unredacted frame
 * is never written to disk. Deferring a blackout to send time — as a vector op
 * alongside the rest — would break the second rule outright: the frame with the
 * secret in it would be sitting in the blob store the whole time, indexed and
 * pushable.
 *
 * So a blackout is separated out and routed through `redactAndStore` instead. It
 * is applied before the bytes are stored, not painted over them afterwards.
 *
 * **The limit, stated rather than papered over:** that guarantee only holds for
 * a blackout drawn *before* the first store. Blacking something out on an image
 * already on disk produces a new redacted blob and cannot unwrite the old one.
 * The annotator should therefore offer redaction at capture; anything later is a
 * second-best that §12.1's sentence does not cover.
 *
 * ## Coordinates are described as they will be seen
 *
 * §12.2's fitting downscales images per agent, so an annotation's pixel
 * coordinates change between what was drawn and what is sent. A description
 * carrying the *original* numbers would point a model at the wrong place — a
 * confident wrong answer, which is worse than a vague right one. Descriptions
 * are therefore generated from the geometry as sent, and carry a plain-language
 * position as well, because "upper left" survives any scaling and "(412, 208)"
 * does not survive a resize nobody told the describer about.
 */

import type { Rect } from './redact.js';

export interface Point {
  x: number;
  y: number;
}

/** A colour as the user chose it, kept for the description rather than for CSS. */
export type AnnotationColour = 'red' | 'yellow' | 'green' | 'blue' | 'white' | 'black';

export type Annotation =
  | { kind: 'rectangle'; colour: AnnotationColour; rect: Rect; label?: string }
  | { kind: 'arrow'; colour: AnnotationColour; from: Point; to: Point; label?: string }
  | { kind: 'freehand'; colour: AnnotationColour; points: Point[]; label?: string }
  | { kind: 'text'; colour: AnnotationColour; at: Point; text: string }
  /**
   * A region to obliterate — its own kind, not a black rectangle.
   *
   * Distinguishing it by colour would be a heuristic where §12.3 gives a tool,
   * and getting that heuristic wrong means either a highlight silently burned
   * into the stored blob or a *secret* silently left in it. The second is the
   * one that matters, and neither should depend on which colour was picked.
   */
  | { kind: 'blackout'; rect: Rect }
  /**
   * A crop, described rather than applied here.
   *
   * Kept as a vector op like the rest, because §12.3's rule is that the original
   * survives — and a crop applied at capture would destroy the surrounding
   * context that makes a screenshot legible later.
   */
  | { kind: 'crop'; rect: Rect };

/**
 * Flatten annotations onto an image. Injected: needs a decoder, like everything
 * else that touches pixels (§12.1, §12.2).
 */
export type Flattener = (frame: Buffer, annotations: readonly Annotation[]) => Promise<Buffer>;

/**
 * Rescale annotations to match an image that was resized for an agent (§12.2).
 *
 * Without this, a description generated after fitting would carry coordinates
 * from the image as drawn and point at the wrong part of the image as sent.
 */
export function scaleAnnotations(
  annotations: readonly Annotation[],
  factor: number,
): Annotation[] {
  const p = (point: Point): Point => ({ x: Math.round(point.x * factor), y: Math.round(point.y * factor) });
  const r = (rect: Rect): Rect => ({
    x: Math.round(rect.x * factor),
    y: Math.round(rect.y * factor),
    w: Math.round(rect.w * factor),
    h: Math.round(rect.h * factor),
  });

  return annotations.map((a) => {
    switch (a.kind) {
      case 'rectangle':
        return { ...a, rect: r(a.rect) };
      case 'arrow':
        return { ...a, from: p(a.from), to: p(a.to) };
      case 'freehand':
        return { ...a, points: a.points.map(p) };
      case 'text':
        return { ...a, at: p(a.at) };
      case 'blackout':
      case 'crop':
        return { ...a, rect: r(a.rect) };
    }
  });
}

/**
 * Where something is, in words.
 *
 * Included alongside the pixel coordinates because it survives everything:
 * a resize, a crop, a model that does not reason well about numbers. For a
 * weaker vision model this phrase is often the part that lands.
 */
export function positionOf(point: Point, width: number, height: number): string {
  if (width <= 0 || height <= 0) return 'somewhere';
  const vertical = point.y < height / 3 ? 'upper' : point.y > (height * 2) / 3 ? 'lower' : 'middle';
  const horizontal = point.x < width / 3 ? 'left' : point.x > (width * 2) / 3 ? 'right' : 'centre';
  return vertical === 'middle' && horizontal === 'centre' ? 'centre' : `${vertical} ${horizontal}`;
}

/**
 * Describe what was drawn, for the text block that travels with the image.
 *
 * `null` when there is nothing to say. An empty "the user annotated this image"
 * line would be noise on every ordinary paste, and noise in the one place §12.3
 * relies on being read.
 */
export function describeAnnotations(
  annotations: readonly Annotation[],
  size: { width: number; height: number },
): string | null {
  const lines = annotations.map((a) => describeOne(a, size)).filter((l): l is string => l !== null);
  if (lines.length === 0) return null;
  return `Annotations on this image: ${lines.join('; ')}.`;
}

function describeOne(a: Annotation, size: { width: number; height: number }): string | null {
  const where = (p: Point): string =>
    `(${p.x}, ${p.y}) in the ${positionOf(p, size.width, size.height)}`;
  const labelled = (label: string | undefined): string =>
    label === undefined ? '' : ` labeled ${JSON.stringify(label)}`;

  switch (a.kind) {
    case 'rectangle':
      return (
        `${a.colour} box around ${a.rect.w}×${a.rect.h} at ` +
        `${where({ x: a.rect.x, y: a.rect.y })}${labelled(a.label)}`
      );
    case 'arrow':
      // The *tip* is what an arrow means, so it leads. An arrow described by its
      // tail points a model at where the user's hand started, not at what they
      // meant.
      return `${a.colour} arrow pointing at ${where(a.to)}${labelled(a.label)}`;
    case 'freehand': {
      const first = a.points[0];
      if (first === undefined) return null;
      return `${a.colour} freehand mark near ${where(first)}${labelled(a.label)}`;
    }
    case 'text':
      return `${a.colour} text ${JSON.stringify(a.text)} at ${where(a.at)}`;
    case 'blackout':
      // Said out loud. A model that can see a black box and is told nothing may
      // decide the interface has a black box in it.
      return `a ${a.rect.w}×${a.rect.h} region redacted at ${where({ x: a.rect.x, y: a.rect.y })}`;
    case 'crop':
      // Worth saying: a model shown a crop with no note may reason about the
      // whole screen it thinks it is seeing.
      return `cropped to ${a.rect.w}×${a.rect.h}`;
  }
}

/**
 * Split a drawing session into what must be burned in and what stays editable.
 *
 * The one place §12.1 and §12.3 have to be reconciled, and the reason it is a
 * function rather than a comment: a blackout deferred as a vector op leaves the
 * secret in the stored blob, and every other annotation burned in early destroys
 * the original §12.3 promises to keep.
 */
export function splitRedactions(annotations: readonly Annotation[]): {
  redactions: Rect[];
  editable: Annotation[];
} {
  const redactions: Rect[] = [];
  const editable: Annotation[] = [];
  for (const a of annotations) {
    if (a.kind === 'blackout') {
      redactions.push(a.rect);
      continue;
    }
    editable.push(a);
  }
  return { redactions, editable };
}
