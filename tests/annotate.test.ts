/**
 * Annotations, and the text that travels with them (DESIGN.md §12.3, §15 Phase 7).
 *
 * > The flattened image is sent with a generated text block describing the
 * > annotations … for weaker vision models it's often the only part that lands,
 * > which is a good reason to always send both.
 *
 * The description is therefore load-bearing rather than decorative: a small
 * vision model given an arrow and a caption will often answer the caption and
 * ignore the arrow, and given only the arrow will answer something else. Most of
 * what is tested here is that the sentence says the useful thing — where, in
 * words that survive a resize, and what the user actually pointed at.
 */

import { describe, expect, it } from 'vitest';
import {
  describeAnnotations,
  positionOf,
  scaleAnnotations,
  splitRedactions,
  type Annotation,
} from '@main/content/annotate.js';

const SIZE = { width: 1200, height: 900 };

describe('describing what was drawn', () => {
  it('leads an arrow with its tip, not its tail', () => {
    const arrow: Annotation = {
      kind: 'arrow',
      colour: 'red',
      from: { x: 100, y: 100 },
      to: { x: 900, y: 700 },
      label: 'this button does nothing',
    };

    const text = describeAnnotations([arrow], SIZE) ?? '';
    // An arrow described by where the hand started points a model at the wrong
    // thing. The tip is the whole meaning of an arrow.
    expect(text).toContain('(900, 700)');
    expect(text).not.toContain('(100, 100)');
    expect(text).toContain('this button does nothing');
  });

  it('says where in words as well as in pixels', () => {
    const text = describeAnnotations(
      [{ kind: 'arrow', colour: 'red', from: { x: 0, y: 0 }, to: { x: 1100, y: 100 } }],
      SIZE,
    );
    // "upper right" survives a resize and a model that reasons badly about
    // numbers; "(1100, 100)" survives neither.
    expect(text).toContain('upper right');
  });

  it('says nothing at all when nothing was drawn', () => {
    // An "the user annotated this" line on every ordinary paste would be noise
    // in the one place §12.3 depends on being read.
    expect(describeAnnotations([], SIZE)).toBeNull();
  });

  it('mentions a redacted region rather than leaving a mystery box', () => {
    const text = describeAnnotations([{ kind: 'blackout', rect: { x: 10, y: 10, w: 200, h: 40 } }], SIZE);
    // A model that can see a black rectangle and is told nothing may decide the
    // interface has a black rectangle in it.
    expect(text).toContain('redacted');
  });

  it('mentions a crop, because a model cannot tell it is looking at part', () => {
    const text = describeAnnotations([{ kind: 'crop', rect: { x: 0, y: 0, w: 400, h: 300 } }], SIZE);
    expect(text).toContain('cropped to 400×300');
  });

  it('skips a freehand stroke with no points rather than describing nothing', () => {
    expect(describeAnnotations([{ kind: 'freehand', colour: 'blue', points: [] }], SIZE)).toBeNull();
  });
});

describe('coordinates as the model will see them', () => {
  it('scales with the image', () => {
    const drawn: Annotation[] = [
      { kind: 'arrow', colour: 'red', from: { x: 100, y: 200 }, to: { x: 800, y: 600 } },
      { kind: 'rectangle', colour: 'blue', rect: { x: 10, y: 20, w: 100, h: 50 } },
    ];

    const scaled = scaleAnnotations(drawn, 0.5);
    expect(scaled[0]).toMatchObject({ to: { x: 400, y: 300 } });
    expect(scaled[1]).toMatchObject({ rect: { x: 5, y: 10, w: 50, h: 25 } });
  });

  it('keeps the description honest after a resize', () => {
    // §12.2 downscales per agent. A description carrying the coordinates as
    // drawn would point at the wrong part of the image as sent — a confident
    // wrong answer, which is worse than a vague right one.
    const drawn: Annotation[] = [
      { kind: 'arrow', colour: 'red', from: { x: 0, y: 0 }, to: { x: 1000, y: 800 } },
    ];
    const sent = describeAnnotations(scaleAnnotations(drawn, 0.5), { width: 600, height: 450 });

    expect(sent).toContain('(500, 400)');
    // And still in the same part of the picture, which is the point of saying it
    // twice.
    expect(sent).toContain('lower right');
  });

  it('does not claim a position it cannot know', () => {
    expect(positionOf({ x: 5, y: 5 }, 0, 0)).toBe('somewhere');
  });
});

describe('what must be burned in before storage', () => {
  it('separates blackouts from everything editable', () => {
    /**
     * Where §12.1 and §12.3 meet. Deferring a blackout to send time — as a
     * vector op alongside the rest — leaves the frame with the secret in it
     * sitting in the blob store the whole time, indexed and pushable, which
     * breaks §12.1 outright.
     */
    const annotations: Annotation[] = [
      { kind: 'arrow', colour: 'red', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } },
      { kind: 'blackout', rect: { x: 100, y: 100, w: 200, h: 40 } },
      { kind: 'text', colour: 'yellow', at: { x: 5, y: 5 }, text: 'here' },
    ];

    const split = splitRedactions(annotations);
    expect(split.redactions).toEqual([{ x: 100, y: 100, w: 200, h: 40 }]);
    expect(split.editable.map((a) => a.kind)).toEqual(['arrow', 'text']);
  });

  it('does not treat a black highlight as a redaction', () => {
    // Deciding by colour would be a heuristic where §12.3 gives a tool, and
    // getting it wrong means either a highlight burned irreversibly into the
    // stored blob or — the one that matters — a secret quietly left in it.
    const split = splitRedactions([
      { kind: 'rectangle', colour: 'black', rect: { x: 0, y: 0, w: 10, h: 10 }, label: 'look here' },
    ]);
    expect(split.redactions).toEqual([]);
    expect(split.editable).toHaveLength(1);
  });
});
