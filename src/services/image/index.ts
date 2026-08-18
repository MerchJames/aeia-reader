/**
 * The image service: pick an adapter, ask it for a picture.
 *
 * Two backends, one door. Which one is in force is the reader's choice, and
 * every difference between them is a declared capability rather than a branch
 * at the call site.
 */

import { useAppStore } from '../../store';
import type { ProbeResult } from '../types';
import { comfyAdapter } from './comfy';
import { openaiAdapter } from './openai';
import type { ImageAdapter, ImageAdapterId, ImageConfig, ImageRequest, ImageResult } from './types';

export * from './types';
export { detectMapping, parseWorkflow, fillWorkflow } from './workflow';
export type { Detection, Workflow, WorkflowNode } from './workflow';

export const IMAGE_ADAPTERS: Record<ImageAdapterId, ImageAdapter> = {
  openai: openaiAdapter,
  comfy: comfyAdapter,
};

export const adapterFor = (id: ImageAdapterId | string): ImageAdapter =>
  IMAGE_ADAPTERS[id as ImageAdapterId] ?? IMAGE_ADAPTERS.openai;

/** The reader's current image configuration, read fresh from the store. */
export const imageConfig = (): ImageConfig => {
  const s = useAppStore.getState();
  return {
    base: s.imageBaseUrl,
    apiKey: s.imageApiKey,
    adapter: s.imageAdapter,
    workflow: s.comfyWorkflow,
    mapping: s.comfyMapping ?? {},
    model: s.imageModel,
  };
};

export const probeImageService = async (signal?: AbortSignal): Promise<ProbeResult> => {
  const config = imageConfig();
  const adapter = adapterFor(config.adapter);
  const result = await adapter.probe(config, signal);
  return {
    ...result,
    capabilities: result.up ? [...adapter.capabilities(config)] : [],
  };
};

export const generateImage = (req: ImageRequest): Promise<ImageResult> => {
  const config = imageConfig();
  return adapterFor(config.adapter).generate(config, req);
};

/** What the configured backend can do right now. */
export const imageCapabilities = () => {
  const config = imageConfig();
  return adapterFor(config.adapter).capabilities(config);
};
