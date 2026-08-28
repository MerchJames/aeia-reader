/**
 * `/v1/images/generations` — the OpenAI-compatible image endpoint.
 *
 * The simple half of the pair: one POST, one picture. It has no seed and no
 * img2img, so it declares neither, and continuity for a character rests
 * entirely on the appearance sheet being prepended to every prompt.
 *
 * `b64_json` is requested rather than a URL on purpose. A URL response would
 * mean fetching the image from wherever the service put it — often a signed
 * bucket link that expires — and the reader's copy has to be bytes on their own
 * machine, not a link that rots.
 */

import { apiRoot, authHeaders, getJsonOrNull, serviceError } from '../http';
import type { Capability } from '../types';
import type { ImageAdapter, ImageConfig, ImageRequest, ImageResult } from './types';

const b64ToBlob = (b64: string, type = 'image/png'): Blob => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
};

/** `1024x1024` — the only size format this API takes. */
const sizeParam = (w: number, h: number) => `${Math.round(w)}x${Math.round(h)}`;

export const openaiAdapter: ImageAdapter = {
  id: 'openai',
  label: 'OpenAI-compatible (/v1/images)',

  capabilities(): Set<Capability> {
    // Deliberately empty. Declaring `negative` here would let the caller send a
    // negative prompt that the endpoint silently discards, which reads to the
    // reader as "negatives do not work" rather than "this backend has none".
    return new Set<Capability>();
  },

  async probe(config, signal) {
    const root = apiRoot(config.base);
    if (!root) return { up: false, detail: 'no address set' };
    // There is no image-specific health route, so ask the one thing every
    // OpenAI-compatible host answers.
    const data = await getJsonOrNull<{ data?: unknown[] }>(`${root}/models`, { apiKey: config.apiKey, signal });
    if (!data) return { up: false, detail: 'no answer at that address' };
    const n = Array.isArray(data.data) ? data.data.length : 0;
    return { up: true, detail: n ? `${n} models` : 'reachable' };
  },

  async generate(config: ImageConfig, req: ImageRequest): Promise<ImageResult> {
    const res = await fetch(`${apiRoot(config.base)}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config.apiKey) },
      body: JSON.stringify({
        model: config.model || 'dall-e-3',
        prompt: req.prompt,
        n: 1,
        size: sizeParam(req.width, req.height),
        response_format: 'b64_json',
      }),
      signal: req.signal,
    });
    if (!res.ok) throw await serviceError('Image', res);

    const data = await res.json() as { data?: { b64_json?: string; url?: string }[] };
    const first = data?.data?.[0];
    if (first?.b64_json) return { blob: b64ToBlob(first.b64_json) };
    if (first?.url) {
      // Some hosts ignore response_format. Fetch it here, at export-safe time,
      // so what gets stored is still bytes.
      const img = await fetch(first.url, { signal: req.signal });
      if (!img.ok) throw await serviceError('Image', img);
      return { blob: await img.blob() };
    }
    throw new Error('The image endpoint returned no image.');
  },
};
