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

/** One conversation turn in Gilmok's canonical form. */
export interface NormalizedTurn {
  role: 'user' | 'assistant' | 'system';
  content: ContentBlock[];
}

/** A recorded downgrade, so capability gaps are visible rather than silent. */
export interface DowngradeNote {
  reason: 'no_image_support' | 'over_max_long_edge' | 'over_max_count' | 'no_audio_support';
  detail: string;
}
