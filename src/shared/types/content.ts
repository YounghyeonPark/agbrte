/**
 * Normalized content blocks (DESIGN.md §3.13).
 *
 * Everything a user or agent can send — typed text, a pasted image, a screen
 * capture, an annotated capture, a voice clip — is normalized to this union
 * before it reaches any adapter. Adapters downgrade per their declared
 * `ContentSupport`, and every downgrade is logged, so a model "ignoring your
 * screenshot" is diagnosable rather than mysterious.
 */

import type { Sha256 } from './ids.js';
import type { WorkspacePath } from './paths.js';

/** A rectangle, in the coordinate space of whatever image it is attached to. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

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

export interface ImageProvenance {
  kind: 'paste' | 'drop' | 'screen_capture' | 'annotated_capture' | 'headless_browser';
  /** Which machine produced the pixels. Matters once sessions can be remote. */
  origin: 'client' | 'remote';
  capturedAt?: string;
  displayId?: string;
  windowTitle?: string;
  url?: string;
  viewport?: { w: number; h: number; dpr: number };
  /** sha256 of the unannotated original; annotations are stored as vectors. */
  annotatedFrom?: Sha256;
  /** Applied to the stored blob, never only to the view (§12.1). */
  redactions?: ReadonlyArray<{ x: number; y: number; w: number; h: number }>;
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  sha256: Sha256;
  mime: string;
  width: number;
  height: number;
  provenance: ImageProvenance;
  /**
   * Marks the user drew, kept as vectors (§12.3).
   *
   * On the block rather than in `provenance` because they are not a fact *about*
   * the capture, they are content — and because they have to survive the trip to
   * the host that owns the log, which is what flattens and describes them at
   * send time. The stored blob stays unannotated: §12.3's rule is that the
   * original is never destroyed, and a flattened copy points back at it through
   * `annotatedFrom`.
   *
   * Blackouts are the exception and are *not* here. They went through
   * `redactAndStore` before the frame was ever written, because deferring one
   * would leave the secret in the blob store for the whole editable lifetime —
   * §12.1's guarantee, which §12.3 must not undo.
   */
  annotations?: Annotation[];
}

export interface AudioBlock {
  type: 'audio';
  sha256: Sha256;
  mime: string;
  durationMs: number;
  /** Produced locally by STT; the audio itself never reaches a provider. */
  transcript?: string;
}

export interface FileRefBlock {
  type: 'file_ref';
  path: WorkspacePath;
}

export interface ArtifactRefBlock {
  type: 'artifact_ref';
  artifactId: string;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | FileRefBlock
  | ArtifactRefBlock;

export interface ContentSupport {
  image: boolean;
  audio: boolean;
  pdf: boolean;
  video: boolean;
}

/** One conversation turn in Agbrte's canonical form. */
export interface NormalizedTurn {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
}

/** A recorded downgrade, so capability gaps are visible rather than silent. */
export interface DowngradeNote {
  reason:
    | 'no_image_support'
    | 'over_max_long_edge'
    | 'over_max_count'
    | 'no_audio_support'
    /** Marks could not be drawn here; §12.3's description was sent instead. */
    | 'annotations_not_flattened'
    /**
     * A voice clip had no usable transcript (§12.4).
     *
     * Its own reason rather than `no_audio_support`, which would name the wrong
     * cause: the agent's capabilities are irrelevant here, because audio never
     * reaches a provider whatever they say. What failed was the local engine.
     */
    | 'not_transcribed';
  detail: string;
}
