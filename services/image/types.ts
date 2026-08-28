/**
 * One request shape, two very different backends behind it.
 *
 * `/v1/images/generations` takes a sentence and gives you a picture. ComfyUI
 * takes an entire graph and gives you a job id. The reader should not have to
 * know which one they are talking to in order to press a button on a passage,
 * so everything either can do is expressed here and everything only ONE can do
 * is a declared capability the caller checks first.
 */

import type { Capability } from '../types';

export type ImageAdapterId = 'openai' | 'comfy';

export interface ImageRequest {
  prompt: string;
  /** Ignored by adapters that do not declare the `negative` capability. */
  negative?: string;
  width: number;
  height: number;
  /** Locked per character for continuity; ignored without the `seed` capability. */
  seed?: number;
  /** data: URI for img2img, used only with the `img2img` capability. */
  reference?: string;
  signal?: AbortSignal;
  /** Coarse progress, 0..1, where the backend can report it. */
  onProgress?: (fraction: number) => void;
}

export interface ImageResult {
  blob: Blob;
  /** The seed that was actually used, when the backend says. */
  seed?: number;
}

export interface ImageAdapter {
  id: ImageAdapterId;
  label: string;
  /** What this backend can do, given the reader's current configuration. */
  capabilities(config: ImageConfig): Set<Capability>;
  probe(config: ImageConfig, signal?: AbortSignal): Promise<{ up: boolean; detail?: string }>;
  generate(config: ImageConfig, req: ImageRequest): Promise<ImageResult>;
}

export interface ImageConfig {
  base: string;
  apiKey: string;
  adapter: ImageAdapterId;
  /** ComfyUI only: the reader's API-format workflow, as JSON text. */
  workflow: string;
  /** ComfyUI only: node ids the reader has pinned, overriding auto-detection. */
  mapping: Partial<WorkflowMapping>;
  /** OpenAI-compatible only: the model name to ask for. */
  model: string;
}

/** Which node in a ComfyUI graph carries which part of the request. */
export interface WorkflowMapping {
  positive: string;
  negative: string;
  seed: string;
  size: string;
  reference: string;
}
